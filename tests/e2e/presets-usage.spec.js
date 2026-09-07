import { test, expect } from "@playwright/test";
const api = (page, path, body) =>
  page.evaluate(
    async ({ path, body }) => {
      const response = await fetch("/api/plugins/silent-failover" + path, {
        method: body === undefined ? "GET" : "POST",
        headers: SillyTavern.getContext().getRequestHeaders(),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (!response.ok) throw Error(await response.text());
      return response.json();
    },
    { path, body },
  );
async function open(page) {
  await page.goto("/");
  await expect(page.locator("#silent-failover-settings")).toBeAttached();
  const current = await api(page, "/config");
  await api(page, "/config", {
    ...current,
    enabled: true,
    nativeFirst: false,
    loop: false,
    floatingWindow: false,
    nodes: [],
  });
  await page.reload();
  await page.locator("#extensions-settings-button .drawer-toggle").click();
  const root = page.locator("#silent-failover-settings");
  await root.locator(".inline-drawer-toggle").click();
  return root;
}
test("automatic saves retain keys, rapid edits and copied presets without changing the host connection", async ({
  page,
}) => {
  const root = await open(page);
  const native = await page.evaluate(() =>
    JSON.stringify(SillyTavern.getContext().chatCompletionSettings),
  );
  await root.getByRole("button", { name: "新增节点", exact: true }).click();
  await root.getByLabel("名称", { exact: true }).fill("Auto node");
  await root
    .getByLabel("API 地址", { exact: true })
    .fill("http://127.0.0.1:9107/C/v1");
  await root.getByLabel("API Key", { exact: true }).fill("test-only-autosave");
  await expect(root.locator("[data-dirty]")).toContainText("尚未填完整");
  expect((await api(page, "/config")).nodes).toHaveLength(0);
  await root.getByLabel("模型 ID", { exact: true }).fill("mock-C");
  await expect
    .poll(async () => (await api(page, "/config")).nodes[0]?.keySet)
    .toBe(true);
  await expect(root.getByLabel("API Key", { exact: true })).toHaveValue("");
  await root.getByLabel("模型 ID", { exact: true }).fill("mock-updated");
  await expect
    .poll(async () => (await api(page, "/config")).nodes[0]?.model)
    .toBe("mock-updated");
  await root.getByRole("button", { name: "应用节点", exact: true }).click();
  await page.route("**/api/plugins/silent-failover/config", async (route) => {
    if (route.request().method() === "POST")
      await new Promise((resolve) => setTimeout(resolve, 400));
    await route.continue();
  });
  const rounds = root.locator('[name="maxRounds"]');
  await rounds.fill("2");
  const pending = page.waitForRequest(
    (r) => r.url().endsWith("/silent-failover/config") && r.method() === "POST",
  );
  await pending;
  await rounds.fill("7");
  await expect.poll(async () => (await api(page, "/config")).maxRounds).toBe(7);
  await expect(root.locator("[data-dirty]")).toContainText("保存");
  await page.unroute("**/api/plugins/silent-failover/config");
  const original = await api(page, "/config");
  await root.getByRole("button", { name: "复制预设", exact: true }).click();
  await page.locator(".popup-input").fill("Copy " + Date.now());
  await page.locator(".popup-button-ok").click();
  await expect
    .poll(async () => (await api(page, "/config")).activePresetId)
    .not.toBe(original.activePresetId);
  const copy = await api(page, "/config");
  expect(copy.nodes[0].keySet).toBe(true);
  await root.locator('[name="maxRounds"]').fill("3");
  await expect.poll(async () => (await api(page, "/config")).maxRounds).toBe(3);
  await root
    .getByRole("button", { name: "显示任务悬浮窗", exact: true })
    .click();
  await expect
    .poll(async () => (await api(page, "/config")).floatingWindow)
    .toBe(true);
  await page
    .locator(".sf-task-panel")
    .getByLabel("切换预设", { exact: true })
    .selectOption(original.activePresetId);
  await expect.poll(async () => (await api(page, "/config")).maxRounds).toBe(7);
  expect(
    await page.evaluate(() =>
      JSON.stringify(SillyTavern.getContext().chatCompletionSettings),
    ),
  ).toBe(native);
  await page.reload();
  expect((await api(page, "/config")).nodes[0].keySet).toBe(true);
});

test("NEW is quiet and usage survives interrupted attempts and reaches the host stream", async ({
  page,
}) => {
  await page.route("**/api/plugins/silent-failover/update/check", (route) =>
    route.fulfill({ json: { latestVersion: "9.0.0", available: true } }),
  );
  const root = await open(page);
  await expect(
    root.locator(".inline-drawer-header [data-new-version]"),
  ).toBeVisible();
  await expect(page.locator("#toast-container .toast")).toHaveCount(0);
  const current = await api(page, "/config");
  await api(page, "/config", {
    ...current,
    nodes: ["A", "B", "C"].map((name, i) => ({
      name,
      model: "mock",
      key: "test-only-" + name,
      url: `http://127.0.0.1:9107/${name}/v1`,
      priority: i,
      stream: true,
    })),
  });
  await root.getByRole("button", { name: "刷新配置", exact: true }).click();
  await page.request.post("http://127.0.0.1:9107/control", {
    data: { mode: "usage-partial" },
  });
  const response = await page.evaluate(async () => {
    const r = await fetch("/api/backends/chat-completions/generate", {
      method: "POST",
      headers: SillyTavern.getContext().getRequestHeaders(),
      body: JSON.stringify({
        chat_completion_source: "custom",
        stream: true,
        messages: [{ role: "user", content: "mock usage" }],
      }),
    });
    return r.text();
  });
  expect(response).toContain('"prompt_tokens":100');
  expect(response).toContain('"completion_tokens":20');
  expect(response).not.toContain("DO NOT DISPLAY PARTIAL");
  const record = (await api(page, "/records"))[0];
  expect(record.attempts[0].diagnostics.usage).toBeUndefined();
  expect(record.attempts[1].diagnostics.usagePartial).toBe(true);
  expect(record.attempts[1].diagnostics.usage.outputTokens).toBe(5);
  expect(record.attempts[2].diagnostics.usage.outputTokens).toBe(20);
  await root.locator("[data-history] summary").click();
  await root.getByRole("button", { name: "刷新记录", exact: true }).click();
  await root
    .locator("[data-records] details")
    .first()
    .locator("summary")
    .click();
  await expect(root.locator("[data-records] details").first()).toContainText(
    "Token · 输入 100",
  );
});

test("mobile preset selector fits and the collapsed panel remains a circle", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const root = await open(page);
  await root
    .getByRole("button", { name: "显示任务悬浮窗", exact: true })
    .click();
  const panel = page.locator(".sf-task-panel");
  await expect(panel.getByLabel("切换预设")).toBeVisible();
  await page.screenshot({ path: "artifacts/presets-mobile.png" });
  const box = await panel.boundingBox();
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(390);
  await panel.getByRole("button", { name: "收起悬浮窗" }).click();
  const bubble = await panel.boundingBox();
  expect(bubble.width).toBeLessThanOrEqual(54);
  expect(bubble.height).toBeLessThanOrEqual(54);
  await page.screenshot({ path: "artifacts/presets-mobile-collapsed.png" });
});

test("a failed automatic save keeps the draft and manual save retries it", async ({
  page,
}) => {
  const root = await open(page);
  const before = await api(page, "/config");
  await page.route("**/api/plugins/silent-failover/config", async (route) => {
    if (route.request().method() === "POST")
      await route.fulfill({ status: 503, json: { error: "模拟网络保存失败" } });
    else await route.continue();
  });
  await root.locator('[name="maxRounds"]').fill("9");
  await expect(root.locator("[data-dirty]")).toContainText("模拟网络保存失败");
  expect((await api(page, "/config")).maxRounds).toBe(before.maxRounds);
  await expect(root.locator('[name="maxRounds"]')).toHaveValue("9");
  await page.unroute("**/api/plugins/silent-failover/config");
  await root.getByRole("button", { name: "保存设置", exact: true }).click();
  await expect.poll(async () => (await api(page, "/config")).maxRounds).toBe(9);
});

test("switching presets in the floating panel keeps an active request and lets the user stop it", async ({
  page,
}) => {
  const root = await open(page);
  let current = await api(page, "/config");
  await api(page, "/config", {
    ...current,
    floatingWindow: true,
    nodes: [
      {
        name: "slow node",
        url: "http://127.0.0.1:9107/C/v1",
        model: "mock",
        key: "test-only",
      },
    ],
  });
  current = await api(page, "/config");
  const originalId = current.activePresetId;
  const copy = await api(page, "/presets", {
    action: "copy",
    name: "Switch running " + Date.now(),
    revision: current.revision,
  });
  await api(page, "/presets", {
    action: "activate",
    id: originalId,
    revision: copy.revision,
  });
  await root.getByRole("button", { name: "刷新配置", exact: true }).click();
  await page.request.post("http://127.0.0.1:9107/control", {
    data: { mode: "slow" },
  });
  const id = "preset-active-" + Date.now();
  await api(page, "/jobs", {
    id,
    request: { messages: [{ role: "user", content: "local mock" }] },
  });
  const panel = page.locator(".sf-task-panel");
  await expect(panel).toHaveAttribute("data-state", "running");
  await panel.getByLabel("切换预设").selectOption(copy.activePresetId);
  await expect
    .poll(async () => (await api(page, "/config")).activePresetId)
    .toBe(copy.activePresetId);
  expect((await api(page, "/jobs/" + id)).state).toBe("running");
  await expect(panel).toContainText("新预设用于下次");
  await panel.getByRole("button", { name: "停止生成", exact: true }).click();
  await expect
    .poll(async () => (await api(page, "/jobs/" + id)).state)
    .toBe("cancelled");
});
