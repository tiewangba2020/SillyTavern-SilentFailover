import { test, expect } from "@playwright/test";

async function setup(page) {
  await page.goto("/");
  await expect(page.locator("#silent-failover-settings")).toBeAttached();
  await page.evaluate(async () => {
    const path = "/api/plugins/silent-failover/config";
    const headers = SillyTavern.getContext().getRequestHeaders();
    const config = await (await fetch(path, { headers })).json();
    await fetch(path, {
      method: "POST",
      headers,
      body: JSON.stringify({
        ...config,
        enabled: true,
        floatingWindow: false,
        nodes: [
          {
            id: "touch-test",
            name: "Touch Test",
            model: "mock-C",
            url: "http://127.0.0.1:9107/C/v1",
            enabled: true,
          },
        ],
      }),
    });
  });
  await page.reload();
  await page.locator("#extensions-settings-button .drawer-toggle").click();
  const root = page.locator("#silent-failover-settings");
  await root.locator(".inline-drawer-toggle").click();
  return root;
}

for (const width of [320, 390, 1024]) {
  test.describe(`touch controls at ${width}px`, () => {
    test.use({
      viewport: { width, height: 900 },
      hasTouch: true,
      isMobile: true,
    });
    test("actions are readable without hover and work by touch", async ({
      page,
    }) => {
      const root = await setup(page);
      for (const name of [
        "新增节点",
        "保存设置",
        "刷新配置",
        "撤销修改",
        "显示任务悬浮窗",
        "一键更新插件",
      ]) {
        const button = root.getByRole("button", { name, exact: true });
        await expect(button.locator(".sf-action-label")).toBeVisible();
        const box = await button.boundingBox();
        expect(box.height).toBeGreaterThanOrEqual(44);
        expect(box.x + box.width).toBeLessThanOrEqual(width);
      }
      const row = root.locator(".sf-node");
      for (const label of ["上移", "下移", "编辑", "测试", "删除"])
        await expect(row.getByText(label, { exact: true })).toBeVisible();
      await row
        .getByRole("button", { name: "编辑 Touch Test", exact: true })
        .tap();
      await expect(
        root
          .getByRole("button", { name: "测试当前节点（发送一次 API 请求）" })
          .getByText("测试连接"),
      ).toBeVisible();
      await root
        .getByRole("button", { name: "获取模型列表", exact: true })
        .tap();
      await expect(root.locator("#sf-model-options option")).not.toHaveCount(0);
      await root.getByRole("button", { name: "取消编辑", exact: true }).tap();
      await expect(root.locator(".sf-editor")).toHaveCount(0);
      await row
        .getByRole("button", { name: "删除 Touch Test", exact: true })
        .tap();
      await expect(page.locator("dialog[open]")).toContainText("删除节点");
      await page.keyboard.press("Escape");
      await expect(row).toHaveCount(1);
      // Oversized element screenshots reset Chromium's touch emulation; capture the viewport.
      await root
        .getByRole("button", { name: "新增节点", exact: true })
        .scrollIntoViewIfNeeded();
      await page.screenshot({ path: `artifacts/touch-settings-${width}.png` });
      await root
        .getByRole("button", { name: "显示任务悬浮窗", exact: true })
        .tap();
      const panel = page.locator(".sf-task-panel");
      for (const name of ["收起悬浮窗", "关闭悬浮窗", "停止生成"]) {
        const button = panel.getByRole("button", { name, exact: true });
        await expect(button.locator(".sf-action-label")).toBeVisible();
        const box = await button.boundingBox();
        expect(box.height).toBeGreaterThanOrEqual(44);
        expect(box.width).toBeGreaterThanOrEqual(44);
      }
      await panel
        .getByLabel("切换到 API", { exact: true })
        .selectOption("touch-test");
      await panel
        .getByRole("button", { name: "应用于下次生成", exact: true })
        .tap();
      await expect(panel.locator(".sf-panel-node")).toHaveText("Touch Test");
      await panel.screenshot({ path: `artifacts/touch-floating-${width}.png` });
      await panel
        .getByRole("button", { name: "收起悬浮窗", exact: true })
        .tap();
      await expect(panel.locator(".sf-panel-body")).toBeHidden();
      const collapsed = await panel.boundingBox();
      expect(collapsed.width).toBe(52);
      expect(collapsed.height).toBe(52);
      await panel
        .getByRole("button", { name: "展开悬浮窗", exact: true })
        .tap();
      await expect(panel.locator(".sf-panel-body")).toBeVisible();
      await panel
        .getByRole("button", { name: "收起悬浮窗", exact: true })
        .tap();
      const touch = await page.context().newCDPSession(page);
      await touch.send("Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints: [{ x: collapsed.x + 26, y: collapsed.y + 26 }],
      });
      await touch.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ x: 40, y: 240 }],
      });
      await touch.send("Input.dispatchTouchEvent", {
        type: "touchEnd",
        touchPoints: [],
      });
      await touch.detach();
      await expect(panel.locator(".sf-panel-body")).toBeHidden();
      expect((await panel.boundingBox()).x).toBe(8);
      await expect(
        panel.getByRole("button", { name: "关闭悬浮窗" }),
      ).toBeHidden();
      await panel.screenshot({
        path: `artifacts/touch-collapsed-${width}.png`,
      });
      await panel
        .getByRole("button", { name: "展开悬浮窗", exact: true })
        .tap();
      await expect(panel.locator(".sf-panel-body")).toBeVisible();
      await panel
        .getByRole("button", { name: "关闭悬浮窗", exact: true })
        .tap();
      await expect(panel).toBeHidden();
    });
  });
}

test("desktop retains compact icons and keyboard operation", async ({
  page,
}) => {
  const root = await setup(page);
  const add = root.getByRole("button", { name: "新增节点", exact: true });
  await expect(add.locator(".sf-action-label")).toBeHidden();
  await expect(
    root
      .getByRole("button", { name: "保存设置", exact: true })
      .locator(".sf-action-label"),
  ).toBeVisible();
  await add.focus();
  await page.keyboard.press("Enter");
  await expect(root.locator(".sf-editor")).toBeVisible();
});
