const make = (tag, cls, text) => {
  const element = document.createElement(tag);
  element.className = cls;
  if (text !== undefined) element.textContent = text;
  return element;
};
const icon = (name, title, action) => {
  const b = make("button", "sf-panel-icon");
  b.type = "button";
  b.title = title;
  b.setAttribute("aria-label", title);
  b.append(make("i", `fa-solid fa-${name}`));
  b.onclick = action;
  return b;
};
export function createTaskPanel(api, openRecords) {
  const panel = make("section", "sf-task-panel");
  panel.setAttribute("aria-label", "API还没挂任务");
  const header = make("header", "sf-panel-header");
  const title = make("strong", "", "API还没挂");
  header.append(make("i", "fa-solid fa-shuffle"), title);
  const body = make("div", "sf-panel-body");
  let hidden = false,
    collapsed = false,
    selectedId,
    config,
    records = [],
    lastConfigVisible = false;
  const collapse = icon("minus", "收起悬浮窗", () => {
    collapsed = !collapsed;
    body.hidden = collapsed;
    collapse.title = collapsed ? "展开悬浮窗" : "收起悬浮窗";
    collapse.setAttribute("aria-label", collapse.title);
    collapse.firstChild.className = `fa-solid fa-${collapsed ? "plus" : "minus"}`;
    clamp();
  });
  header.append(
    collapse,
    icon("xmark", "关闭悬浮窗", () => {
      hidden = true;
      panel.hidden = true;
    }),
  );
  const tasks = make("select", "sf-panel-select");
  tasks.setAttribute("aria-label", "当前生成任务");
  tasks.onchange = () => {
    selectedId = tasks.value;
    render();
  };
  const status = make("div", "sf-panel-state", "暂无生成任务");
  status.setAttribute("role", "status");
  const node = make("strong", "sf-panel-node");
  const model = make("div", "sf-panel-model");
  const stats = make("div", "sf-panel-stats");
  const choose = make("select", "sf-panel-select");
  choose.setAttribute("aria-label", "切换到 API");
  const actions = make("div", "sf-panel-actions");
  let commandBusy = false;
  const command = async (suffix, data) => {
    if (!selectedId || commandBusy) return;
    commandBusy = true;
    switchButton.disabled = stop.disabled = true;
    try {
      await api(`/jobs/${selectedId}/${suffix}`, data);
      status.textContent =
        suffix === "switch" ? "正在切换节点" : "正在停止生成";
    } catch (e) {
      status.textContent = e.message;
    } finally {
      commandBusy = false;
    }
  };
  const switchButton = icon(
    "right-left",
    "切换 API",
    () => void command("switch", { nodeId: choose.value }),
  );
  const stop = icon(
    "stop",
    "停止生成",
    () => void command("cancel", { reason: "panel_stop" }),
  );
  stop.classList.add("sf-panel-stop");
  actions.append(choose, switchButton, stop);
  body.append(tasks, status, node, model, stats, actions);
  panel.append(header, body);
  document.body.append(panel);
  panel.hidden = true;
  const notice = make("aside", "sf-task-notice");
  const noticeText = make("button", "sf-notice-text");
  noticeText.type = "button";
  noticeText.onclick = openRecords;
  notice.append(
    noticeText,
    icon("xmark", "关闭提示", () => {
      notice.hidden = true;
    }),
  );
  document.body.append(notice);
  notice.hidden = true;
  let noticeTimer,
    initialized = false;
  const known = new Map();
  function notify(jobs) {
    for (const job of jobs) {
      const signature = `${job.state}:${job.attemptCount}`;
      if (
        initialized &&
        known.get(job.id) !== signature &&
        job.mode !== "node_test" &&
        job.generation !== "quiet"
      ) {
        if (job.state === "cancelled") notice.hidden = true;
        const failed = ["exhausted", "invalid"].includes(job.state);
        const progress = config.notificationMode === "progress";
        if (
          config.notificationMode !== "silent" &&
          (failed || (progress && job.state !== "cancelled"))
        ) {
          const a = job.attempts?.at(-1);
          const text = failed
            ? "本次生成未成功，点击查看记录"
            : job.state === "succeeded"
              ? "已取得完整回复"
              : job.state === "waiting"
                ? `第 ${job.round} 轮结束，等待重试`
                : `${a?.node || "API"} · 第 ${job.round} 轮尝试中`;
          if (!panel.hidden && !failed) {
            notice.hidden = true;
          } else {
            noticeText.textContent = text;
            notice.dataset.state = failed ? "failed" : job.state;
            notice.hidden = false;
            clearTimeout(noticeTimer);
            if (!failed)
              noticeTimer = setTimeout(() => {
                notice.hidden = true;
              }, 5000);
          }
        }
      }
      known.set(job.id, signature);
    }
    for (const id of known.keys())
      if (!jobs.some((j) => j.id === id)) known.delete(id);
    initialized = true;
    if (config.notificationMode === "silent") notice.hidden = true;
  }
  function fill(select, entries, value) {
    const signature = JSON.stringify(entries);
    if (select.dataset.options !== signature) {
      select.replaceChildren(
        ...entries.map(([id, label]) => {
          const option = make("option", "", label);
          option.value = id;
          return option;
        }),
      );
      select.dataset.options = signature;
      if (entries.some((e) => e[0] === value)) select.value = value;
    }
  }
  function render() {
    const jobs = records.filter((j) => j.mode !== "node_test");
    const active = jobs.filter((j) => ["running", "waiting"].includes(j.state));
    let job =
      active.find((j) => j.id === selectedId) ||
      active[0] ||
      jobs.find((j) => j.id === selectedId);
    selectedId = job?.id;
    fill(
      tasks,
      active.map((j) => [
        j.id,
        `${new Date(j.started).toLocaleTimeString()} · ${j.generation || "生成"}`,
      ]),
      selectedId,
    );
    tasks.hidden = active.length < 2;
    const a = job?.attempts?.at(-1);
    const running = !!job && ["running", "waiting"].includes(job.state);
    panel.dataset.state = job?.state || "idle";
    status.textContent = !job
      ? "暂无生成任务"
      : {
          succeeded: "上游已完成",
          cancelled: "已停止",
          exhausted: "尝试已结束",
          invalid: "未执行",
          waiting: "等待下一轮",
        }[job.state] ||
        (a?.diagnostics?.bytes ? "正在接收上游数据" : "等待上游响应");
    node.textContent = a?.node || "就绪";
    model.textContent = a?.model || "";
    stats.textContent = job
      ? `第 ${job.round}${job.maxRounds ? " / " + job.maxRounds : ""} 轮  ·  ${Math.max(0, Math.floor(((job.ended || Date.now()) - job.started) / 1000))} 秒  ·  ${job.attemptCount} 次尝试`
      : "";
    fill(
      choose,
      job?.availableNodes?.map((n) => [n.id, n.name]) || [],
      choose.value,
    );
    choose.disabled = !running || commandBusy;
    switchButton.disabled = !running || commandBusy || !choose.value;
    stop.disabled = !running || commandBusy;
    panel.hidden = !config?.floatingWindow || hidden;
    clamp();
  }
  function clamp() {
    if (panel.hidden) return;
    if (!panel.style.left) {
      // Mobile SillyTavern transforms the root, so bottom anchoring can use a zero-height containing block.
      panel.style.right = panel.style.bottom = "auto";
      panel.style.left = `${innerWidth - panel.offsetWidth - 16}px`;
      panel.style.top = `${innerHeight - panel.offsetHeight - 110}px`;
    }
    const box = panel.getBoundingClientRect();
    panel.style.left = `${Math.max(8, Math.min(box.left, innerWidth - box.width - 8))}px`;
    panel.style.top = `${Math.max(8, Math.min(box.top, innerHeight - box.height - 100))}px`;
  }
  let drag;
  header.onpointerdown = (e) => {
    if (e.target.closest("button") || e.button !== 0) return;
    const box = panel.getBoundingClientRect();
    drag = { x: e.clientX - box.left, y: e.clientY - box.top };
    header.setPointerCapture(e.pointerId);
  };
  header.onpointermove = (e) => {
    if (!drag) return;
    panel.style.right = panel.style.bottom = "auto";
    panel.style.left = `${e.clientX - drag.x}px`;
    panel.style.top = `${e.clientY - drag.y}px`;
    clamp();
  };
  header.onpointerup = header.onpointercancel = () => {
    drag = null;
  };
  window.addEventListener("resize", clamp);
  return {
    update(nextConfig, nextRecords) {
      config = nextConfig;
      records = nextRecords;
      if (config.floatingWindow !== lastConfigVisible) hidden = false;
      lastConfigVisible = config.floatingWindow;
      render();
      notify(records);
    },
    show() {
      hidden = false;
      render();
    },
    dispose() {
      clearTimeout(noticeTimer);
      window.removeEventListener("resize", clamp);
      panel.remove();
      notice.remove();
    },
  };
}
