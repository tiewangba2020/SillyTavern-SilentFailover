import { test, expect } from "vitest";
import {
  shouldIntercept,
  HOST_GENERATION_WINDOW_MS,
  apiErrorMessage,
  shouldRetryPoll,
  POLL_NOT_FOUND_ATTEMPTS,
  CONTACT_TIMEOUT_MS,
  contactBase,
} from "../../extension/adapter.js";

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

test("a job-not-found 404 is reported as a task problem, not a missing server", () => {
  // 本插件服务端在跑时会带 JSON error，酒馆自身/反代的 404 是 HTML，走 statusMessage 兜底。
  expect(apiErrorMessage(404, { error: "任务不存在或已结束" })).toBe(
    "任务不存在或已结束",
  );
  expect(apiErrorMessage(404, null)).toContain("未找到插件服务端");
  expect(apiErrorMessage(404, { error: "   " })).toContain("未找到插件服务端");
  // 登录与权限问题仍然给可操作的提示，不被服务端的简短文案顶掉。
  expect(apiErrorMessage(401, { error: "Authentication required" })).toContain(
    "登录已失效",
  );
  expect(apiErrorMessage(403, { error: "Forbidden" })).toContain("权限");
  expect(apiErrorMessage(400, { error: "节点不存在" })).toBe("节点不存在");
  expect(apiErrorMessage(500, null)).toBe("服务端请求失败");
});

test("a poll 404 is retried before it is treated as fatal", () => {
  const state = (notFound) => ({
    aborted: false,
    lastContact: now,
    now,
    notFound,
  });
  expect(shouldRetryPoll({ status: 404 }, state(1))).toBe(true);
  expect(shouldRetryPoll({ status: 404 }, state(POLL_NOT_FOUND_ATTEMPTS - 1))).toBe(
    true,
  );
  expect(shouldRetryPoll({ status: 404 }, state(POLL_NOT_FOUND_ATTEMPTS))).toBe(
    false,
  );
  // 其它错误：只要还能联系上服务端就继续等，超时才放弃。
  expect(shouldRetryPoll({ name: "TimeoutError" }, state(0))).toBe(true);
  expect(
    shouldRetryPoll(
      { name: "TimeoutError" },
      { aborted: false, lastContact: now, now: now + CONTACT_TIMEOUT_MS + 1, notFound: 0 },
    ),
  ).toBe(false);
  expect(
    shouldRetryPoll({ status: 404 }, { aborted: true, lastContact: now, now, notFound: 0 }),
  ).toBe(false);
});

test("coming back from a frozen page counts as fresh contact", () => {
  // 锁屏冻结两分钟之后，lastContact 是很久以前；不修正的话第一条请求失败就会放弃。
  const lastContact = now;
  const resumedAt = now + 120_000;
  expect(contactBase(lastContact, resumedAt)).toBe(resumedAt);
  expect(
    shouldRetryPoll(
      { name: "TypeError" },
      { aborted: false, lastContact: contactBase(lastContact, resumedAt), now: resumedAt + 500, notFound: 0 },
    ),
  ).toBe(true);
  // 回到前台之后真的又失联 55 秒，仍然要放弃。
  expect(
    shouldRetryPoll(
      { name: "TypeError" },
      {
        aborted: false,
        lastContact: contactBase(lastContact, resumedAt),
        now: resumedAt + CONTACT_TIMEOUT_MS + 1,
        notFound: 0,
      },
    ),
  ).toBe(false);
  // 没有发生过冻结时保持原值，不能把真实的失联判定顶掉。
  expect(contactBase(now, 0)).toBe(now);
  expect(contactBase(now, now - 1)).toBe(now);
});
