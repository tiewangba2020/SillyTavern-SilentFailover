export class Failure extends Error {
  constructor(message, details = {}) {
    super(message);
    Object.assign(this, details);
  }
}
export function redact(value, keys = []) {
  let text = typeof value === "string" ? value : JSON.stringify(value ?? "");
  for (const key of keys.filter(Boolean).sort((a, b) => b.length - a.length))
    text = text.split(key).join("[REDACTED]");
  return text
    .replace(/(Bearer\s+)[^\s"',;]+/gi, "$1[REDACTED]")
    .replace(
      /((?:api[_-]?key|authorization|token|cookie|secret)\s*[=:]\s*)[^\s,;]+/gi,
      "$1[REDACTED]",
    )
    .slice(0, 4096);
}
export function failureRecord(error, keys) {
  const status = error.status || null;
  const cause = error.cause?.errors?.[0] || error.cause;
  let category =
    error.category ||
    { 401: "authentication", 403: "permission", 429: "rate_limit" }[status] ||
    (status >= 500 ? "provider" : status >= 400 ? "request" : "network");
  if (
    /quota|credit|balance|billing|额度|余额|预扣费/i.test(
      `${error.code || ""} ${error.message || ""}`,
    )
  )
    category = "quota";
  return {
    status,
    category,
    code: redact(error.code || cause?.code || "", keys),
    message: redact(
      [error.message || "Unknown failure", cause?.message]
        .filter(Boolean)
        .join(": "),
      keys,
    ),
    phase: error.phase || "request",
  };
}
export const abortError = () => new DOMException("Cancelled", "AbortError");
export const CANCEL_REASONS = Object.freeze({
  user_cancel: "在请求记录中停止任务",
  user_stop: "酒馆停止了生成",
  panel_stop: "用户在悬浮窗停止了生成",
  chat_changed: "切换聊天，已取消旧聊天请求",
  page_closed: "页面刷新或关闭，已取消请求",
  plugin_disabled: "故障转移已停用",
  native_disabled: "原生连接联动已关闭",
  connection_changed: "连接模式已切换",
  client_aborted: "酒馆请求的取消信号已触发",
  client_error: "浏览器与服务端的任务通信失败",
  lease_expired: "浏览器超过 60 秒未保持任务连接",
  server_shutdown: "酒馆服务关闭或重启",
});
export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason || abortError());
    const done = () => {
      signal?.removeEventListener("abort", cancel);
      resolve();
    };
    const timer = setTimeout(done, ms);
    const cancel = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
      reject(signal.reason || abortError());
    };
    signal?.addEventListener("abort", cancel, { once: true });
  });
}
