import { test, expect, beforeAll, afterAll } from "vitest";
import { mockProvider } from "../mock-provider.mjs";
import { attempt } from "../../server/upstream.js";
import { DEFAULTS } from "../../server/store.js";
import { failureRecord } from "../../server/errors.js";
let mock;
test("network diagnostics preserve the underlying cause while redacting keys", () => {
  const error = new TypeError("fetch failed", {
    cause: Object.assign(new Error("connect ECONNREFUSED private-key"), {
      code: "ECONNREFUSED",
    }),
  });
  const r = failureRecord(error, ["private-key"]);
  expect(r.code).toBe("ECONNREFUSED");
  expect(r.message).toContain("connect ECONNREFUSED");
  expect(r.message).not.toContain("private-key");
});
beforeAll(async () => {
  mock = await mockProvider();
});
afterAll(() => mock.close());
const payload = { messages: [{ role: "user", content: "hello" }] };
function node(name, stream = true) {
  return {
    name,
    url: mock.url + "/" + name + "/v1",
    model: "model",
    key: "test-only-" + name,
    stream,
  };
}
test("reads complete SSE across split UTF-8 byte chunks", async () => {
  mock.setMode("success");
  const data = await attempt(
    node("C"),
    payload,
    new AbortController().signal,
    DEFAULTS,
  );
  expect(data.choices[0].message.content).toBe("完整回复验证通过。");
});
test("rejects a partial stream even if the connection ended cleanly", async () => {
  mock.setMode("fallback");
  await expect(
    attempt(node("B"), payload, new AbortController().signal, DEFAULTS),
  ).rejects.toMatchObject({ category: "interrupted" });
});
test("captures HTTP status and provider code", async () => {
  await expect(
    attempt(node("A"), payload, new AbortController().signal, DEFAULTS),
  ).rejects.toMatchObject({ status: 401, code: "invalid_api_key" });
});
test("reads non-streaming JSON", async () => {
  mock.setMode("success");
  const data = await attempt(
    node("C", false),
    payload,
    new AbortController().signal,
    DEFAULTS,
  );
  expect(data.choices[0].finish_reason).toBe("stop");
});
test("rejects HTTP 200 containing error", async () => {
  mock.setMode("embedded");
  await expect(
    attempt(node("C", false), payload, new AbortController().signal, DEFAULTS),
  ).rejects.toThrow("embedded failure");
});
test("cancels a pending connection", async () => {
  mock.setMode("slow");
  const c = new AbortController();
  const p = attempt(node("C"), payload, c.signal, DEFAULTS);
  setTimeout(() => c.abort(new DOMException("cancel", "AbortError")), 20);
  await expect(p).rejects.toMatchObject({ name: "AbortError" });
});
test("enforces total timeout", async () => {
  mock.setMode("slow");
  await expect(
    attempt(node("C"), payload, new AbortController().signal, {
      ...DEFAULTS,
      timeoutSeconds: 0.03,
    }),
  ).rejects.toMatchObject({ category: "timeout" });
});
