import { test, expect } from "vitest";
import { tokenUsage, usageForHost } from "../../server/usage.js";
test("normalizes reported counters without retaining untrusted fields or guessing missing usage", () => {
  expect(
    tokenUsage({
      prompt_tokens: 100,
      completion_tokens: 50,
      total_tokens: 150,
      private: "secret",
      completion_tokens_details: { reasoning_tokens: 20 },
      prompt_tokens_details: { cached_tokens: 60 },
    }),
  ).toEqual({
    inputTokens: 100,
    outputTokens: 50,
    totalTokens: 150,
    reasoningTokens: 20,
    cacheReadTokens: 60,
  });
  expect(
    tokenUsage({
      prompt_tokens: -1,
      completion_tokens: "100",
      total_tokens: Infinity,
    }),
  ).toBeUndefined();
  expect(tokenUsage(undefined)).toBeUndefined();
  expect(tokenUsage({ completion_tokens: 0 })).toEqual({ outputTokens: 0 });
});
test("Claude caches and Gemini reasoning are included exactly once and map to host protocols", () => {
  const claude = tokenUsage(
    {
      input_tokens: 10,
      cache_read_input_tokens: 80,
      cache_creation_input_tokens: 20,
      output_tokens: 30,
    },
    "claude",
  );
  expect(claude).toMatchObject({
    inputTokens: 110,
    outputTokens: 30,
    totalTokens: 140,
  });
  expect(usageForHost(claude, "claude")).toMatchObject({
    input_tokens: 10,
    cache_read_input_tokens: 80,
    cache_creation_input_tokens: 20,
  });
  const gemini = tokenUsage(
    {
      promptTokenCount: 100,
      candidatesTokenCount: 40,
      thoughtsTokenCount: 60,
      totalTokenCount: 200,
    },
    "gemini",
  );
  expect(gemini).toMatchObject({ outputTokens: 100, totalTokens: 200 });
  expect(usageForHost(gemini)).toMatchObject({
    prompt_tokens: 100,
    completion_tokens: 100,
    completion_tokens_details: { reasoning_tokens: 60 },
  });
  expect(usageForHost(gemini, "makersuite")).toMatchObject({
    candidatesTokenCount: 40,
    thoughtsTokenCount: 60,
  });
});
