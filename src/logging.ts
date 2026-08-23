import type { Context } from "hono";

export type RequestLogMeta = {
  model?: string;
  served?: string;
  input_tokens?: number;
  output_tokens?: number;
  error?: string;
};

function fmtMeta(meta: RequestLogMeta): string {
  const parts: string[] = [];
  if (meta.model !== undefined) parts.push(`model=${meta.model}`);
  if (meta.served) parts.push(`served=${meta.served}`);
  if (meta.input_tokens !== undefined)
    parts.push(`in=${meta.input_tokens}`);
  if (meta.output_tokens !== undefined)
    parts.push(`out=${meta.output_tokens}`);
  if (meta.error) parts.push(`error="${meta.error.slice(0, 120)}"`);
  return parts.join(" ");
}

export function logRequest(
  c: Context,
  status: number,
  startedAt: number,
  meta: RequestLogMeta = {},
): void {
  const ts = new Date().toTimeString().slice(0, 8);
  const dur = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(
    `[${ts}] ${c.req.method} ${c.req.path} ${status} ${dur}s ${fmtMeta(meta)}`.trimEnd(),
  );
}
