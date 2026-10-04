import { test, expect } from "@playwright/test";
test.use({
  baseURL: "http://failover.test:8017",
  launchOptions: {
    args: [
      "--host-resolver-rules=MAP failover.test 127.0.0.1",
      "--no-proxy-server",
    ],
  },
  viewport: { width: 390, height: 844 },
  hasTouch: true,
  isMobile: true,
});
test("HTTP LAN origin can add/save/test a node and receive a real SillyTavern chat reply", async ({
  page,
}) => {
  await page.request.post("http://127.0.0.1:9107/control", {
    data: { mode: "success" },
  });
  await page.goto("/");
  await expect(page.locator("#silent-failover-settings")).toBeAttached();
  expect(await page.evaluate(() => isSecureContext)).toBe(false);
  expect(await page.evaluate(() => typeof crypto.randomUUID)).toBe("undefined");
  await page.evaluate(async () => {
    const path = "/api/plugins/silent-failover/config";
    const headers = SillyTavern.getContext().getRequestHeaders();
    const config = await (await fetch(path, { headers })).json();
    const response = await fetch(path, {
      method: "POST",
      headers,
      body: JSON.stringify({
        ...config,
        enabled: true,
        nativeFirst: false,
        loop: false,
        floatingWindow: false,
        nodes: [],
      }),
    });
    if (!response.ok) throw Error("Config initialization failed");
  });
  await page.reload();
  await page.locator("#extensions-settings-button .drawer-toggle").click();
  const root = page.locator("#silent-failover-settings");
  await root.locator(".inline-drawer-toggle").click();
  await expect(root.locator("[data-status]")).toContainText("已连接");
  await root.getByRole("button", { name: "新增节点", exact: true }).click();
  await root.getByLabel("名称", { exact: true }).fill("LAN test node");
  await root
    .getByLabel("API 地址", { exact: true })
    .fill("http://127.0.0.1:9107/C/v1");
  await root.getByLabel("API Key", { exact: true }).fill("test-only-lan-key");
  await root.getByLabel("模型 ID", { exact: true }).fill("mock-C");
  await expect(root.locator("[data-dirty]")).toContainText("已自动保存");
  await root
    .getByRole("button", {
      name: "测试当前节点（发送一次 API 请求）",
      exact: true,
    })
    .click();
  await expect(root.locator("[data-test]")).toContainText("测试成功");
  await root.getByRole("button", { name: "应用节点", exact: true }).click();
  await root.getByRole("button", { name: "保存设置", exact: true }).click();
  await page.locator("#extensions-settings-button .drawer-toggle").click();
  await page.evaluate(async () => {
    const c = SillyTavern.getContext();
    await c.executeSlashCommandsWithOptions("/api quiet=true custom");
    Object.assign(c.chatCompletionSettings, {
      custom_url: "http://127.0.0.1:9107/original/v1",
      custom_model: "original",
      custom_include_body: "",
      custom_exclude_body: "",
      custom_include_headers: "",
      stream_openai: false,
    });
    await c.selectCharacterById(0);
  });
  await page.locator("#send_textarea").fill("局域网生成验证");
  await page.locator("#send_but").click();
  await expect(page.locator("#chat .mes_text").last()).toContainText(
    "完整回复验证通过",
  );
  await page.screenshot({ path: "artifacts/lan-http-chat.png" });
});
