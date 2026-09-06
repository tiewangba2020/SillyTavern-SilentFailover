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
    root.getByRole("button", { name: "仅使用备用节点", exact: true }),
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
  await root
    .getByRole("button", { name: "仅使用备用节点", exact: true })
    .click();
  await expect(root.locator("[data-status]")).toHaveText("已使用故障转移连接");
  await page.locator("#extensions-settings-button .drawer-toggle").click();
  await page.evaluate(async () => {
    const c = SillyTavern.getContext();
    Object.assign(c.chatCompletionSettings, { temp_openai: 1, openai_max_tokens: 1024, openai_max_context: 32768 });
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
test("real-world global sampling survives a quota failure and Claude fallback", async ({ page }) => {
  await setup(page, "parameters");
  const c = await api(page, "/config");
  await api(page, "/config", { ...c, nodes: c.nodes.map(n => n.name === "B" ? { ...n, model: "claude-haiku-4-5-20251001", maxTokens: 4096 } : n) });
  await page.evaluate(() => { const s=SillyTavern.getContext().chatCompletionSettings; s.temp_openai=1.3; s.openai_max_tokens=30000; s.openai_max_context=2000000; });
  await page.locator("#send_textarea").fill("浏览器真实参数回归");
  await page.locator("#send_but").click();
  await expect.poll(async () => (await api(page, "/records"))[0]?.state).toBe("succeeded");
  await expect(page.locator("#chat .mes_text").last()).toContainText("完整回复验证通过");
  const record=(await api(page, "/records"))[0];
  expect(record.attempts.map(a=>a.node)).toEqual(["A", "B"]);
  expect(record.attempts[0].category).toBe("quota");
  expect(record.attempts[1].adjustments.map(a=>a.parameter)).toEqual(["temperature", "max_tokens"]);
  const calls=await (await page.request.get("http://127.0.0.1:9107/calls")).json();
  expect(calls.calls[1].body).toMatchObject({temperature:1,max_tokens:4096});
  expect(await page.evaluate(()=>SillyTavern.getContext().chatCompletionSettings.temp_openai)).toBe(1.3);
  expect(await page.evaluate(()=>SillyTavern.getContext().chatCompletionSettings.openai_max_tokens)).toBe(30000);
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
  await root.getByRole("button", { name: "保存节点", exact: true }).click();
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
    .getByRole("button", { name: "仅使用备用节点", exact: true })
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
  await api(page, "/config", { ...c, loop: false });
  expect(await page.evaluate(() => window.sfTestGeneration)).toBe("AbortError");
  const r = (await api(page, "/records"))[0];
  expect(r.round).toBe(1);
  expect(r.attemptCount).toBe(3);
  await expect(page.locator("#toast-container .toast-error")).toHaveCount(0);
});
test("refresh preserves installed configuration and dedicated connection still works", async ({
  page,
}) => {
  await setup(page, "fallback");
  await page.waitForTimeout(1200);
  await page.reload();
  await expect(page.locator("#silent-failover-settings")).toBeAttached();
  await page.evaluate(async () => {
    await SillyTavern.getContext().selectCharacterById(0);
  });
  expect(
    await page.evaluate(
      () => SillyTavern.getContext().chatCompletionSettings.custom_url,
    ),
  ).toBe("http://sillytavern-failover.invalid/v1");
  expect(await generate(page)).toBe("success");
  await expect(page.locator("#toast-container .toast-error")).toHaveCount(0);
});
test("ordinary API requests pass through the adapter unchanged", async ({
  page,
}) => {
  await open(page);
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
test("UI edits and priority changes persist; loop switch is immediate", async ({
  page,
}) => {
  const root = await open(page);
  const c = await api(page, "/config");
  await api(page, "/config", {
    ...c,
    enabled: false,
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
  await root.getByRole("button", { name: "保存节点", exact: true }).click();
  await expect(root.locator(".sf-node").first()).toContainText("new-model");
  expect((await api(page, "/config")).nodes[0].keySet).toBe(true);
  await root.getByRole("button", { name: "上移 Two", exact: true }).click();
  await expect(root.locator(".sf-node").first()).toContainText("Two");
  await root
    .getByRole("checkbox", { name: "自动循环重试", exact: true })
    .check();
  await expect.poll(async () => (await api(page, "/config")).loop).toBe(true);
});
