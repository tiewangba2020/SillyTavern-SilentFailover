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
    if (disposed || url.origin !== location.origin || url.pathname !== "/api/backends/chat-completions/generate")
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
    const settings = await api("/config").catch(
      () => lifecycle.config?.() || null
    );
    if (!settings?.enabled) return previous(input, init);
    const nativeFirst = settings.nativeFirst !== false;
    const id = crypto.randomUUID();
    const saved = lifecycle.start?.();
    const preferredNodeId = lifecycle.takePreferredNode?.(saved?.type);
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
            {
              id,
              request: body,
              nativeFirst,
              generation: saved?.type,
              preferredNodeId
            },
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
var VERSION = "1.4.2";

// extension/panel.js
var make = (tag, cls, text) => {
  const element = document.createElement(tag);
  element.className = cls;
  if (text !== void 0) element.textContent = text;
  return element;
};
var icon = (name, title, action, touchLabel) => {
  const b = make("button", "sf-panel-icon");
  b.type = "button";
  b.title = title;
  b.setAttribute("aria-label", title);
  b.append(make("i", `fa-solid fa-${name}`));
  b.firstChild.setAttribute("aria-hidden", "true");
  if (touchLabel) b.append(make("span", "sf-action-label", touchLabel));
  b.onclick = action;
  return b;
};
function createTaskPanel(api, openRecords) {
  const panel2 = make("section", "sf-task-panel");
  panel2.setAttribute("aria-label", "API\u8FD8\u6CA1\u6302\u4EFB\u52A1");
  const header = make("header", "sf-panel-header");
  const title = make("strong", "", "API\u8FD8\u6CA1\u6302");
  header.append(make("i", "fa-solid fa-shuffle"), title);
  const body = make("div", "sf-panel-body");
  let hidden = false, collapsed = false, suppressPointerClick = false, selectedId, preferredNodeId = "", chooserContext, config2, records = [], lastConfigVisible = false;
  const collapse = icon(
    "minus",
    "\u6536\u8D77\u60AC\u6D6E\u7A97",
    () => {
      const previous = panel2.getBoundingClientRect();
      collapsed = !collapsed;
      panel2.dataset.collapsed = String(collapsed);
      body.hidden = collapsed;
      collapse.title = collapsed ? "\u5C55\u5F00\u60AC\u6D6E\u7A97" : "\u6536\u8D77\u60AC\u6D6E\u7A97";
      collapse.setAttribute("aria-label", collapse.title);
      collapse.firstChild.className = `fa-solid fa-${collapsed ? "plus" : "minus"}`;
      collapse.querySelector(".sf-action-label").textContent = collapsed ? "\u5C55\u5F00" : "\u6536\u8D77";
      collapse.setAttribute("aria-expanded", String(!collapsed));
      panel2.style.left = `${previous.right - panel2.offsetWidth}px`;
      clamp();
    },
    "\u6536\u8D77"
  );
  collapse.setAttribute("aria-expanded", "true");
  collapse.classList.add("sf-panel-collapse");
  header.append(
    collapse,
    icon(
      "xmark",
      "\u5173\u95ED\u60AC\u6D6E\u7A97",
      () => {
        hidden = true;
        panel2.hidden = true;
      },
      "\u5173\u95ED"
    )
  );
  const tasks = make("select", "sf-panel-select");
  tasks.setAttribute("aria-label", "\u5F53\u524D\u751F\u6210\u4EFB\u52A1");
  tasks.onchange = () => {
    selectedId = tasks.value;
    render2();
  };
  const status = make("div", "sf-panel-state", "\u6682\u65E0\u751F\u6210\u4EFB\u52A1");
  status.setAttribute("role", "status");
  const node = make("strong", "sf-panel-node");
  const model = make("div", "sf-panel-model");
  const stats = make("div", "sf-panel-stats");
  const choose = make("select", "sf-panel-select");
  choose.setAttribute("aria-label", "\u5207\u6362\u5230 API");
  const targetLabel = make("label", "sf-panel-target");
  const targetText = make("span", "", "\u4E0B\u6B21\u4F18\u5148 API");
  targetLabel.append(targetText, choose);
  const actions = make("div", "sf-panel-actions");
  let commandBusy = false, commandError = "";
  const command = async (suffix, data) => {
    if (!selectedId || commandBusy) return;
    commandBusy = true;
    commandError = "";
    switchButton.disabled = stop.disabled = true;
    try {
      await api(`/jobs/${selectedId}/${suffix}`, data);
      status.textContent = suffix === "switch" ? "\u6B63\u5728\u5207\u6362\u8282\u70B9" : "\u6B63\u5728\u505C\u6B62\u751F\u6210";
    } catch (e) {
      commandError = e.message;
    } finally {
      commandBusy = false;
      render2();
    }
  };
  const switchButton = icon("right-left", "\u5207\u6362 API", () => {
    if (panel2.dataset.state === "running" || panel2.dataset.state === "waiting") {
      void command("switch", { nodeId: choose.value });
    } else {
      preferredNodeId = choose.value;
      render2();
    }
  });
  switchButton.classList.add("sf-panel-switch");
  const switchText = make("span", "", "\u5207\u6362 API");
  switchButton.append(switchText);
  choose.onchange = () => {
    commandError = "";
    choose.title = choose.selectedOptions[0]?.textContent || "";
    render2();
  };
  const stop = icon(
    "stop",
    "\u505C\u6B62\u751F\u6210",
    () => void command("cancel", { reason: "panel_stop" }),
    "\u505C\u6B62\u751F\u6210"
  );
  stop.classList.add("sf-panel-stop");
  actions.append(targetLabel, switchButton, stop);
  body.append(tasks, status, node, model, stats, actions);
  panel2.append(header, body);
  document.body.append(panel2);
  panel2.hidden = true;
  const notice = make("aside", "sf-task-notice");
  const noticeText = make("button", "sf-notice-text");
  noticeText.type = "button";
  noticeText.onclick = openRecords;
  notice.append(
    noticeText,
    icon(
      "xmark",
      "\u5173\u95ED\u63D0\u793A",
      () => {
        notice.hidden = true;
      },
      "\u5173\u95ED"
    )
  );
  document.body.append(notice);
  notice.hidden = true;
  let noticeTimer, initialized = false;
  const known = /* @__PURE__ */ new Map();
  function notify(jobs) {
    for (const job of jobs) {
      const signature = `${job.state}:${job.attemptCount}`;
      if (initialized && known.get(job.id) !== signature && job.mode !== "node_test" && job.generation !== "quiet") {
        if (job.state === "cancelled") notice.hidden = true;
        const failed = ["exhausted", "invalid"].includes(job.state);
        const progress = config2.notificationMode === "progress";
        if (config2.notificationMode !== "silent" && (failed || progress && job.state !== "cancelled")) {
          const a = job.attempts?.at(-1);
          const text = failed ? "\u672C\u6B21\u751F\u6210\u672A\u6210\u529F\uFF0C\u70B9\u51FB\u67E5\u770B\u8BB0\u5F55" : job.state === "succeeded" ? "\u5DF2\u53D6\u5F97\u5B8C\u6574\u56DE\u590D" : job.state === "waiting" ? `\u7B2C ${job.round} \u8F6E\u7ED3\u675F\uFF0C\u7B49\u5F85\u91CD\u8BD5` : `${a?.node || "API"} \xB7 \u7B2C ${job.round} \u8F6E\u5C1D\u8BD5\u4E2D`;
          if (!panel2.hidden && !failed) {
            notice.hidden = true;
          } else {
            noticeText.textContent = text;
            notice.dataset.state = failed ? "failed" : job.state;
            notice.hidden = false;
            clearTimeout(noticeTimer);
            if (!failed)
              noticeTimer = setTimeout(() => {
                notice.hidden = true;
              }, 5e3);
          }
        }
      }
      known.set(job.id, signature);
    }
    for (const id of known.keys())
      if (!jobs.some((j) => j.id === id)) known.delete(id);
    initialized = true;
    if (config2.notificationMode === "silent") notice.hidden = true;
  }
  function fill(select, entries, value) {
    const signature = JSON.stringify(entries);
    if (select.dataset.options !== signature) {
      select.replaceChildren(
        ...entries.map(([id, label]) => {
          const option = make("option", "", label);
          option.value = id;
          return option;
        })
      );
      select.dataset.options = signature;
      if (entries.some((e) => e[0] === value)) select.value = value;
    }
  }
  function render2() {
    const jobs = records.filter((j) => j.mode !== "node_test");
    const active = jobs.filter((j) => ["running", "waiting"].includes(j.state));
    let job = active.find((j) => j.id === selectedId) || active[0] || jobs.find((j) => j.id === selectedId);
    selectedId = job?.id;
    fill(
      tasks,
      active.map((j) => [
        j.id,
        `${new Date(j.started).toLocaleTimeString()} \xB7 ${j.generation || "\u751F\u6210"}`
      ]),
      selectedId
    );
    tasks.hidden = active.length < 2;
    const a = job?.attempts?.at(-1);
    const running = !!job && ["running", "waiting"].includes(job.state);
    const savedNodes = (config2?.nodes || []).filter((n) => n.enabled).sort((a2, b) => a2.priority - b.priority);
    if (preferredNodeId && !savedNodes.some((n) => n.id === preferredNodeId))
      preferredNodeId = "";
    const preferred = savedNodes.find((n) => n.id === preferredNodeId);
    panel2.dataset.state = job?.state || "idle";
    status.textContent = !job ? "\u6682\u65E0\u751F\u6210\u4EFB\u52A1" : {
      succeeded: "\u4E0A\u6E38\u5DF2\u5B8C\u6210",
      cancelled: "\u5DF2\u505C\u6B62",
      exhausted: "\u5C1D\u8BD5\u5DF2\u7ED3\u675F",
      invalid: "\u672A\u6267\u884C",
      waiting: "\u7B49\u5F85\u4E0B\u4E00\u8F6E"
    }[job.state] || (a?.diagnostics?.bytes ? "\u6B63\u5728\u63A5\u6536\u4E0A\u6E38\u6570\u636E" : "\u7B49\u5F85\u4E0A\u6E38\u54CD\u5E94");
    node.textContent = a?.node || "\u5C31\u7EEA";
    model.textContent = a ? `${a.model} \xB7 ${a.diagnostics?.stream !== false ? "\u6D41\u5F0F" : "\u975E\u6D41\u5F0F"}` : "";
    stats.textContent = job ? `\u7B2C ${job.round}${job.maxRounds ? " / " + job.maxRounds : ""} \u8F6E  \xB7  ${Math.max(0, Math.floor(((job.ended || Date.now()) - job.started) / 1e3))} \u79D2  \xB7  ${job.attemptCount} \u6B21\u5C1D\u8BD5` : "";
    if (!running && preferred) {
      status.textContent = "\u4E0B\u6B21\u751F\u6210\u5DF2\u5C31\u7EEA";
      node.textContent = preferred.name;
      model.textContent = `${preferred.model} \xB7 ${preferred.stream !== false ? "\u6D41\u5F0F" : "\u975E\u6D41\u5F0F"}`;
      stats.textContent = "\u4EC5\u4E0B\u4E00\u6B21\u751F\u6210\u4F18\u5148";
    }
    const nextContext = running ? job.id : "idle";
    const defaultTarget = running ? job.availableNodes?.find((n) => n.id !== a?.nodeId)?.id || "" : preferredNodeId;
    fill(
      choose,
      running ? job.availableNodes?.map((n) => [
        n.id,
        `${n.name} \xB7 ${n.stream !== false ? "\u6D41\u5F0F" : "\u975E\u6D41\u5F0F"} \xB7 ${n.model}`
      ]) || [] : [
        ["", "\u6309\u5DF2\u4FDD\u5B58\u7684\u4F18\u5148\u7EA7"],
        ...savedNodes.map((n) => [
          n.id,
          `${n.name} \xB7 ${n.stream !== false ? "\u6D41\u5F0F" : "\u975E\u6D41\u5F0F"} \xB7 ${n.model}`
        ])
      ],
      chooserContext === nextContext ? choose.value : defaultTarget
    );
    if (chooserContext !== nextContext) {
      choose.value = defaultTarget;
      commandError = "";
    }
    chooserContext = nextContext;
    choose.title = choose.selectedOptions[0]?.textContent || "";
    targetText.textContent = running ? "\u672C\u6B21\u5207\u6362\u5230" : "\u4E0B\u6B21\u4F18\u5148 API";
    switchText.textContent = running ? "\u5207\u6362 API" : "\u5E94\u7528\u4E8E\u4E0B\u6B21\u751F\u6210";
    switchButton.title = switchText.textContent;
    switchButton.setAttribute("aria-label", switchText.textContent);
    choose.disabled = commandBusy || !config2?.enabled;
    switchButton.disabled = commandBusy || !config2?.enabled || (running ? !choose.value || choose.value === a?.nodeId : choose.value === preferredNodeId);
    stop.disabled = !running || commandBusy;
    if (commandError) status.textContent = commandError;
    panel2.hidden = !config2?.floatingWindow || hidden;
    clamp();
  }
  function clamp() {
    if (panel2.hidden) return;
    if (!panel2.style.left) {
      panel2.style.right = panel2.style.bottom = "auto";
      panel2.style.left = `${innerWidth - panel2.offsetWidth - 16}px`;
      panel2.style.top = `${innerHeight - panel2.offsetHeight - 110}px`;
    }
    const box = panel2.getBoundingClientRect();
    panel2.style.left = `${Math.max(8, Math.min(box.left, innerWidth - box.width - 8))}px`;
    panel2.style.top = `${Math.max(8, Math.min(box.top, innerHeight - box.height - 100))}px`;
  }
  let drag;
  header.onpointerdown = (e) => {
    suppressPointerClick = false;
    const bubble = collapsed && panel2.offsetWidth <= 60;
    if (!bubble && e.target.closest("button") || e.button !== 0) return;
    const box = panel2.getBoundingClientRect();
    drag = {
      x: e.clientX - box.left,
      y: e.clientY - box.top,
      startX: e.clientX,
      startY: e.clientY,
      moved: false,
      bubble
    };
    (bubble ? collapse : header).setPointerCapture(e.pointerId);
  };
  header.onpointermove = (e) => {
    if (!drag) return;
    if (!drag.moved && Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) < 6)
      return;
    drag.moved = true;
    panel2.style.right = panel2.style.bottom = "auto";
    panel2.style.left = `${e.clientX - drag.x}px`;
    panel2.style.top = `${e.clientY - drag.y}px`;
    clamp();
  };
  header.onpointerup = header.onpointercancel = (e) => {
    if (drag?.bubble && drag.moved) {
      const box = panel2.getBoundingClientRect();
      panel2.style.left = `${box.left + box.width / 2 < innerWidth / 2 ? 8 : innerWidth - box.width - 8}px`;
      clamp();
      suppressPointerClick = true;
    } else if (drag?.bubble && e.type === "pointerup" && e.pointerType !== "mouse") {
      collapse.click();
      suppressPointerClick = true;
    }
    drag = null;
  };
  const resetPointerClick = () => {
    suppressPointerClick = false;
  };
  const discardPointerClick = (event) => {
    if (!suppressPointerClick || event.detail === 0) return;
    suppressPointerClick = false;
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  document.addEventListener("pointerdown", resetPointerClick, true);
  document.addEventListener("click", discardPointerClick, true);
  window.addEventListener("resize", clamp);
  return {
    takePreferredNode(generation) {
      if (generation === "quiet") return void 0;
      const id = preferredNodeId || void 0;
      preferredNodeId = "";
      chooserContext = void 0;
      render2();
      return id;
    },
    update(nextConfig, nextRecords) {
      config2 = nextConfig;
      records = nextRecords;
      if (config2.floatingWindow !== lastConfigVisible) hidden = false;
      lastConfigVisible = config2.floatingWindow;
      render2();
      notify(records);
    },
    show() {
      hidden = false;
      render2();
    },
    dispose() {
      clearTimeout(noticeTimer);
      window.removeEventListener("resize", clamp);
      document.removeEventListener("pointerdown", resetPointerClick, true);
      document.removeEventListener("click", discardPointerClick, true);
      panel2.remove();
      notice.remove();
    }
  };
}

