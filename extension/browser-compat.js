// randomUUID requires a secure context; getRandomValues also works on LAN HTTP.
export function requestId() {
  if (typeof globalThis.crypto?.randomUUID === "function")
    return globalThis.crypto.randomUUID();
  if (typeof globalThis.crypto?.getRandomValues !== "function")
    throw new Error("浏览器不支持安全随机数，请更新浏览器后重试");
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((n) => n.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// Scope timers/listeners to a single request instead of requiring newer
// AbortSignal.any/timeout APIs, which are absent in older mobile browsers.
export function requestDeadline(parent, milliseconds = 12000) {
  const controller = new AbortController();
  const abort = () =>
    controller.abort(
      parent.reason || new DOMException("请求已取消", "AbortError"),
    );
  const timer = setTimeout(
    () =>
      controller.abort(new DOMException("连接插件服务端超时", "TimeoutError")),
    milliseconds,
  );
  if (parent?.aborted) abort();
  else parent?.addEventListener("abort", abort, { once: true });
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer);
      parent?.removeEventListener("abort", abort);
    },
  };
}
