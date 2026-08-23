export type UpstreamError = {
  status: number;
  message: string;
  type: string;
  code: string | null;
};

const STATUS_TYPE: Record<number, { type: string; code: string }> = {
  400: { type: "invalid_request_error", code: "bad_request" },
  401: { type: "authentication_error", code: "invalid_api_key" },
  403: { type: "permission_error", code: "insufficient_plan" },
  404: { type: "invalid_request_error", code: "not_found" },
  408: { type: "timeout_error", code: "timeout" },
  425: { type: "api_error", code: "too_early" },
  429: { type: "rate_limit_error", code: "usage_limit_reached" },
};

export function classifyUpstreamError(
  status: number,
  body: string,
): UpstreamError {
  let msg = body.slice(0, 500);
  let errorCode: string | null = null;
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    if (typeof parsed.error === "string") msg = parsed.error;
    else if (
      parsed.error &&
      typeof parsed.error === "object" &&
      typeof (parsed.error as Record<string, unknown>).message === "string"
    ) {
      msg = (parsed.error as Record<string, unknown>).message as string;
    }
    if (typeof parsed.errorCode === "string") errorCode = parsed.errorCode;
  } catch {}

  const mapped = STATUS_TYPE[status];
  let type = mapped?.type ?? (status >= 500 ? "api_error" : "invalid_request_error");
  let code = errorCode ?? mapped?.code ?? null;

  if (/upgrade to pro/i.test(msg)) {
    type = "permission_error";
    code = "starter_model_blocked";
  }
  return { status, message: msg || `Perch upstream error ${status}`, type, code };
}

export function openAiErrorBody(e: UpstreamError | Error): {
  error: { message: string; type: string; code: string | null };
} {
  if (e instanceof Error && !(e as UpstreamErrorLike).status) {
    return {
      error: { message: e.message, type: "api_error", code: null },
    };
  }
  const u = e as unknown as UpstreamError;
  return {
    error: { message: u.message, type: u.type, code: u.code },
  };
}

type UpstreamErrorLike = { status?: number };

export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || (status >= 500 && status <= 599);
}
