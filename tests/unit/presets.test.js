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
test("corrupted or orphaned config no longer bricks the plugin", () => {
  const dir = fs.mkdtempSync(path.join(tmpdir(), "sf-broken-"));
  cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "silent-failover", "config.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });

  // 手机被强杀、存储写一半：JSON 解析不了
  fs.writeFileSync(file, '{"nodes": [{"name": "x"');
  const broken = new Store(dir);
  expect(broken.warning).toContain("无法解析");
  expect(broken.config.nodes).toEqual([]);
  const backups = fs
    .readdirSync(path.dirname(file))
    .filter((n) => n.startsWith("config.json.broken-"));
  expect(backups).toHaveLength(1);
  expect(fs.readFileSync(file, "utf8")).toContain('"schema"');

  // 预设指针指向已不存在的预设、预设条目本身残缺
  fs.writeFileSync(
    file,
    JSON.stringify({
      ...DEFAULTS,
      activePresetId: "gone",
      nodes: [node],
      presets: [{ id: "kept", name: "A" }, { id: "kept2", name: "B", config: null }],
    }),
  );
  const orphan = new Store(dir);
  expect(orphan.presets).toHaveLength(1);
  expect(orphan.activePresetId).toBe(orphan.presets[0].id);
  expect(orphan.config.nodes).toEqual([node]);
  expect(JSON.parse(fs.readFileSync(file, "utf8")).activePresetId).toBe(
    orphan.activePresetId,
  );

  // 冷重启把主文件写坏了，但 atomicJson 留下的临时文件是完整的：优先从它恢复。
  fs.writeFileSync(file, '{"nodes": [{"na');
  const temporary = path.join(
    path.dirname(file),
    "config.json.0f9c1a2b-1111-2222-3333-444455556666.tmp",
  );
  fs.writeFileSync(
    temporary,
    JSON.stringify({ ...DEFAULTS, enabled: true, nodes: [node] }),
  );
  const salvaged = new Store(dir);
  expect(salvaged.warning).toContain("临时文件");
  expect(salvaged.config.enabled).toBe(true);
  expect(salvaged.config.nodes).toEqual([node]);
  expect(salvaged.keys()).toContain(node.key);
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
