import { test, expect, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { Store, DEFAULTS } from "../../server/store.js";
import { Jobs } from "../../server/jobs.js";
const cleanup = [];
afterEach(() =>
  cleanup
    .splice(0)
    .reverse()
    .forEach((fn) => fn()),
);
const node = {
  name: "test",
  url: "https://example.com/v1",
  model: "m",
  key: "test-only-preset-secret",
};
function fixture() {
  const dir = fs.mkdtempSync(path.join(tmpdir(), "sf-presets-"));
  cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, "silent-failover"));
  fs.writeFileSync(
    path.join(dir, "silent-failover/config.json"),
    JSON.stringify({ ...DEFAULTS, enabled: true, nodes: [node] }),
  );
  return { store: new Store(dir), dir };
}
test("migrates old settings, isolates copies and keeps all keys out of public preset metadata", () => {
  const { store, dir } = fixture();
  const original = store.publicConfig();
  expect(original.presetName).toBe("默认预设");
  expect(JSON.stringify(original)).not.toContain(node.key);
  const copy = store.changePreset({
    ...original,
    action: "copy",
    name: "Long context",
  });
  expect(copy.nodes[0].keySet).toBe(true);
  store.save({
    ...copy,
    headerSeconds: 999,
    nodes: [{ ...copy.nodes[0], key: "test-only-changed" }],
  });
  store.changePreset({ action: "activate", id: original.activePresetId });
  expect(store.config.headerSeconds).toBe(DEFAULTS.headerSeconds);
  expect(store.config.nodes[0].key).toBe(node.key);
  const reloaded = new Store(dir);
  expect(reloaded.publicConfig().presets).toHaveLength(2);
  expect(reloaded.keys()).toContain("test-only-changed");
  expect(JSON.stringify(reloaded.publicConfig())).not.toContain(
    "test-only-changed",
  );
});
test("rejects stale saves and duplicate names without overwriting saved data", () => {
  const { store, dir } = fixture();
  const old = store.publicConfig();
  store.save({ ...old, loop: true });
  expect(() => store.save({ ...old, loop: false })).toThrow("其他页面");
  expect(() =>
    store.changePreset({ action: "copy", name: "默认预设" }),
  ).toThrow("重复");
  expect(() => store.changePreset({ action: "delete" })).toThrow("至少保留");
  expect(new Store(dir).config.loop).toBe(true);
});
test("switching or deleting a preset does not redirect or cancel its active generation", async () => {
  const { store } = fixture();
  store.save({
    ...store.publicConfig(),
    nodes: [
      { ...node, name: "A" },
      { ...node, name: "B" },
    ],
  });
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const called = [];
  const jobs = new Jobs(store, {
    attempt: async (n) => {
      called.push(n.name);
      if (n.name === "A") {
        await gate;
        throw new Error("test failure");
      }
      return {
        choices: [{ message: { content: "complete" }, finish_reason: "stop" }],
      };
    },
  });
  cleanup.push(() => jobs.close());
  const id = store.activePresetId;
  jobs.create("switch-test", { messages: [{ role: "user", content: "hi" }] });
  store.changePreset({ action: "create", name: "Disabled empty" });
  store.changePreset({ action: "activate", id });
  store.changePreset({ action: "delete" });
  release();
  for (let i = 0; i < 100 && jobs.get("switch-test").state === "running"; i++)
    await new Promise((r) => setTimeout(r, 5));
  expect(jobs.get("switch-test").state).toBe("succeeded");
  expect(called).toEqual(["A", "B"]);
  expect(jobs.get("switch-test").presetName).toBe("默认预设");
  expect(JSON.stringify(jobs.list())).not.toContain(node.key);
});
