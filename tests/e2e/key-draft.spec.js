import { test, expect } from "@playwright/test";

test.use({
  viewport: { width: 390, height: 844 },
  hasTouch: true,
  isMobile: true,
});

test("mobile clipboard Keys automatically save and survive blank re-edits", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.locator("#silent-failover-settings")).toBeAttached();
  await page.locator("#extensions-settings-button .drawer-toggle").click();
  const root = page.locator("#silent-failover-settings");
  await root.locator(".inline-drawer-toggle").click();
  await root.getByRole("button", { name: "新增节点", exact: true }).click();
  const name = `Key draft ${Date.now()}`;
  await root.getByLabel("名称", { exact: true }).fill(name);
  await root
    .getByLabel("API 地址", { exact: true })
    .fill("http://127.0.0.1:9107/C/v1");
  await root.getByLabel("模型 ID", { exact: true }).fill("mock-C");
  const key = root.getByLabel("API Key", { exact: true });
  await expect(key).toHaveAttribute("type", "text");
  await expect(key).toHaveAttribute("autocomplete", "off");
  await expect(key).toHaveAttribute("autocapitalize", "none");
  await expect(key).toHaveAttribute("autocorrect", "off");
  await expect(key).toHaveAttribute("spellcheck", "false");
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.evaluate(() =>
    navigator.clipboard.writeText("test-draft-key-local-only"),
  );
  await key.tap();
  await page.keyboard.press("ControlOrMeta+V");
  await expect(key).toHaveValue("test-draft-key-local-only");
  await root.getByRole("button", { name: "应用节点", exact: true }).click();
  const row = root.locator(".sf-node").filter({ hasText: name });
  await expect(row).toContainText("Key 已保存");
  await row.getByRole("button", { name: `编辑 ${name}`, exact: true }).click();
  await expect(
    root.getByLabel("API Key（留空保留）", { exact: true }),
  ).toHaveValue("");
  await root.getByLabel("模型 ID", { exact: true }).fill("mock-new");
  const saveRequest = page.waitForRequest(
    (r) => r.url().endsWith("/silent-failover/config") && r.method() === "POST",
  );
  await root.getByRole("button", { name: "保存设置", exact: true }).click();
  expect(
    (await saveRequest).postDataJSON().nodes.find((n) => n.name === name).key,
  ).toBe("");
  await expect(row).toContainText("Key 已保存");
  await page.reload();
  await page.locator("#extensions-settings-button .drawer-toggle").click();
  await root.locator(".inline-drawer-toggle").click();
  await expect(row).toContainText("Key 已保存");
  await row.getByRole("button", { name: `编辑 ${name}`, exact: true }).click();
  await expect(
    root.getByLabel("API Key（留空保留）", { exact: true }),
  ).toHaveValue("");
  // Replacement Keys save automatically; subsequent blank edits retain them.
  await root
    .getByLabel("API Key（留空保留）", { exact: true })
    .fill("test-replacement-key-local-only");
  await root.getByRole("button", { name: "应用节点", exact: true }).click();
  await expect(row).toContainText("Key 已保存");
  await row.getByRole("button", { name: `编辑 ${name}`, exact: true }).click();
  const replacement = page.waitForRequest(
    (r) => r.url().endsWith("/silent-failover/config") && r.method() === "POST",
  );
  await root.getByRole("button", { name: "保存设置", exact: true }).click();
  expect(
    (await replacement).postDataJSON().nodes.find((n) => n.name === name).key,
  ).toBe("");
  await expect(row).toContainText("Key 已保存");
});
