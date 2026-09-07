import { API, ENDPOINT, installAdapter } from "./adapter.js";
import { VERSION } from "../server/version.js";
import { createTaskPanel } from "./panel.js";
import { completeApiUrl } from "../server/url.js";
const ctx = () => SillyTavern.getContext();
const STATES = {
  running: "尝试中",
  waiting: "等待下一轮",
  succeeded: "上游已完成",
  failed: "失败",
  exhausted: "本轮已耗尽",
  cancelled: "已取消",
  invalid: "未执行",
};
let bridge, root, config, refreshTimer, snapshot;
let hostConnection;
const READY_STATUS = "API还没挂就绪";
let savedConfig,
  dirty = false,
  editorRead,
  panel;
let saveTimer,
  savePromise,
  editRevision = 0,
  presetBusy = false,
  editorSync;
let updateTimer;
const testControllers = new Set();
const localRecords = [];
const browserEvents = [];
const recordEvent = (stage) => {
  browserEvents.push({ stage, at: Date.now() });
  browserEvents.splice(0, Math.max(0, browserEvents.length - 100));
};
const subscriptions = [];
const el = (tag, props = {}, text) => {
  const e = document.createElement(tag);
  Object.assign(e, props);
  if (text !== undefined) e.textContent = text;
  return e;
};
function button(icon, label, fn, touchLabel = label) {
  const b = el("button", {
    type: "button",
    className: "menu_button sf-icon",
    title: label,
  });
  b.setAttribute("aria-label", label);
  b.append(el("i", { className: `fa-solid fa-${icon}` }));
  b.firstChild.setAttribute("aria-hidden", "true");
  b.append(el("span", { className: "sf-action-label" }, touchLabel));
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
    savedConfig?.enabled &&
    c.mainApi === "openai" &&
    ["custom", "openai", "claude", "makersuite"].includes(
      c.chatCompletionSettings.chat_completion_source,
    ) &&
    !selected()
  );
}
async function migrateLegacyConnection() {
  if (!selected()) return;
  bridge.cancel("connection_changed");
  const c = ctx();
  const previous = c.extensionSettings.silent_failover?.previous;
  Object.assign(
    c.chatCompletionSettings,
    previous?.values || { custom_url: "", custom_model: "" },
  );
  if (previous && c.CONNECT_API_MAP[previous.api])
    await c.executeSlashCommandsWithOptions(`/api quiet=true ${previous.api}`);
  if (c.extensionSettings.silent_failover)
    delete c.extensionSettings.silent_failover.previous;
  for (const [id, key] of [
    ["custom_api_url_text", "custom_url"],
    ["custom_model_id", "custom_model"],
  ]) {
    const field = document.getElementById(id);
    if (field) field.value = c.chatCompletionSettings[key] || "";
  }
  c.saveSettingsDebounced();
}
function updateReadiness() {
  if (!hostConnection) return;
  const available =
    nativeSelected() &&
    (savedConfig.nativeFirst || savedConfig.nodes.some((n) => n.enabled));
  if (available && hostConnection.online_status === "no_connection")
    hostConnection.setOnlineStatus(READY_STATUS);
  else if (!available && hostConnection.online_status === READY_STATUS)
    hostConnection.setOnlineStatus("no_connection");
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
  if (editorRead) {
    message("请先完成当前节点编辑");
    return;
  }
  const existing = Boolean(node.id);
  node = { ...node, id: node.id || crypto.randomUUID() };
  const area = root.querySelector("[data-editor]");
  area.replaceChildren();
  const form = el("form", { className: "sf-editor" });
  form.append(el("strong", {}, existing ? "编辑节点" : "新增节点"));
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
      node.key || node.keySet ? "API Key（留空保留）" : "API Key",
      "key",
      "",
      "text",
      {
        autocomplete: "off",
        inputMode: "text",
        autocapitalize: "none",
        spellcheck: false,
        placeholder: node.key
          ? "已填写，保存设置后生效"
          : node.keySet
            ? "已保存，留空不更换"
            : "填写 API Key",
      },
    ),
    labelInput("优先级", "priority", node.priority, "number", {
      min: 0,
      max: 99999,
      required: true,
    }),
  );
  fields.querySelector('[name="key"]').setAttribute("autocorrect", "off");
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
    "应用节点",
  );
  actions.append(
    save,
    button("xmark", "取消编辑", () => {
      if (savePromise) {
        message("正在保存，请稍后再操作");
        return;
      }
      area.replaceChildren();
      editorRead = null;
      editorSync = null;
      config = structuredClone(savedConfig);
      dirty = false;
      clearTimeout(saveTimer);
      render();
    }),
  );
  form.append(actions);
  const read = () => {
    const data = new FormData(form);
    return {
      ...node,
      id: node.id || crypto.randomUUID(),
      name: data.get("name"),
      url: (() => {
        try {
          return completeApiUrl(
            data.get("url"),
            data.get("protocol"),
            config.autoCompleteUrl !== false,
          );
        } catch {
          return data.get("url");
        }
      })(),
      model: data.get("model"),
      protocol: data.get("protocol"),
      // A staged Key has not reached the server yet; blank edits must retain it too.
      key: data.get("key") || node.key || "",
      priority: Number(data.get("priority")),
      stream: streamInput.checked,
    };
  };
  const stage = (close = true) => {
    if (!form.checkValidity()) throw new Error("节点尚未填完整，修改未保存");
    const updated = read();
    const i = config.nodes.findIndex((n) => n.id === node.id);
    if (i >= 0) config.nodes[i] = updated;
    else config.nodes.push(updated);
    if (close) {
      editorRead = null;
      editorSync = null;
      area.replaceChildren();
    }
    dirty = true;
  };
  editorRead = stage;
  editorSync = (updated) => {
    const saved = updated.nodes.find((n) => n.id === node.id);
    if (saved) {
      node = { ...saved };
      const field = form.querySelector('[name="key"]');
      field.value = "";
      field.placeholder = saved.keySet ? "已保存，留空不更换" : "填写 API Key";
    }
  };
  form.addEventListener("input", (e) => {
    if (e.target.type === "search") return;
    dirty = true;
    markDirty();
  });
  const modelInput = form.querySelector('[name="model"]');
  const picker = el("div", { className: "sf-model-picker", hidden: true });
  const search = el("input", {
    type: "search",
    className: "text_pole",
    placeholder: "搜索可用模型",
  });
  search.setAttribute("aria-label", "搜索可用模型");
  const models = el("select", {
    id: "sf-model-options",
    className: "text_pole",
    size: 6,
  });
  models.setAttribute("aria-label", "可用模型");
  const count = el("span", { className: "sf-muted", role: "status" });
  picker.append(search, count, models);
  let availableModels = [],
    lookupRevision = 0;
  const renderModels = () => {
    const query = search.value.trim().toLowerCase();
    const matches = availableModels.filter((id) =>
      id.toLowerCase().includes(query),
    );
    models.replaceChildren(
      ...matches.map((id) => el("option", { value: id, title: id }, id)),
    );
    models.value = modelInput.value;
    count.textContent = matches.length
      ? `显示 ${matches.length} / ${availableModels.length} 个模型`
      : "没有匹配的模型";
    models.hidden = !matches.length;
  };
  search.oninput = renderModels;
  for (const input of [search, models])
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") event.preventDefault();
    });
  models.onchange = () => {
    modelInput.value = models.value;
    modelInput.dispatchEvent(new Event("input", { bubbles: true }));
  };
  const modelStatus = el("p", { className: "sf-muted", role: "status" });
  const modelButton = button(
    "list",
    "获取模型列表",
    () =>
      void guarded(async () => {
        modelButton.disabled = true;
        const revision = ++lookupRevision;
        availableModels = [];
        picker.hidden = true;
        models.replaceChildren();
        modelStatus.textContent = "正在获取模型…";
        try {
          const result = await bridge.api("/models", {
            node: read(),
            settings: { autoCompleteUrl: config.autoCompleteUrl },
          });
          if (revision !== lookupRevision || !form.isConnected) return;
          availableModels = result.models;
          search.value = "";
          renderModels();
          picker.hidden = false;
          modelStatus.textContent = `已获取 ${result.models.length} 个模型${result.truncated ? "（列表已截断）" : ""}`;
        } catch (e) {
          if (revision === lookupRevision) modelStatus.textContent = e.message;
        } finally {
          if (revision === lookupRevision) modelButton.disabled = false;
        }
      }),
  );
  for (const input of [
    protocol,
    form.querySelector('[name="url"]'),
    form.querySelector('[name="key"]'),
  ])
    input.addEventListener("input", () => {
      lookupRevision++;
      availableModels = [];
      picker.hidden = true;
      modelButton.disabled = false;
      models.replaceChildren();
      modelStatus.textContent = "";
    });
  actions.append(
    modelButton,
    button(
      "flask",
      "测试当前节点（发送一次 API 请求）",
      () => void runNodeTest(read()),
      "测试连接",
    ),
  );
  form.append(modelStatus, picker);
  form.onsubmit = (e) => {
    e.preventDefault();
    void guarded(async () => {
      save.disabled = true;
      try {
        stage();
        render();
        markDirty();
      } finally {
        save.disabled = false;
      }
    });
  };
  area.append(form);
  form.querySelector("input").focus();
}
async function saveConfig(changes) {
  config = { ...config, ...changes };
  dirty = true;
  render();
  markDirty();
}
function markDirty() {
  root.querySelector("[data-dirty]").textContent = dirty
    ? "等待自动保存"
    : "已保存";
  if (dirty) {
    editRevision++;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(
      () =>
        void commitSettings(false).catch((e) => {
          root.querySelector("[data-dirty]").textContent =
            e.message || "自动保存失败，修改仍保留";
        }),
      650,
    );
  }
}
async function commitSettings(closeEditor = true) {
  clearTimeout(saveTimer);
  if (savePromise) {
    await savePromise;
    if (dirty) return commitSettings(closeEditor);
    if (closeEditor && editorRead) {
      editorRead();
      dirty = false;
      render();
    }
    return;
  }
  if (!dirty && !editorRead) return;
  for (const input of root.querySelectorAll(
    '[data-controls] input[type="number"], [data-advanced] input[type="number"]',
  )) {
    if (!input.disabled && (!input.value || !input.checkValidity()))
      throw new Error("请填写范围内的数值设置");
  }
  editorRead?.(closeEditor);
  const revision = editRevision;
  const outgoing = structuredClone(config);
  root.querySelector("[data-dirty]").textContent = "正在保存…";
  savePromise = (async () => {
    const updated = await bridge.api("/config", outgoing);
    savedConfig = structuredClone(updated);
    config.revision = updated.revision;
    if (revision === editRevision) {
      config = updated;
      dirty = false;
      editorSync?.(updated);
      if (!document.activeElement?.closest("[data-controls], [data-advanced]"))
        render();
      // Keep focused numeric fields and the open node editor stable while typing.
      root.querySelector("[data-dirty]").textContent = "已自动保存";
    }
    updateReadiness();
  })();
  try {
    await savePromise;
  } finally {
    savePromise = null;
  }
  if (dirty) return commitSettings(closeEditor);
  if (closeEditor) {
    render();
    message("设置已保存");
  }
}

