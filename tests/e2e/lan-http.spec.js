import { test, expect } from "@playwright/test";
import fs from "node:fs/promises";

async function setup(page, { legacy = false, status = 200 } = {}) {
  const calls = [];
  if (legacy)
    await page.addInitScript(() => {
      Object.defineProperty(AbortSignal, "any", { value: undefined });
      Object.defineProperty(AbortSignal, "timeout", { value: undefined });
    });
  await page.route("http://lan-check.test/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === "/")
      return route.fulfill({
        contentType: "text/html",
        body: "<!doctype html><title>LAN HTTP test</title>",
      });
    if (
      [
        "/extension/adapter.js",
        "/extension/browser-compat.js",
        "/server/usage.js",
      ].includes(pathname)
    )
      return route.fulfill({
        contentType: "text/javascript",
        body: await fs.readFile(
          new URL("../.." + pathname, import.meta.url),
          "utf8",
        ),
      });
    if (pathname === "/api/plugins/silent-failover/config") {
      if (status !== 200)
        return route.fulfill({
          status,
          contentType: "text/html",
          body: "private gateway page",
        });
      return route.fulfill({ json: { enabled: true, nativeFirst: false } });
    }
    if (pathname === "/api/plugins/silent-failover/jobs") {
      const body = route.request().postDataJSON();
      calls.push(body);
      return route.fulfill({
        json: {
          id: body.id,
          state: "succeeded",
          result: {
            choices: [
              {
                message: { content: "LAN complete reply" },
                finish_reason: "stop",
              },
            ],
            tokenUsage: { inputTokens: 10, outputTokens: 4 },
          },
        },
      });
    }
    return route.fulfill({ json: { ok: true } });
  });
  await page.goto("http://lan-check.test/");
  await page.evaluate(async () => {
    const { installAdapter } = await import("/extension/adapter.js");
    window.testBridge = installAdapter(() => ({
      getRequestHeaders: () => ({ "Content-Type": "application/json" }),
    }));
  });
  return calls;
}

for (const legacy of [false, true]) {
  test(`LAN HTTP can read configuration and generate with legacy signal APIs ${legacy}`, async ({
    page,
  }) => {
    const calls = await setup(page, { legacy });
    const result = await page.evaluate(async () => {
      const settings = await window.testBridge.api("/config");
      const replies = [];
      for (const stream of [true, false]) {
        const response = await fetch(
          "/api/backends/chat-completions/generate",
          {
            method: "POST",
            body: JSON.stringify({
              chat_completion_source: "custom",
              stream,
              messages: [{ role: "user", content: "test" }],
            }),
          },
        );
        replies.push(await response.text());
      }
      return {
        secure: isSecureContext,
        uuid: typeof crypto.randomUUID,
        settings,
        replies,
      };
    });
    expect(result.secure).toBe(false);
    expect(result.uuid).toBe("undefined");
    expect(result.settings.enabled).toBe(true);
    expect(
      result.replies.every(
        (reply) =>
          reply.includes("LAN complete reply") &&
          reply.includes('"prompt_tokens":10'),
      ),
    ).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[0].id).not.toBe(calls[1].id);
  });
}
for (const [status, message] of [
  [401, "登录已失效"],
  [403, "拒绝了插件请求"],
  [404, "未找到插件服务端"],
  [502, "不是有效 JSON"],
]) {
  test(`LAN status ${status} explains access failure without exposing gateway response`, async ({
    page,
  }) => {
    await setup(page, { status });
    const error = await page.evaluate(async () => {
      try {
        await window.testBridge.api("/config");
      } catch (e) {
        return { message: e.message, status: e.status };
      }
    });
    expect(error.status).toBe(status);
    expect(error.message).toContain(message);
    expect(error.message).not.toContain("private gateway page");
  });
}
