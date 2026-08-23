import { getPerchAuth } from "../src/auth.js";
import { baseUrl, MODEL_CALL_PATH } from "../src/upstream.js";

const auth = await getPerchAuth();
const body = JSON.stringify({
  request: {
    lane: "chat",
    messages: [{ role: "user", content: "What is the weather in Tokyo? Use the tool." }],
    tools: [
      {
        type: "function",
        function: {
          name: "get_weather",
          description: "Get current weather for a city",
          parameters: {
            type: "object",
            properties: { city: { type: "string" } },
            required: ["city"],
          },
        },
      },
    ],
    maxOutputTokens: 200,
    toolChoice: "auto",
  },
  runId: crypto.randomUUID(),
  lane: "chat",
  strictManual: false,
  preferredModelId: null,
  avoidModelIds: [],
  attribution: null,
  clientSurface: "cli",
  manualModelOptionId: null,
});

const res = await fetch(`${baseUrl()}${MODEL_CALL_PATH}`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Accept: "text/event-stream",
    Authorization: `Bearer ${auth.token}`,
  },
  body,
});
console.log("status", res.status);
const text = await res.text();
for (const line of text.split("\n")) {
  if (!line.startsWith("data:")) continue;
  const ev = JSON.parse(line.slice(5).trim());
  if (
    ev.type === "tool_call_delta" ||
    ev.type === "tool_use_end" ||
    ev.type === "done"
  ) {
    console.log(JSON.stringify(ev, null, 2).slice(0, 1500));
  }
}
