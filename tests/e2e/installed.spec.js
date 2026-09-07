import { test, expect } from "@playwright/test";
const API = "/api/plugins/silent-failover";
async function api(page, path, body) {
  return page.evaluate(
    async ({ path, body }) => {
      const r = await fetch("/api/plugins/silent-failover" + path, {
        method: body === undefined ? "GET" : "POST",
        headers: SillyTavern.getContext().getRequestHeaders(),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (!r.ok) throw new Error(await r.text());
      return r.json();
    },
    { path, body },
  );
}
async function open(page) {
  await page.goto("/");
  await page.waitForFunction(
    () => !!window.SillyTavern?.getContext().characters.length,
  );
  if (await page.locator(".popup-button-ok:visible").count())
    await page.locator(".popup-button-ok:visible").click();
  await expect(page.locator("#silent-failover-settings")).toBeAttached();
  await page.locator("#extensions-settings-button .drawer-toggle").click();
  const root = page.locator("#silent-failover-settings");
  await root.locator(".inline-drawer-toggle").click();
  await expect(
    root.getByRole("button", { name: "保存设置", exact: true }),
  ).toBeVisible();
  return root;
}
async function setup(page, mode = "fallback", loop = false) {
  await page.request.post("http://127.0.0.1:9107/control", {
    data: { mode },
    maxRetries: 1,
  });
  const root = await open(page);
  const current = await api(page, "/config");
  await api(page, "/config", {
    ...current,
    enabled: true,
    nativeFirst: false,
    maxRounds: 0,
    notificationMode: "silent",
    floatingWindow: false,
    waitMode: "patient",
    loop,
    intervalSeconds: 1,
    nodes: ["A", "B", "C"].map((name, i) => ({
      name,
      url: `http://127.0.0.1:9107/${name}/v1`,
      key: "test-only-" + name,
      model: "mock-" + name,
      priority: i + 1,
      enabled: true,
    })),
  });
  await api(page, "/records/clear", {});
  await root.getByRole("button", { name: "刷新配置", exact: true }).click();
  await page.locator("#extensions-settings-button .drawer-toggle").click();
  await page.evaluate(async () => {
    const c = SillyTavern.getContext();
    await c.executeSlashCommandsWithOptions("/api quiet=true custom");
    Object.assign(c.chatCompletionSettings, {
      custom_url: "http://127.0.0.1:9107/original/v1",
      custom_model: "original-model",
      custom_include_body: "",
      custom_exclude_body: "",
      custom_include_headers: "",
      stream_openai: false,
      temp_openai: 1,
      openai_max_tokens: 1024,
      openai_max_context: 32768,
    });
    await c.selectCharacterById(0);
  });
  await page.waitForFunction(
    () => SillyTavern.getContext().characterId !== undefined,
  );
  await page.evaluate(() => {
    document
      .querySelectorAll("#toast-container > *")
      .forEach((e) => e.remove());
  });
}
async function generate(page, type = "normal") {
  return page.evaluate(async (type) => {
    try {
      await SillyTavern.getContext().generate(type);
      return "success";
    } catch (e) {
      return e.name;
    }
  }, type);
}

test("diagnostics distinguish quiet requests and export safe browser delivery events", async ({
  page,
}) => {
  await setup(page, "success");
  await generate(page, "quiet");
  await expect
    .poll(async () =>
      (await api(page, "/records"))[0]?.clientEvents?.some(
        (e) => e.stage === "response_prepared",
      ),
    )
    .toBe(true);
  const quiet = (await api(page, "/records"))[0];
  expect(quiet.generation).toBe("quiet");
  expect(quiet.attempts.at(-1).diagnostics.completion.textChars).toBe(9);
  await page.locator("#extensions-settings-button .drawer-toggle").click();
  const root = page.locator("#silent-failover-settings");
  await root.locator("[data-history] > summary").click();
  const download = page.waitForEvent("download");
  await root.getByRole("button", { name: "导出诊断日志" }).click();
  const file = await download;
  const stream = await file.createReadStream();
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString();
  const data = JSON.parse(text);
  expect(data.schema).toBe(2);
  expect(data.browserEvents.some((e) => e.stage === "generation_ended")).toBe(
    true,
  );
  expect(text).not.toContain("test-only-");
  expect(text).not.toContain("完整回复验证通过。");
});

test("one-click update reports restart and handles download failure in the settings panel", async ({
  page,
}) => {
  const root = await open(page);
  await page.route("**/api/plugins/silent-failover/update", (route) =>
    route.fulfill({ json: { state: "updating" } }),
  );
  await page.route("**/api/plugins/silent-failover/update/status", (route) =>
    route.fulfill({
      json: {
        state: "installed",
        installedVersion: "1.3.0",
        restartRequired: true,
      },
    }),
  );
  await root.getByRole("button", { name: "一键更新插件" }).click();
  await expect(root.locator("[data-status]")).toContainText(
    "请重启酒馆后台并刷新页面",
  );
  await page.unroute("**/api/plugins/silent-failover/update/status");
  await page.route("**/api/plugins/silent-failover/update/status", (route) =>
    route.fulfill({
      json: { state: "failed", error: "GitHub 下载失败（HTTP 503）" },
    }),
  );
  await root.getByRole("button", { name: "一键更新插件" }).click();
  await expect(root.locator("[data-status]")).toHaveText(
    "GitHub 下载失败（HTTP 503）",
  );
  await expect(
    root.getByRole("button", { name: "一键更新插件" }),
  ).toBeEnabled();
});
test("real-world global sampling survives a quota failure and Claude fallback", async ({
  page,
}) => {
  await setup(page, "parameters");
  const c = await api(page, "/config");
  await api(page, "/config", {
    ...c,
    nodes: c.nodes.map((n) =>
      n.name === "B"
        ? { ...n, model: "claude-haiku-4-5-20251001", maxTokens: 4096 }
        : n,
    ),
  });
  await page.evaluate(() => {
    const s = SillyTavern.getContext().chatCompletionSettings;
    s.temp_openai = 1.3;
    s.openai_max_tokens = 30000;
    s.openai_max_context = 2000000;
  });
  await page.locator("#send_textarea").fill("浏览器真实参数回归");
  await page.locator("#send_but").click();
  await expect
    .poll(async () => (await api(page, "/records"))[0]?.state)
    .toBe("succeeded");
  await expect(page.locator("#chat .mes_text").last()).toContainText(
    "完整回复验证通过",
  );
  const record = (await api(page, "/records"))[0];
  expect(record.attempts.map((a) => a.node)).toEqual(["A", "B"]);
  expect(record.attempts[0].category).toBe("quota");
  expect(record.attempts[1].adjustments.map((a) => a.parameter)).toEqual([
    "temperature",
  ]);
  const calls = await (
    await page.request.get("http://127.0.0.1:9107/calls")
  ).json();
  expect(calls.calls[1].body).toMatchObject({
    temperature: 1,
    max_tokens: 30000,
  });
  expect(
    await page.evaluate(
      () => SillyTavern.getContext().chatCompletionSettings.temp_openai,
    ),
  ).toBe(1.3);
  expect(
    await page.evaluate(
      () => SillyTavern.getContext().chatCompletionSettings.openai_max_tokens,
    ),
  ).toBe(30000);
  await expect(page.locator("#toast-container .toast-error")).toHaveCount(0);
});
test("installed extension can add/edit/reorder nodes and persists on reload", async ({
  page,
}) => {
  const root = await open(page);
  const current = await api(page, "/config");
  await api(page, "/config", { ...current, nodes: [], enabled: false });
  await root.getByRole("button", { name: "刷新配置", exact: true }).click();
  await root.getByRole("button", { name: "新增节点", exact: true }).click();
  await root.getByLabel("名称", { exact: true }).fill("界面验证节点");
  await root.getByLabel("模型 ID", { exact: true }).fill("test-model");
  await root
    .getByLabel("API 地址", { exact: true })
    .fill("http://127.0.0.1:9107/C/v1");
  await root.getByLabel("API Key", { exact: true }).fill("test-secret-ui");
  await root.getByRole("button", { name: "保存设置", exact: true }).click();
  await expect(root.locator(".sf-node")).toHaveCount(1);
  expect(JSON.stringify(await api(page, "/config"))).not.toContain(
    "test-secret-ui",
  );
  await page.reload();
  await expect(page.locator("#silent-failover-settings .sf-node")).toHaveCount(
    1,
  );
});
test("native send shows only complete fallback reply and no error toast", async ({
  page,
}) => {
  await setup(page);
  await page.locator("#send_textarea").fill("故障转移验证");
  await page.locator("#send_but").click();
  await expect
    .poll(async () => {
      const r = await api(page, "/records");
      return r[0]?.state;
    })
    .toBe("succeeded");
  await expect(page.locator("#chat .mes_text").last()).toContainText(
    "完整回复验证通过",
  );
  await expect(page.locator("#chat")).not.toContainText(
    "DO NOT DISPLAY PARTIAL",
  );
  await expect(page.locator("#toast-container .toast-error")).toHaveCount(0);
  const records = await api(page, "/records");
  expect(records[0].attempts.map((a) => a.node)).toEqual(["A", "B", "C"]);
  expect(JSON.stringify(records)).not.toContain("test-only-A");
});
test("all failures end silently without blank reply; regenerate preserves original", async ({
  page,
}) => {
  await setup(page, "all-fail");
  const before = await page.evaluate(() =>
    SillyTavern.getContext().chat.map((m) => m.mes),
  );
  expect(await generate(page)).toBe("AbortError");
  expect(
    await page.evaluate(() => SillyTavern.getContext().chat.map((m) => m.mes)),
  ).toEqual(before);
  expect(await generate(page, "regenerate")).toBe("AbortError");
  expect(
    await page.evaluate(() => SillyTavern.getContext().chat.map((m) => m.mes)),
  ).toEqual(before);
  await expect(page.locator("#toast-container .toast-error")).toHaveCount(0);
  await expect(page.locator("#send_but")).toBeVisible();
});
test("automatic loop recovers in second round without intermediate notifications", async ({
  page,
}) => {
  await setup(page, "loop", true);
  expect(await generate(page)).toBe("success");
  const records = await api(page, "/records");
  expect(records[0].round).toBe(2);
  expect(records[0].attempts.map((a) => a.node)).toEqual([
    "A",
    "B",
    "C",
    "A",
    "B",
  ]);
  await expect(page.locator("#toast-container .toast-error")).toHaveCount(0);
});
test("stop cancels a pending node and prevents all later attempts", async ({
  page,
}) => {
  await setup(page, "slow", true);
  await page.evaluate(() => {
    window.sfTestGeneration = SillyTavern.getContext()
      .generate("normal")
      .catch((e) => e.name);
  });
  await expect
    .poll(async () => (await api(page, "/records"))[0]?.attemptCount)
    .toBe(1);
  await page.locator("#mes_stop").click();
  await expect
    .poll(async () => (await api(page, "/records"))[0]?.state)
    .toBe("cancelled");
  expect(await page.evaluate(() => window.sfTestGeneration)).toBe("AbortError");
  const response = await page.request.get("http://127.0.0.1:9107/calls");
  expect((await response.json()).calls).toHaveLength(1);
  await expect(page.locator("#toast-container .toast-error")).toHaveCount(0);
});
test("desktop and mobile settings are usable without overflow", async ({
  page,
}) => {
  const root = await open(page);
  await root.getByRole("button", { name: "新增节点", exact: true }).click();
  await page.screenshot({
    path: "artifacts/desktop-settings.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await root.scrollIntoViewIfNeeded();
  await page.screenshot({
    path: "artifacts/mobile-settings.png",
    fullPage: true,
  });
  expect(await root.evaluate((e) => e.scrollWidth <= e.clientWidth + 2)).toBe(
    true,
  );
  await expect(root.getByLabel("API 地址", { exact: true })).toBeVisible();
  const box = await root
    .getByRole("button", { name: "保存设置", exact: true })
    .boundingBox();
  expect(box.width).toBeGreaterThan(100);
  expect(box.height).toBeLessThan(55);
});
test("continue and swipe failures preserve message contents and valid swipe index", async ({
  page,
}) => {
  await setup(page, "all-fail");
  const before = await page.evaluate(() =>
    SillyTavern.getContext().chat.map((m) => m.mes),
  );
  expect(await generate(page, "continue")).toBe("AbortError");
  expect(
    await page.evaluate(() => SillyTavern.getContext().chat.map((m) => m.mes)),
  ).toEqual(before);
  await page.evaluate(async () => {
    try {
      await SillyTavern.getContext().swipe.right();
    } catch (e) {
      if (e.name !== "AbortError") throw e;
    }
  });
  expect(
    await page.evaluate(() => SillyTavern.getContext().chat.map((m) => m.mes)),
  ).toEqual(before);
  expect(
    await page.evaluate(() => {
      const m = SillyTavern.getContext().chat.at(-1);
      return (m.swipe_id ?? 0) < (m.swipes?.length || 1);
    }),
  ).toBe(true);
  await expect(page.locator("#toast-container .toast-error")).toHaveCount(0);
});
test("turning off loop while waiting stops without another round", async ({
  page,
}) => {
  await setup(page, "all-fail", true);
  const c = await api(page, "/config");
  await api(page, "/config", { ...c, intervalSeconds: 30 });
  await page.evaluate(() => {
    window.sfTestGeneration = SillyTavern.getContext()
      .generate("normal")
      .catch((e) => e.name);
  });
  await expect
    .poll(async () => (await api(page, "/records"))[0]?.state)
    .toBe("waiting");
  await api(page, "/config", { ...(await api(page, "/config")), loop: false });
  expect(await page.evaluate(() => window.sfTestGeneration)).toBe("AbortError");
  const r = (await api(page, "/records"))[0];
  expect(r.round).toBe(1);
  expect(r.attemptCount).toBe(3);
  await expect(page.locator("#toast-container .toast-error")).toHaveCount(0);
});
test("refresh preserves original connection and backup routing still works", async ({
  page,
}) => {
  await setup(page, "fallback");
  await Promise.all([
    page.waitForResponse((r) => r.url().endsWith("/api/settings/save")),
    page.evaluate(() => SillyTavern.getContext().saveSettingsDebounced()),
  ]);
  await page.reload();
  await expect(page.locator("#silent-failover-settings")).toBeAttached();
  await page.evaluate(async () => {
    await SillyTavern.getContext().selectCharacterById(0);
  });
  expect(
    await page.evaluate(
      () => SillyTavern.getContext().chatCompletionSettings.custom_url,
    ),
  ).toBe("http://127.0.0.1:9107/original/v1");
  expect(await generate(page)).toBe("success");
  expect((await api(page, "/records"))[0].state).toBe("succeeded");
  await expect(page.locator("#toast-container .toast-error")).toHaveCount(0);
});
test("ordinary API requests pass through the adapter unchanged", async ({
  page,
}) => {
  await open(page);
  const c = await api(page, "/config");
  await api(page, "/config", { ...c, enabled: false });
  let seen = false;
  await page.route("**/api/backends/chat-completions/generate", (route) => {
    seen = true;
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ untouched: true }),
    });
  });
  const result = await page.evaluate(async () => {
    const r = await fetch("/api/backends/chat-completions/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_completion_source: "custom",
        custom_url: "https://another-provider.example/v1",
      }),
    });
    return r.json();
  });
  expect(seen).toBe(true);
  expect(result).toEqual({ untouched: true });
});
test("group chat uses the same silent fallback chain", async ({ page }) => {
  await setup(page, "fallback");
  await page.evaluate(async () => {
    const c = SillyTavern.getContext();
    const name = "FailoverGroup" + Date.now();
    const r = await fetch("/api/groups/create", {
      method: "POST",
      headers: c.getRequestHeaders(),
      body: JSON.stringify({
        name,
        members: [c.characters[0].avatar],
        allow_self_responses: true,
        activation_strategy: 1,
        generation_mode: 0,
      }),
    });
    c.groups.push(await r.json());
    await c.executeSlashCommandsWithOptions("/go " + name);
  });
  await page.waitForFunction(() => !!SillyTavern.getContext().groupId);
  await generate(page);
  expect((await api(page, "/records"))[0].state).toBe("succeeded");
  await expect(page.locator("#chat .mes_text").last()).toContainText(
    "完整回复验证通过",
  );
  await expect(page.locator("#toast-container .toast-error")).toHaveCount(0);
});
test("changing chat cancels the current task without writing to the new chat", async ({
  page,
}) => {
  await setup(page, "slow", true);
  await page.evaluate(() => {
    window.sfTestGeneration = SillyTavern.getContext()
      .generate("normal")
      .catch((e) => e.name);
  });
  await expect
    .poll(async () => (await api(page, "/records"))[0]?.attemptCount)
    .toBe(1);
  await page.evaluate(async () => {
    await SillyTavern.getContext().openCharacterChat(
      "failover-switch-" + Date.now(),
    );
  });
  await expect
    .poll(async () => (await api(page, "/records"))[0]?.state)
    .toBe("cancelled");
  await expect(page.locator("#chat")).not.toContainText("完整回复验证通过");
  await expect(page.locator("#toast-container .toast-error")).toHaveCount(0);
});
test("UI edits and priority changes save automatically", async ({ page }) => {
  const root = await open(page);
  const c = await api(page, "/config");
  await api(page, "/config", {
    ...c,
    enabled: false,
    loop: false,
    nodes: [
      {
        name: "One",
        url: "http://127.0.0.1:9107/C/v1",
        key: "private-ui-key",
        model: "old-model",
        priority: 1,
      },
      {
        name: "Two",
        url: "http://127.0.0.1:9107/B/v1",
        model: "second",
        priority: 2,
      },
    ],
  });
  await root.getByRole("button", { name: "刷新配置", exact: true }).click();
  await root.getByRole("button", { name: "编辑 One", exact: true }).click();
  await root.getByLabel("模型 ID", { exact: true }).fill("new-model");
  await root.getByRole("button", { name: "应用节点", exact: true }).click();
  await expect(root.locator(".sf-node").first()).toContainText("new-model");
  expect((await api(page, "/config")).nodes[0].keySet).toBe(true);
  await root.getByRole("button", { name: "上移 Two", exact: true }).click();
  await expect(root.locator(".sf-node").first()).toContainText("Two");
  await root
    .getByRole("checkbox", { name: "自动循环重试", exact: true })
    .check();
  await expect.poll(async () => (await api(page, "/config")).loop).toBe(true);
  await expect
    .poll(
      async () =>
        (await api(page, "/config")).nodes.find((n) => n.name === "One").model,
    )
    .toBe("new-model");
});

