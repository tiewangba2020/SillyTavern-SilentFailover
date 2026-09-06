const make = (tag, cls, text) => {
  const element = document.createElement(tag);
  element.className = cls;
  if (text !== undefined) element.textContent = text;
  return element;
};
const icon = (name, title, action, touchLabel) => {
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
export function createTaskPanel(api, openRecords) {
  const panel = make("section", "sf-task-panel");
  panel.setAttribute("aria-label", "API还没挂任务");
  const header = make("header", "sf-panel-header");
  const title = make("strong", "", "API还没挂");
  header.append(make("i", "fa-solid fa-shuffle"), title);
  const body = make("div", "sf-panel-body");
  let hidden = false,
    collapsed = false,
    suppressPointerClick = false,
    selectedId,
    preferredNodeId = "",
    chooserContext,
    config,
    records = [],
    lastConfigVisible = false;
  const collapse = icon(
    "minus",
    "收起悬浮窗",
    () => {
      const previous = panel.getBoundingClientRect();
      collapsed = !collapsed;
      panel.dataset.collapsed = String(collapsed);
      body.hidden = collapsed;
      collapse.title = collapsed ? "展开悬浮窗" : "收起悬浮窗";
      collapse.setAttribute("aria-label", collapse.title);
      collapse.firstChild.className = `fa-solid fa-${collapsed ? "plus" : "minus"}`;
      collapse.querySelector(".sf-action-label").textContent = collapsed
        ? "展开"
        : "收起";
      collapse.setAttribute("aria-expanded", String(!collapsed));
      panel.style.left = `${previous.right - panel.offsetWidth}px`;
      clamp();
    },
    "收起",
  );
  collapse.setAttribute("aria-expanded", "true");
  collapse.classList.add("sf-panel-collapse");
  header.append(
    collapse,
    icon(
      "xmark",
      "关闭悬浮窗",
      () => {
        hidden = true;
        panel.hidden = true;
      },
      "关闭",
    ),
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
  const targetLabel = make("label", "sf-panel-target");
  const targetText = make("span", "", "下次优先 API");
  targetLabel.append(targetText, choose);
  const actions = make("div", "sf-panel-actions");
  let commandBusy = false,
    commandError = "";
  const command = async (suffix, data) => {
    if (!selectedId || commandBusy) return;
    commandBusy = true;
    commandError = "";
    switchButton.disabled = stop.disabled = true;
    try {
      await api(`/jobs/${selectedId}/${suffix}`, data);
      status.textContent =
        suffix === "switch" ? "正在切换节点" : "正在停止生成";
    } catch (e) {
      commandError = e.message;
    } finally {
      commandBusy = false;
      render();
    }
  };
  const switchButton = icon("right-left", "切换 API", () => {
    if (
      panel.dataset.state === "running" ||
      panel.dataset.state === "waiting"
    ) {
      void command("switch", { nodeId: choose.value });
    } else {
      preferredNodeId = choose.value;
      render();
    }
  });
  switchButton.classList.add("sf-panel-switch");
  const switchText = make("span", "", "切换 API");
  switchButton.append(switchText);
  choose.onchange = () => {
    commandError = "";
    choose.title = choose.selectedOptions[0]?.textContent || "";
    render();
  };
  const stop = icon(
    "stop",
    "停止生成",
    () => void command("cancel", { reason: "panel_stop" }),
    "停止生成",
  );
  stop.classList.add("sf-panel-stop");
  actions.append(targetLabel, switchButton, stop);
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
    icon(
      "xmark",
      "关闭提示",
      () => {
        notice.hidden = true;
      },
      "关闭",
    ),
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
    const savedNodes = (config?.nodes || [])
      .filter((n) => n.enabled)
      .sort((a, b) => a.priority - b.priority);
    if (preferredNodeId && !savedNodes.some((n) => n.id === preferredNodeId))
      preferredNodeId = "";
    const preferred = savedNodes.find((n) => n.id === preferredNodeId);
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
    model.textContent = a
      ? `${a.model} · ${a.diagnostics?.stream !== false ? "流式" : "非流式"}`
      : "";
    stats.textContent = job
      ? `第 ${job.round}${job.maxRounds ? " / " + job.maxRounds : ""} 轮  ·  ${Math.max(0, Math.floor(((job.ended || Date.now()) - job.started) / 1000))} 秒  ·  ${job.attemptCount} 次尝试`
      : "";
    if (!running && preferred) {
      status.textContent = "下次生成已就绪";
      node.textContent = preferred.name;
      model.textContent = `${preferred.model} · ${preferred.stream !== false ? "流式" : "非流式"}`;
      stats.textContent = "仅下一次生成优先";
    }
    const nextContext = running ? job.id : "idle";
    const defaultTarget = running
      ? job.availableNodes?.find((n) => n.id !== a?.nodeId)?.id || ""
      : preferredNodeId;
    fill(
      choose,
      running
        ? job.availableNodes?.map((n) => [
            n.id,
            `${n.name} · ${n.stream !== false ? "流式" : "非流式"} · ${n.model}`,
          ]) || []
        : [
            ["", "按已保存的优先级"],
            ...savedNodes.map((n) => [
              n.id,
              `${n.name} · ${n.stream !== false ? "流式" : "非流式"} · ${n.model}`,
            ]),
          ],
      chooserContext === nextContext ? choose.value : defaultTarget,
    );
    if (chooserContext !== nextContext) {
      choose.value = defaultTarget;
      commandError = "";
    }
    chooserContext = nextContext;
    choose.title = choose.selectedOptions[0]?.textContent || "";
    targetText.textContent = running ? "本次切换到" : "下次优先 API";
    switchText.textContent = running ? "切换 API" : "应用于下次生成";
    switchButton.title = switchText.textContent;
    switchButton.setAttribute("aria-label", switchText.textContent);
    choose.disabled = commandBusy || !config?.enabled;
    switchButton.disabled =
      commandBusy ||
      !config?.enabled ||
      (running
        ? !choose.value || choose.value === a?.nodeId
        : choose.value === preferredNodeId);
    stop.disabled = !running || commandBusy;
    if (commandError) status.textContent = commandError;
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
    suppressPointerClick = false;
    const bubble = collapsed && panel.offsetWidth <= 60;
    if ((!bubble && e.target.closest("button")) || e.button !== 0) return;
    const box = panel.getBoundingClientRect();
    drag = {
      x: e.clientX - box.left,
      y: e.clientY - box.top,
      startX: e.clientX,
      startY: e.clientY,
      moved: false,
      bubble,
    };
    (bubble ? collapse : header).setPointerCapture(e.pointerId);
  };
  header.onpointermove = (e) => {
    if (!drag) return;
    if (
      !drag.moved &&
      Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) < 6
    )
      return;
    drag.moved = true;
    panel.style.right = panel.style.bottom = "auto";
    panel.style.left = `${e.clientX - drag.x}px`;
    panel.style.top = `${e.clientY - drag.y}px`;
    clamp();
  };
  header.onpointerup = header.onpointercancel = (e) => {
    if (drag?.bubble && drag.moved) {
      const box = panel.getBoundingClientRect();
      panel.style.left = `${box.left + box.width / 2 < innerWidth / 2 ? 8 : innerWidth - box.width - 8}px`;
      clamp();
      suppressPointerClick = true;
    } else if (
      drag?.bubble &&
      e.type === "pointerup" &&
      e.pointerType !== "mouse"
    ) {
      // Browsers may suppress the first synthesized click after dragging a touch control.
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
    // Expanding changes hit targets; a trailing touch click can otherwise hit Close.
    suppressPointerClick = false;
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  document.addEventListener("pointerdown", resetPointerClick, true);
  document.addEventListener("click", discardPointerClick, true);
  window.addEventListener("resize", clamp);
  return {
    takePreferredNode(generation) {
      if (generation === "quiet") return undefined;
      const id = preferredNodeId || undefined;
      preferredNodeId = "";
      chooserContext = undefined;
      render();
      return id;
    },
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
      document.removeEventListener("pointerdown", resetPointerClick, true);
      document.removeEventListener("click", discardPointerClick, true);
      panel.remove();
      notice.remove();
    },
  };
}
