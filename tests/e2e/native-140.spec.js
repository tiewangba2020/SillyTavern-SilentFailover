import { test, expect } from "@playwright/test";

async function api(page, path, body) {
  return page.evaluate(
    async ({ path, body }) => {
      const r = await fetch("/api/plugins/silent-failover" + path, {
        method: body === undefined ? "GET" : "POST",
        headers: SillyTavern.getContext().getRequestHeaders(),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (!r.ok) throw Error(await r.text());
      return r.json();
    },
    { path, body },
  );
}
async function setup(page, nativeFirst = false) {
  await page.request.post("http://127.0.0.1:9107/control", {
    data: { mode: "success" },
  });
  await page.goto("/");
  await page.waitForFunction(
    () => SillyTavern.getContext().characters.length > 0,
  );
  await expect(page.locator("#silent-failover-settings")).toBeAttached();
  await api(page, "/config", {
    ...(await api(page, "/config")),
    enabled: true,
    nativeFirst,
    autoCompleteUrl: true,
    floatingWindow: false,
    loop: false,
    nodes: [
      {
        id: "backup-140",
        name: "Backup 140",
        url: "http://127.0.0.1:9107/C/v1",
        model: "mock-C",
        stream: false,
      },
    ],
  });
  await api(page, "/records/clear", {});
  await page.reload();
  await expect(page.locator("#silent-failover-settings")).toBeAttached();
  await page.evaluate(async () => {
    const c = SillyTavern.getContext();
    await c.executeSlashCommandsWithOptions("/api quiet=true custom");
    Object.assign(c.chatCompletionSettings, {
      custom_url: "http://127.0.0.1:9107/original/v1",
      custom_model: "original-model",
      stream_openai: true,
      custom_include_headers: "",
      custom_include_body: "",
      custom_exclude_body: "",
      temp_openai: 1,
      openai_max_tokens: 2048,
      openai_max_context: 32768,
    });
    await c.selectCharacterById(0);
  });
}
async function openPanel(page) {
  await page.locator("#extensions-settings-button .drawer-toggle").click();
  const root = page.locator("#silent-failover-settings");
  await root.locator(".inline-drawer-toggle").click();
  return root;
}
const values = (page) =>
  page.evaluate(() => {
    const s = SillyTavern.getContext().chatCompletionSettings;
    return {
      source: s.chat_completion_source,
      url: s.custom_url,
      model: s.custom_model,
      stream: s.stream_openai,
    };
  });

for (const nativeFirst of [false, true]) {
  test(`custom connection settings survive upgrade and backups reply (native first: ${nativeFirst})`, async ({
    page,
  }) => {
    await setup(page, nativeFirst);
    const custom = {
      custom_include_body: "top_k: 20",
      custom_exclude_body: "- frequency_penalty",
      custom_include_headers: "X-Native-Only: private-test-value",
    };
    await page.evaluate(
      (custom) =>
        Object.assign(SillyTavern.getContext().chatCompletionSettings, custom),
      custom,
    );
    await page.evaluate(() => SillyTavern.getContext().generate("normal"));
    const records = await api(page, "/records");
    const job = records[0];
    expect(job.state).toBe("succeeded");
    expect(job.attempts.map((a) => a.node)).toEqual(
      nativeFirst ? ["酒馆原生连接", "Backup 140"] : ["Backup 140"],
    );
    if (nativeFirst) expect(job.attempts[0].category).toBe("configuration");
    await expect(page.locator("#chat .mes").last()).toContainText(
      "完整回复验证通过",
    );
    expect(
      await page.evaluate(
        (keys) =>
          Object.fromEntries(
            keys.map((k) => [
              k,
              SillyTavern.getContext().chatCompletionSettings[k],
            ]),
          ),
        Object.keys(custom),
      ),
    ).toEqual(custom);
    expect(JSON.stringify(records)).not.toContain("private-test-value");
  });
}

test("native-only routing works without rewriting settings even when original status is offline", async ({
  page,
}) => {
  await setup(page, true);
  await api(page, "/config", { ...(await api(page, "/config")), nodes: [] });
  const root = await openPanel(page);
  await root.getByRole("button", { name: "刷新配置", exact: true }).click();
  await page.locator("#extensions-settings-button .drawer-toggle").click();
  const before = await values(page);
  await page.evaluate(async () =>
    (await import("/script.js")).setOnlineStatus("no_connection"),
  );
  await expect
    .poll(() => page.evaluate(() => SillyTavern.getContext().onlineStatus))
    .not.toBe("no_connection");
  await page.evaluate(() => SillyTavern.getContext().generate("normal"));
  const job = (await api(page, "/records"))[0];
  expect(job.state).toBe("succeeded");
  expect(job.attempts.map((a) => a.node)).toEqual(["酒馆原生连接"]);
  expect(await values(page)).toEqual(before);
});

test("temporary config lookup failure cannot send an opted-out original API request", async ({
  page,
}) => {
  await setup(page);
  await page.route("**/api/plugins/silent-failover/config", (route) =>
    route.abort(),
  );
  await page.evaluate(() => SillyTavern.getContext().generate("normal"));
  const job = (await api(page, "/records"))[0];
  expect(job.state).toBe("succeeded");
  expect(job.attempts.map((a) => a.node)).toEqual(["Backup 140"]);
});

test("backup-only generation and native list opt-out never rewrite connection settings or model discovery", async ({
  page,
}) => {
  await setup(page);
  const before = await values(page);
  const root = await openPanel(page);
  await expect(root.locator(".sf-native")).toContainText("流式请求");
  await expect(root.locator(".sf-node")).toContainText("非流式请求");
  await expect(
    root.getByRole("button", { name: "仅使用备用节点", exact: true }),
  ).toHaveCount(0);
  await root.getByLabel("启用 酒馆原生 API", { exact: true }).check();
  await root.getByRole("button", { name: "保存设置", exact: true }).click();
  await root.getByLabel("启用 酒馆原生 API", { exact: true }).uncheck();
  await root.getByRole("button", { name: "保存设置", exact: true }).click();
  expect(await values(page)).toEqual(before);
  await page.route("**/api/backends/chat-completions/status", (r) =>
    r.fulfill({ json: { data: [{ id: "original-1" }, { id: "original-2" }] } }),
  );
  expect(
    await page.evaluate(async () =>
      (
        await fetch("/api/backends/chat-completions/status", {
          method: "POST",
          body: JSON.stringify({ chat_completion_source: "custom" }),
        })
      ).json(),
    ),
  ).toEqual({ data: [{ id: "original-1" }, { id: "original-2" }] });
  await page.locator("#extensions-settings-button .drawer-toggle").click();
  await page.evaluate(() => SillyTavern.getContext().generate("normal"));
  const job = (await api(page, "/records"))[0];
  expect(job.state).toBe("succeeded");
  expect(job.attempts.map((a) => a.node)).toEqual(["Backup 140"]);
  await expect(page.locator("#chat .mes").last()).toContainText(
    "完整回复验证通过",
  );
  expect(await values(page)).toEqual(before);
});

test("unconfigured original API is recorded as failed and backups still reply", async ({
  page,
}) => {
  await setup(page, true);
  await page.evaluate(() =>
    Object.assign(SillyTavern.getContext().chatCompletionSettings, {
      custom_url: "",
      custom_model: "",
    }),
  );
  await page.evaluate(() => SillyTavern.getContext().generate("normal"));
  const job = (await api(page, "/records"))[0];
  expect(job.state).toBe("succeeded");
  expect(job.attempts.map((a) => a.node)).toEqual([
    "酒馆原生连接",
    "Backup 140",
  ]);
  expect(job.attempts[0].category).toBe("configuration");
  expect((await values(page)).url).toBe("");
});

test("URL completion toggle, stream labels and removed output cap behave in the editor", async ({
  page,
}) => {
  await setup(page);
  const root = await openPanel(page);
  await root.getByRole("button", { name: "新增节点", exact: true }).click();
  await root.getByLabel("名称", { exact: true }).fill("Bare URL");
  await root
    .getByLabel("API 地址", { exact: true })
    .fill("https://example.com");
  await root.getByLabel("模型 ID", { exact: true }).fill("example-model");
  await expect(root.locator("[name=maxTokens]")).toHaveCount(0);
  await root.getByRole("button", { name: "应用节点", exact: true }).click();
  await expect(
    root.locator(".sf-node").filter({ hasText: "Bare URL" }),
  ).toContainText("https://example.com/v1");
  await root.getByLabel("自动补全 API 地址", { exact: true }).uncheck();
  await root
    .getByRole("button", { name: "编辑 Bare URL", exact: true })
    .click();
  await root
    .getByLabel("API 地址", { exact: true })
    .fill("https://example.com/custom");
  await root.getByLabel("上游使用流式请求", { exact: true }).uncheck();
  await root.getByRole("button", { name: "保存设置", exact: true }).click();
  expect(
    (await api(page, "/config")).nodes.find((n) => n.name === "Bare URL"),
  ).toMatchObject({ url: "https://example.com/custom", stream: false });
  await expect(
    root.locator(".sf-node").filter({ hasText: "Bare URL" }),
  ).toContainText("非流式请求");
});

test("legacy dedicated connection restores its saved native values on upgrade", async ({
  page,
}) => {
  await setup(page);
  await Promise.all([
    page.waitForResponse((r) => r.url().endsWith("/api/settings/save")),
    page.evaluate(() => {
      const c = SillyTavern.getContext();
      c.extensionSettings.silent_failover = {
        previous: {
          api: "custom",
          values: {
            custom_url: "https://restored.example/v1",
            custom_model: "restored-model",
            stream_openai: true,
          },
        },
      };
      Object.assign(c.chatCompletionSettings, {
        custom_url: "http://sillytavern-failover.invalid/v1",
        custom_model: "failover-default",
        stream_openai: false,
      });
      c.saveSettingsDebounced();
    }),
  ]);
  await page.reload();
  await expect
    .poll(() => values(page))
    .toEqual({
      source: "custom",
      url: "https://restored.example/v1",
      model: "restored-model",
      stream: true,
    });
  expect(
    await page.evaluate(
      () =>
        SillyTavern.getContext().extensionSettings.silent_failover?.previous,
    ),
  ).toBeUndefined();
});
