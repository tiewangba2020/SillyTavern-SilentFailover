import { describe, test, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Store } from "../../server/store.js";
import { Jobs } from "../../server/jobs.js";

const resources = [];
afterEach(() => {
  for (const r of resources.splice(0)) {
    r.jobs.close();
    rmSync(r.dir, { recursive: true, force: true });
  }
});
function fixture(attempt) {
  const dir = mkdtempSync(path.join(tmpdir(), "st-failover-"));
  const store = new Store(dir);
  store.save({
    enabled: true,
    loop: false,
    intervalSeconds: 1,
    nodes: ["A", "B", "C"].map((name, i) => ({
      name,
      url: "https://example.com/v1",
      key: "secret-" + name,
      model: name,
      priority: i + 1,
      enabled: true,
    })),
  });
  const jobs = new Jobs(store, { attempt, waitMs: 15, leaseMs: 1000 });
  resources.push({ dir, jobs });
  return { store, jobs };
}
const request = { messages: [{ role: "user", content: "Hello" }] };
const ok = {
  choices: [
    {
      message: { role: "assistant", content: "Complete answer" },
      finish_reason: "stop",
    },
  ],
};
async function finish(jobs, id) {
  for (let i = 0; i < 400; i++) {
    const j = jobs.get(id, true);
    if (["succeeded", "exhausted", "cancelled", "invalid"].includes(j.state))
      return j;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("job did not finish");
}
describe("sequential jobs", () => {
  test("335 recovery rounds keep only 1000 attempt details and bounded persisted logs", async () => {
    let calls = 0;
    const { jobs, store } = fixture(async () => {
      calls++;
      if (calls === 1005) return ok;
      throw new Error("temporary failure");
    });
    jobs.waitMs = 0;
    store.save({ ...store.publicConfig(), loop: true });
    const job = jobs.create("stress-rounds", request);
    for (let i = 0; i < 3000; i++) {
      const j = jobs.get(job.id, true);
      if (j.state === "succeeded") break;
      await new Promise((r) => setTimeout(r, 5));
    }
    const j = jobs.get(job.id);
    expect(j.state).toBe("succeeded");
    expect(j.round).toBe(335);
    expect(j.attemptCount).toBe(1005);
    expect(j.attempts).toHaveLength(1000);
    expect(j.dropped).toBe(5);
    expect(store.loadLogs().find((r) => r.id === j.id).attempts).toHaveLength(
      1000,
    );
  }, 30000);
  test("acknowledging a result releases content without losing diagnostic record", async () => {
    const { jobs, store } = fixture(async () => ok);
    const j = await finish(jobs, jobs.create("ack-result", request).id);
    expect(j.result).toEqual(ok);
    jobs.acknowledge(j.id);
    expect(jobs.get(j.id).result).toBeUndefined();
    expect(jobs.list()[0].state).toBe("succeeded");
    expect(jobs.list()[0].clientEvents[0].stage).toBe("browser_received");
    expect(jobs.list()[0].attempts[0].diagnostics.completion.textChars).toBe(
      15,
    );
    expect(JSON.stringify(store.loadLogs())).not.toContain("Complete answer");
    jobs.jobs.delete(j.id);
    expect(jobs.clientEvent(j.id, "client_failed")).toBe(true);
    expect(jobs.clientEvent(j.id, "secret-body")).toBe(false);
    expect(store.loadLogs()[0].clientEvents.at(-1).stage).toBe("client_failed");
  });
  test("lease expiry cancels orphaned tasks", async () => {
    const { jobs } = fixture(
      (n, p, s) =>
        new Promise((resolve, reject) =>
          s.addEventListener("abort", () => reject(s.reason), { once: true }),
        ),
    );
    const j = jobs.create("lease-test", request);
    jobs.jobs.get(j.id).lease = Date.now() - 2000;
    jobs.expire();
    expect((await finish(jobs, j.id)).state).toBe("cancelled");
  });
  test("configuration changes apply to next round", async () => {
    let calls = 0;
    let store;
    const f = fixture(async (n) => {
      calls++;
      if (calls === 3)
        store.save({
          ...store.publicConfig(),
          nodes: store.publicConfig().nodes.filter((n) => n.name === "B"),
        });
      if (calls === 4) {
        expect(n.name).toBe("B");
        return ok;
      }
      throw new Error("down");
    });
    store = f.store;
    store.save({ ...store.publicConfig(), loop: true });
    const j = await finish(f.jobs, f.jobs.create("config-round", request).id);
    expect(j.state).toBe("succeeded");
    expect(calls).toBe(4);
  });
  test("tries in order, stops at first success and logs errors without secrets", async () => {
    const calls = [];
    const { jobs } = fixture(async (node) => {
      calls.push(node.name);
      if (node.name === "A") throw new Error("bad secret-A");
      return ok;
    });
    const j = jobs.create("request-1", request);
    expect((await finish(jobs, j.id)).state).toBe("succeeded");
    expect(calls).toEqual(["A", "B"]);
    expect(JSON.stringify(jobs.list())).not.toContain("secret-A");
  });
  test("exhausts once when loop is off", async () => {
    const calls = [];
    const { jobs } = fixture(async (n) => {
      calls.push(n.name);
      throw new Error("503");
    });
    expect(
      (await finish(jobs, jobs.create("request-2", request).id)).state,
    ).toBe("exhausted");
    expect(calls).toEqual(["A", "B", "C"]);
  });
  test("recovers on second round using same original messages", async () => {
    const calls = [];
    const { jobs, store } = fixture(async (n, p) => {
      calls.push(n.name);
      expect(p.messages).toEqual(request.messages);
      p.messages[0].content = "mutated";
      if (calls.length === 5) return ok;
      throw new Error("down");
    });
    store.save({ ...store.publicConfig(), loop: true });
    const j = await finish(jobs, jobs.create("request-3", request).id);
    expect(j.state).toBe("succeeded");
    expect(j.round).toBe(2);
    expect(calls).toEqual(["A", "B", "C", "A", "B"]);
  });
  test("turning off loop while waiting ends without another attempt", async () => {
    const { jobs, store } = fixture(async () => {
      throw new Error("down");
    });
    store.save({ ...store.publicConfig(), loop: true });
    const j = jobs.create("request-4", request);
    while (jobs.get(j.id).state !== "waiting")
      await new Promise((r) => setTimeout(r, 1));
    store.save({ ...store.publicConfig(), loop: false });
    jobs.configChanged();
    expect((await finish(jobs, j.id)).attemptCount).toBe(3);
  });
  test("cancellation aborts current attempt and prevents next node", async () => {
    const calls = [];
    const { jobs } = fixture((n, p, signal) => {
      calls.push(n.name);
      return new Promise((resolve, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        }),
      );
    });
    const j = jobs.create("request-5", request);
    jobs.cancel(j.id, "chat_changed");
    jobs.cancel(j.id, "client_error");
    const ended = await finish(jobs, j.id);
    expect(ended.state).toBe("cancelled");
    expect(ended.cancelReason).toBe("chat_changed");
    expect(ended.reason).toContain("切换聊天");
    expect(ended.attempts[0].cancelReason).toBe("chat_changed");
    expect(calls).toEqual(["A"]);
  });
  test("duplicate task creation never starts another upstream request", async () => {
    let calls = 0;
    const { jobs } = fixture(async () => {
      calls++;
      return ok;
    });
    const a = jobs.create("same-request", request);
    const b = jobs.create("same-request", request);
    expect(a.id).toBe(b.id);
    await finish(jobs, a.id);
    expect(calls).toBe(1);
  });
});
