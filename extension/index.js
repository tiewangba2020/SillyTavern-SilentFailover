import { API, ENDPOINT, installAdapter } from "./adapter.js";
const ctx = () => SillyTavern.getContext();
const STATES = {
  running: "尝试中",
  waiting: "等待下一轮",
  succeeded: "成功",
  failed: "失败",
  exhausted: "本轮已耗尽",
  cancelled: "已取消",
  invalid: "未执行",
};
let bridge, root, config, refreshTimer, snapshot;
const localRecords = [];
const subscriptions = [];
const el = (tag, props = {}, text) => {
  const e = document.createElement(tag);
  Object.assign(e, props);
  if (text !== undefined) e.textContent = text;
  return e;
};
function button(icon, label, fn) {
  const b = el("button", {
    type: "button",
    className: "menu_button sf-icon",
    title: label,
  });
  b.setAttribute("aria-label", label);
  b.append(el("i", { className: `fa-solid fa-${icon}` }));
  b.onclick = fn;
  return b;
}
function message(text) {
  root.querySelector("[data-status]").textContent = text;
}
async function guarded(fn) {
  try {
    await fn();
  } catch (e) {
    message(e.message || "操作失败");
  }
}
function selected() {
  const c = ctx();
  return (
    c.mainApi === "openai" &&
    c.chatCompletionSettings.custom_url === ENDPOINT &&
    c.chatCompletionSettings.chat_completion_source === "custom"
  );
}
function nativeSelected() {
  const c = ctx();
  return (
    config?.enabled &&
    config?.nativeFirst &&
    c.mainApi === "openai" &&
    ["custom", "openai", "claude", "makersuite"].includes(
      c.chatCompletionSettings.chat_completion_source,
    ) &&
    !selected()
  );
}
async function setNativeFirst(value) {
  if (value) {
    if (!config.nativeAvailable)
      throw new Error("服务端不支持原生联动，请更新并重启酒馆");
    if (selected()) await restore();
    const c = ctx();
    if (
      c.mainApi !== "openai" ||
      !["custom", "openai", "claude", "makersuite"].includes(
        c.chatCompletionSettings.chat_completion_source,
      ) ||
      selected()
    )
      throw new Error(
        "请先选择 Custom、OpenAI、Claude 或 Google AI Studio 连接",
      );
  }
  bridge.cancel("connection_changed");
  await saveConfig({ nativeFirst: value, ...(value ? { enabled: true } : {}) });
  document.getElementById("api_button_openai")?.click();
  message(value ? "已联动原生连接" : "已关闭原生连接联动");
}
async function connect() {
  bridge.cancel("connection_changed");
  const c = ctx();
  const settings = c.chatCompletionSettings;
  if (!selected()) {
    const saved = await c.executeSlashCommandsWithOptions("/api quiet=true");
    c.extensionSettings.silent_failover = {
      previous: {
        api: saved.pipe,
        values: Object.fromEntries(
          [
            "custom_url",
            "custom_model",
            "stream_openai",
            "custom_include_body",
            "custom_exclude_body",
            "custom_include_headers",
          ].map((k) => [k, settings[k]]),
        ),
      },
    };
  }
  Object.assign(settings, {
    custom_url: ENDPOINT,
    custom_model: "failover-default",
    stream_openai: false,
    custom_include_body: "",
    custom_exclude_body: "",
    custom_include_headers: "",
  });
  config.enabled = true;
  config.nativeFirst = false;
  config = await bridge.api("/config", config);
  await c.executeSlashCommandsWithOptions("/api quiet=true custom");
  for (const [id, value] of [
    ["custom_api_url_text", ENDPOINT],
    ["custom_model_id", "failover-default"],
  ]) {
    const field = document.getElementById(id);
    if (field) {
      field.value = value;
      field.dispatchEvent(new Event("input", { bubbles: true }));
    }
  }
  const stream = document.getElementById("stream_toggle");
  if (stream) {
    stream.checked = false;
    stream.dispatchEvent(new Event("change", { bubbles: true }));
  }
  document.getElementById("api_button_openai")?.click();
  c.saveSettingsDebounced();
  render();
  message("已使用故障转移连接");
}
async function restore() {
  bridge.cancel("connection_changed");
  const c = ctx();
  const previous = c.extensionSettings.silent_failover?.previous;
  if (!previous) {
    message("没有已保存的原连接");
    return;
  }
  Object.assign(c.chatCompletionSettings, previous.values);
  c.saveSettingsDebounced();
  if (c.CONNECT_API_MAP[previous.api])
    await c.executeSlashCommandsWithOptions(`/api quiet=true ${previous.api}`);
  delete c.extensionSettings.silent_failover.previous;
  c.saveSettingsDebounced();
  message("已恢复原连接");
}
function labelInput(label, key, value, type = "text", extra = {}) {
  const box = el("label", { className: "sf-field" });
  box.append(el("span", {}, label));
  const input = el("input", { type, value: value ?? "", name: key, ...extra });
  input.classList.add("text_pole");
  box.append(input);
  return box;
}
function editor(
  node = {
    name: "",
    url: "",
    model: "",
    priority: config.nodes.length + 1,
    enabled: true,
    stream: true,
  },
) {
  const area = root.querySelector("[data-editor]");
  area.replaceChildren();
  const form = el("form", { className: "sf-editor" });
  form.append(el("strong", {}, node.id ? "编辑节点" : "新增节点"));
  const fields = el("div", { className: "sf-fields" });
  const protocolField = el("label", { className: "sf-field" });
  const protocol = el("select", { name: "protocol", className: "text_pole" });
  protocol.setAttribute("aria-label", "API 协议");
  for (const [value, name] of [
    ["openai", "OpenAI / 兼容接口"],
    ["claude", "Claude 原生"],
    ["gemini", "Gemini 原生"],
  ])
    protocol.append(
      el(
        "option",
        { value, selected: (node.protocol || "openai") === value },
        name,
      ),
    );
  protocolField.append(el("span", {}, "API 协议"), protocol);
  fields.append(protocolField);
  fields.append(
    labelInput("名称", "name", node.name, "text", {
      required: true,
      maxLength: 100,
    }),
    labelInput("模型 ID", "model", node.model, "text", {
      required: true,
      maxLength: 200,
    }),
    labelInput("API 地址", "url", node.url, "url", {
      required: true,
      placeholder: "https://api.example.com/v1",
    }),
    labelInput(
      node.keySet ? "API Key（留空保留）" : "API Key",
      "key",
      "",
      "password",
      { autocomplete: "new-password" },
    ),
    labelInput("优先级", "priority", node.priority, "number", {
      min: 0,
      max: 99999,
      required: true,
    }),
    labelInput("节点输出上限", "maxTokens", node.maxTokens, "number", {
      min: 1,
      max: 2000000,
      step: 1,
      placeholder: "跟随酒馆",
    }),
  );
  const stream = el("label", { className: "sf-check" });
  const streamInput = el("input", {
    type: "checkbox",
    name: "stream",
    checked: node.stream !== false,
  });
  stream.append(streamInput, document.createTextNode("上游使用流式请求"));
  fields.append(stream);
  form.append(fields);
  const actions = el("div", { className: "sf-actions" });
  const save = el(
    "button",
    { type: "submit", className: "menu_button" },
    "保存节点",
  );
  actions.append(
    save,
    button("xmark", "取消编辑", () => area.replaceChildren()),
  );
  form.append(actions);
  form.onsubmit = (e) => {
    e.preventDefault();
    void guarded(async () => {
      save.disabled = true;
      try {
        const data = new FormData(form);
        const updated = {
          ...node,
          name: data.get("name"),
          url: data.get("url"),
          model: data.get("model"),
          protocol: data.get("protocol"),
          key: data.get("key"),
          priority: Number(data.get("priority")),
          maxTokens:
            data.get("maxTokens") === "" ? null : Number(data.get("maxTokens")),
          stream: streamInput.checked,
        };
        const nodes = [...config.nodes];
        const i = nodes.findIndex((n) => n.id === node.id);
        if (i >= 0) nodes[i] = updated;
        else nodes.push(updated);
        config = await bridge.api("/config", { ...config, nodes });
        area.replaceChildren();
        render();
        message("节点已保存");
      } finally {
        save.disabled = false;
      }
    });
  };
  area.append(form);
  form.querySelector("input").focus();
}
async function saveConfig(changes) {
  const updated = await bridge.api("/config", { ...config, ...changes });
  config = { ...config, ...updated };
  render();
}
function renderNative() {
  const area = root.querySelector("[data-native]");
  area.replaceChildren();
  if (!config?.nativeFirst) return;
  const settings = ctx().chatCompletionSettings;
  const source = settings.chat_completion_source;
  const supported =
    ctx().mainApi === "openai" &&
    ["custom", "openai", "claude", "makersuite"].includes(source) &&
    !selected();
  const row = el("div", { className: "sf-native" });
  const text = el("div", { className: "sf-node-text" });
  text.append(el("strong", {}, "首选 · 酒馆原生连接"));
  if (supported) {
    const model =
      settings[
        {
          custom: "custom_model",
          openai: "openai_model",
          claude: "claude_model",
          makersuite: "google_model",
        }[source]
      ];
    const url =
      source === "custom"
        ? settings.custom_url
        : settings.reverse_proxy ||
          {
            openai: "https://api.openai.com/v1",
            claude: "https://api.anthropic.com/v1",
            makersuite: "https://generativelanguage.googleapis.com",
          }[source];
    text.append(
      el("span", {}, model || "未选择模型"),
      el("small", { className: "sf-muted" }, url || "未设置地址"),
      el("small", { className: "sf-muted" }, "使用酒馆当前密钥"),
    );
  } else {
    text.append(
      el(
        "span",
        {},
        "当前连接不支持联动：支持 Custom、OpenAI、Claude、Google AI Studio",
      ),
    );
  }
  row.append(el("i", { className: "fa-solid fa-link" }), text);
  area.append(row);
}
function render() {
  if (!config) return;
  const controls = root.querySelector("[data-controls]");
  controls.replaceChildren();
  for (const [key, label] of [
    ["enabled", "启用故障转移"],
    ["loop", "自动循环重试"],
  ]) {
    const wrap = el("label", { className: "sf-check" });
    const input = el("input", { type: "checkbox", checked: config[key] });
    input.setAttribute("aria-label", label);
    input.onchange = () =>
      void guarded(() => saveConfig({ [key]: input.checked }));
    wrap.append(input, document.createTextNode(label));
    controls.append(wrap);
  }
  const native = el("label", { className: "sf-check" });
  const nativeInput = el("input", {
    type: "checkbox",
    checked: config.nativeFirst,
  });
  nativeInput.setAttribute("aria-label", "原生连接优先");
  nativeInput.onchange = () =>
    void guarded(async () => {
      try {
        await setNativeFirst(nativeInput.checked);
      } finally {
        render();
      }
    });
  native.append(nativeInput, document.createTextNode("原生连接优先"));
  controls.append(native);
  renderNative();
  const interval = labelInput(
    "轮次间隔（秒）",
    "intervalSeconds",
    config.intervalSeconds,
    "number",
    { min: 1, max: 3600 },
  );
  interval.querySelector("input").onchange = (e) =>
    void guarded(() => saveConfig({ intervalSeconds: Number(e.target.value) }));
  controls.append(interval);
  const nodes = root.querySelector("[data-nodes]");
  nodes.replaceChildren();
  if (!config.nodes.length)
    nodes.append(el("p", { className: "sf-muted" }, "暂无 API 节点"));
  const sorted = [...config.nodes].sort((a, b) => a.priority - b.priority);
  sorted.forEach((n, index) => {
    const row = el("div", { className: "sf-node" });
    const enabled = el("input", {
      type: "checkbox",
      checked: n.enabled,
      title: "启用 " + n.name,
    });
    enabled.setAttribute("aria-label", "启用 " + n.name);
    enabled.onchange = () =>
      void guarded(() =>
        saveConfig({
          nodes: config.nodes.map((x) =>
            x.id === n.id ? { ...x, enabled: enabled.checked } : x,
          ),
        }),
      );
    const text = el("div", { className: "sf-node-text" });
    text.append(
      el("strong", {}, `${n.priority}. ${n.name}`),
      el("span", { className: "sf-muted" }, n.model),
      el("small", { className: "sf-muted" }, n.url),
      el("small", {}, n.keyHint || "未设置 Key"),
    );
    const actions = el("div", { className: "sf-row-actions" });
    const move = (dir) =>
      void guarded(async () => {
        const other = index + dir;
        if (other < 0 || other >= sorted.length) return;
        [sorted[index], sorted[other]] = [sorted[other], sorted[index]];
        await saveConfig({
          nodes: sorted.map((x, i) => ({ ...x, priority: i + 1 })),
        });
      });
    const up = button("arrow-up", "上移 " + n.name, () => move(-1));
    up.disabled = index === 0;
    const down = button("arrow-down", "下移 " + n.name, () => move(1));
    down.disabled = index === sorted.length - 1;
    const test = button(
      "flask",
      "测试 " + n.name + "（发送一次 API 请求）",
      () =>
        void guarded(async () => {
          test.disabled = true;
          try {
            const job = await bridge.api("/test", { nodeId: n.id });
            await refreshRecords();
            let j = job;
            while (["running", "waiting"].includes(j.state)) {
              await new Promise((r) => setTimeout(r, 600));
              j = await bridge.api("/jobs/" + j.id);
            }
            await refreshRecords();
          } finally {
            test.disabled = false;
          }
        }),
    );
    actions.append(
      up,
      down,
      button("pen", "编辑 " + n.name, () => editor(n)),
      test,
      button(
        "trash",
        "删除 " + n.name,
        () =>
          void guarded(async () => {
            const result = await ctx().Popup.show.confirm("删除节点", n.name);
            if (result === ctx().POPUP_RESULT.AFFIRMATIVE)
              await saveConfig({
                nodes: config.nodes.filter((x) => x.id !== n.id),
              });
          }),
      ),
    );
    row.append(enabled, text, actions);
    nodes.append(row);
  });
  const advanced = root.querySelector("[data-advanced]");
  advanced.replaceChildren();
  for (const [key, label, min, max] of [
    ["timeoutSeconds", "单节点总超时（秒）", 1, 3600],
    ["headerSeconds", "响应头超时（秒）", 1, 600],
    ["firstTokenSeconds", "首数据超时（秒）", 1, 600],
    ["idleSeconds", "数据间隔超时（秒）", 1, 600],
  ]) {
    const field = labelInput(label, key, config[key], "number", { min, max });
    field.querySelector("input").onchange = (e) =>
      void guarded(() => saveConfig({ [key]: Number(e.target.value) }));
    advanced.append(field);
  }
}
async function refreshRecords() {
  if (!root?.isConnected) return;
  let records = [];
  try {
    records = await bridge.api("/records");
  } catch {}
  const area = root.querySelector("[data-records]");
  const open = new Set(
    [...area.querySelectorAll("details[open]")].map((x) => x.dataset.id),
  );
  area.replaceChildren();
  for (const r of [...localRecords, ...records]) {
    const detail = el("details", { className: "sf-record" });
    detail.dataset.id = r.id;
    detail.open = open.has(r.id);
    const summary = el("summary");
    summary.append(
      el("span", {}, new Date(r.started).toLocaleTimeString()),
      el(
        "span",
        { className: "sf-state sf-" + r.state },
        STATES[r.state] || r.state,
      ),
      el(
        "span",
        {},
        r.round ? `第 ${r.round} 轮 · 累计尝试 ${r.attemptCount} 次` : "",
      ),
    );
    detail.append(summary);
    if (r.mode)
      detail.append(
        el(
          "p",
          { className: "sf-muted" },
          {
            node_test: "单节点测试",
            native_first: "原生优先，再尝试备用节点",
            fallback: "仅使用备用节点",
          }[r.mode] || r.mode,
        ),
      );
    if (["running", "waiting"].includes(r.state))
      detail.append(
        button(
          "stop",
          "停止此任务",
          () =>
            void guarded(async () => {
              await bridge.api("/jobs/" + r.id + "/cancel", {
                reason: "user_cancel",
              });
              await refreshRecords();
            }),
        ),
      );
    if (r.reason)
      detail.append(
        el(
          "p",
          {},
          r.reason === "已停止" ? "旧版记录未保存具体取消来源" : r.reason,
        ),
      );
    if (r.nextAttemptAt)
      detail.append(
        el(
          "p",
          {},
          `下一次尝试约在 ${Math.max(0, Math.ceil((r.nextAttemptAt - Date.now()) / 1000))} 秒后`,
        ),
      );
    if (r.dropped)
      detail.append(
        el("p", { className: "sf-muted" }, `更早的 ${r.dropped} 条详情已清理`),
      );
    for (const a of r.attempts || []) {
      const line = el("div", { className: "sf-attempt" });
      line.append(
        el("strong", {}, `第 ${a.round} 轮 · ${a.node} · ${a.model}`),
        el(
          "span",
          {},
          `${STATES[a.state] || a.state}${a.status ? ` · HTTP ${a.status}` : ""} · 耗时 ${((a.ms ?? 0) / 1000).toFixed(1)} 秒`,
        ),
      );
      for (const adjustment of a.adjustments || [])
        line.append(
          el(
            "p",
            { className: "sf-muted" },
            `${adjustment.parameter === "temperature" ? "温度" : "输出上限"}：${adjustment.from ?? "默认"} → ${adjustment.to}（${adjustment.reason}）`,
          ),
        );
      if (a.message)
        line.append(
          el(
            "pre",
            {},
            `${a.category} / ${a.phase}\n${a.code || ""} ${a.message}`,
          ),
        );
      detail.append(line);
    }
    area.append(detail);
  }
  if (!area.children.length)
    area.append(el("p", { className: "sf-muted" }, "暂无请求记录"));
}
function watch(event, fn) {
  ctx().eventSource.on(event, fn);
  subscriptions.push([event, fn]);
}
function capture(type, options, dry) {
  if (!dry && (selected() || nativeSelected())) {
    const c = ctx();
    snapshot = {
      type,
      chat: c.chat,
      last: c.chat.length ? structuredClone(c.chat.at(-1)) : null,
      length: c.chat.length,
    };
  }
}
async function restoreFailed(s) {
  // Regenerate/swipe can edit the last message before the HTTP request is made.
  if (!s || s.chat !== ctx().chat) return;
  if (s.type === "regenerate" && s.last && ctx().chat.length === s.length - 1) {
    ctx().chat.push(s.last);
    ctx().addOneMessage(s.last);
    await ctx().saveChat();
  }
  if (s.type === "swipe" && s.last && ctx().chat.length === s.length) {
    const m = s.last;
    const index = Math.max(
      0,
      Math.min(m.swipe_id ?? 0, (m.swipes?.length ?? 1) - 1),
    );
    m.swipe_id = index;
    if (m.swipes?.[index] != null) m.mes = m.swipes[index];
    if (m.swipe_info?.[index])
      Object.assign(m, structuredClone(m.swipe_info[index]));
    ctx().chat[s.length - 1] = m;
    ctx().addOneMessage(m, { type: "swipe", forceId: s.length - 1 });
    await ctx().saveChat();
  }
}
async function boot() {
  if (document.getElementById("silent-failover-settings")) return;
  root = el("div", { id: "silent-failover-settings" });
  root.innerHTML = `<div class="inline-drawer"><div class="inline-drawer-toggle inline-drawer-header"><b>静默 API 故障转移</b><div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div></div><div class="inline-drawer-content"><div class="sf-actions" data-actions></div><p class="sf-muted" data-status></p><div class="sf-controls" data-controls></div><div data-editor></div><div data-native></div><div data-nodes></div><details><summary>超时设置</summary><div class="sf-fields" data-advanced></div></details><details data-history><summary>请求记录</summary><div class="sf-actions" data-log-actions></div><div data-records></div></details></div></div>`;
  document.getElementById("extensions_settings2").append(root);
  const actions = root.querySelector("[data-actions]");
  const connectButton = el(
    "button",
    { type: "button", className: "menu_button" },
    "仅使用备用节点",
  );
  connectButton.onclick = () => void guarded(connect);
  actions.append(
    connectButton,
    button("rotate-left", "恢复原连接", () => void guarded(restore)),
    button("plus", "新增节点", () => {
      if (config) editor();
    }),
    button(
      "rotate",
      "刷新配置",
      () =>
        void guarded(async () => {
          config = await bridge.api("/config");
          render();
          message("服务端已连接");
        }),
    ),
  );
  root.querySelector("[data-log-actions]").append(
    button("rotate", "刷新记录", () => void refreshRecords()),
    button(
      "trash",
      "清空已结束记录",
      () =>
        void guarded(async () => {
          await bridge.api("/records/clear", {});
          localRecords.length = 0;
          await refreshRecords();
        }),
    ),
  );
  watch(ctx().eventTypes.GENERATION_STARTED, capture);
  watch(ctx().eventTypes.SETTINGS_UPDATED, renderNative);
  watch(ctx().eventTypes.CHATCOMPLETION_SOURCE_CHANGED, renderNative);
  watch(ctx().eventTypes.GENERATION_STOPPED, () => bridge.cancel("user_stop"));
  watch(ctx().eventTypes.CHAT_CHANGED, () => {
    bridge.cancel("chat_changed");
    snapshot = null;
  });
  const unload = () => bridge.cancel("page_closed");
  window.addEventListener("pagehide", unload);
  subscriptions.push(["pagehide", unload]);
  refreshTimer = setInterval(() => {
    renderNative();
    if (root.querySelector("[data-history]").open && !document.hidden)
      void refreshRecords();
  }, 2500);
  await guarded(async () => {
    config = await bridge.api("/config");
    render();
    message("服务端已连接 · 1.1.1");
  });
}
export async function onDisable() {
  if (bridge && config)
    await bridge.api("/config", { ...config, enabled: false }).catch(() => {});
  if (selected()) await restore().catch(() => {});
  bridge?.dispose();
  clearInterval(refreshTimer);
  for (const [event, fn] of subscriptions.splice(0)) {
    if (event === "pagehide") window.removeEventListener(event, fn);
    else ctx().eventSource.removeListener(event, fn);
  }
  root?.remove();
}
// Install before APP_READY so automatic connection checks also use this adapter.
bridge = installAdapter(
  ctx,
  (r) => {
    localRecords.unshift(r);
    localRecords.splice(100);
  },
  {
    start() {
      const s = snapshot;
      snapshot = null;
      return s;
    },
    failed: restoreFailed,
  },
);
ctx().eventSource.on(ctx().eventTypes.APP_READY, () => {
  void boot();
});