// server/url.js
function completeApiUrl(value, protocol = "openai", enabled = true) {
  const url = new URL(value);
  let pathname = url.pathname.replace(/\/+$/, "");
  if (enabled && protocol !== "gemini" && !/\/v\d+(?:beta\d*|alpha\d*)?(?:\/|$)/i.test(pathname) && !/\/(?:chat\/completions|messages|responses)$/.test(pathname)) {
    pathname += "/v1";
  }
  url.pathname = pathname;
  return url.href.replace(/\/+$/, "");
}

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
var hostConnection;
var READY_STATUS = "API\u8FD8\u6CA1\u6302\u5C31\u7EEA";
var savedConfig;
var dirty = false;
var editorRead;
var panel;
var testControllers = /* @__PURE__ */ new Set();
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
function button(icon2, label, fn, touchLabel = label) {
  const b = el("button", {
    type: "button",
    className: "menu_button sf-icon",
    title: label
  });
  b.setAttribute("aria-label", label);
  b.append(el("i", { className: `fa-solid fa-${icon2}` }));
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
    message(e.message || "\u64CD\u4F5C\u5931\u8D25");
  }
}
function selected() {
  const c = ctx();
  return c.mainApi === "openai" && c.chatCompletionSettings.custom_url === ENDPOINT && c.chatCompletionSettings.chat_completion_source === "custom";
}
function nativeSelected() {
  const c = ctx();
  return savedConfig?.enabled && c.mainApi === "openai" && ["custom", "openai", "claude", "makersuite"].includes(
    c.chatCompletionSettings.chat_completion_source
  ) && !selected();
}
async function migrateLegacyConnection() {
  if (!selected()) return;
  bridge.cancel("connection_changed");
  const c = ctx();
  const previous = c.extensionSettings.silent_failover?.previous;
  Object.assign(
    c.chatCompletionSettings,
    previous?.values || { custom_url: "", custom_model: "" }
  );
  if (previous && c.CONNECT_API_MAP[previous.api])
    await c.executeSlashCommandsWithOptions(`/api quiet=true ${previous.api}`);
  if (c.extensionSettings.silent_failover)
    delete c.extensionSettings.silent_failover.previous;
  for (const [id, key] of [
    ["custom_api_url_text", "custom_url"],
    ["custom_model_id", "custom_model"]
  ]) {
    const field = document.getElementById(id);
    if (field) field.value = c.chatCompletionSettings[key] || "";
  }
  c.saveSettingsDebounced();
}
function updateReadiness() {
  if (!hostConnection) return;
  const available = nativeSelected() && (savedConfig.nativeFirst || savedConfig.nodes.some((n) => n.enabled));
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
      node.key || node.keySet ? "API Key\uFF08\u7559\u7A7A\u4FDD\u7559\uFF09" : "API Key",
      "key",
      "",
      "text",
      {
        autocomplete: "off",
        inputMode: "text",
        autocapitalize: "none",
        spellcheck: false,
        placeholder: node.key ? "\u5DF2\u586B\u5199\uFF0C\u4FDD\u5B58\u8BBE\u7F6E\u540E\u751F\u6548" : node.keySet ? "\u5DF2\u4FDD\u5B58\uFF0C\u7559\u7A7A\u4E0D\u66F4\u6362" : "\u586B\u5199 API Key"
      }
    ),
    labelInput("\u4F18\u5148\u7EA7", "priority", node.priority, "number", {
      min: 0,
      max: 99999,
      required: true
    })
  );
  fields.querySelector('[name="key"]').setAttribute("autocorrect", "off");
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
    "\u5E94\u7528\u8282\u70B9"
  );
  actions.append(
    save,
    button("xmark", "\u53D6\u6D88\u7F16\u8F91", () => {
      area.replaceChildren();
      editorRead = null;
    })
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
            config.autoCompleteUrl !== false
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
      stream: streamInput.checked
    };
  };
  const stage = () => {
    if (!form.reportValidity()) throw new Error("\u8BF7\u586B\u5199\u6709\u6548\u7684\u8282\u70B9\u8BBE\u7F6E");
    const updated = read();
    const i = config.nodes.findIndex((n) => n.id === node.id);
    if (i >= 0) config.nodes[i] = updated;
    else config.nodes.push(updated);
    editorRead = null;
    area.replaceChildren();
    dirty = true;
  };
  editorRead = stage;
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
    placeholder: "\u641C\u7D22\u53EF\u7528\u6A21\u578B"
  });
  search.setAttribute("aria-label", "\u641C\u7D22\u53EF\u7528\u6A21\u578B");
  const models = el("select", {
    id: "sf-model-options",
    className: "text_pole",
    size: 6
  });
  models.setAttribute("aria-label", "\u53EF\u7528\u6A21\u578B");
  const count = el("span", { className: "sf-muted", role: "status" });
  picker.append(search, count, models);
  let availableModels = [], lookupRevision = 0;
  const renderModels = () => {
    const query = search.value.trim().toLowerCase();
    const matches = availableModels.filter(
      (id) => id.toLowerCase().includes(query)
    );
    models.replaceChildren(
      ...matches.map((id) => el("option", { value: id, title: id }, id))
    );
    models.value = modelInput.value;
    count.textContent = matches.length ? `\u663E\u793A ${matches.length} / ${availableModels.length} \u4E2A\u6A21\u578B` : "\u6CA1\u6709\u5339\u914D\u7684\u6A21\u578B";
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
    "\u83B7\u53D6\u6A21\u578B\u5217\u8868",
    () => void guarded(async () => {
      modelButton.disabled = true;
      const revision = ++lookupRevision;
      availableModels = [];
      picker.hidden = true;
      models.replaceChildren();
      modelStatus.textContent = "\u6B63\u5728\u83B7\u53D6\u6A21\u578B\u2026";
      try {
        const result = await bridge.api("/models", {
          node: read(),
          settings: { autoCompleteUrl: config.autoCompleteUrl }
        });
        if (revision !== lookupRevision || !form.isConnected) return;
        availableModels = result.models;
        search.value = "";
        renderModels();
        picker.hidden = false;
        modelStatus.textContent = `\u5DF2\u83B7\u53D6 ${result.models.length} \u4E2A\u6A21\u578B${result.truncated ? "\uFF08\u5217\u8868\u5DF2\u622A\u65AD\uFF09" : ""}`;
      } catch (e) {
        if (revision === lookupRevision) modelStatus.textContent = e.message;
      } finally {
        if (revision === lookupRevision) modelButton.disabled = false;
      }
    })
  );
  for (const input of [
    protocol,
    form.querySelector('[name="url"]'),
    form.querySelector('[name="key"]')
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
      "\u6D4B\u8BD5\u5F53\u524D\u8282\u70B9\uFF08\u53D1\u9001\u4E00\u6B21 API \u8BF7\u6C42\uFF09",
      () => void runNodeTest(read()),
      "\u6D4B\u8BD5\u8FDE\u63A5"
    )
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
  root.querySelector("[data-dirty]").textContent = dirty ? "\u6709\u672A\u4FDD\u5B58\u7684\u4FEE\u6539" : "\u5DF2\u4FDD\u5B58";
}
async function commitSettings() {
  for (const input of root.querySelectorAll(
    '[data-controls] input[type="number"], [data-advanced] input[type="number"]'
  )) {
    if (!input.disabled && (!input.value || !input.reportValidity()))
      throw new Error("\u8BF7\u586B\u5199\u8303\u56F4\u5185\u7684\u6570\u503C\u8BBE\u7F6E");
  }
  editorRead?.();
  const content = root.querySelector(".inline-drawer-content");
  content.inert = true;
  let updated;
  try {
    updated = await bridge.api("/config", config);
  } finally {
    content.inert = false;
  }
  config = updated;
  savedConfig = structuredClone(updated);
  updateReadiness();
  dirty = false;
  render();
  markDirty();
  message("\u8BBE\u7F6E\u5DF2\u4FDD\u5B58");
}
async function runNodeTest(node) {
  const area = root.querySelector("[data-test]");
  if (testControllers.size) {
    message("\u5DF2\u6709\u8FDE\u901A\u6027\u6D4B\u8BD5\u6B63\u5728\u8FDB\u884C\uFF0C\u8BF7\u5148\u505C\u6B62");
    return;
  }
  const id = crypto.randomUUID(), controller = new AbortController();
  testControllers.add(controller);
  const started = Date.now();
  area.replaceChildren();
  const status = el("p", { role: "status" });
  const output = el("pre");
  const stop = button("stop", "\u505C\u6B62\u6D4B\u8BD5", () => controller.abort());
  area.append(
    el("strong", {}, `\u8FDE\u901A\u6027\u6D4B\u8BD5 \xB7 ${node.name || "\u5F53\u524D\u8282\u70B9"}`),
    status,
    stop,
    output
  );
  area.scrollIntoView({ block: "nearest" });
  const tick = () => {
    status.textContent = `\u6D4B\u8BD5\u4E2D \xB7 \u5DF2\u7B49\u5F85 ${Math.floor((Date.now() - started) / 1e3)} \u79D2`;
  };
  tick();
  const timer = setInterval(tick, 1e3);
  try {
    let job = await bridge.api(
      "/test",
      { id, node, settings: config },
      controller.signal
    );
    while (["running", "waiting"].includes(job.state)) {
      await new Promise((r) => setTimeout(r, 500));
      job = await bridge.api("/jobs/" + id, void 0, controller.signal);
    }
    clearInterval(timer);
    status.textContent = `${job.state === "succeeded" ? "\u6D4B\u8BD5\u6210\u529F" : job.state === "cancelled" ? "\u6D4B\u8BD5\u5DF2\u505C\u6B62" : "\u6D4B\u8BD5\u5931\u8D25"} \xB7 ${((Date.now() - started) / 1e3).toFixed(1)} \u79D2 \xB7 ${node.model}`;
    output.textContent = job.state === "succeeded" ? (job.result?.choices?.[0]?.message?.content || "\u65E0\u6B63\u6587\uFF0C\u67E5\u770B\u7ED3\u675F\u539F\u56E0").slice(0, 500) : job.attempts?.at(-1)?.message || job.reason || "\u672A\u53D6\u5F97\u56DE\u590D";
    if (job.state === "succeeded") await bridge.api("/jobs/" + id + "/ack", {});
  } catch (e) {
    clearInterval(timer);
    status.textContent = controller.signal.aborted ? "\u6D4B\u8BD5\u5DF2\u505C\u6B62" : "\u6D4B\u8BD5\u5931\u8D25";
    output.textContent = controller.signal.aborted ? "" : e.message;
    await bridge.api("/jobs/" + id + "/cancel", { reason: "user_cancel" }).catch(() => {
    });
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
  const supported = ctx().mainApi === "openai" && ["custom", "openai", "claude", "makersuite"].includes(source) && !selected();
  const row = el("div", { className: "sf-native" });
  const text = el("div", { className: "sf-node-text" });
  text.append(el("strong", {}, "\u9152\u9986\u539F\u751F API"));
  const enabled = el("input", {
    type: "checkbox",
    checked: config.nativeFirst !== false
  });
  enabled.setAttribute("aria-label", "\u542F\u7528 \u9152\u9986\u539F\u751F API");
  enabled.onchange = () => void saveConfig({ nativeFirst: enabled.checked });
  text.append(
    el(
      "small",
      { className: "sf-muted" },
      settings.stream_openai ? "\u6D41\u5F0F\u8BF7\u6C42" : "\u975E\u6D41\u5F0F\u8BF7\u6C42"
    )
  );
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
  row.append(enabled, text);
  area.append(row);
}
function render() {
  if (!config) return;
  const controls = root.querySelector("[data-controls]");
  controls.replaceChildren();
  for (const [key, label] of [
    ["enabled", "\u542F\u7528\u6545\u969C\u8F6C\u79FB"],
    ["loop", "\u81EA\u52A8\u5FAA\u73AF\u91CD\u8BD5"],
    ["autoCompleteUrl", "\u81EA\u52A8\u8865\u5168 API \u5730\u5740"]
  ]) {
    const wrap = el("label", { className: "sf-check" });
    const input = el("input", { type: "checkbox", checked: config[key] });
    input.setAttribute("aria-label", label);
    input.onchange = () => void guarded(() => saveConfig({ [key]: input.checked }));
    wrap.append(input, document.createTextNode(label));
    controls.append(wrap);
  }
  renderNative();
  const interval = labelInput(
    "\u8F6E\u6B21\u95F4\u9694\uFF08\u79D2\uFF09",
    "intervalSeconds",
    config.intervalSeconds,
    "number",
    { min: 1, max: 3600 }
  );
  interval.querySelector("input").oninput = (e) => {
    config.intervalSeconds = Number(e.target.value);
    dirty = true;
    markDirty();
  };
  controls.append(interval);
  const rounds = labelInput(
    "\u603B\u8F6E\u6B21\u4E0A\u9650\uFF080 \u4E0D\u9650\uFF09",
    "maxRounds",
    config.maxRounds ?? 0,
    "number",
    { min: 0, max: 1e4, step: 1 }
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
      "\u63D0\u793A\u65B9\u5F0F",
      [
        ["silent", "\u5B8C\u5168\u9759\u9ED8"],
        ["failure", "\u4EC5\u6700\u7EC8\u5931\u8D25\u63D0\u793A"],
        ["progress", "\u663E\u793A\u5207\u6362\u8FC7\u7A0B"]
      ]
    ],
    [
      "waitMode",
      "\u7B49\u5F85\u7B56\u7565",
      [
        ["patient", "\u8010\u5FC3\u7B49\u5F85"],
        ["limited", "\u9650\u65F6\u5207\u6362"]
      ]
    ]
  ]) {
    const label = el("label", { className: "sf-field" });
    const select = el("select", { className: "text_pole", name: key });
    select.setAttribute("aria-label", title);
    label.append(el("span", {}, title), select);
    for (const [value, text] of options)
      select.append(
        el("option", { value, selected: config[key] === value }, text)
      );
    select.onchange = () => void saveConfig({ [key]: select.value });
    controls.append(label);
  }
  const floatLabel = el("label", { className: "sf-check" });
  const floatInput = el("input", {
    type: "checkbox",
    checked: config.floatingWindow
  });
  floatInput.onchange = () => void saveConfig({ floatingWindow: floatInput.checked });
  floatLabel.append(floatInput, document.createTextNode("\u663E\u793A\u60AC\u6D6E\u7A97"));
  controls.append(floatLabel);
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
      el(
        "small",
        { className: "sf-stream" },
        n.stream !== false ? "\u6D41\u5F0F\u8BF7\u6C42" : "\u975E\u6D41\u5F0F\u8BF7\u6C42"
      ),
      el("small", { className: "sf-muted" }, n.url),
      el(
        "small",
        {},
        n.key ? "Key \u5DF2\u586B\u5199\uFF08\u5F85\u4FDD\u5B58\uFF09" : n.keySet ? `Key \u5DF2\u4FDD\u5B58${n.keyHint ? " \xB7 " + n.keyHint : ""}` : "\u672A\u8BBE\u7F6E Key"
      )
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
    const up = button("arrow-up", "\u4E0A\u79FB " + n.name, () => move(-1), "\u4E0A\u79FB");
    up.disabled = index === 0;
    const down = button("arrow-down", "\u4E0B\u79FB " + n.name, () => move(1), "\u4E0B\u79FB");
    down.disabled = index === sorted.length - 1;
    const test = button(
      "flask",
      "\u6D4B\u8BD5 " + n.name + "\uFF08\u53D1\u9001\u4E00\u6B21 API \u8BF7\u6C42\uFF09",
      () => void runNodeTest(n),
      "\u6D4B\u8BD5"
    );
    actions.append(
      up,
      down,
      button("pen", "\u7F16\u8F91 " + n.name, () => editor(n), "\u7F16\u8F91"),
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
        }),
        "\u5220\u9664"
      )
    );
    row.append(enabled, text, actions);
    nodes.append(row);
  });
  const advanced = root.querySelector("[data-advanced]");
  advanced.closest("details").hidden = config.waitMode !== "limited";
  advanced.replaceChildren();
  for (const [key, label, min, max] of [
    ["timeoutSeconds", "\u5B8C\u6574\u56DE\u590D\u6700\u591A\u7B49\u591A\u4E45\uFF08\u79D2\uFF0C0 \u4E0D\u9650\uFF09", 0, 86400],
    ["headerSeconds", "\u5B8C\u5168\u6CA1\u56DE\u5E94\u65F6\u7B49\u591A\u4E45\uFF08\u79D2\uFF0C0 \u4E0D\u9650\uFF09", 0, 86400],
    ["firstTokenSeconds", "\u5F00\u59CB\u56DE\u5E94\u540E\uFF0C\u9996\u6279\u6570\u636E\u7B49\u591A\u4E45\uFF08\u79D2\uFF0C0 \u4E0D\u9650\uFF09", 0, 86400],
    ["idleSeconds", "\u63A5\u6536\u6570\u636E\u4E2D\uFF0C\u505C\u987F\u591A\u4E45\u5C31\u6362\uFF08\u79D2\uFF0C0 \u4E0D\u9650\uFF09", 0, 86400]
  ]) {
    const field = labelInput(label, key, config[key], "number", { min, max });
    field.querySelector("input").disabled = config.waitMode === "patient";
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
  markDirty();
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
          "\u505C\u6B62\u751F\u6210",
          () => void guarded(async () => {
            await bridge.api("/jobs/" + r.id + "/cancel", {
              reason: "user_cancel"
            });
            await refreshRecords();
          })
        )
      );
    if (r.connectionNote)
      detail.append(el("p", { className: "sf-muted" }, r.connectionNote));
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
  updateReadiness();
  if (!dry && nativeSelected()) {
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
  root.innerHTML = `<div class="inline-drawer"><div class="inline-drawer-toggle inline-drawer-header"><b>API\u8FD8\u6CA1\u6302</b><div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div></div><div class="inline-drawer-content"><div class="sf-actions" data-actions></div><p class="sf-muted" data-status></p><div class="sf-controls" data-controls></div><div data-editor></div><div data-native></div><div data-nodes></div><details><summary>\u8D85\u65F6\u8BBE\u7F6E</summary><div class="sf-fields" data-advanced></div></details><details data-history><summary>\u8BF7\u6C42\u8BB0\u5F55</summary><div class="sf-actions" data-log-actions></div><div data-records></div></details></div></div>`;
  document.getElementById("extensions_settings2").append(root);
  const actions = root.querySelector("[data-actions]");
  const dirtyStatus = el("p", { className: "sf-muted", role: "status" });
  dirtyStatus.dataset.dirty = "";
  actions.after(dirtyStatus);
  const testArea = el("div", { className: "sf-test-result" });
  testArea.dataset.test = "";
  root.querySelector("[data-editor]").after(testArea);
  panel = createTaskPanel(bridge.api, () => {
    root.querySelector(".inline-drawer-content").style.display = "block";
    root.querySelector("[data-history]").open = true;
    const drawer = root.closest(".drawer-content");
    if (!drawer || getComputedStyle(drawer).display === "none")
      document.getElementById("extensions-settings-button")?.querySelector(".drawer-toggle")?.click();
    void refreshRecords();
  });
  actions.append(
    button("plus", "\u65B0\u589E\u8282\u70B9", () => {
      if (config) editor();
    }),
    button(
      "rotate",
      "\u5237\u65B0\u914D\u7F6E",
      () => void guarded(async () => {
        if (dirty) throw new Error("\u6709\u672A\u4FDD\u5B58\u7684\u4FEE\u6539\uFF0C\u8BF7\u5148\u4FDD\u5B58\u6216\u64A4\u9500");
        config = await bridge.api("/config");
        savedConfig = structuredClone(config);
        updateReadiness();
        render();
        message("\u670D\u52A1\u7AEF\u5DF2\u8FDE\u63A5");
      })
    )
  );
  const saveButton = button(
    "floppy-disk",
    "\u4FDD\u5B58\u8BBE\u7F6E",
    () => void guarded(async () => {
      if (saveButton.disabled) return;
      saveButton.disabled = true;
      try {
        await commitSettings();
      } finally {
        saveButton.disabled = false;
      }
    })
  );
  saveButton.classList.add("sf-labeled-action");
  saveButton.classList.remove("sf-icon");
  actions.append(
    saveButton,
    button("rotate-left", "\u64A4\u9500\u4FEE\u6539", () => {
      config = structuredClone(savedConfig);
      dirty = false;
      editorRead = null;
      root.querySelector("[data-editor]").replaceChildren();
      render();
      message("\u5DF2\u64A4\u9500\u672A\u4FDD\u5B58\u7684\u4FEE\u6539");
    }),
    button(
      "window-restore",
      "\u663E\u793A\u4EFB\u52A1\u60AC\u6D6E\u7A97",
      () => {
        if (!config) return;
        void saveConfig({ floatingWindow: true });
        panel.update(config, []);
        panel.show();
      },
      "\u60AC\u6D6E\u7A97"
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
  refreshTimer = setInterval(() => {
    renderNative();
    updateReadiness();
    if (!document.hidden) {
      if (root.querySelector("[data-history]").open) void refreshRecords();
      if (config)
        void bridge.api("/records").then(
          (records) => panel.update(
            { ...savedConfig, floatingWindow: config.floatingWindow },
            records
          )
        ).catch(() => {
        });
    }
  }, 1e3);
  await guarded(async () => {
    const hostPath = "/script.js";
    hostConnection = await import(hostPath);
    await migrateLegacyConnection();
    config = await bridge.api("/config");
    savedConfig = structuredClone(config);
    render();
    message(
      `\u524D\u7AEF ${VERSION} \xB7 \u670D\u52A1\u7AEF ${config.version || "\u672A\u77E5"}${config.version !== VERSION ? " \xB7 \u8BF7\u540C\u6B65\u5347\u7EA7\u4E24\u90E8\u5206" : " \xB7 \u5DF2\u8FDE\u63A5"}`
    );
    panel.update(config, await bridge.api("/records"));
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
  if (bridge && savedConfig)
    await bridge.api("/config", { ...savedConfig, enabled: false }).catch(() => {
    });
  savedConfig = null;
  updateReadiness();
  bridge?.dispose();
  for (const c of testControllers) c.abort();
  panel?.dispose();
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
    failed: restoreFailed,
    takePreferredNode: (generation) => panel?.takePreferredNode(generation),
    config: () => savedConfig
  }
);
ctx().eventSource.on(ctx().eventTypes.APP_READY, () => {
  void boot();
});
export {
  onDisable
};
