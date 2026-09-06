import { test, expect } from "@playwright/test";
async function api(page, path, body, prefix = "/api/plugins/silent-failover") {
  return page.evaluate(
    async ({ path, body, prefix }) => {
      const r = await fetch(prefix + path, {
        method: body === undefined ? "GET" : "POST",
        headers: SillyTavern.getContext().getRequestHeaders(),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (!r.ok) throw Error(await r.text());
      return r.json();
    },
    { path, body, prefix },
  );
}
async function setup(page, source = "custom", mode = "success", stream = true) {
  await page.request.post("http://127.0.0.1:9108/control", { data: { mode } });
  await page.request.post("http://127.0.0.1:9107/control", {
    data: { mode: "fallback" },
  });
  await page.goto("/");
  await expect(page.locator("#silent-failover-settings")).toBeAttached();
  if (await page.locator(".popup-button-ok:visible").count())
    await page.locator(".popup-button-ok:visible").click();
  await api(
    page,
    "/write",
    { key: "api_key_custom", value: "mock-native-key", label: "Native test" },
    "/api/secrets",
  );
  const c = await api(page, "/config");
  expect(c.nativeAvailable).toBe(true);
  await api(page, "/config", {
    ...c,
    enabled: true,
    nativeFirst: true,
    loop: false,
    intervalSeconds: 1,
    nodes: [
      {
        id: "backup",
        name: "Backup",
        url: "http://127.0.0.1:9107/C/v1",
        key: "mock-backup-key",
        model: "backup",
        enabled: true,
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
      custom_url: "http://127.0.0.1:9108/v1",
      custom_model: "native-test",
      custom_include_body: "",
      custom_include_headers: "",
      custom_exclude_body: "",
      n: 1,
      temp_openai: 1,
      openai_max_tokens: 1024,
      openai_max_context: 32768,
      stream_openai: false,
    });
    document.getElementById("api_button_openai").click();
    await c.selectCharacterById(0);
  });
  await expect(page.locator("#send_but")).toBeVisible();
  await page.evaluate(
    ({ source, stream }) => {
      const c = SillyTavern.getContext();
      Object.assign(c.chatCompletionSettings, {
        chat_completion_source: source,
        openai_model: "gpt-4o-mini",
        claude_model: "claude-sonnet-4-5",
        google_model: "gemini-2.5-flash",
        reverse_proxy: source === "custom" ? "" : "http://127.0.0.1:9108/v1",
        proxy_password: "mock-proxy-key",
        stream_openai: stream,
        use_sysprompt: true,
        enable_web_search: false,
        request_images: false,
        function_calling: false,
      });
      document
        .querySelectorAll("#toast-container > *")
        .forEach((e) => e.remove());
    },
    { source, stream },
  );
}
async function generate(page) {
  await page.evaluate(() => {
    window.nativeDone = false;
    window.nativeGeneration = SillyTavern.getContext()
      .generate("normal")
      .then(
        () => "success",
        (e) => e.name,
      )
      .then((value) => {
        window.nativeDone = true;
        return value;
      });
  });
  await expect
    .poll(
      async () => {
        if (
          await page
            .getByText("Connecting To Proxy", { exact: true })
            .isVisible()
        )
          await page.locator(".popup-button-ok:visible").click();
        return page.evaluate(() => window.nativeDone);
      },
      { timeout: 40000 },
    )
    .toBe(true);
  return page.evaluate(() => window.nativeGeneration);
}
for (const source of ["custom", "openai", "claude", "makersuite"]) {
  for (const stream of [true, false]) {
    test(`${source} native ${stream ? "SSE" : "JSON"} succeeds without backup`, async ({
      page,
    }) => {
      await setup(page, source, "success", stream);
      expect(await generate(page)).toBe("success");
      await expect(page.locator("#chat .mes_text").last()).toContainText(
        "Native complete OK",
      );
      const records = await api(page, "/records");
      expect(records[0].attemptCount).toBe(1);
      expect(records[0].attempts[0].node).toBe("酒馆原生连接");
      expect(JSON.stringify(records)).not.toContain("mock-proxy-key");
      const calls = await (
        await page.request.get("http://127.0.0.1:9108/calls")
      ).json();
      expect(calls).toHaveLength(1);
      if (source === "claude") {
        expect(calls[0].claudeKey).toBe("mock-proxy-key");
        expect(calls[0].version).toBe("2023-06-01");
        expect(calls[0].body.system).toBeDefined();
      }
      if (source === "makersuite") {
        expect(calls[0].geminiKey).toBe("mock-proxy-key");
        expect(calls[0].body.contents).toBeDefined();
      }
      if (source === "custom")
        expect(calls[0].bearer).toBe("Bearer mock-native-key");
      await expect(page.locator("#toast-container .toast-error")).toHaveCount(
        0,
      );
    });
  }
  test(`${source} native error silently falls back across protocols`, async ({
    page,
  }) => {
    await setup(page, source, "fail");
    expect(await generate(page)).toBe("success");
    await expect(page.locator("#chat .mes_text").last()).toContainText(
      "完整回复验证通过",
    );
    expect(
      (await api(page, "/records"))[0].attempts.map((a) => a.node),
    ).toEqual(["酒馆原生连接", "Backup"]);
    await expect(page.locator("#toast-container .toast-error")).toHaveCount(0);
  });
}
test("native stream interruptions are discarded; all failures restore chat silently", async ({
  page,
}) => {
  await setup(page, "claude", "partial");
  expect(await generate(page)).toBe("success");
  await expect(page.locator("#chat .mes_text").last()).not.toContainText(
    "Native complete OK",
  );
  expect((await api(page, "/records"))[0].attempts[0].category).toBe(
    "interrupted",
  );
  await page.request.post("http://127.0.0.1:9108/control", {
    data: { mode: "fail" },
  });
  await page.request.post("http://127.0.0.1:9107/control", {
    data: { mode: "all-fail" },
  });
  const before = await page.evaluate(() =>
    SillyTavern.getContext().chat.map((m) => m.mes),
  );
  expect(await generate(page)).toBe("AbortError");
  expect(
    await page.evaluate(() => SillyTavern.getContext().chat.map((m) => m.mes)),
  ).toEqual(before);
  await expect(page.locator("#toast-container .toast-error")).toHaveCount(0);
});
test("native model and active key update on next request, and disabled plugin passes through", async ({
  page,
}) => {
  await setup(page);
  expect(await generate(page)).toBe("success");
  await api(
    page,
    "/write",
    { key: "api_key_custom", value: "changed-native-key" },
    "/api/secrets",
  );
  await page.evaluate(() => {
    SillyTavern.getContext().chatCompletionSettings.custom_model =
      "new-native-model";
  });
  expect(await generate(page)).toBe("success");
  const calls = await (
    await page.request.get("http://127.0.0.1:9108/calls")
  ).json();
  expect(calls[1].body.model).toBe("new-native-model");
  expect(calls[1].bearer).toBe("Bearer changed-native-key");
  const c = await api(page, "/config");
  await api(page, "/config", { ...c, enabled: false });
  let passthrough = false;
  await page.route("**/api/backends/chat-completions/generate", (route) => {
    passthrough = true;
    return route.fulfill({ json: { original: true } });
  });
  const r = await api(
    page,
    "/generate",
    {
      chat_completion_source: "custom",
      custom_url: "http://127.0.0.1:9108/v1",
    },
    "/api/backends/chat-completions",
  );
  expect(passthrough).toBe(true);
  expect(r).toEqual({ original: true });
});
test("native first repeats each round and can be cancelled by disabling linkage", async ({
  page,
}) => {
  await setup(page, "makersuite", "recover");
  await page.request.post("http://127.0.0.1:9107/control", {
    data: { mode: "all-fail" },
  });
  const c = await api(page, "/config");
  await api(page, "/config", { ...c, loop: true });
  expect(await generate(page)).toBe("success");
  expect((await api(page, "/records"))[0].attempts.map((a) => a.node)).toEqual([
    "酒馆原生连接",
    "Backup",
    "酒馆原生连接",
  ]);
  await page.request.post("http://127.0.0.1:9108/control", {
    data: { mode: "slow" },
  });
  await page.evaluate(() => {
    window.nativePending = SillyTavern.getContext()
      .generate("normal")
      .catch((e) => e.name);
  });
  await expect
    .poll(async () => (await api(page, "/records"))[0].state)
    .toBe("running");
  await api(page, "/config", { ...c, nativeFirst: false });
  expect(await page.evaluate(() => window.nativePending)).toBe("AbortError");
});
test("backup nodes can use Claude and Gemini native protocols", async ({
  page,
}) => {
  await setup(page, "custom", "success");
  const c = await api(page, "/config");
  for (const protocol of ["claude", "gemini"]) {
    await api(page, "/config", {
      ...c,
      nodes: [
        {
          id: "native-backup",
          name: protocol,
          protocol,
          url: "http://127.0.0.1:9108/v1",
          model:
            protocol === "claude" ? "claude-sonnet-4-5" : "gemini-2.5-flash",
          key: "backup-native-secret",
        },
      ],
    });
    const j = await api(page, "/test", { nodeId: "native-backup" });
    await expect
      .poll(async () => (await api(page, "/jobs/" + j.id)).state)
      .toBe("succeeded");
  }
});

test("OpenAI error then Claude interruption recovers on Gemini", async ({
  page,
}) => {
  await setup(page, "custom", "chain");
  const c = await api(page, "/config");
  await api(page, "/config", {
    ...c,
    nodes: [
      {
        id: "claude",
        name: "Claude",
        protocol: "claude",
        url: "http://127.0.0.1:9108/v1",
        model: "claude-sonnet-4-5",
        key: "claude-test",
        priority: 1,
      },
      {
        id: "gemini",
        name: "Gemini",
        protocol: "gemini",
        url: "http://127.0.0.1:9108",
        model: "gemini-2.5-flash",
        key: "gemini-test",
        priority: 2,
      },
    ],
  });
  expect(await generate(page)).toBe("success");
  const record = (await api(page, "/records"))[0];
  expect(record.attempts.map((a) => a.state)).toEqual([
    "failed",
    "failed",
    "succeeded",
  ]);
  expect(record.attempts[1].category).toBe("interrupted");
  const calls = await (
    await page.request.get("http://127.0.0.1:9108/calls")
  ).json();
  expect(calls.map((c) => c.protocol)).toEqual(["openai", "claude", "gemini"]);
  expect(calls[1].claudeKey).toBe("claude-test");
  expect(calls[1].bearer).toBeUndefined();
  expect(calls[2].geminiKey).toBe("gemini-test");
  expect(calls[2].claudeKey).toBeUndefined();
  await expect(page.locator("#toast-container .toast-error")).toHaveCount(0);
});

test("linkage UI preserves native connection across mode changes and reload", async ({
  page,
}) => {
  await setup(page);
  await page.locator("#extensions-settings-button .drawer-toggle").click();
  const root = page.locator("#silent-failover-settings");
  await root.locator(".inline-drawer-toggle").click();
  await expect(root.locator(".sf-native")).toContainText("native-test");
  await root.getByLabel("启用 酒馆原生 API", { exact: true }).uncheck();
  await root.getByRole("button", { name: "保存设置", exact: true }).click();
  await expect(
    root.getByLabel("启用 酒馆原生 API", { exact: true }),
  ).not.toBeChecked();
  await root.getByLabel("启用 酒馆原生 API", { exact: true }).check();
  await root.getByRole("button", { name: "保存设置", exact: true }).click();
  await expect(root.locator("[data-status]")).toHaveText("设置已保存");
  expect(
    await page.evaluate(
      () => SillyTavern.getContext().chatCompletionSettings.custom_url,
    ),
  ).toBe("http://127.0.0.1:9108/v1");
  await Promise.all([
    page.waitForResponse((r) => r.url().endsWith("/api/settings/save")),
    page.evaluate(() => SillyTavern.getContext().saveSettingsDebounced()),
  ]);
  await page.reload();
  await expect(root.locator(".sf-native")).toContainText("native-test");
  await page.locator("#extensions-settings-button .drawer-toggle").click();
  await root.locator(".inline-drawer-toggle").click();
  await page.screenshot({
    path: "artifacts/native-desktop.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: "artifacts/native-mobile.png",
    fullPage: true,
  });
  expect(await root.evaluate((e) => e.scrollWidth <= e.clientWidth + 1)).toBe(
    true,
  );
  await root.getByRole("button", { name: "新增节点", exact: true }).click();
  await root.getByLabel("API 协议", { exact: true }).selectOption("gemini");
  await expect(root.getByLabel("API 协议", { exact: true })).toHaveValue(
    "gemini",
  );
});