test("draft model lookup and connectivity test work before saving and can be cancelled", async ({
  page,
}) => {
  await page.request.post("http://127.0.0.1:9107/control", {
    data: { mode: "success" },
  });
  const root = await open(page);
  const before = await api(page, "/config");
  await root.getByRole("button", { name: "新增节点", exact: true }).click();
  await root.getByLabel("名称", { exact: true }).fill("Draft test");
  await root
    .getByLabel("API 地址", { exact: true })
    .fill("http://127.0.0.1:9107/C/v1");
  await root.getByRole("button", { name: "获取模型列表", exact: true }).click();
  await expect(root.locator("#sf-model-options option")).toHaveCount(2);
  await root.getByLabel("模型 ID", { exact: true }).fill("mock-C");
  await root
    .getByRole("button", {
      name: "测试当前节点（发送一次 API 请求）",
      exact: true,
    })
    .click();
  await expect(root.locator("[data-test]")).toContainText("测试成功");
  await expect
    .poll(async () => (await api(page, "/config")).nodes.length)
    .toBe(before.nodes.length + 1);
  await page.request.post("http://127.0.0.1:9107/control", {
    data: { mode: "slow" },
  });
  await root
    .getByRole("button", {
      name: "测试当前节点（发送一次 API 请求）",
      exact: true,
    })
    .click();
  await expect(root.locator("[data-test]")).toContainText("测试中");
  await root.getByRole("button", { name: "停止测试", exact: true }).click();
  await expect(root.locator("[data-test]")).toContainText("测试已停止");
  await root.getByRole("button", { name: "撤销修改", exact: true }).click();
  await expect(root.locator("[data-dirty]")).toHaveText("已保存");
});

