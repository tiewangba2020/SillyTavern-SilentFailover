import { test, expect, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import {
  Updater,
  FILES,
  REPOSITORY,
  UPDATE_ASSET,
  validatePackage,
  newer,
} from "../../server/update.js";
const roots = [];
afterEach(() =>
  roots
    .splice(0)
    .forEach((root) => fs.rmSync(root, { recursive: true, force: true })),
);
function bundle(version = "1.3.0") {
  return {
    schema: 1,
    version,
    files: FILES.map((name) => {
      const text =
        name === "frontend/manifest.json"
          ? JSON.stringify({
              version,
              homePage: `https://github.com/${REPOSITORY}`,
              js: "dist/index.js",
              css: "style.css",
              minimum_client_version: "1.18.0",
            })
          : name === "server/package.json"
            ? JSON.stringify({
                name: "sillytavern-silent-failover-server",
                version,
                main: "index.cjs",
              })
            : "new-file-content";
      const data = Buffer.from(text);
      return {
        path: name,
        content: data.toString("base64"),
        sha256: createHash("sha256").update(data).digest("hex"),
      };
    }),
  };
}
function fixture(options = {}) {
  const root = fs.mkdtempSync(path.join(tmpdir(), "sf-update-test-"));
  roots.push(root);
  const serverDir = path.join(
    root,
    "plugins/SillyTavern-SilentFailover-Server",
  );
  const frontend = path.join(
    root,
    "public/scripts/extensions/third-party/SillyTavern-SilentFailover",
  );
  fs.writeFileSync(
    path.join(root, "package.json"),
    '{"name":"sillytavern","version":"1.18.0"}',
  );
  fs.writeFileSync(path.join(root, "server.js"), "");
  for (const [name, data] of validatePackage(bundle("1.2.0"), "1.2.0")) {
    const [component, ...parts] = name.split("/");
    const dest = path.join(
      component === "server" ? serverDir : frontend,
      ...parts,
    );
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, data);
  }
  fs.mkdirSync(path.join(root, "data"));
  fs.writeFileSync(path.join(root, "data/config.json"), "private-preserve");
  const download = async (url) => {
    if (url === `https://api.github.com/repos/${REPOSITORY}/releases/latest`)
      return { tag_name: "v1.3.0", assets: [{ name: UPDATE_ASSET }] };
    expect(url).toBe(
      `https://github.com/${REPOSITORY}/releases/latest/download/${UPDATE_ASSET}`,
    );
    return bundle();
  };
  const updater = new Updater({
    root,
    serverDir,
    download,
    runningVersion: "1.2.0",
    ...options,
  });
  return { updater, root, serverDir, frontend };
}
test("validates versions, complete file allowlist, integrity and paired manifests", () => {
  expect(newer("1.10.0", "1.2.9")).toBe(true);
  expect(newer("1.2.0-evil", "1.1.0")).toBe(false);
  const altered = bundle();
  altered.files[0].content = Buffer.from("corrupt").toString("base64");
  expect(() => validatePackage(altered, "1.3.0")).toThrow("校验");
  const traversal = bundle();
  traversal.files[0].path = "../config.json";
  expect(() => validatePackage(traversal, "1.3.0")).toThrow("文件列表");
  expect(() => validatePackage(bundle(), "1.4.0")).toThrow("版本");
});

test("version checks share a cached metadata request and never install files", async () => {
  const calls = [];
  const { updater } = fixture({
    download: async (url) => {
      calls.push(url);
      return { tag_name: "v1.9.0", assets: [{ name: UPDATE_ASSET }] };
    },
  });
  const results = await Promise.all([
    updater.check(),
    updater.check(),
    updater.check(),
  ]);
  expect(results.every((r) => r.available)).toBe(true);
  await updater.check();
  expect(calls).toEqual([
    `https://api.github.com/repos/${REPOSITORY}/releases/latest`,
  ]);
  expect(updater.state.state).toBe("idle");
});
test("updates both components, preserves user data, backs up and requires restart", async () => {
  const { updater, root, serverDir, frontend } = fixture();
  expect((await updater.check()).available).toBe(true);
  expect(updater.start().state).toBe("updating");
  expect(() => updater.start()).toThrow("正在进行");
  await updater.promise;
  expect(updater.state).toMatchObject({
    state: "installed",
    installedVersion: "1.3.0",
    restartRequired: true,
  });
  expect(
    JSON.parse(fs.readFileSync(path.join(serverDir, "package.json"))).version,
  ).toBe("1.3.0");
  expect(
    JSON.parse(fs.readFileSync(path.join(frontend, "manifest.json"))).version,
  ).toBe("1.3.0");
  expect(fs.readFileSync(path.join(root, "data/config.json"), "utf8")).toBe(
    "private-preserve",
  );
  expect(
    fs.existsSync(
      path.join(root, "backups", updater.state.backup, "restore.json"),
    ),
  ).toBe(true);
  expect(() => updater.start()).toThrow("重启");
});
test("rolls back all modified files after a replacement failure", async () => {
  let writes = 0;
  const { updater, frontend, serverDir } = fixture({
    replace(from, to) {
      if (++writes === 4) throw new Error("disk failure");
      fs.renameSync(from, to);
    },
  });
  updater.start();
  await updater.promise;
  expect(updater.state.state).toBe("failed");
  expect(updater.state.error).toContain("已恢复");
  for (const [dir, name] of [
    [frontend, "manifest.json"],
    [serverDir, "package.json"],
  ])
    expect(JSON.parse(fs.readFileSync(path.join(dir, name))).version).toBe(
      "1.2.0",
    );
});
test("rejects active generation, untrusted release assets and symbolic links", async () => {
  expect(() => fixture({ busy: () => true }).updater.start()).toThrow(
    "生成任务",
  );
  const wrong = fixture({
    download: async () => ({
      tag_name: "v1.3.0",
      assets: [
        {
          name: UPDATE_ASSET,
          browser_download_url: "https://example.com/untrusted.json",
        },
      ],
    }),
  }).updater;
  wrong.start();
  await wrong.promise;
  expect(wrong.state.state).toBe("failed");
  const { updater, root, frontend } = fixture();
  const dist = path.join(frontend, "dist");
  fs.renameSync(dist, path.join(root, "linked-dist"));
  fs.symlinkSync(path.join(root, "linked-dist"), dist, "junction");
  updater.start();
  await updater.promise;
  expect(updater.state.state).toBe("failed");
  expect(updater.state.error).toContain("符号链接");
});
