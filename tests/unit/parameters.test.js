import { test, expect } from "vitest";
import { adaptParameters, rejectsTrailingModelTurn } from "../../server/parameters.js";
import { prepare } from "../../server/protocols.js";
import { failureRecord } from "../../server/errors.js";

test("actual Claude gateway models accept a global temperature of 1.3 without mutating the prompt", () => {
  const input = {
    temperature: 1.3,
    max_tokens: 30000,
    messages: [{ role: "user", content: "Browser verification" }],
  };
  for (const model of [
    "【示例】claude-opus-4-6",
    "claude-haiku-4-5-20251001",
    "anthropic/claude-sonnet-4-5",
  ]) {
    const node = {
      model,
      protocol: "openai",
      url: "https://example.com/v1",
      key: "test",
    };
    const result = adaptParameters(node, input);
    expect(result.payload.temperature).toBe(1);
    expect(prepare(node, input).body.temperature).toBe(1);
    expect(result.adjustments).toEqual([
      {
        parameter: "temperature",
        from: 1.3,
        to: 1,
        reason: "Claude 温度范围为 0 到 1",
      },
    ]);
  }
  expect(input.temperature).toBe(1.3);
  expect(adaptParameters({ model: "gpt-4o" }, input).payload.temperature).toBe(
    1.3,
  );
});
test("relay-prefixed Claude model names are still treated as Claude", () => {
  // 中继站会把厂商名拼在模型前面，分隔符是连字符而不是 / ] 】。
  // 漏判会让全局温度 1.3 原样打到上游，换来 400 "temperature: range: 0..1"。
  const input = { temperature: 1.3, messages: [{ role: "user", content: "hi" }] };
  for (const model of [
    "gemini-claude-opus-4-6-thinking",
    "gemini-claude-sonnet-4-5",
    "[自营]gemini-claude-opus-4-6-thinking",
  ]) {
    const node = {
      model,
      protocol: "openai",
      url: "https://example.com/v1",
      key: "test",
    };
    expect(adaptParameters(node, input).payload.temperature, model).toBe(1);
    expect(prepare(node, input).body.temperature, model).toBe(1);
  }
  for (const model of ["gemini-3.8-flash", "gemini-3.1-pro-high", "gpt-4o"]) {
    const node = {
      model,
      protocol: "openai",
      url: "https://example.com/v1",
      key: "test",
    };
    expect(adaptParameters(node, input).payload.temperature, model).toBe(1.3);
  }
  // "claude-" 前面是字母数字时不算，避免误伤 myclaude-x 这类名字。
  expect(
    adaptParameters({ model: "myclaude-x", protocol: "openai" }, input).payload
      .temperature,
  ).toBe(1.3);
});
test("obsolete per-node output caps are ignored; output limits follow SillyTavern", () => {
  const input = { max_tokens: 30000, max_completion_tokens: 50000 };
  const { payload } = adaptParameters({ maxTokens: 4096 }, input);
  expect(payload).toEqual(input);
  expect(input.max_tokens).toBe(30000);
  expect(
    adaptParameters({ maxTokens: 4096 }, { max_tokens: 8 }).payload.max_tokens,
  ).toBe(8);
  expect(adaptParameters({ maxTokens: null }, input).adjustments).toEqual([]);
});
test("Chinese precharge failures are classified as quota, not permission", () => {
  expect(
    failureRecord(
      {
        status: 403,
        code: "insufficient_user_quota",
        message: "预扣费额度失败",
      },
      [],
    ).category,
  ).toBe("quota");
});
test("only the Gemini models that enforce turn validation are matched", () => {
  for (const model of [
    "gemini-3.5-flash-lite",
    "gemini-3.6-flash",
    "gemini-3.7-flash",
    "gemini-3.8-flash",
    "[按次]gemini-3.8-flash",
    "google/gemini-3.6-flash",
    "gemini-3.9-flash",
    "gemini-4.0-flash",
  ])
    expect(rejectsTrailingModelTurn(model), model).toBe(true);
  for (const model of [
    "gemini-3.1-pro-high",
    "gemini-3.5-flash",
    "gemini-3-flash",
    "gemini-2.5-pro",
    "gemini-1.5-flash",
    "gpt-4o",
    "claude-opus-4-6",
  ])
    expect(rejectsTrailingModelTurn(model), model).toBe(false);
});
test("Gemini models that reject a trailing model turn get it converted to a user turn", () => {
  const trailing = {
    messages: [
      { role: "user", content: "hi" },
      { role: "assistant", content: "prefill" },
    ],
  };
  for (const model of [
    "gemini-3.8-flash",
    "gemini-3.5-flash-lite",
    "gemini-3.7-flash",
  ]) {
    const node = {
      model,
      protocol: "openai",
      url: "https://example.com/v1",
      key: "test",
    };
    const result = adaptParameters(node, trailing);
    expect(result.payload.messages.at(-1).role).toBe("user");
    expect(result.adjustments).toEqual([
      {
        parameter: "trailing_model_turn",
        from: "assistant",
        to: "user",
        reason: "该 Gemini 模型不接受以模型轮结尾的请求",
      },
    ]);
    expect(prepare(node, trailing).body.messages.at(-1).role).toBe("user");
  }
  expect(trailing.messages.at(-1).role).toBe("assistant");
});
test("models that still accept a prefill keep the trailing model turn", () => {
  const trailing = { messages: [{ role: "assistant", content: "prefill" }] };
  for (const model of [
    "gemini-3.1-pro-high",
    "gemini-3.5-flash",
    "gemini-2.5-pro",
    "gpt-4o",
    "claude-opus-4-6",
  ])
    expect(
      adaptParameters({ model, protocol: "openai" }, trailing).adjustments,
    ).toEqual([]);
  expect(
    adaptParameters(
      { model: "gemini-3.8-flash", protocol: "openai" },
      {
        messages: [
          { role: "assistant", content: "a" },
          { role: "user", content: "b" },
        ],
      },
    ).adjustments,
  ).toEqual([]);
});
test("native Gemini nodes lose the trailing model turn before role conversion", () => {
  const host = {
    getPromptNames: () => ({
      charName: "Char",
      userName: "User",
      groupNames: [],
      startsWithGroupName: () => false,
    }),
    convertGooglePrompt: (messages) => ({
      contents: messages.map((m) => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text: m.content }],
      })),
      system_instruction: { parts: [] },
    }),
    calculateGoogleBudgetTokens: () => null,
    safety: [],
  };
  const node = {
    model: "gemini-3.8-flash",
    protocol: "gemini",
    url: "https://generativelanguage.googleapis.com",
    key: "test",
  };
  const body = prepare(
    node,
    {
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "prefill" },
      ],
    },
    host,
  ).body;
  expect(body.contents.at(-1).role).toBe("user");
});