test("patient mode hides timeouts and limited mode retains saved values", async ({
  page,
}) => {
  const root = await open(page);
  const c = await api(page, "/config");
  await api(page, "/config", { ...c, waitMode: "patient", headerSeconds: 999 });
  await root.getByRole("button", { name: "刷新配置", exact: true }).click();
  const timeouts = root.locator("[data-advanced]").locator("..");
  await expect(timeouts).toBeHidden();
  await root.getByLabel("等待策略", { exact: true }).selectOption("limited");
  await expect(timeouts).toBeVisible();
  await timeouts.locator("summary").click();
  await expect(
    root.getByLabel("完全没回应时等多久（秒，0 不限）", { exact: true }),
  ).toHaveValue("999");
  await root.getByLabel("等待策略", { exact: true }).selectOption("patient");
  await expect(timeouts).toBeHidden();
  await root.getByRole("button", { name: "保存设置", exact: true }).click();
  expect((await api(page, "/config")).headerSeconds).toBe(999);
});

test("model picker shows all eight models independently of the current model and discards stale lookups", async ({
  page,
}) => {
  const root = await open(page);
  const c = await api(page, "/config");
  const ids = [
    "opus-4-6",
    "opus-4-6-thinking",
    "opus-4-7",
    "opus-4-7-thinking",
    "opus-4-8",
    "opus-4-8-thinking",
    "opus-5",
    "opus-5-thinking",
  ];
  let releaseResponse;
  await page.route("**/api/plugins/silent-failover/models", async (route) => {
    if (releaseResponse)
      await new Promise((resolve) => {
        releaseResponse = resolve;
      });
    await route.fulfill({ json: { models: ids, truncated: false } });
  });
  await root.getByRole("button", { name: "新增节点", exact: true }).click();
  await root.getByLabel("模型 ID", { exact: true }).fill(ids[0]);
  await root.getByRole("button", { name: "获取模型列表", exact: true }).click();
  await expect(root.locator("#sf-model-options option")).toHaveCount(8);
  await expect(root.getByLabel("搜索可用模型", { exact: true })).toHaveValue(
    "",
  );
  await root.getByLabel("搜索可用模型", { exact: true }).fill("thinking");
  await expect(root.locator("#sf-model-options option")).toHaveCount(4);
  await root
    .getByLabel("可用模型", { exact: true })
    .selectOption("opus-5-thinking");
  await expect(root.getByLabel("模型 ID", { exact: true })).toHaveValue(
    "opus-5-thinking",
  );
  await root.getByLabel("搜索可用模型", { exact: true }).fill("");
  await expect(root.locator("#sf-model-options option")).toHaveCount(8);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await root
      .locator(".sf-model-picker")
      .evaluate((e) => e.scrollWidth <= e.clientWidth + 1),
  ).toBe(true);
  releaseResponse = true;
  const requested = page.waitForRequest(
    "**/api/plugins/silent-failover/models",
  );
  await root.getByRole("button", { name: "获取模型列表", exact: true }).click();
  await requested;
  await root
    .getByLabel("API 地址", { exact: true })
    .fill("https://changed.example/v1");
  const received = page.waitForResponse(
    "**/api/plugins/silent-failover/models",
  );
  releaseResponse();
  await received;
  await expect(root.locator(".sf-model-picker")).toBeHidden();
  await expect(root.locator("#sf-model-options option")).toHaveCount(0);
  expect((await api(page, "/config")).nodes).toEqual(c.nodes);
});

