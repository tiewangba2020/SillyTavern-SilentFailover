import { Failure } from "./errors.js";

export async function listModels(node, signal) {
  const protocol = node.protocol || "openai";
  let base = node.url.replace(/\/(chat\/completions|messages)\/?$/, "");
  if (protocol === "gemini") {
    const url = new URL(base);
    let pathname = url.pathname
      .replace(/\/models\/.*$/, "")
      .replace(/\/+$/, "");
    if (!/\/v1(beta)?$/.test(pathname)) pathname += "/v1beta";
    url.pathname = pathname;
    base = url.href.replace(/\/+$/, "");
  }
  const headers =
    protocol === "claude"
      ? { "x-api-key": node.key, "anthropic-version": "2023-06-01" }
      : protocol === "gemini"
        ? { "x-goog-api-key": node.key }
        : node.key
          ? { Authorization: `Bearer ${node.key}` }
          : {};
  const models = new Set();
  let cursor;
  for (let page = 0; page < 20; page++) {
    const url = new URL(base + "/models");
    if (cursor)
      url.searchParams.set(
        protocol === "gemini" ? "pageToken" : "after_id",
        cursor,
      );
    const response = await fetch(url, {
      headers,
      signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]),
      redirect: "error",
    });
    if (!response.ok)
      throw new Failure("获取模型列表失败", { status: response.status });
    const reader = response.body.getReader();
    let size = 0;
    const chunks = [];
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.length;
        if (size > 2 * 1024 * 1024) throw new Error("模型列表过大");
        chunks.push(part.value);
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    let data;
    try {
      data = JSON.parse(Buffer.concat(chunks).toString());
    } catch {
      throw new Error("模型接口未返回有效 JSON，可手动填写模型 ID");
    }
    const entries = protocol === "gemini" ? data.models : data.data;
    if (!Array.isArray(entries))
      throw new Error("模型列表格式不受支持，可手动填写模型 ID");
    for (const entry of entries) {
      if (
        protocol === "gemini" &&
        !entry.supportedGenerationMethods?.includes("generateContent")
      )
        continue;
      const id =
        protocol === "gemini" ? entry.name?.replace(/^models\//, "") : entry.id;
      if (
        typeof id === "string" &&
        id.length &&
        id.length <= 200 &&
        !/[\r\n\x00-\x1f]/.test(id)
      )
        models.add(id);
      if (models.size >= 2000)
        return { models: [...models].sort(), truncated: true };
    }
    const next =
      protocol === "gemini"
        ? data.nextPageToken
        : protocol === "claude" && data.has_more
          ? data.last_id
          : null;
    if (!next || next === cursor)
      return { models: [...models].sort(), truncated: false };
    if (typeof next !== "string" || next.length > 2048)
      throw new Error("模型分页数据无效");
    cursor = next;
  }
  return { models: [...models].sort(), truncated: true };
}
