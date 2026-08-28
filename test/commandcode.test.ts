import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCcBody, toCcMessages, toCcOptions, toCcTools } from "../src/commandcode.js";

test("toCcMessages maps system messages to system string", () => {
  const r = toCcMessages([
    { role: "system", content: "be terse" },
    { role: "developer", content: "and safe" },
  ]);
  assert.equal(r.system, "be terse\n\nand safe");
  assert.deepEqual(r.messages, []);
});

test("toCcMessages maps user/assistant text to text blocks", () => {
  const r = toCcMessages([
    { role: "user", content: "hi" },
    { role: "assistant", content: "hello" },
  ]);
  assert.deepEqual(r.messages, [
    { role: "user", content: [{ type: "text", text: "hi" }] },
    { role: "assistant", content: [{ type: "text", text: "hello" }] },
  ]);
});

test("toCcMessages flattens OpenAI content part arrays", () => {
  const r = toCcMessages([
    {
      role: "user",
      content: [
        { type: "text", text: "look" },
        { type: "image_url", image_url: { url: "http://x/y.png" } },
      ],
    },
  ]);
  assert.deepEqual(r.messages, [
    { role: "user", content: [{ type: "text", text: "look" }] },
  ]);
});

test("toCcMessages maps assistant tool_calls to tool_use blocks", () => {
  const r = toCcMessages([
    {
      role: "assistant",
      content: null,
      tool_calls: [
        { id: "call_1", function: { name: "read", arguments: '{"path":"a.ts"}' } },
      ],
    },
  ]);
  assert.deepEqual(r.messages, [
    {
      role: "assistant",
      content: [{ type: "tool_use", id: "call_1", name: "read", input: { path: "a.ts" } }],
    },
  ]);
});

test("toCcMessages maps tool results to user tool_result blocks", () => {
  const r = toCcMessages([{ role: "tool", tool_call_id: "call_1", content: "file body" }]);
  assert.deepEqual(r.messages, [
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "call_1",
          content: [{ type: "text", text: "file body" }],
        },
      ],
    },
  ]);
});

test("toCcTools maps OpenAI function tools to input_schema", () => {
  const tools = toCcTools([
    {
      type: "function",
      function: {
        name: "read",
        description: "read a file",
        parameters: { type: "object", properties: { path: { type: "string" } } },
      },
    },
  ]);
  assert.deepEqual(tools, [
    {
      name: "read",
      description: "read a file",
      input_schema: { type: "object", properties: { path: { type: "string" } } },
    },
  ]);
  assert.equal(toCcTools([]), null);
  assert.equal(toCcTools(undefined), null);
});

test("buildCcBody includes required envelope and params", () => {
  const body = JSON.parse(
    buildCcBody({
      model: "minimax/minimax-m3-free",
      system: "sys",
      messages: [{ role: "user", content: [{ type: "text", text: "Say OK" }] }],
      tools: null,
      maxOutputTokens: 16,
      temperature: null,
    }),
  );
  for (const key of [
    "workingDir",
    "date",
    "environment",
    "structure",
    "isGitRepo",
    "currentBranch",
    "mainBranch",
    "gitStatus",
    "recentCommits",
  ]) {
    assert.ok(key in body.config, `config.${key} missing`);
  }
  assert.equal(typeof body.memory, "string");
  assert.ok(typeof body.threadId === "string" && body.threadId.length > 10);
  assert.equal(body.permissionMode, "default");
  assert.equal(body.mode, "agent");
  assert.deepEqual(body.params, {
    model: "minimax/minimax-m3-free",
    messages: [{ role: "user", content: [{ type: "text", text: "Say OK" }] }],
    system: "sys",
    max_tokens: 16,
    stream: true,
  });
});

test("toCcOptions applies max token + temperature precedence", () => {
  const o = toCcOptions(
    { messages: [{ role: "user", content: "x" }], max_tokens: 8, temperature: 0.2 },
    "minimax/minimax-m3-free",
  );
  assert.equal(o.maxOutputTokens, 8);
  assert.equal(o.temperature, 0.2);
  assert.equal(o.system, null);
});
