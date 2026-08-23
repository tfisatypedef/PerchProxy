import type { OpenAiChatRequest, OpenAiMessage } from "./translate.js";

export type ResponsesInputItem = {
  type?: string;
  role?: string;
  content?: unknown;
  name?: string;
  arguments?: string;
  call_id?: string;
  output?: unknown;
};

export type ResponsesRequest = {
  model?: string;
  input?: unknown;
  instructions?: unknown;
  tools?: Array<{
    type?: string;
    name?: string;
    description?: string;
    parameters?: unknown;
  }>;
  tool_choice?: unknown;
  stream?: boolean;
  max_output_tokens?: number;
  temperature?: number;
};

function partsToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => {
        const part = p as { type?: string; text?: unknown };
        if (typeof part?.text === "string") return part.text;
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  if (content == null) return "";
  return String(content);
}

export function responsesToChat(req: ResponsesRequest): OpenAiChatRequest {
  const messages: OpenAiMessage[] = [];

  const instructions = typeof req.instructions === "string" ? req.instructions.trim() : "";
  if (instructions) {
    messages.push({ role: "system", content: instructions });
  }

  const input = req.input;
  if (typeof input === "string") {
    messages.push({ role: "user", content: input });
  } else if (Array.isArray(input)) {
    for (const raw of input as ResponsesInputItem[]) {
      const item = raw ?? {};
      const type = item.type ?? "message";
      if (type === "message") {
        messages.push({
          role: (item.role as OpenAiMessage["role"]) ?? "user",
          content: partsToText(item.content),
        });
      } else if (type === "function_call") {
        const call = {
          id: item.call_id ?? `call_${crypto.randomUUID().slice(0, 8)}`,
          function: { name: item.name ?? "", arguments: item.arguments ?? "{}" },
        };
        const last = messages[messages.length - 1];
        if (last && last.role === "assistant") {
          last.tool_calls = last.tool_calls ?? [];
          last.tool_calls.push(call);
        } else {
          messages.push({ role: "assistant", content: null, tool_calls: [call] });
        }
      } else if (type === "function_call_output") {
        messages.push({
          role: "tool",
          tool_call_id: item.call_id ?? "",
          content:
            typeof item.output === "string"
              ? item.output
              : JSON.stringify(item.output ?? ""),
        });
      } else if (type === "reasoning") {
        continue;
      } else {
        messages.push({
          role: (item.role as OpenAiMessage["role"]) ?? "user",
          content: partsToText(item.content) || JSON.stringify(item),
        });
      }
    }
  }

  const tools = (req.tools ?? [])
    .filter((t) => t.type === undefined || t.type === "function")
    .map((t) => ({
      type: "function" as const,
      function: {
        name: t.name ?? "",
        description: t.description,
        parameters: t.parameters,
      },
    }));

  let toolChoice: unknown = req.tool_choice;
  if (
    toolChoice &&
    typeof toolChoice === "object" &&
    (toolChoice as { type?: string }).type === "function"
  ) {
    toolChoice = "required";
  }

  return {
    model: req.model,
    messages,
    tools: tools.length ? tools : undefined,
    tool_choice: toolChoice as OpenAiChatRequest["tool_choice"],
    max_completion_tokens: req.max_output_tokens,
    temperature: req.temperature,
    stream: req.stream,
  };
}

let respCounter = 0;
function genId(prefix: string): string {
  respCounter += 1;
  return `${prefix}_${Date.now().toString(36)}${respCounter.toString(36)}${crypto
    .randomUUID()
    .replace(/-/g, "")
    .slice(0, 8)}`;
}

export type ToolCallOut = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

export type ResponseOutputItem =
  | {
      type: "message";
      id: string;
      role: "assistant";
      status: "completed";
      content: Array<{ type: "output_text"; text: string; annotations: [] }>;
    }
  | {
      type: "function_call";
      id: string;
      call_id: string;
      name: string;
      arguments: string;
      status: "completed";
    };

export function buildResponseObject(opts: {
  model: string;
  text: string;
  toolCalls: ToolCallOut[];
  usage: Record<string, number> | null;
}): Record<string, unknown> {
  const output: ResponseOutputItem[] = [];
  if (opts.text) {
    output.push({
      type: "message",
      id: genId("msg"),
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: opts.text, annotations: [] }],
    });
  }
  for (const tc of opts.toolCalls) {
    output.push({
      type: "function_call",
      id: genId("fc"),
      call_id: tc.id,
      name: tc.function.name,
      arguments: tc.function.arguments,
      status: "completed",
    });
  }
  return {
    id: genId("resp"),
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status: "completed",
    model: opts.model,
    output,
    usage: opts.usage
      ? {
          input_tokens: opts.usage.prompt_tokens ?? 0,
          output_tokens: opts.usage.completion_tokens ?? 0,
          total_tokens: opts.usage.total_tokens ?? 0,
        }
      : { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
    metadata: {},
    error: null,
  };
}
