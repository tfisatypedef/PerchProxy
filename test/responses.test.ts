import assert from "node:assert/strict";
import { test } from "node:test";
import {
  responsesToChat,
  buildResponseObject,
  type ResponsesRequest,
} from "../src/responses.js";

test("string input becomes user message", () => {
  const r = responsesToChat({ input: "hello" } as ResponsesRequest);
  assert.deepEqual(r.messages, [{ role: "user", content: "hello" }]);
});

test("instructions become system message", () => {
  const r = responsesToChat({
    instructions: "be terse",
    input: "hi",
  } as unknown as ResponsesRequest);
  assert.equal(r.messages[0].role, "system");
  assert.equal(r.messages[0].content, "be terse");
});

test("message items with parts flatten to text", () => {
  const r = responsesToChat({
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "a" }] },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "b" }] },
    ],
  });
  assert.deepEqual(r.messages, [
    { role: "user", content: "a" },
    { role: "assistant", content: "b" },
  ]);
});

test("function_call merges into preceding assistant message", () => {
  const r = responsesToChat({
    input: [
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "let me check" }] },
      { type: "function_call", call_id: "c1", name: "get_weather", arguments: '{"city":"Tokyo"}' },
      { type: "function_call_output", call_id: "c1", output: '{"temp":20}' },
    ],
  });
  assert.equal(r.messages.length, 2);
  const assistant = r.messages[0];
  assert.equal(assistant.role, "assistant");
  assert.equal(assistant.content, "let me check");
  assert.equal(assistant.tool_calls?.length, 1);
  assert.equal(assistant.tool_calls?.[0].id, "c1");
  assert.equal(r.messages[1].role, "tool");
  assert.equal(r.messages[1].tool_call_id, "c1");
});

test("orphan function_call creates assistant message", () => {
  const r = responsesToChat({
    input: [
      { type: "function_call", call_id: "c9", name: "f", arguments: "{}" },
    ],
  });
  assert.equal(r.messages[0].role, "assistant");
  assert.equal(r.messages[0].tool_calls?.length, 1);
});

test("responses tools convert to chat tools; tool_choice object -> required", () => {
  const r = responsesToChat({
    input: "x",
    tool_choice: { type: "function", name: "f" },
    tools: [
      { type: "function", name: "f", description: "d", parameters: { type: "object" } },
      { type: "web_search" as never },
    ],
  });
  assert.equal(r.tools?.length, 1);
  assert.equal(r.tools![0].function.name, "f");
  assert.equal(r.tool_choice, "required");
});

test("buildResponseObject emits message + function_call items and usage", () => {
  const resp = buildResponseObject({
    model: "auto",
    text: "checking",
    toolCalls: [
      { id: "call_1", type: "function", function: { name: "get_weather", arguments: '{"city":"Tokyo"}' } },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  });
  assert.equal(resp.status, "completed");
  assert.equal((resp.output as Array<{ type: string }>)[0].type, "message");
  assert.equal((resp.output as Array<{ type: string }>)[1].type, "function_call");
  const fc = (resp.output as Array<{ call_id?: string }>)[1];
  assert.equal(fc.call_id, "call_1");
  assert.deepEqual(resp.usage, { input_tokens: 10, output_tokens: 5, total_tokens: 15 });
});
