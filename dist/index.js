// extension/adapter.js
var ENDPOINT = "http://sillytavern-failover.invalid/v1";
var API = "/api/plugins/silent-failover";
var cancelled = () => new DOMException("Silent failover stopped", "AbortError");
var json = (value) => new Response(JSON.stringify(value), {
  status: 200,
  headers: { "Content-Type": "application/json" }
});
var delay = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) return reject(cancelled());
  const done = () => {
    signal?.removeEventListener("abort", abort);
    resolve();
  };
  const timer = setTimeout(done, ms);
  const abort = () => {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
    reject(cancelled());
  };
  signal?.addEventListener("abort", abort, { once: true });
});
function installAdapter(context, onLocalRecord = () => {
}, lifecycle = {}) {
  const previous = window.fetch;
  const active = /* @__PURE__ */ new Map();
  let disposed = false;
  async function api(path, body, signal) {
    const response = await previous(API + path, {
      method: body === void 0 ? "GET" : "POST",
      headers: context().getRequestHeaders(),
      ...body === void 0 ? {} : { body: JSON.stringify(body) },
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(12e3)]) : AbortSignal.timeout(12e3)
    });
    const data = await response.json();
    if (!response.ok)
      throw Object.assign(new Error(data.error || "\u670D\u52A1\u7AEF\u8BF7\u6C42\u5931\u8D25"), {
        status: response.status
      });
    return data;
  }
  async function wrapper(input, init) {
    const url = new URL(
      input instanceof Request ? input.url : String(input),
      location.href
    );
    if (disposed || url.origin !== location.origin || ![
      "/api/backends/chat-completions/generate",
      "/api/backends/chat-completions/status"
    ].includes(url.pathname))
      return previous(input, init);
    let body;
    try {
      body = typeof init?.body === "string" ? JSON.parse(init.body) : input instanceof Request ? await input.clone().json() : null;
    } catch {
      return previous(input, init);
    }
    if (!["custom", "openai", "claude", "makersuite"].includes(
      body?.chat_completion_source
    ))
      return previous(input, init);
    const dedicated = body.chat_completion_source === "custom" && body.custom_url === ENDPOINT;
    let nativeFirst = false;
    if (!dedicated) {
      const settings = await api("/config").catch(() => null);
      nativeFirst = settings?.enabled === true && settings?.nativeFirst === true;
      if (!nativeFirst) return previous(input, init);
    }
    if (url.pathname.endsWith("/status"))
      return json({
        data: [
          {
            id: nativeFirst ? context().chatCompletionSettings[{
              custom: "custom_model",
              openai: "openai_model",
              claude: "claude_model",
              makersuite: "google_model"
            }[body.chat_completion_source]] || "native-default" : "failover-default",
            object: "model"
          }
        ]
      });
    const id = crypto.randomUUID();
    const saved = lifecycle.start?.();
    const controller = new AbortController();
    const originalSignal = init?.signal || (input instanceof Request ? input.signal : null);
    const abort = () => controller.abort("client_aborted");
    originalSignal?.addEventListener("abort", abort, { once: true });
    if (originalSignal?.aborted) abort();
    active.set(id, controller);
    let phase = "create_job";
    try {
      let job;
      let lastContact = Date.now();
      while (!job) {
        try {
          job = await api(
            "/jobs",
            { id, request: body, nativeFirst, generation: saved?.type },
            controller.signal
          );
          lastContact = Date.now();
        } catch (e) {
          if (controller.signal.aborted || e.status && e.status < 500 || Date.now() - lastContact > 55e3)
            throw e;
          await delay(1e3, controller.signal);
        }
      }
      phase = "poll_job";
      while (["running", "waiting"].includes(job.state)) {
        await delay(600, controller.signal);
        try {
          job = await api("/jobs/" + id, void 0, controller.signal);
          lastContact = Date.now();
        } catch (e) {
          if (controller.signal.aborted || e.status === 404 || Date.now() - lastContact > 55e3)
            throw e;
        }
      }
      if (controller.signal.aborted || job.state !== "succeeded")
        throw cancelled();
      void api("/jobs/" + id + "/ack", {}).catch(() => {
      });
      phase = "prepare_response";
      const handoff = (response) => {
        void api("/jobs/" + id + "/events", {
          stage: "response_prepared"
        }).catch(() => {
        });
        return response;
      };
      if (!body.stream) return handoff(json(job.result));
      const choice = job.result.choices[0];
      const source = body.chat_completion_source;
      if (source === "claude" || source === "makersuite") {
        const message2 = choice.message;
        const chunks = source === "claude" ? [
          ...message2.reasoning_content ? [
            {
              type: "content_block_delta",
              index: 0,
              delta: {
                type: "thinking_delta",
                thinking: message2.reasoning_content
              }
            }
          ] : [],
          {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: message2.content }
          },
          { type: "message_delta", delta: { stop_reason: "end_turn" } },
          { type: "message_stop" }
        ] : [
          ...message2.reasoning_content ? [
            {
              candidates: [
                {
                  content: {
                    parts: [
                      {
                        text: message2.reasoning_content,
                        thought: true
                      }
                    ]
                  }
                }
              ]
            }
          ] : [],
          {
            candidates: [
              {
                content: { parts: [{ text: message2.content }] },
                finishReason: "STOP"
              }
            ]
          }
        ];
        return handoff(
          new Response(
            chunks.map((c) => `data: ${JSON.stringify(c)}

`).join("") + "data: [DONE]\n\n",
            {
              headers: { "Content-Type": "text/event-stream" }
            }
          )
        );
      }
      const chunk = {
        id: job.result.id,
        object: "chat.completion.chunk",
        model: job.result.model,
        choices: [
          {
            index: 0,
            delta: choice.message,
            finish_reason: choice.finish_reason
          }
        ]
      };
      return handoff(
        new Response(`data: ${JSON.stringify(chunk)}

data: [DONE]

`, {
          headers: { "Content-Type": "text/event-stream" }
        })
      );
    } catch (e) {
      void api("/jobs/" + id + "/events", { stage: "client_failed" }).catch(
        () => {
        }
      );
      if (!controller.signal.aborted && e.name !== "AbortError")
        onLocalRecord({
          id,
          started: Date.now(),
          state: "invalid",
          status: Number.isInteger(e.status) ? e.status : null,
          phase,
          errorType: [
            "TypeError",
            "SyntaxError",
            "TimeoutError",
            "AbortError"
          ].includes(e.name) ? e.name : "Error",
          reason: "\u670D\u52A1\u7AEF\u8FDE\u63A5\u4E0D\u53EF\u7528\u6216\u8BF7\u6C42\u65E0\u6548",
          attempts: []
        });
      void api("/jobs/" + id + "/cancel", {
        reason: controller.signal.aborted ? controller.signal.reason || "client_aborted" : "client_error"
      }).catch(() => {
      });
      await lifecycle.failed?.(saved);
      throw cancelled();
    } finally {
      active.delete(id);
      originalSignal?.removeEventListener("abort", abort);
    }
  }
  window.fetch = wrapper;
  return {
    api,
    cancel(reason = "client_aborted") {
      for (const controller of active.values()) controller.abort(reason);
    },
    dispose() {
      disposed = true;
      this.cancel("plugin_disabled");
      if (window.fetch === wrapper) window.fetch = previous;
    },
    get active() {
      return active.size;
    }
  };
}

