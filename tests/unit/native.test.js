import { test, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { nativeNode } from "../../server/native.js";
import { Store } from "../../server/store.js";
import { Jobs } from "../../server/jobs.js";
import { nativeCompletion } from "../../server/protocols.js";

const input = {
  chat_completion_source: "custom",
  custom_url: "https://example.com/v1",
  model: "original",
  stream: true,
  messages: [{ role: "user", content: "Hello" }],
};
test("native keys resolve by current user and selected secret, never from another provider", () => {
  const calls = [];
  const host = {
    readSecret: (dirs, key, id) => {
      calls.push([dirs.root, key, id]);
      return dirs.root + "-secret";
    },
  };
  for (const [source, key] of [
    ["custom", "custom"],
    ["openai", "openai"],
    ["claude", "claude"],
    ["makersuite", "makersuite"],
  ]) {
    const a = nativeNode(
      { ...input, chat_completion_source: source, secret_id: "selected" },
      { root: "alice" },
      host,
    );
    const b = nativeNode(
      { ...input, chat_completion_source: source },
      { root: "bob" },
      host,
    );
    expect(a.key).toBe("alice-secret");
    expect(b.key).toBe("bob-secret");
    expect(calls.at(-2)).toEqual(["alice", "api_key_" + key, "selected"]);
  }
  expect(() =>
    nativeNode({ ...input, chat_completion_source: "vertexai" }, {}, host),
  ).toThrow("支持");
  expect(() =>
    nativeNode(
      { ...input, custom_url: "http://sillytavern-failover.invalid/v1" },
      {},
      host,
    ),
  ).toThrow("地址");
});
test("native proxy credentials stay off the request snapshot and use the proxy only", () => {
  const n = nativeNode(
    {
      ...input,
      chat_completion_source: "claude",
      reverse_proxy: "https://proxy.example/v1",
      proxy_password: "private-proxy",
    },
    {},
    {
      readSecret() {
        throw Error("must not read official key");
      },
    },
  );
  expect(n.key).toBe("private-proxy");
  expect(n.url).toBe("https://proxy.example/v1");
  expect(JSON.stringify(n.request)).not.toContain("private-proxy");
});
test("every round starts with native, deduplicates same node, and redacts all native secrets", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sf-native-"));
  const store = new Store(dir);
  const native = nativeNode(
    input,
    {},
    { readSecret: () => "native-private-secret" },
  );
  store.save({
    enabled: true,
    nativeFirst: true,
    loop: true,
    nodes: [
      { ...native, id: "copy", name: "copy", priority: 0 },
      {
        id: "backup",
        name: "backup",
        model: "backup",
        url: "https://backup.example/v1",
      },
    ],
  });
  const calls = [];
  const jobs = new Jobs(store, {
    waitMs: 0,
    attempt: async (n) => {
      calls.push(n.id);
      if (calls.length === 4)
        return { choices: [{ message: { content: "OK" } }] };
      throw Error("failure " + native.key);
    },
  });
  try {
    jobs.create("native-rounds", input, { nativeNode: native });
    for (
      let i = 0;
      i < 100 && jobs.get("native-rounds").state !== "succeeded";
      i++
    )
      await new Promise((r) => setTimeout(r, 5));
    expect(calls).toEqual([native.id, "backup", native.id, "backup"]);
    expect(jobs.get("native-rounds").state).toBe("succeeded");
    expect(JSON.stringify(jobs.list())).not.toContain(native.key);
    expect(JSON.stringify(store.loadLogs())).not.toContain(native.key);
    expect(jobs.jobs.get("native-rounds").nativeNode).toBeNull();
  } finally {
    jobs.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
test("native structured replies preserve text and reasoning and reject tool output", () => {
  const c = nativeCompletion(
    {
      content: [
        { type: "thinking", thinking: "reason" },
        { type: "text", text: "OK" },
      ],
    },
    "claude",
  );
  expect(c.choices[0].message).toMatchObject({
    content: "OK",
    reasoning_content: "reason",
  });
  const g = nativeCompletion(
    {
      candidates: [
        {
          content: {
            parts: [{ text: "reason", thought: true }, { text: "OK" }],
          },
          finishReason: "STOP",
        },
      ],
    },
    "gemini",
  );
  expect(g.choices[0].message).toMatchObject({
    content: "OK",
    reasoning_content: "reason",
  });
  expect(() =>
    nativeCompletion({ content: [{ type: "tool_use" }] }, "claude"),
  ).toThrow("Non-text");
  expect(() =>
    nativeCompletion({ promptFeedback: { blockReason: "SAFETY" } }, "gemini"),
  ).toThrow("SAFETY");
});
