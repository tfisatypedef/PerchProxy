import type { PerchCallOptions, PerchTool } from "./upstream.js";

export type OpenAiMessage = {
  role: string;
  content?: unknown;
  tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
  name?: string;
};

export type OpenAiChatRequest = {
  model?: string;
  messages: OpenAiMessage[];
  tools?: unknown[];
  tool_choice?: unknown;
  max_tokens?: number;
  max_completion_tokens?: number;
  temperature?: number;
  stream?: boolean;
  response_format?: unknown;
};

const KNOWN_MODELS: Record<string, string> = {
  "qwen-3.6": "wandb-qwen3-6-35b-a3b",
  "deepseek-v4-flash": "wandb-deepseek-ai-deepseek-v4-flash",
  "kimi-k2.5": "bedrock-mantle-moonshotai-kimi-k2-5",
  "glm-5": "bedrock-mantle-zai-glm-5",
  "qwen3-coder": "bedrock-mantle-qwen-qwen3-coder-480b-a35b-instruct",
  "nemotron-super": "bedrock-mantle-nvidia-nemotron-super-3-120b",
  "minimax-m2": "bedrock-mantle-minimax-minimax-m2",
  "gemma-4-e2b": "bedrock-mantle-google-gemma-4-e2b",
  "gemma-4-31b": "bedrock-mantle-google-gemma-4-31b",
  "glm-5.2": "wandb-zai-org-glm-5-2",
  "deepseek-v4-pro": "wandb-deepseek-ai-deepseek-v4-pro",
  "kimi-k2.6": "wandb-kimi-k2-6",
  "kimi-k2.7-code": "wandb-kimi-k2-7-code",
  "minimax-m3": "wandb-minimax-m3",
  "nemotron-ultra": "wandb-nvidia-nvidia-nemotron-3-ultra-550b-a55b",
  "nemotron-3.5-lightning":
    "wandb-nvidia-nvidia-nemotron-3-5-lightning-30b-a3b",
  "grok-4.3": "bedrock-mantle-xai-grok-4-3",
  "qwen-3.7-plus": "fireworks-accounts-fireworks-models-qwen3p7-plus",
  "qwen-3.8-27b": "wandb-qwen-qwen3-8-27b",
  "deepseek-v4-flash-0731": "wandb-deepseek-ai-deepseek-v4-flash-0731",
  inkling: "fireworks-accounts-fireworks-models-inkling",
};

export function toManualModelOptionId(model?: string): string | null {
  const m = model?.trim();
  if (!m || m === "auto" || m === "roost") return null;
  return KNOWN_MODELS[m.toLowerCase()] ?? m;
}

function mapToolChoice(tc: unknown): "auto" | "required" | "none" | undefined {
  if (tc == null) return undefined;
  if (typeof tc === "string") {
    if (tc === "none") return "none";
    if (tc === "required") return "required";
    return "auto";
  }
  return "required";
}

export function toPerchOptions(req: OpenAiChatRequest): PerchCallOptions {
  const tools: PerchTool[] | undefined = req.tools?.length
    ? (req.tools.filter(
        (t): t is PerchTool =>
          !!t &&
          typeof t === "object" &&
          (t as PerchTool).type === "function" &&
          !!(t as PerchTool).function,
      ) as PerchTool[])
    : undefined;
  const hasTools = !!tools?.length;
  return {
    messages: req.messages as Record<string, unknown>[],
    tools,
    toolChoice: hasTools ? mapToolChoice(req.tool_choice) : undefined,
    maxOutputTokens:
      req.max_completion_tokens ?? req.max_tokens ?? undefined,
    temperature: req.temperature ?? undefined,
    responseFormat:
      (req.response_format as Record<string, unknown> | undefined)?.type ===
      "json_object"
        ? { type: "json_object" }
        : undefined,
    manualModelOptionId: toManualModelOptionId(req.model),
  };
}

export type ToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

export type PerchResult = {
  text: string;
  toolCalls: ToolCall[];
  provider: string;
  model: string;
  usage: Record<string, number> | null;
};

export function normalizeToolCallsTestable(raw: unknown): ToolCall[] {
  return normalizeToolCalls(raw);
}

function normalizeToolCalls(raw: unknown): ToolCall[] {
  if (!Array.isArray(raw)) return [];
  const out: ToolCall[] = [];
  for (let i = 0; i < raw.length; i++) {
    const tc = raw[i] as Record<string, unknown>;
    if (!tc || typeof tc !== "object") continue;
    const fn = (tc.function ?? {}) as Record<string, unknown>;
    const name =
      typeof tc.name === "string"
        ? tc.name
        : typeof fn.name === "string"
          ? fn.name
          : "";
    let args: string;
    if (typeof tc.arguments === "string") {
      args = tc.arguments;
    } else if (tc.arguments && typeof tc.arguments === "object") {
      args = JSON.stringify(tc.arguments);
    } else if (typeof fn.arguments === "string") {
      args = fn.arguments;
    } else if (fn.input && typeof fn.input === "object") {
      args = JSON.stringify(fn.input);
    } else if (typeof tc.rawArgumentsText === "string") {
      args = tc.rawArgumentsText.trim();
    } else {
      args = "{}";
    }
    out.push({
      id: String(
        tc.id ?? `call_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`,
      ),
      type: "function",
      function: { name, arguments: args },
    });
  }
  return out;
}

export function fromDoneEvent(ev: Record<string, unknown>): PerchResult {
  let text = typeof ev.text === "string" ? ev.text : "";
  if (!text && typeof ev.content === "string") text = ev.content;
  return {
    text,
    toolCalls: normalizeToolCalls(ev.toolCalls),
    provider: String(ev.provider ?? "auto"),
    model: String(ev.model ?? "auto"),
    usage: extractUsage(ev.usage),
  };
}

export function extractUsage(u: unknown): Record<string, number> | null {
  if (!u || typeof u !== "object") return null;
  const rec = u as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === "number" ? v : undefined);
  const pt = num(rec.promptTokens) ?? num(rec.inputTokens) ?? num(rec.prompt_tokens);
  const ct = num(rec.completionTokens) ?? num(rec.outputTokens) ?? num(rec.completion_tokens);
  const tt = num(rec.totalTokens) ?? num(rec.total_tokens);
  if (pt == null && ct == null && tt == null) return null;
  return {
    prompt_tokens: pt ?? 0,
    completion_tokens: ct ?? 0,
    total_tokens: tt ?? (pt ?? 0) + (ct ?? 0),
  };
}