async function presetAction(action, id) {
  if (presetBusy) return;
  presetBusy = true;
  try {
    let name;
    if (["create", "copy", "rename"].includes(action)) {
      name = await ctx().Popup.show.input(
        "预设名称",
        "",
        action === "rename" ? config.presetName : "",
      );
      if (!name?.trim()) return;
    }
    if (
      action === "delete" &&
      (await ctx().Popup.show.confirm("删除当前预设", config.presetName)) !==
        ctx().POPUP_RESULT.AFFIRMATIVE
    )
      return;
    root.querySelector(".inline-drawer-content").inert = true;
    await commitSettings(true);
    const updated = await bridge.api("/presets", {
      action,
      id,
      name,
      activePresetId: config.activePresetId,
      revision: config.revision,
    });
    config = updated;
    savedConfig = structuredClone(updated);
    dirty = false;
    render();
    updateReadiness();
    panel.update(updated, await bridge.api("/records"));
    message(`当前预设：${updated.presetName}，已保存`);
  } finally {
    presetBusy = false;
    root.querySelector(".inline-drawer-content").inert = false;
    renderPresets();
  }
}
function renderPresets() {
  const area = root.querySelector("[data-presets]");
  if (!area || !config) return;
  area.replaceChildren();
  const label = el("label", { className: "sf-field" });
  const select = el("select", { className: "text_pole", disabled: presetBusy });
  select.setAttribute("aria-label", "当前预设");
  for (const p of config.presets || [])
    select.append(
      el(
        "option",
        { value: p.id, selected: p.id === config.activePresetId },
        p.name,
      ),
    );
  select.onchange = () =>
    void guarded(() => presetAction("activate", select.value));
  label.append(el("span", {}, "当前预设"), select);
  area.append(label);
  for (const [action, icon, text] of [
    ["create", "plus", "新建预设"],
    ["copy", "copy", "复制预设"],
    ["rename", "pen", "重命名预设"],
    ["delete", "trash", "删除预设"],
  ]) {
    const b = button(
      icon,
      text,
      () => void guarded(() => presetAction(action)),
    );
    b.disabled =
      presetBusy || (action === "delete" && config.presets?.length <= 1);
    area.append(b);
  }
}
async function runNodeTest(node) {
  const area = root.querySelector("[data-test]");
  if (testControllers.size) {
    message("已有连通性测试正在进行，请先停止");
    return;
  }
  const id = crypto.randomUUID(),
    controller = new AbortController();
  testControllers.add(controller);
  const started = Date.now();
  area.replaceChildren();
  const status = el("p", { role: "status" });
  const output = el("pre");
  const stop = button("stop", "停止测试", () => controller.abort());
  area.append(
    el("strong", {}, `连通性测试 · ${node.name || "当前节点"}`),
    status,
    stop,
    output,
  );
  area.scrollIntoView({ block: "nearest" });
  const tick = () => {
    status.textContent = `测试中 · 已等待 ${Math.floor((Date.now() - started) / 1000)} 秒`;
  };
  tick();
  const timer = setInterval(tick, 1000);
  try {
    let job = await bridge.api(
      "/test",
      { id, node, settings: config },
      controller.signal,
    );
    while (["running", "waiting"].includes(job.state)) {
      await new Promise((r) => setTimeout(r, 500));
      job = await bridge.api("/jobs/" + id, undefined, controller.signal);
    }
    clearInterval(timer);
    status.textContent = `${job.state === "succeeded" ? "测试成功" : job.state === "cancelled" ? "测试已停止" : "测试失败"} · ${((Date.now() - started) / 1000).toFixed(1)} 秒 · ${node.model}`;
    output.textContent =
      job.state === "succeeded"
        ? (
            job.result?.choices?.[0]?.message?.content || "无正文，查看结束原因"
          ).slice(0, 500)
        : job.attempts?.at(-1)?.message || job.reason || "未取得回复";
    if (job.state === "succeeded") await bridge.api("/jobs/" + id + "/ack", {});
  } catch (e) {
    clearInterval(timer);
    status.textContent = controller.signal.aborted ? "测试已停止" : "测试失败";
    output.textContent = controller.signal.aborted ? "" : e.message;
    await bridge
      .api("/jobs/" + id + "/cancel", { reason: "user_cancel" })
      .catch(() => {});
  } finally {
    clearInterval(timer);
    stop.disabled = true;
    testControllers.delete(controller);
    await refreshRecords();
  }
}
function renderNative() {
  const area = root.querySelector("[data-native]");
  area.replaceChildren();
  if (!config) return;
  const settings = ctx().chatCompletionSettings;
  const source = settings.chat_completion_source;
  const supported =
    ctx().mainApi === "openai" &&
    ["custom", "openai", "claude", "makersuite"].includes(source) &&
    !selected();
  const row = el("div", { className: "sf-native" });
  const text = el("div", { className: "sf-node-text" });
  text.append(el("strong", {}, "酒馆原生 API"));
  const enabled = el("input", {
    type: "checkbox",
    checked: config.nativeFirst !== false,
  });
  enabled.setAttribute("aria-label", "启用 酒馆原生 API");
  enabled.onchange = () => void saveConfig({ nativeFirst: enabled.checked });
  text.append(
    el(
      "small",
      { className: "sf-muted" },
      settings.stream_openai ? "流式请求" : "非流式请求",
    ),
  );
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
  row.append(enabled, text);
  area.append(row);
}
function render() {
  if (!config) return;
  renderPresets();
  const controls = root.querySelector("[data-controls]");
  controls.replaceChildren();
  for (const [key, label] of [
    ["enabled", "启用故障转移"],
    ["loop", "自动循环重试"],
    ["autoCompleteUrl", "自动补全 API 地址"],
  ]) {
    const wrap = el("label", { className: "sf-check" });
    const input = el("input", { type: "checkbox", checked: config[key] });
    input.setAttribute("aria-label", label);
    input.onchange = () =>
      void guarded(() => saveConfig({ [key]: input.checked }));
    wrap.append(input, document.createTextNode(label));
    controls.append(wrap);
  }
  renderNative();
  const interval = labelInput(
    "轮次间隔（秒）",
    "intervalSeconds",
    config.intervalSeconds,
    "number",
    { min: 1, max: 3600 },
  );
  interval.querySelector("input").oninput = (e) => {
    config.intervalSeconds = Number(e.target.value);
    dirty = true;
    markDirty();
  };
  controls.append(interval);
  const rounds = labelInput(
    "总轮次上限（0 不限）",
    "maxRounds",
    config.maxRounds ?? 0,
    "number",
    { min: 0, max: 10000, step: 1 },
  );
  rounds.querySelector("input").oninput = (e) => {
    config.maxRounds = Number(e.target.value);
    dirty = true;
    markDirty();
  };
  controls.append(rounds);
  for (const [key, title, options] of [
    [
      "notificationMode",
      "提示方式",
      [
        ["silent", "完全静默"],
        ["failure", "仅最终失败提示"],
        ["progress", "显示切换过程"],
      ],
    ],
    [
      "waitMode",
      "等待策略",
      [
        ["patient", "耐心等待"],
        ["limited", "限时切换"],
      ],
    ],
  ]) {
    const label = el("label", { className: "sf-field" });
    const select = el("select", { className: "text_pole", name: key });
    select.setAttribute("aria-label", title);
    label.append(el("span", {}, title), select);
    for (const [value, text] of options)
      select.append(
        el("option", { value, selected: config[key] === value }, text),
      );
    select.onchange = () => void saveConfig({ [key]: select.value });
    controls.append(label);
  }
  const floatLabel = el("label", { className: "sf-check" });
  const floatInput = el("input", {
    type: "checkbox",
    checked: config.floatingWindow,
  });
  floatInput.onchange = () =>
    void saveConfig({ floatingWindow: floatInput.checked });
  floatLabel.append(floatInput, document.createTextNode("显示悬浮窗"));
  controls.append(floatLabel);
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
      el(
        "small",
        { className: "sf-stream" },
        n.stream !== false ? "流式请求" : "非流式请求",
      ),
      el("small", { className: "sf-muted" }, n.url),
      el(
        "small",
        {},
        n.key
          ? "Key 已填写（待保存）"
          : n.keySet
            ? `Key 已保存${n.keyHint ? " · " + n.keyHint : ""}`
            : "未设置 Key",
      ),
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
    const up = button("arrow-up", "上移 " + n.name, () => move(-1), "上移");
    up.disabled = index === 0;
    const down = button("arrow-down", "下移 " + n.name, () => move(1), "下移");
    down.disabled = index === sorted.length - 1;
    const test = button(
      "flask",
      "测试 " + n.name + "（发送一次 API 请求）",
      () => void runNodeTest(n),
      "测试",
    );
    actions.append(
      up,
      down,
      button("pen", "编辑 " + n.name, () => editor(n), "编辑"),
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
        "删除",
      ),
    );
    row.append(enabled, text, actions);
    nodes.append(row);
  });
  const advanced = root.querySelector("[data-advanced]");
  advanced.closest("details").hidden = config.waitMode !== "limited";
  advanced.replaceChildren();
  for (const [key, label, min, max] of [
    ["timeoutSeconds", "完整回复最多等多久（秒，0 不限）", 0, 86400],
    ["headerSeconds", "完全没回应时等多久（秒，0 不限）", 0, 86400],
    ["firstTokenSeconds", "开始回应后，首批数据等多久（秒，0 不限）", 0, 86400],
    ["idleSeconds", "接收数据中，停顿多久就换（秒，0 不限）", 0, 86400],
  ]) {
    const field = labelInput(label, key, config[key], "number", { min, max });
    field.querySelector("input").disabled = config.waitMode === "patient";
    field.querySelector("input").oninput = (e) => {
      config[key] = Number(e.target.value);
      dirty = true;
      markDirty();
    };
    advanced.append(field);
  }
  markDirty();
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
    if (r.generation)
      detail.append(
        el(
          "p",
          { className: "sf-muted" },
          `生成类型：${{ normal: "聊天回复", quiet: "后台生成（不新增聊天消息）", regenerate: "重新生成", swipe: "切换候选", continue: "继续生成", impersonate: "代写用户消息", unknown: "未识别" }[r.generation] || "未识别"}`,
        ),
      );
    if (r.state === "succeeded") {
      const stages = new Set((r.clientEvents || []).map((e) => e.stage));
      detail.append(
        el(
          "p",
          {},
          r.mode === "node_test"
            ? "节点测试完成，不发送到聊天"
            : stages.has("client_failed")
              ? "浏览器报告交付失败"
              : stages.has("response_prepared")
                ? "已准备酒馆响应（不代表聊天已显示）"
                : stages.has("browser_received")
                  ? "浏览器已收到结果"
                  : "尚无浏览器接收确认；旧日志不包含交付信息",
        ),
      );
    }
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
          "停止生成",
          () =>
            void guarded(async () => {
              await bridge.api("/jobs/" + r.id + "/cancel", {
                reason: "user_cancel",
              });
              await refreshRecords();
            }),
        ),
      );
    if (r.connectionNote)
      detail.append(el("p", { className: "sf-muted" }, r.connectionNote));
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
        el(
          "strong",
          {},
          `第 ${a.round} 轮 · ${a.node} · ${a.model}${r.presetName ? " · " + r.presetName : ""}`,
        ),
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
      if (a.diagnostics) {
        const d = a.diagnostics,
          c = d.completion,
          t = d.timeouts;
        line.append(
          el(
            "p",
            { className: "sf-muted" },
            `${d.protocol || "unknown"} · ${d.stream ? "上游流式" : "上游非流式"} · HTTP ${d.httpStatus ?? "未收到"} · ${d.contentType || "未收到响应头"} · ${d.bytes ?? 0} 字节`,
          ),
        );
        if (d.headersMs != null)
          line.append(
            el(
              "p",
              {},
              `响应头 ${d.headersMs} ms · 首数据 ${d.firstDataMs ?? "未收到"} ms`,
            ),
          );
        if (c)
          line.append(
            el(
              "p",
              {},
              `正文 ${c.textChars} 字符 · 推理 ${c.reasoningChars} 字符 · 结束原因 ${c.finishReason}${c.refusal ? " · 拒答" : ""}`,
            ),
          );
        if (d.usage) {
          const labels = {
            inputTokens: "输入",
            outputTokens: "输出",
            totalTokens: "总计",
            reasoningTokens: "推理（含于输出）",
            cacheReadTokens: "缓存读取（含于输入）",
            cacheWriteTokens: "缓存写入（含于输入）",
          };
          line.append(
            el(
              "p",
              { className: "sf-token-usage" },
              "Token · " +
                Object.entries(labels)
                  .filter(([key]) => d.usage[key] !== undefined)
                  .map(([key, label]) => `${label} ${d.usage[key]}`)
                  .join(" · ") +
                (d.usagePartial || a.state !== "succeeded"
                  ? "（API 已报告，可能不完整）"
                  : "（API 已报告）"),
            ),
          );
        } else if (
          a.state === "succeeded" ||
          c?.textChars ||
          c?.reasoningChars
        ) {
          line.append(
            el(
              "p",
              { className: "sf-muted sf-token-usage" },
              a.state === "succeeded"
                ? "Token：API 未返回用量"
                : "Token：已收到部分回复，API 未返回用量，可能已计费",
            ),
          );
        }
        if (d.bodyShape) line.append(el("p", {}, `响应结构：${d.bodyShape}`));
        if (t)
          line.append(
            el(
              "p",
              { className: "sf-muted" },
              `实际超时（秒）：总计 ${t.timeoutSeconds} / 响应头 ${t.headerSeconds} / 首数据 ${t.firstTokenSeconds} / 间隔 ${t.idleSeconds}`,
            ),
          );
      }
      detail.append(line);
    }
    area.append(detail);
  }
  if (!area.children.length)
    area.append(el("p", { className: "sf-muted" }, "暂无请求记录"));
}
async function exportDiagnostics() {
  const data = await bridge.api("/diagnostics");
  data.frontendVersion = VERSION;
  data.browserEvents = browserEvents;
  data.localRecords = localRecords;
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }),
  );
  const a = el("a", {
    href: url,
    download: `silent-failover-diagnostics-${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
  });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
async function updatePlugin() {
  const b = root.querySelector("[data-update]");
  b.disabled = true;
  try {
    if (!config?.updateSupported)
      throw new Error(
        "当前服务端尚不支持一键更新，请先手动安装 1.2.0 或更新版本并重启酒馆",
      );
    message("正在检查并更新前后端…");
    let state = await bridge.api("/update", {});
    while (state.state === "updating") {
      await new Promise((r) => setTimeout(r, 1000));
      state = await bridge.api("/update/status");
    }
    if (state.state === "failed") throw new Error(state.error);
    message(
      state.restartRequired
        ? `已安装 ${state.installedVersion}，请重启酒馆后台并刷新页面`
        : `已是最新正式版 ${state.runningVersion}`,
    );
  } finally {
    b.disabled = false;
  }
}
async function checkNewVersion() {
  try {
    const result = await bridge.api("/update/check");
    const newer = (a, b) => {
      if (!/^\d+\.\d+\.\d+$/.test(a || "") || !/^\d+\.\d+\.\d+$/.test(b || ""))
        return false;
      const x = a.split(".").map(Number),
        y = b.split(".").map(Number);
      for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
      return false;
    };
    const available =
      newer(result.latestVersion, VERSION) ||
      newer(result.latestVersion, config?.version);
    for (const badge of root.querySelectorAll("[data-new-version]")) {
      badge.hidden = !available;
      badge.title = `新版本 ${result.latestVersion}${config?.canUpdate === false ? "，请联系酒馆管理员更新" : ""}`;
    }
    if (available)
      root.querySelector("[data-update]").title =
        `更新至 ${result.latestVersion}`;
  } catch {
    /* Update checks never interrupt generation or editing. */
  }
}
function watch(event, fn) {
  ctx().eventSource.on(event, fn);
  subscriptions.push([event, fn]);
}
function capture(type, options, dry) {
  updateReadiness();
  if (!dry && nativeSelected()) {
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
  root.innerHTML = `<div class="inline-drawer"><div class="inline-drawer-toggle inline-drawer-header"><b>API还没挂</b><div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div></div><div class="inline-drawer-content"><div class="sf-actions" data-actions></div><p class="sf-muted" data-status></p><div class="sf-controls" data-controls></div><div data-editor></div><div data-native></div><div data-nodes></div><details><summary>超时设置</summary><div class="sf-fields" data-advanced></div></details><details data-history><summary>请求记录</summary><div class="sf-actions" data-log-actions></div><div data-records></div></details></div></div>`;
  document.getElementById("extensions_settings2").append(root);
  const presetArea = el("div", { className: "sf-presets" });
  presetArea.dataset.presets = "";
  root.querySelector("[data-controls]").before(presetArea);
  const actions = root.querySelector("[data-actions]");
  const dirtyStatus = el("p", { className: "sf-muted", role: "status" });
  dirtyStatus.dataset.dirty = "";
  actions.after(dirtyStatus);
  const testArea = el("div", { className: "sf-test-result" });
  testArea.dataset.test = "";
  root.querySelector("[data-editor]").after(testArea);
  panel = createTaskPanel(
    bridge.api,
    () => {
      root.querySelector(".inline-drawer-content").style.display = "block";
      root.querySelector("[data-history]").open = true;
      const drawer = root.closest(".drawer-content");
      if (!drawer || getComputedStyle(drawer).display === "none")
        document
          .getElementById("extensions-settings-button")
          ?.querySelector(".drawer-toggle")
          ?.click();
      void refreshRecords();
    },
    (id) => presetAction("activate", id),
  );
  actions.append(
    button("plus", "新增节点", () => {
      if (config) editor();
    }),
    button(
      "rotate",
      "刷新配置",
      () =>
        void guarded(async () => {
          if (savePromise) await savePromise;
          if (
            dirty &&
            (await ctx().Popup.show.confirm(
              "放弃未保存的修改并刷新",
              "将重新读取服务端已保存的配置",
            )) !== ctx().POPUP_RESULT.AFFIRMATIVE
          )
            return;
          clearTimeout(saveTimer);
          config = await bridge.api("/config");
          savedConfig = structuredClone(config);
          dirty = false;
          editorRead = editorSync = null;
          root.querySelector("[data-editor]").replaceChildren();
          updateReadiness();
          render();
          message("服务端已连接");
        }),
    ),
  );
  const saveButton = button(
    "floppy-disk",
    "保存设置",
    () =>
      void guarded(async () => {
        if (saveButton.disabled) return;
        saveButton.disabled = true;
        try {
          await commitSettings();
        } finally {
          saveButton.disabled = false;
        }
      }),
  );
  saveButton.classList.add("sf-labeled-action");
  saveButton.classList.remove("sf-icon");
  actions.append(
    saveButton,
    button("rotate-left", "撤销修改", () => {
      if (savePromise) {
        message("正在保存，请稍后再操作");
        return;
      }
      clearTimeout(saveTimer);
      config = structuredClone(savedConfig);
      dirty = false;
      editorRead = null;
      editorSync = null;
      root.querySelector("[data-editor]").replaceChildren();
      render();
      message("已撤销未保存的修改");
    }),
    button(
      "window-restore",
      "显示任务悬浮窗",
      () => {
        if (!config) return;
        void saveConfig({ floatingWindow: true });
        panel.update(config, []);
        panel.show();
      },
      "悬浮窗",
    ),
  );
  const update = button(
    "download",
    "一键更新插件",
    () => void guarded(updatePlugin),
  );
  update.dataset.update = "";
  actions.append(update);
  for (const parent of [
    update,
    root.querySelector(".inline-drawer-header b"),
  ]) {
    const badge = el(
      "span",
      { className: "sf-new-badge", hidden: true },
      "NEW",
    );
    badge.dataset.newVersion = "";
    parent.append(badge);
  }
  root.querySelector("[data-log-actions]").append(
    button("rotate", "刷新记录", () => void refreshRecords()),
    button("download", "导出诊断日志", () => void guarded(exportDiagnostics)),
    button(
      "trash",
      "清空已结束记录",
      () =>
        void guarded(async () => {
          await bridge.api("/records/clear", {});
          localRecords.length = 0;
          browserEvents.length = 0;
          await refreshRecords();
        }),
    ),
  );
  watch(ctx().eventTypes.GENERATION_STARTED, capture);
  for (const name of [
    "GENERATION_STARTED",
    "GENERATION_ENDED",
    "MESSAGE_RECEIVED",
    "CHARACTER_MESSAGE_RENDERED",
  ]) {
    const event = ctx().eventTypes[name];
    if (event) watch(event, () => recordEvent(name.toLowerCase()));
  }
  watch(ctx().eventTypes.SETTINGS_UPDATED, renderNative);
  watch(ctx().eventTypes.CHATCOMPLETION_SOURCE_CHANGED, renderNative);
  watch(ctx().eventTypes.ONLINE_STATUS_CHANGED, updateReadiness);
  watch(ctx().eventTypes.GENERATION_STOPPED, () => bridge.cancel("user_stop"));
  watch(ctx().eventTypes.CHAT_CHANGED, () => {
    bridge.cancel("chat_changed");
    snapshot = null;
  });
  const unload = () => {
    bridge.cancel("page_closed");
    for (const c of testControllers) c.abort();
  };
  window.addEventListener("pagehide", unload);
  subscriptions.push(["pagehide", unload]);
  const flushHidden = () => {
    if (document.hidden && dirty) void commitSettings(false).catch(() => {});
  };
  window.addEventListener("visibilitychange", flushHidden);
  subscriptions.push(["visibilitychange", flushHidden]);
  refreshTimer = setInterval(() => {
    renderNative();
    updateReadiness();
    if (!document.hidden) {
      if (root.querySelector("[data-history]").open) void refreshRecords();
      if (config)
        void bridge
          .api("/records")
          .then((records) =>
            panel.update(
              { ...savedConfig, floatingWindow: config.floatingWindow },
              records,
            ),
          )
          .catch(() => {});
    }
  }, 1000);
  await guarded(async () => {
    const hostPath = "/script.js";
    hostConnection = await import(hostPath);
    await migrateLegacyConnection();
    config = await bridge.api("/config");
    savedConfig = structuredClone(config);
    render();
    message(
      `前端 ${VERSION} · 服务端 ${config.version || "未知"}${config.version !== VERSION ? " · 请同步升级两部分" : " · 已连接"}`,
    );
    panel.update(config, await bridge.api("/records"));
    root.querySelector("[data-update]").disabled = config.canUpdate === false;
    if (config.updateSupported) {
      void checkNewVersion();
      updateTimer = setInterval(() => void checkNewVersion(), 86400000);
      const state = await bridge.api("/update/status");
      if (state.restartRequired)
        message(`已安装 ${state.installedVersion}，请重启酒馆后台并刷新页面`);
      else if (state.state === "failed") message(state.error);
      else if (state.state === "updating")
        message("插件更新正在进行，请稍后查看");
    }
  });
}
export async function onDisable() {
  clearTimeout(saveTimer);
  clearInterval(updateTimer);
  if (savePromise) await savePromise.catch(() => {});
  if (bridge && savedConfig)
    await bridge
      .api("/config", { ...savedConfig, enabled: false })
      .catch(() => {});
  savedConfig = null;
  updateReadiness();
  bridge?.dispose();
  for (const c of testControllers) c.abort();
  panel?.dispose();
  clearInterval(refreshTimer);
  for (const [event, fn] of subscriptions.splice(0)) {
    if (["pagehide", "visibilitychange"].includes(event))
      window.removeEventListener(event, fn);
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
    takePreferredNode: (generation) => panel?.takePreferredNode(generation),
    config: () => savedConfig,
    flush: () => commitSettings(false),
  },
);
ctx().eventSource.on(ctx().eventTypes.APP_READY, () => {
  void boot();
});
