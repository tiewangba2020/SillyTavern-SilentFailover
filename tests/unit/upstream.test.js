import { test, expect, beforeAll, afterAll, vi } from "vitest";
import http from "node:http";
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
async function withResponse(respond, run) {
  const server = http.createServer((req, res) => {
    req.resume();
    respond(res);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await run({
      ...node("C", false),
      url: `http://127.0.0.1:${server.address().port}/v1`,
    });
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

test("retains reported token usage and partial-text counts when a stream disconnects or is stopped", async () => {
  for (const stop of [false, true]) {
    const controller = new AbortController();
    await withResponse(
      (res) => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(
          'data: {"choices":[{"delta":{"content":"private partial text"}}],"usage":{"prompt_tokens":100,"completion_tokens":12}}\n\n',
        );
        if (stop)
          setTimeout(
            () => controller.abort(new DOMException("stop", "AbortError")),
            40,
          );
        else res.end();
      },
      async (fixtureNode) => {
        const diagnostics = {};
        await expect(
          attempt(
            fixtureNode,
            payload,
            controller.signal,
            DEFAULTS,
            null,
            diagnostics,
          ),
        ).rejects.toBeDefined();
        expect(diagnostics.usage).toEqual({
          inputTokens: 100,
          outputTokens: 12,
        });
        expect(diagnostics.usagePartial).toBe(true);
        expect(diagnostics.completion.textChars).toBe(20);
        expect(JSON.stringify(diagnostics)).not.toContain(
          "private partial text",
        );
      },
    );
  }
});

test("keeps provider-reported usage even on an HTTP error without inventing a zero for missing usage", async () => {
  await withResponse(
    (res) => {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          error: { message: "upstream failed" },
          usage: { prompt_tokens: 10 },
        }),
      );
    },
    async (fixtureNode) => {
      const diagnostics = {};
      await expect(
        attempt(
          fixtureNode,
          payload,
          new AbortController().signal,
          DEFAULTS,
          null,
          diagnostics,
        ),
      ).rejects.toThrow();
      expect(diagnostics.usage).toEqual({ inputTokens: 10 });
    },
  );
});

test("separate usage chunks retain known input and output counts", async () => {
  await withResponse(
    (res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(
        'data: {"usage":{"prompt_tokens":100},"choices":[]}\n\ndata: {"usage":{"completion_tokens":8},"choices":[{"delta":{"content":"done"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
      );
    },
    async (fixtureNode) => {
      const diagnostics = {};
      const result = await attempt(
        fixtureNode,
        payload,
        new AbortController().signal,
        DEFAULTS,
        null,
        diagnostics,
      );
      expect(diagnostics.usage).toEqual({ inputTokens: 100, outputTokens: 8 });
      expect(result.usage).toEqual({
        prompt_tokens: 100,
        completion_tokens: 8,
      });
    },
  );
});

test("generation works independently of the host fetch dispatcher contract", async () => {
  mock.setMode("success");
  const incompatibleFetch = vi.fn(() => {
    throw new TypeError("invalid onError method");
  });
  vi.stubGlobal("fetch", incompatibleFetch);
  try {
    const result = await attempt(
      node("C"),
      payload,
      new AbortController().signal,
      DEFAULTS,
    );
    expect(result.choices[0].message.content).toBe("完整回复验证通过。");
    expect(incompatibleFetch).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
  }
});
test("reads complete SSE across split UTF-8 byte chunks", async () => {
  mock.setMode("success");
  const diagnostics = {};
  const data = await attempt(
    node("C"),
    payload,
    new AbortController().signal,
    DEFAULTS,
    null,
    diagnostics,
  );
  expect(data.choices[0].message.content).toBe("完整回复验证通过。");
  expect(diagnostics).toMatchObject({
    httpStatus: 200,
    parser: "sse",
    contentType: "text/event-stream",
    streamEnded: true,
  });
  expect(diagnostics.bytes).toBeGreaterThan(0);
  expect(diagnostics.completion.textChars).toBe(9);
  expect(JSON.stringify(diagnostics)).not.toContain("完整回复");
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
      waitMode: "limited",
    }),
  ).rejects.toMatchObject({ category: "timeout" });
});

test("classifies invalid response bodies without retaining content", async () => {
  for (const [body, contentType, shape] of [
    ["<html>private-response-content</html>", "text/html", "html_or_xml"],
    [
      "data: private-response-content",
      "application/json",
      "sse_with_wrong_content_type",
    ],
    ["", "application/json", "empty"],
  ]) {
    const diagnostics = {};
    await withResponse(
      (res) => {
        res.setHeader("content-type", contentType);
        res.end(body);
      },
      async (fixtureNode) => {
        await expect(
          attempt(
            fixtureNode,
            payload,
            new AbortController().signal,
            DEFAULTS,
            null,
            diagnostics,
          ),
        ).rejects.toThrow("Invalid JSON");
        expect(diagnostics.bodyShape).toBe(shape);
        expect(JSON.stringify(diagnostics)).not.toContain(
          "private-response-content",
        );
      },
    );
  }
});

test("records zero text for content filtering without retrying a refusal", async () => {
  const diagnostics = {};
  await withResponse(
    (res) => {
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          choices: [
            { message: { content: "" }, finish_reason: "content_filter" },
          ],
        }),
      );
    },
    async (fixtureNode) => {
      await attempt(
        fixtureNode,
        payload,
        new AbortController().signal,
        DEFAULTS,
        null,
        diagnostics,
      );
      expect(diagnostics.completion).toMatchObject({
        textChars: 0,
        finishReason: "content_filter",
      });
    },
  );
});

test("patient waiting accepts delayed content beyond all configured cutoffs", async () => {
  await withResponse(
    async (res) => {
      await new Promise((r) => setTimeout(r, 40));
      res.writeHead(200, { "content-type": "application/json" });
      res.flushHeaders();
      await new Promise((r) => setTimeout(r, 40));
      res.write('{"choices":');
      await new Promise((r) => setTimeout(r, 40));
      res.end(
        JSON.stringify([
          { message: { content: "late complete" }, finish_reason: "stop" },
        ]) + "}",
      );
    },
    async (fixtureNode) => {
      const result = await attempt(
        fixtureNode,
        payload,
        new AbortController().signal,
        {
          ...DEFAULTS,
          waitMode: "patient",
          timeoutSeconds: 0.01,
          headerSeconds: 0.01,
          firstTokenSeconds: 0.01,
          idleSeconds: 0.01,
        },
      );
      expect(result.choices[0].message.content).toBe("late complete");
    },
  );
});
