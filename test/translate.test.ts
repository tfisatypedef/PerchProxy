import assert from "node:assert/strict";
import { test } from "node:test";
import { toPerchOptions, toManualModelOptionId, normalizeToolCallsTestable, fromDoneEvent, extractUsage } from "../src/translate.js";

test("toManualModelOptionId maps known models", () => {
  assert.equal(toManualModelOptionId("glm-5"), "bedrock-mantle-zai-glm-5");
  assert.equal(toManualModelOptionId("GLM-5"), "bedrock-mantle-zai-glm-5");
});

test("toManualModelOptionId passes unknown through", () => {
  assert.equal(toManualModelOptionId("weird-model"), "weird-model");
});

test("toManualModelOptionId auto is null", () => {
  assert.equal(toManualModelOptionId("auto"), null);
  assert.equal(toManualModelOptionId(undefined), null);
  assert.equal(toManualModelOptionId("roost"), null);
});

test("toPerchOptions passes tools through and maps tool_choice", () => {
  const opts = toPerchOptions({
    messages: [{ role: "user", content: "hi" }],
    tool_choice: "required",
    tools: [
      {
        type: "function",
        function: { name: "f", description: "d", parameters: { type: "object" } },
      },
    ],
  });
  assert.equal(opts.toolChoice, "required");
  assert.equal(opts.tools?.length, 1);
  assert.equal(opts.tools![0].function.name, "f");
});

test("toPerchOptions drops tools when choice none", () => {
  const opts = toPerchOptions({
    messages: [],
    tool_choice: "none",
    tools: [
      { type: "function", function: { name: "f" } as never },
    ],
  });
  assert.equal(opts.toolChoice, "none");
});

test("normalize flat upstream toolCalls", () => {
  const calls = normalizeToolCallsTestable([
    {
      id: "functions.get_weather:0",
      name: "get_weather",
      arguments: { city: "Tokyo" },
      sealed: true,
    },
  ]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].function.name, "get_weather");
  assert.equal(calls[0].function.arguments, '{"city":"Tokyo"}');
});

test("normalize nested anthropic-style toolCalls fallback", () => {
  const calls = normalizeToolCallsTestable([
    { id: "x", function: { name: "n", input: { a: 1 } } },
  ]);
  assert.equal(calls[0].function.name, "n");
  assert.equal(calls[0].function.arguments, '{"a":1}');
});

test("fromDoneEvent extracts text, calls, usage", () => {
  const r = fromDoneEvent({
    text: "hello",
    toolCalls: [
      { id: "i", name: "t", arguments: {}, sealed: true },
    ],
    provider: "wandb",
    model: "deepseek-ai/DeepSeek-V4-Flash",
    usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
  });
  assert.equal(r.text, "hello");
  assert.equal(r.provider, "wandb");
  assert.deepEqual(r.usage, {
    prompt_tokens: 10,
    completion_tokens: 5,
    total_tokens: 15,
  });
});

test("extractUsage handles snake_case", () => {
  assert.deepEqual(extractUsage({ prompt_tokens: 1, completion_tokens: 2 }), {
    prompt_tokens: 1,
    completion_tokens: 2,
    total_tokens: 3,
  });
  assert.equal(extractUsage(null), null);
});
