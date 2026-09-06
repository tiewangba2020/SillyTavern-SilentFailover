import { test, expect } from "@playwright/test";

test("applying and reopening a node retains its pending Key until settings are saved", async ({
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
  await root
    .getByLabel("API Key", { exact: true })
    .fill("test-draft-key-local-only");
  await root.getByRole("button", { name: "应用节点", exact: true }).click();
  const row = root.locator(".sf-node").filter({ hasText: name });
  await expect(row).toContainText("Key 已填写（待保存）");
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
  ).toBe("test-draft-key-local-only");
  await expect(row).toContainText("Key 已保存");
  await page.reload();
  await page.locator("#extensions-settings-button .drawer-toggle").click();
  await root.locator(".inline-drawer-toggle").click();
  await expect(row).toContainText("Key 已保存");
  await row.getByRole("button", { name: `编辑 ${name}`, exact: true }).click();
  await expect(
    root.getByLabel("API Key（留空保留）", { exact: true }),
  ).toHaveValue("");
  // Replacement Keys must also survive another edit before the global save.
  await root
    .getByLabel("API Key（留空保留）", { exact: true })
    .fill("test-replacement-key-local-only");
  await root.getByRole("button", { name: "应用节点", exact: true }).click();
  await expect(row).toContainText("Key 已填写（待保存）");
  await row.getByRole("button", { name: `编辑 ${name}`, exact: true }).click();
  const replacement = page.waitForRequest(
    (r) => r.url().endsWith("/silent-failover/config") && r.method() === "POST",
  );
  await root.getByRole("button", { name: "保存设置", exact: true }).click();
  expect(
    (await replacement).postDataJSON().nodes.find((n) => n.name === name).key,
  ).toBe("test-replacement-key-local-only");
  await expect(row).toContainText("Key 已保存");
});
