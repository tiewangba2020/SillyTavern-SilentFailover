import { test, expect } from "vitest";
import { adaptParameters } from "../../server/parameters.js";
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
