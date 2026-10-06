// 复现用户反馈的场景：「织幕·外置组件」(m61-oss/st-end-component-generator) 与
// 「API还没挂」同时启用。覆盖四件事：
//   1. 两个扩展能同时加载，互不干扰；
//   2. 织幕开着的时候，酒馆主生成仍然由本插件接管并正常交付；
//   3. 织幕自己借道酒馆接口（ChatCompletionService）的请求必须原样放行，
//      不能被改道到故障转移节点，否则它自己配的地址、Key、模型会全部失效；
//   4. 轮询期间拿到 404 会先重试，不再把一次已经成功的生成直接判死。
import { test, expect } from "@playwright/test";

const API = "/api/plugins/silent-failover";
const MOCK = "http://127.0.0.1:9107";
const FAILOVER_NODES = ["A", "B", "C"];

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

async function setup(page, mode = "success") {
  await page.request.post(`${MOCK}/control`, { data: { mode } });
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
    loop: false,
    intervalSeconds: 1,
    nodes: FAILOVER_NODES.map((name, i) => ({
      name,
      url: `${MOCK}/${name}/v1`,
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
    document.querySelectorAll("#toast-container > *").forEach((e) => e.remove());
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

test("织幕·外置组件与「API还没挂」同时启用时都能正常加载", async ({ page }) => {
  const failures = [];
  page.on("pageerror", (e) => failures.push(String(e)));
  page.on("console", (m) => {
    if (m.type() === "error") failures.push(m.text());
  });

  await page.goto("/");
  await page.waitForFunction(
    () => !!window.SillyTavern?.getContext().characters.length,
  );

  // 本插件
  await expect(page.locator("#silent-failover-settings")).toBeAttached();
  // 织幕：样式表与魔法棒菜单按钮都是它 init() 里同步挂上去的
  // （悬浮球 #st-esg-ball 默认 ballVisible=false，默认不显示，不能当加载标志）
  await expect(page.locator("#st-end-component-generator-style")).toBeAttached();
  await expect(page.locator("#st-esg-menu-button")).toBeAttached();

  // 织幕的样式表必须真的取得到——只装 index.js 不装 style.css 时这里会 404，
  // 表现成「扩展好像加载了但界面全乱」，容易被误判成两个插件打架。
  const styleStatus = await page.evaluate(async () => {
    const link = document.getElementById("st-end-component-generator-style");
    return (await fetch(link.href)).status;
  });
  expect(styleStatus).toBe(200);

  // 织幕自己会在没有「织幕快捷键」快捷回复集时抛一个未处理的 rejection，
  // 与本次改动无关，单独放行，其余错误一律算失败。
  const unexpected = failures.filter(
    (t) =>
      !/favicon|ERR_ABORTED/.test(t) &&
      !/No quick reply set with name/.test(t),
  );
  expect(unexpected, "页面出现了脚本错误").toEqual([]);
});

test("织幕开着时，酒馆主生成仍由插件接管并交付成功", async ({ page }) => {
  await setup(page, "success");
  expect(await generate(page, "normal")).toBe("success");

  await expect
    .poll(async () => (await api(page, "/records"))[0]?.state)
    .toBe("succeeded");
  await expect(page.locator("#chat .mes_text").last()).toContainText(
    "完整回复验证通过",
  );

  // 记录本身必须来自酒馆主生成，而不是被别的扩展借道触发的
  const record = (await api(page, "/records"))[0];
  expect(["normal", "regenerate"]).toContain(record.generation);
  // 节点 A 是模拟上游里固定失败的节点，说明故障转移链真的跑起来了
  expect(record.attempts.map((a) => a.node)).toEqual(["A", "B"]);
  // 织幕全程在页面上，没有被卸掉
  await expect(page.locator("#st-esg-menu-button")).toBeAttached();
});

test("织幕自己借道酒馆接口的请求原样放行，不被改道到故障转移节点", async ({
  page,
}) => {
  await setup(page, "success");
  const before = (await api(page, "/records")).length;

  // 清空模拟上游的调用记录，只观察织幕这一次请求
  await page.request.post(`${MOCK}/control`, { data: { mode: "success" } });

  const content = await page.evaluate(async () => {
    // 这就是织幕在「自带 API 配置」模式下走的路径：
    // ChatCompletionService.processRequest → fetch('/api/backends/chat-completions/generate')
    const ctx = SillyTavern.getContext();
    const response = await ctx.ChatCompletionService.processRequest(
      {
        stream: false,
        messages: [{ role: "user", content: "织幕借道酒馆接口" }],
        model: "original-model",
        chat_completion_source: "custom",
        max_tokens: 128,
        temperature: 0.7,
        custom_url: "http://127.0.0.1:9107/original/v1",
        custom_include_body: "",
        custom_exclude_body: "",
        custom_include_headers: "",
      },
      {},
      true,
    );
    return (
      response?.content ??
      response?.result?.choices?.[0]?.message?.content ??
      null
    );
  });

  // 请求真的到了织幕自己配的那个地址，而不是插件的节点
  expect(content).toContain("完整回复验证通过");
  const { calls } = await (await page.request.get(`${MOCK}/calls`)).json();
  expect(calls.map((c) => c.node)).toEqual(["original"]);
  expect(
    calls.filter((c) => FAILOVER_NODES.includes(c.node)),
    "织幕的请求被改道到了故障转移节点",
  ).toEqual([]);

  // 插件也不应该为它建任务、写记录
  expect((await api(page, "/records")).length).toBe(before);
});

test("轮询期间拿到 404 会先重试，不会把已经成功的生成判死", async ({
  page,
}) => {
  await setup(page, "success");

  let forced = 0;
  await page.route("**/api/plugins/silent-failover/jobs/*", async (route) => {
    const { pathname } = new URL(route.request().url());
    if (route.request().method() === "GET" && /\/jobs\/[^/]+$/.test(pathname)) {
      forced++;
      if (forced <= 2)
        return route.fulfill({
          status: 404,
          contentType: "application/json",
          body: JSON.stringify({
            error: "任务不存在或已结束",
            code: "job_not_found",
          }),
        });
    }
    return route.continue();
  });

  expect(await generate(page, "normal")).toBe("success");
  await expect(page.locator("#chat .mes_text").last()).toContainText(
    "完整回复验证通过",
  );
  expect(forced, "至少要有两次 404 被真的喂进去").toBeGreaterThanOrEqual(3);
  await expect
    .poll(async () => (await api(page, "/records"))[0]?.state)
    .toBe("succeeded");
});

test("织幕的请求与酒馆主生成并发时，两边各走各的配置", async ({ page }) => {
  await setup(page, "success");
  const before = (await api(page, "/records")).length;
  await page.request.post(`${MOCK}/control`, { data: { mode: "success" } });

  const rounds = await page.evaluate(async () => {
    const ctx = SillyTavern.getContext();
    const askExtension = () =>
      ctx.ChatCompletionService.processRequest(
        {
          stream: false,
          messages: [{ role: "user", content: "织幕并发请求" }],
          model: "original-model",
          chat_completion_source: "custom",
          max_tokens: 128,
          temperature: 0.7,
          custom_url: "http://127.0.0.1:9107/original/v1",
          custom_include_body: "",
          custom_exclude_body: "",
          custom_include_headers: "",
        },
        {},
        true,
      );
    const out = [];
    for (let i = 0; i < 3; i++) {
      // 同时发出：主生成走插件，织幕走它自己的地址。
      const [main, ext] = await Promise.allSettled([
        ctx.generate("normal"),
        askExtension(),
      ]);
      out.push({
        main: main.status,
        ext: ext.status,
        content:
          ext.status === "fulfilled"
            ? (ext.value?.content ??
              ext.value?.result?.choices?.[0]?.message?.content ??
              null)
            : String(ext.reason),
      });
    }
    return out;
  });

  for (const [i, r] of rounds.entries()) {
    expect(r.main, `第 ${i + 1} 轮主生成`).toBe("fulfilled");
    expect(r.ext, `第 ${i + 1} 轮织幕请求`).toBe("fulfilled");
    expect(r.content, `第 ${i + 1} 轮织幕拿到回复`).toContain(
      "完整回复验证通过",
    );
  }

  const { calls } = await (await page.request.get(`${MOCK}/calls`)).json();
  // 织幕的请求一次都没有落到故障转移节点上
  const leaked = calls
    .filter((c) => FAILOVER_NODES.includes(c.node))
    .filter((c) => JSON.stringify(c.body?.messages ?? []).includes("织幕并发请求"));
  expect(leaked, "织幕的请求被改道到了故障转移节点").toEqual([]);
  expect(calls.filter((c) => c.node === "original").length).toBe(3);
  // 只有主生成建了任务
  expect((await api(page, "/records")).length).toBe(before + 3);
});

test("结果确实已被服务端清理时，面板说出真实原因", async ({ page }) => {
  await setup(page, "success");

  // 服务端已经结束任务、正文也清掉了，只剩落盘记录：回 200 + evicted，
  // 而不是 404。1.5.2 在这里只会给一句「服务端连接不可用或请求无效」。
  await page.route("**/api/plugins/silent-failover/jobs/*", async (route) => {
    const { pathname } = new URL(route.request().url());
    if (route.request().method() === "GET" && /\/jobs\/[^/]+$/.test(pathname))
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          id: "gone",
          state: "succeeded",
          evicted: true,
        }),
      });
    return route.continue();
  });

  await generate(page, "normal");
  await page.locator("#extensions-settings-button .drawer-toggle").click();
  const status = page.locator("#silent-failover-settings [data-status]");
  await expect(status).toContainText("结果已被服务端清理");
  await expect(status).toContainText("重新生成");
  // 不能再把这种情况说成「没装服务端」
  await expect(status).not.toContainText("未找到插件服务端");
});
