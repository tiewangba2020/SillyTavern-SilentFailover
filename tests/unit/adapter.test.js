import { test, expect } from "vitest";
import { shouldIntercept, HOST_GENERATION_WINDOW_MS } from "../../extension/adapter.js";

const custom = { chat_completion_source: "custom" };
const now = 1_000_000;

test("only the sources this plugin supports are candidates", () => {
  for (const source of ["custom", "openai", "claude", "makersuite"])
    expect(shouldIntercept({ chat_completion_source: source }, now, true, now)).toBe(true);
  for (const source of ["textgenerationwebui", "kobold", "", undefined])
    expect(shouldIntercept({ chat_completion_source: source }, now, true, now)).toBe(false);
  expect(shouldIntercept(undefined, now, true, now)).toBe(false);
});

test("a fresh host generation marker is what authorizes interception", () => {
  expect(shouldIntercept(custom, now, true, now)).toBe(true);
  expect(shouldIntercept(custom, now, true, now + HOST_GENERATION_WINDOW_MS - 1)).toBe(true);
  expect(shouldIntercept(custom, now, true, now + HOST_GENERATION_WINDOW_MS)).toBe(false);
});

test("requests from other extensions that borrow the tavern endpoint are passed through", () => {
  // 织幕·外置组件 通过 ChatCompletionService / ConnectionManagerRequestService 打
  // /api/backends/chat-completions/generate，酒馆不会为它发 CHAT_COMPLETION_SETTINGS_READY，
  // 所以标记为 0，必须原样放行，让它用自己的 API 地址与模型。
  expect(shouldIntercept({ ...custom, custom_url: "https://example.com/v1" }, 0, true, now)).toBe(
    false,
  );
});

test("older tavern builds without the event keep the previous intercept-everything behaviour", () => {
  expect(shouldIntercept(custom, 0, false, now)).toBe(true);
  expect(shouldIntercept(custom, now, false, now)).toBe(true);
});