// server/version.js
var VERSION = "1.2.0";

// extension/index.js
var ctx = () => SillyTavern.getContext();
var STATES = {
  running: "\u5C1D\u8BD5\u4E2D",
  waiting: "\u7B49\u5F85\u4E0B\u4E00\u8F6E",
  succeeded: "\u4E0A\u6E38\u5DF2\u5B8C\u6210",
  failed: "\u5931\u8D25",
  exhausted: "\u672C\u8F6E\u5DF2\u8017\u5C3D",
  cancelled: "\u5DF2\u53D6\u6D88",
  invalid: "\u672A\u6267\u884C"
};
var bridge;
var root;
var config;
var refreshTimer;
var snapshot;
var localRecords = [];
var browserEvents = [];
var recordEvent = (stage) => {
  browserEvents.push({ stage, at: Date.now() });
  browserEvents.splice(0, Math.max(0, browserEvents.length - 100));
};
var subscriptions = [];
var el = (tag, props = {}, text) => {
  const e = document.createElement(tag);
  Object.assign(e, props);
  if (text !== void 0) e.textContent = text;
  return e;
};
function button(icon, label, fn) {
  const b = el("button", {
    type: "button",
    className: "menu_button sf-icon",
    title: label
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
    message(e.message || "\u64CD\u4F5C\u5931\u8D25");
  }
}
function selected() {
  const c = ctx();
  return c.mainApi === "openai" && c.chatCompletionSettings.custom_url === ENDPOINT && c.chatCompletionSettings.chat_completion_source === "custom";
}
function nativeSelected() {
  const c = ctx();
  return config?.enabled && config?.nativeFirst && c.mainApi === "openai" && ["custom", "openai", "claude", "makersuite"].includes(
    c.chatCompletionSettings.chat_completion_source
  ) && !selected();
}
async function setNativeFirst(value) {
  if (value) {
    if (!config.nativeAvailable)
      throw new Error("\u670D\u52A1\u7AEF\u4E0D\u652F\u6301\u539F\u751F\u8054\u52A8\uFF0C\u8BF7\u66F4\u65B0\u5E76\u91CD\u542F\u9152\u9986");
    if (selected()) await restore();
    const c = ctx();
    if (c.mainApi !== "openai" || !["custom", "openai", "claude", "makersuite"].includes(
      c.chatCompletionSettings.chat_completion_source
    ) || selected())
      throw new Error(
        "\u8BF7\u5148\u9009\u62E9 Custom\u3001OpenAI\u3001Claude \u6216 Google AI Studio \u8FDE\u63A5"
      );
  }
  bridge.cancel("connection_changed");
  await saveConfig({ nativeFirst: value, ...value ? { enabled: true } : {} });
  document.getElementById("api_button_openai")?.click();
  message(value ? "\u5DF2\u8054\u52A8\u539F\u751F\u8FDE\u63A5" : "\u5DF2\u5173\u95ED\u539F\u751F\u8FDE\u63A5\u8054\u52A8");
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
            "custom_include_headers"
          ].map((k) => [k, settings[k]])
        )
      }
    };
  }
  Object.assign(settings, {
    custom_url: ENDPOINT,
    custom_model: "failover-default",
    stream_openai: false,
    custom_include_body: "",
    custom_exclude_body: "",
    custom_include_headers: ""
  });
  config.enabled = true;
  config.nativeFirst = false;
  config = await bridge.api("/config", config);
  await c.executeSlashCommandsWithOptions("/api quiet=true custom");
  for (const [id, value] of [
    ["custom_api_url_text", ENDPOINT],
    ["custom_model_id", "failover-default"]
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
  message("\u5DF2\u4F7F\u7528\u6545\u969C\u8F6C\u79FB\u8FDE\u63A5");
}
async function restore() {
  bridge.cancel("connection_changed");
  const c = ctx();
  const previous = c.extensionSettings.silent_failover?.previous;
  if (!previous) {
    message("\u6CA1\u6709\u5DF2\u4FDD\u5B58\u7684\u539F\u8FDE\u63A5");
    return;
  }
  Object.assign(c.chatCompletionSettings, previous.values);
  c.saveSettingsDebounced();
  if (c.CONNECT_API_MAP[previous.api])
    await c.executeSlashCommandsWithOptions(`/api quiet=true ${previous.api}`);
  delete c.extensionSettings.silent_failover.previous;
  c.saveSettingsDebounced();
  message("\u5DF2\u6062\u590D\u539F\u8FDE\u63A5");
}
function labelInput(label, key, value, type = "text", extra = {}) {
  const box = el("label", { className: "sf-field" });
  box.append(el("span", {}, label));
  const input = el("input", { type, value: value ?? "", name: key, ...extra });
  input.classList.add("text_pole");
  box.append(input);
  return box;
}
function editor(node = {
  name: "",
  url: "",
  model: "",
  priority: config.nodes.length + 1,
  enabled: true,
  stream: true
}) {
  const area = root.querySelector("[data-editor]");
  area.replaceChildren();
  const form = el("form", { className: "sf-editor" });
  form.append(el("strong", {}, node.id ? "\u7F16\u8F91\u8282\u70B9" : "\u65B0\u589E\u8282\u70B9"));
  const fields = el("div", { className: "sf-fields" });
  const protocolField = el("label", { className: "sf-field" });
  const protocol = el("select", { name: "protocol", className: "text_pole" });
  protocol.setAttribute("aria-label", "API \u534F\u8BAE");
  for (const [value, name] of [
    ["openai", "OpenAI / \u517C\u5BB9\u63A5\u53E3"],
    ["claude", "Claude \u539F\u751F"],
    ["gemini", "Gemini \u539F\u751F"]
  ])
    protocol.append(
      el(
        "option",
        { value, selected: (node.protocol || "openai") === value },
        name
      )
    );
  protocolField.append(el("span", {}, "API \u534F\u8BAE"), protocol);
  fields.append(protocolField);
  fields.append(
    labelInput("\u540D\u79F0", "name", node.name, "text", {
      required: true,
      maxLength: 100
    }),
    labelInput("\u6A21\u578B ID", "model", node.model, "text", {
      required: true,
      maxLength: 200
    }),
    labelInput("API \u5730\u5740", "url", node.url, "url", {
      required: true,
      placeholder: "https://api.example.com/v1"
    }),
    labelInput(
      node.keySet ? "API Key\uFF08\u7559\u7A7A\u4FDD\u7559\uFF09" : "API Key",
      "key",
      "",
      "password",
      { autocomplete: "new-password" }
    ),
    labelInput("\u4F18\u5148\u7EA7", "priority", node.priority, "number", {
      min: 0,
      max: 99999,
      required: true
    }),
    labelInput("\u8282\u70B9\u8F93\u51FA\u4E0A\u9650", "maxTokens", node.maxTokens, "number", {
      min: 1,
      max: 2e6,
      step: 1,
      placeholder: "\u8DDF\u968F\u9152\u9986"
    })
  );
  const stream = el("label", { className: "sf-check" });
  const streamInput = el("input", {
    type: "checkbox",
    name: "stream",
    checked: node.stream !== false
  });
  stream.append(streamInput, document.createTextNode("\u4E0A\u6E38\u4F7F\u7528\u6D41\u5F0F\u8BF7\u6C42"));
  fields.append(stream);
  form.append(fields);
  const actions = el("div", { className: "sf-actions" });
  const save = el(
    "button",
    { type: "submit", className: "menu_button" },
    "\u4FDD\u5B58\u8282\u70B9"
  );
  actions.append(
    save,
    button("xmark", "\u53D6\u6D88\u7F16\u8F91", () => area.replaceChildren())
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
          maxTokens: data.get("maxTokens") === "" ? null : Number(data.get("maxTokens")),
          stream: streamInput.checked
        };
        const nodes = [...config.nodes];
        const i = nodes.findIndex((n) => n.id === node.id);
        if (i >= 0) nodes[i] = updated;
        else nodes.push(updated);
        config = await bridge.api("/config", { ...config, nodes });
        area.replaceChildren();
        render();
        message("\u8282\u70B9\u5DF2\u4FDD\u5B58");
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
  const supported = ctx().mainApi === "openai" && ["custom", "openai", "claude", "makersuite"].includes(source) && !selected();
  const row = el("div", { className: "sf-native" });
  const text = el("div", { className: "sf-node-text" });
  text.append(el("strong", {}, "\u9996\u9009 \xB7 \u9152\u9986\u539F\u751F\u8FDE\u63A5"));
  if (supported) {
    const model = settings[{
      custom: "custom_model",
      openai: "openai_model",
      claude: "claude_model",
      makersuite: "google_model"
    }[source]];
    const url = source === "custom" ? settings.custom_url : settings.reverse_proxy || {
      openai: "https://api.openai.com/v1",
      claude: "https://api.anthropic.com/v1",
      makersuite: "https://generativelanguage.googleapis.com"
    }[source];
    text.append(
      el("span", {}, model || "\u672A\u9009\u62E9\u6A21\u578B"),
      el("small", { className: "sf-muted" }, url || "\u672A\u8BBE\u7F6E\u5730\u5740"),
      el("small", { className: "sf-muted" }, "\u4F7F\u7528\u9152\u9986\u5F53\u524D\u5BC6\u94A5")
    );
  } else {
    text.append(
      el(
        "span",
        {},
        "\u5F53\u524D\u8FDE\u63A5\u4E0D\u652F\u6301\u8054\u52A8\uFF1A\u652F\u6301 Custom\u3001OpenAI\u3001Claude\u3001Google AI Studio"
      )
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
    ["enabled", "\u542F\u7528\u6545\u969C\u8F6C\u79FB"],
    ["loop", "\u81EA\u52A8\u5FAA\u73AF\u91CD\u8BD5"]
  ]) {
    const wrap = el("label", { className: "sf-check" });
    const input = el("input", { type: "checkbox", checked: config[key] });
    input.setAttribute("aria-label", label);
    input.onchange = () => void guarded(() => saveConfig({ [key]: input.checked }));
    wrap.append(input, document.createTextNode(label));
    controls.append(wrap);
  }
  const native = el("label", { className: "sf-check" });
  const nativeInput = el("input", {
    type: "checkbox",
    checked: config.nativeFirst
  });
  nativeInput.setAttribute("aria-label", "\u539F\u751F\u8FDE\u63A5\u4F18\u5148");
  nativeInput.onchange = () => void guarded(async () => {
    try {
      await setNativeFirst(nativeInput.checked);
    } finally {
      render();
    }
  });
  native.append(nativeInput, document.createTextNode("\u539F\u751F\u8FDE\u63A5\u4F18\u5148"));
  controls.append(native);
  renderNative();
  const interval = labelInput(
    "\u8F6E\u6B21\u95F4\u9694\uFF08\u79D2\uFF09",
    "intervalSeconds",
    config.intervalSeconds,
    "number",
    { min: 1, max: 3600 }
  );
  interval.querySelector("input").onchange = (e) => void guarded(() => saveConfig({ intervalSeconds: Number(e.target.value) }));
  controls.append(interval);
  const nodes = root.querySelector("[data-nodes]");
  nodes.replaceChildren();
  if (!config.nodes.length)
    nodes.append(el("p", { className: "sf-muted" }, "\u6682\u65E0 API \u8282\u70B9"));
  const sorted = [...config.nodes].sort((a, b) => a.priority - b.priority);
  sorted.forEach((n, index) => {
    const row = el("div", { className: "sf-node" });
    const enabled = el("input", {
      type: "checkbox",
      checked: n.enabled,
      title: "\u542F\u7528 " + n.name
    });
    enabled.setAttribute("aria-label", "\u542F\u7528 " + n.name);
    enabled.onchange = () => void guarded(
      () => saveConfig({
        nodes: config.nodes.map(
          (x) => x.id === n.id ? { ...x, enabled: enabled.checked } : x
        )
      })
    );
    const text = el("div", { className: "sf-node-text" });
    text.append(
      el("strong", {}, `${n.priority}. ${n.name}`),
      el("span", { className: "sf-muted" }, n.model),
      el("small", { className: "sf-muted" }, n.url),
      el("small", {}, n.keyHint || "\u672A\u8BBE\u7F6E Key")
    );
    const actions = el("div", { className: "sf-row-actions" });
    const move = (dir) => void guarded(async () => {
      const other = index + dir;
      if (other < 0 || other >= sorted.length) return;
      [sorted[index], sorted[other]] = [sorted[other], sorted[index]];
      await saveConfig({
        nodes: sorted.map((x, i) => ({ ...x, priority: i + 1 }))
      });
    });
    const up = button("arrow-up", "\u4E0A\u79FB " + n.name, () => move(-1));
    up.disabled = index === 0;
    const down = button("arrow-down", "\u4E0B\u79FB " + n.name, () => move(1));
    down.disabled = index === sorted.length - 1;
    const test = button(
      "flask",
      "\u6D4B\u8BD5 " + n.name + "\uFF08\u53D1\u9001\u4E00\u6B21 API \u8BF7\u6C42\uFF09",
      () => void guarded(async () => {
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
      })
    );
    actions.append(
      up,
      down,
      button("pen", "\u7F16\u8F91 " + n.name, () => editor(n)),
      test,
      button(
        "trash",
        "\u5220\u9664 " + n.name,
        () => void guarded(async () => {
          const result = await ctx().Popup.show.confirm("\u5220\u9664\u8282\u70B9", n.name);
          if (result === ctx().POPUP_RESULT.AFFIRMATIVE)
            await saveConfig({
              nodes: config.nodes.filter((x) => x.id !== n.id)
            });
        })
      )
    );
    row.append(enabled, text, actions);
    nodes.append(row);
  });
  const advanced = root.querySelector("[data-advanced]");
  advanced.replaceChildren();
  for (const [key, label, min, max] of [
    ["timeoutSeconds", "\u5355\u8282\u70B9\u603B\u8D85\u65F6\uFF08\u79D2\uFF09", 1, 3600],
    ["headerSeconds", "\u54CD\u5E94\u5934\u8D85\u65F6\uFF08\u79D2\uFF09", 1, 600],
    ["firstTokenSeconds", "\u9996\u6570\u636E\u8D85\u65F6\uFF08\u79D2\uFF09", 1, 600],
    ["idleSeconds", "\u6570\u636E\u95F4\u9694\u8D85\u65F6\uFF08\u79D2\uFF09", 1, 600]
  ]) {
    const field = labelInput(label, key, config[key], "number", { min, max });
    field.querySelector("input").onchange = (e) => void guarded(async () => {
      if (!e.target.value || !e.target.checkValidity()) {
        recordEvent("timeout_setting_rejected");
        e.target.value = config[key];
        throw new Error(`${label}\u5141\u8BB8 ${min}-${max}\uFF0C\u672A\u4FDD\u5B58\u8BE5\u4FEE\u6539`);
      }
      await saveConfig({ [key]: Number(e.target.value) });
    });
    advanced.append(field);
  }
}
async function refreshRecords() {
  if (!root?.isConnected) return;
  let records = [];
  try {
    records = await bridge.api("/records");
  } catch {
  }
  const area = root.querySelector("[data-records]");
  const open = new Set(
    [...area.querySelectorAll("details[open]")].map((x) => x.dataset.id)
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
        STATES[r.state] || r.state
      ),
      el(
        "span",
        {},
        r.round ? `\u7B2C ${r.round} \u8F6E \xB7 \u7D2F\u8BA1\u5C1D\u8BD5 ${r.attemptCount} \u6B21` : ""
      )
    );
    detail.append(summary);
    if (r.generation)
      detail.append(
        el(
          "p",
          { className: "sf-muted" },
          `\u751F\u6210\u7C7B\u578B\uFF1A${{ normal: "\u804A\u5929\u56DE\u590D", quiet: "\u540E\u53F0\u751F\u6210\uFF08\u4E0D\u65B0\u589E\u804A\u5929\u6D88\u606F\uFF09", regenerate: "\u91CD\u65B0\u751F\u6210", swipe: "\u5207\u6362\u5019\u9009", continue: "\u7EE7\u7EED\u751F\u6210", impersonate: "\u4EE3\u5199\u7528\u6237\u6D88\u606F", unknown: "\u672A\u8BC6\u522B" }[r.generation] || "\u672A\u8BC6\u522B"}`
        )
      );
    if (r.state === "succeeded") {
      const stages = new Set((r.clientEvents || []).map((e) => e.stage));
      detail.append(
        el(
          "p",
          {},
          r.mode === "node_test" ? "\u8282\u70B9\u6D4B\u8BD5\u5B8C\u6210\uFF0C\u4E0D\u53D1\u9001\u5230\u804A\u5929" : stages.has("client_failed") ? "\u6D4F\u89C8\u5668\u62A5\u544A\u4EA4\u4ED8\u5931\u8D25" : stages.has("response_prepared") ? "\u5DF2\u51C6\u5907\u9152\u9986\u54CD\u5E94\uFF08\u4E0D\u4EE3\u8868\u804A\u5929\u5DF2\u663E\u793A\uFF09" : stages.has("browser_received") ? "\u6D4F\u89C8\u5668\u5DF2\u6536\u5230\u7ED3\u679C" : "\u5C1A\u65E0\u6D4F\u89C8\u5668\u63A5\u6536\u786E\u8BA4\uFF1B\u65E7\u65E5\u5FD7\u4E0D\u5305\u542B\u4EA4\u4ED8\u4FE1\u606F"
        )
      );
    }
    if (r.mode)
      detail.append(
        el(
          "p",
          { className: "sf-muted" },
          {
            node_test: "\u5355\u8282\u70B9\u6D4B\u8BD5",
            native_first: "\u539F\u751F\u4F18\u5148\uFF0C\u518D\u5C1D\u8BD5\u5907\u7528\u8282\u70B9",
            fallback: "\u4EC5\u4F7F\u7528\u5907\u7528\u8282\u70B9"
          }[r.mode] || r.mode
        )
      );
    if (["running", "waiting"].includes(r.state))
      detail.append(
        button(
          "stop",
          "\u505C\u6B62\u6B64\u4EFB\u52A1",
          () => void guarded(async () => {
            await bridge.api("/jobs/" + r.id + "/cancel", {
              reason: "user_cancel"
            });
            await refreshRecords();
          })
        )
      );
    if (r.reason)
      detail.append(
        el(
          "p",
          {},
          r.reason === "\u5DF2\u505C\u6B62" ? "\u65E7\u7248\u8BB0\u5F55\u672A\u4FDD\u5B58\u5177\u4F53\u53D6\u6D88\u6765\u6E90" : r.reason
        )
      );
    if (r.nextAttemptAt)
      detail.append(
        el(
          "p",
          {},
          `\u4E0B\u4E00\u6B21\u5C1D\u8BD5\u7EA6\u5728 ${Math.max(0, Math.ceil((r.nextAttemptAt - Date.now()) / 1e3))} \u79D2\u540E`
        )
      );
    if (r.dropped)
      detail.append(
        el("p", { className: "sf-muted" }, `\u66F4\u65E9\u7684 ${r.dropped} \u6761\u8BE6\u60C5\u5DF2\u6E05\u7406`)
      );
    for (const a of r.attempts || []) {
      const line = el("div", { className: "sf-attempt" });
      line.append(
        el("strong", {}, `\u7B2C ${a.round} \u8F6E \xB7 ${a.node} \xB7 ${a.model}`),
        el(
          "span",
          {},
          `${STATES[a.state] || a.state}${a.status ? ` \xB7 HTTP ${a.status}` : ""} \xB7 \u8017\u65F6 ${((a.ms ?? 0) / 1e3).toFixed(1)} \u79D2`
        )
      );
      for (const adjustment of a.adjustments || [])
        line.append(
          el(
            "p",
            { className: "sf-muted" },
            `${adjustment.parameter === "temperature" ? "\u6E29\u5EA6" : "\u8F93\u51FA\u4E0A\u9650"}\uFF1A${adjustment.from ?? "\u9ED8\u8BA4"} \u2192 ${adjustment.to}\uFF08${adjustment.reason}\uFF09`
          )
        );
      if (a.message)
        line.append(
          el(
            "pre",
            {},
            `${a.category} / ${a.phase}
${a.code || ""} ${a.message}`
          )
        );
      if (a.diagnostics) {
        const d = a.diagnostics, c = d.completion, t = d.timeouts;
        line.append(
          el(
            "p",
            { className: "sf-muted" },
            `${d.protocol || "unknown"} \xB7 ${d.stream ? "\u4E0A\u6E38\u6D41\u5F0F" : "\u4E0A\u6E38\u975E\u6D41\u5F0F"} \xB7 HTTP ${d.httpStatus ?? "\u672A\u6536\u5230"} \xB7 ${d.contentType || "\u672A\u6536\u5230\u54CD\u5E94\u5934"} \xB7 ${d.bytes ?? 0} \u5B57\u8282`
          )
        );
        if (d.headersMs != null)
          line.append(
            el(
              "p",
              {},
              `\u54CD\u5E94\u5934 ${d.headersMs} ms \xB7 \u9996\u6570\u636E ${d.firstDataMs ?? "\u672A\u6536\u5230"} ms`
            )
          );
        if (c)
          line.append(
            el(
              "p",
              {},
              `\u6B63\u6587 ${c.textChars} \u5B57\u7B26 \xB7 \u63A8\u7406 ${c.reasoningChars} \u5B57\u7B26 \xB7 \u7ED3\u675F\u539F\u56E0 ${c.finishReason}${c.refusal ? " \xB7 \u62D2\u7B54" : ""}`
            )
          );
        if (d.bodyShape) line.append(el("p", {}, `\u54CD\u5E94\u7ED3\u6784\uFF1A${d.bodyShape}`));
        if (t)
          line.append(
            el(
              "p",
              { className: "sf-muted" },
              `\u5B9E\u9645\u8D85\u65F6\uFF08\u79D2\uFF09\uFF1A\u603B\u8BA1 ${t.timeoutSeconds} / \u54CD\u5E94\u5934 ${t.headerSeconds} / \u9996\u6570\u636E ${t.firstTokenSeconds} / \u95F4\u9694 ${t.idleSeconds}`
            )
          );
      }
      detail.append(line);
    }
    area.append(detail);
  }
  if (!area.children.length)
    area.append(el("p", { className: "sf-muted" }, "\u6682\u65E0\u8BF7\u6C42\u8BB0\u5F55"));
}
async function exportDiagnostics() {
  const data = await bridge.api("/diagnostics");
  data.frontendVersion = VERSION;
  data.browserEvents = browserEvents;
  data.localRecords = localRecords;
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(data, null, 2)], { type: "application/json" })
  );
  const a = el("a", {
    href: url,
    download: `silent-failover-diagnostics-${(/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-")}.json`
  });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1e3);
}
async function updatePlugin() {
  const b = root.querySelector("[data-update]");
  b.disabled = true;
  try {
    if (!config?.updateSupported)
      throw new Error(
        "\u5F53\u524D\u670D\u52A1\u7AEF\u5C1A\u4E0D\u652F\u6301\u4E00\u952E\u66F4\u65B0\uFF0C\u8BF7\u5148\u624B\u52A8\u5B89\u88C5 1.2.0 \u6216\u66F4\u65B0\u7248\u672C\u5E76\u91CD\u542F\u9152\u9986"
      );
    message("\u6B63\u5728\u68C0\u67E5\u5E76\u66F4\u65B0\u524D\u540E\u7AEF\u2026");
    let state = await bridge.api("/update", {});
    while (state.state === "updating") {
      await new Promise((r) => setTimeout(r, 1e3));
      state = await bridge.api("/update/status");
    }
    if (state.state === "failed") throw new Error(state.error);
    message(
      state.restartRequired ? `\u5DF2\u5B89\u88C5 ${state.installedVersion}\uFF0C\u8BF7\u91CD\u542F\u9152\u9986\u540E\u53F0\u5E76\u5237\u65B0\u9875\u9762` : `\u5DF2\u662F\u6700\u65B0\u6B63\u5F0F\u7248 ${state.runningVersion}`
    );
  } finally {
    b.disabled = false;
  }
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
      length: c.chat.length
    };
  }
}
async function restoreFailed(s) {
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
      Math.min(m.swipe_id ?? 0, (m.swipes?.length ?? 1) - 1)
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
  root.innerHTML = `<div class="inline-drawer"><div class="inline-drawer-toggle inline-drawer-header"><b>\u9759\u9ED8 API \u6545\u969C\u8F6C\u79FB</b><div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div></div><div class="inline-drawer-content"><div class="sf-actions" data-actions></div><p class="sf-muted" data-status></p><div class="sf-controls" data-controls></div><div data-editor></div><div data-native></div><div data-nodes></div><details><summary>\u8D85\u65F6\u8BBE\u7F6E</summary><div class="sf-fields" data-advanced></div></details><details data-history><summary>\u8BF7\u6C42\u8BB0\u5F55</summary><div class="sf-actions" data-log-actions></div><div data-records></div></details></div></div>`;
  document.getElementById("extensions_settings2").append(root);
  const actions = root.querySelector("[data-actions]");
  const connectButton = el(
    "button",
    { type: "button", className: "menu_button" },
    "\u4EC5\u4F7F\u7528\u5907\u7528\u8282\u70B9"
  );
  connectButton.onclick = () => void guarded(connect);
  actions.append(
    connectButton,
    button("rotate-left", "\u6062\u590D\u539F\u8FDE\u63A5", () => void guarded(restore)),
    button("plus", "\u65B0\u589E\u8282\u70B9", () => {
      if (config) editor();
    }),
    button(
      "rotate",
      "\u5237\u65B0\u914D\u7F6E",
      () => void guarded(async () => {
        config = await bridge.api("/config");
        render();
        message("\u670D\u52A1\u7AEF\u5DF2\u8FDE\u63A5");
      })
    )
  );
  const update = button(
    "download",
    "\u4E00\u952E\u66F4\u65B0\u63D2\u4EF6",
    () => void guarded(updatePlugin)
  );
  update.dataset.update = "";
  actions.append(update);
  root.querySelector("[data-log-actions]").append(
    button("rotate", "\u5237\u65B0\u8BB0\u5F55", () => void refreshRecords()),
    button("download", "\u5BFC\u51FA\u8BCA\u65AD\u65E5\u5FD7", () => void guarded(exportDiagnostics)),
    button(
      "trash",
      "\u6E05\u7A7A\u5DF2\u7ED3\u675F\u8BB0\u5F55",
      () => void guarded(async () => {
        await bridge.api("/records/clear", {});
        localRecords.length = 0;
        browserEvents.length = 0;
        await refreshRecords();
      })
    )
  );
  watch(ctx().eventTypes.GENERATION_STARTED, capture);
  for (const name of [
    "GENERATION_STARTED",
    "GENERATION_ENDED",
    "MESSAGE_RECEIVED",
    "CHARACTER_MESSAGE_RENDERED"
  ]) {
    const event = ctx().eventTypes[name];
    if (event) watch(event, () => recordEvent(name.toLowerCase()));
  }
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
    message(
      `\u524D\u7AEF ${VERSION} \xB7 \u670D\u52A1\u7AEF ${config.version || "\u672A\u77E5"}${config.version !== VERSION ? " \xB7 \u8BF7\u540C\u6B65\u5347\u7EA7\u4E24\u90E8\u5206" : " \xB7 \u5DF2\u8FDE\u63A5"}`
    );
    root.querySelector("[data-update]").disabled = config.canUpdate === false;
    if (config.updateSupported) {
      const state = await bridge.api("/update/status");
      if (state.restartRequired)
        message(`\u5DF2\u5B89\u88C5 ${state.installedVersion}\uFF0C\u8BF7\u91CD\u542F\u9152\u9986\u540E\u53F0\u5E76\u5237\u65B0\u9875\u9762`);
      else if (state.state === "failed") message(state.error);
      else if (state.state === "updating")
        message("\u63D2\u4EF6\u66F4\u65B0\u6B63\u5728\u8FDB\u884C\uFF0C\u8BF7\u7A0D\u540E\u67E5\u770B");
    }
  });
}
async function onDisable() {
  if (bridge && config)
    await bridge.api("/config", { ...config, enabled: false }).catch(() => {
    });
  if (selected()) await restore().catch(() => {
  });
  bridge?.dispose();
  clearInterval(refreshTimer);
  for (const [event, fn] of subscriptions.splice(0)) {
    if (event === "pagehide") window.removeEventListener(event, fn);
    else ctx().eventSource.removeListener(event, fn);
  }
  root?.remove();
}
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
    failed: restoreFailed
  }
);
ctx().eventSource.on(ctx().eventTypes.APP_READY, () => {
  void boot();
});
export {
  onDisable
};