test("idle API preference applies once to normal generation and survives quiet tasks without saving priorities", async ({
  page,
}) => {
  await setup(page, "success");
  const c = await api(page, "/config");
  await api(page, "/config", { ...c, floatingWindow: true });
  await page.locator("#extensions-settings-button .drawer-toggle").click();
  await page.getByRole("button", { name: "刷新配置", exact: true }).click();
  await page.locator("#extensions-settings-button .drawer-toggle").click();
  const panel = page.locator(".sf-task-panel");
  await expect(panel.getByLabel("切换到 API", { exact: true })).toBeEnabled();
  await panel
    .getByLabel("切换到 API", { exact: true })
    .selectOption(c.nodes.find((n) => n.name === "C").id);
  await panel
    .getByRole("button", { name: "应用于下次生成", exact: true })
    .click();
  await expect(panel.locator(".sf-panel-node")).toHaveText("C");
  await generate(page, "quiet");
  await page.locator("#send_textarea").fill("下次 API 预选验证");
  await page.locator("#send_but").click();
  await expect
    .poll(
      async () =>
        (await api(page, "/records")).find((j) => j.generation !== "quiet")
          ?.state,
    )
    .toBe("succeeded");
  const job = (await api(page, "/records")).find(
    (j) => j.generation !== "quiet",
  );
  expect(job.attempts.map((a) => a.node)).toEqual(["C"]);
  await expect(page.locator("#chat .mes").last()).toContainText(
    "完整回复验证通过",
  );
  await expect(panel.getByLabel("切换到 API", { exact: true })).toHaveValue("");
  await page.locator("#send_textarea").fill("恢复默认优先级验证");
  await page.locator("#send_but").click();
  await expect
    .poll(
      async () =>
        (await api(page, "/records")).filter(
          (j) => j.generation !== "quiet" && j.state === "succeeded",
        ).length,
    )
    .toBe(2);
  expect((await api(page, "/records"))[0].attempts.map((a) => a.node)).toEqual([
    "A",
    "B",
  ]);
  expect((await api(page, "/config")).nodes).toEqual(c.nodes);
});

test("floating panel switches an active API, stops generation and fits mobile", async ({
  page,
}) => {
  await setup(page, "manual", true);
  let c = await api(page, "/config");
  await api(page, "/config", { ...c, floatingWindow: true });
  await page.locator("#extensions-settings-button .drawer-toggle").click();
  await page.getByRole("button", { name: "刷新配置", exact: true }).click();
  await page.locator("#extensions-settings-button .drawer-toggle").click();
  await page.locator("#send_textarea").fill("手动切换完整回复验证");
  await page.locator("#send_but").click();
  await expect
    .poll(async () => (await api(page, "/records"))[0]?.state)
    .toBe("running");
  const job = (await api(page, "/records"))[0];
  const panel = page.locator(".sf-task-panel");
  await expect(panel).toBeVisible();
  await expect(panel.locator(".sf-panel-node")).toHaveText("A");
  await panel
    .getByLabel("切换到 API", { exact: true })
    .selectOption(c.nodes.find((n) => n.name === "C").id);
  await panel.getByRole("button", { name: "切换 API", exact: true }).click();
  await expect
    .poll(async () => (await api(page, "/jobs/" + job.id)).state)
    .toBe("succeeded");
  await expect(panel.locator(".sf-panel-node")).toHaveText("C");
  await expect(page.locator("#chat .mes").last()).toContainText(
    "完整回复验证通过",
  );
  await page.screenshot({ path: "artifacts/floating-desktop.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: "artifacts/floating-mobile.png" });
  expect(await panel.evaluate((e) => e.scrollWidth <= e.clientWidth + 1)).toBe(
    true,
  );
  const bounds = await panel.boundingBox();
  expect(bounds.y).toBeGreaterThanOrEqual(0);
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(844);
  await panel.getByRole("button", { name: "收起悬浮窗" }).click();
  await expect(panel.locator(".sf-panel-body")).toBeHidden();
  await panel.getByRole("button", { name: "展开悬浮窗" }).click();
  const next = await api(page, "/jobs", {
    id: crypto.randomUUID(),
    request: { messages: [{ role: "user", content: "stop task" }] },
  });
  await expect(panel.getByRole("button", { name: "停止生成" })).toBeEnabled();
  await panel.getByRole("button", { name: "停止生成" }).click();
  await expect
    .poll(async () => (await api(page, "/jobs/" + next.id)).state)
    .toBe("cancelled");
});

test("saved round limit ends retries and final-failure mode shows one notice", async ({
  page,
}) => {
  await setup(page, "all-fail", true);
  await page.locator("#extensions-settings-button .drawer-toggle").click();
  const root = page.locator("#silent-failover-settings");
  await root.getByLabel("总轮次上限（0 不限）").fill("2");
  await root.getByLabel("提示方式", { exact: true }).selectOption("failure");
  await root.getByRole("button", { name: "保存设置", exact: true }).click();
  const job = await api(page, "/jobs", {
    id: crypto.randomUUID(),
    request: { messages: [{ role: "user", content: "round test" }] },
  });
  await expect
    .poll(async () => (await api(page, "/jobs/" + job.id)).state)
    .toBe("exhausted");
  expect((await api(page, "/jobs/" + job.id)).attemptCount).toBe(6);
  await expect(page.locator(".sf-task-notice")).toBeVisible();
  await expect(page.locator(".sf-task-notice")).toContainText("本次生成未成功");
  await root.getByLabel("提示方式", { exact: true }).selectOption("silent");
  await root.getByRole("button", { name: "保存设置", exact: true }).click();
  await expect(page.locator(".sf-task-notice")).toBeHidden();
  const c = await api(page, "/config");
  await api(page, "/config", { ...c, maxRounds: 0 });
});
