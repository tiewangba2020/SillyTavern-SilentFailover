import { test, expect, beforeAll, afterAll } from "vitest";
import express from "express";
import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../../server/store.js";
import { init, exit } from "../../server/index.js";
let dir, server, url;
beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(tmpdir(), "sf-api-"));
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    const user = req.headers["x-test-user"];
    if (["one", "two"].includes(user))
      req.user = { directories: { root: path.join(dir, user) } };
    next();
  });
  const router = express.Router();
  await init(router);
  app.use("/api", router);
  server = await new Promise((r) => {
    const s = app.listen(0, "127.0.0.1", () => r(s));
  });
  url = `http://127.0.0.1:${server.address().port}/api`;
});
afterAll(async () => {
  await exit();
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  fs.rmSync(dir, { recursive: true, force: true });
});
async function call(user, route, body) {
  return fetch(url + route, {
    method: body ? "POST" : "GET",
    headers: {
      "Content-Type": "application/json",
      ...(user ? { "x-test-user": user } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}
test("management API rejects unauthenticated callers", async () => {
  expect((await call(null, "/config")).status).toBe(401);
});
test("per-user settings and task results cannot be read by another user", async () => {
  const config = {
    enabled: true,
    loop: false,
    nodes: [
      {
        name: "private-one",
        url: "https://example.com/v1",
        model: "x",
        key: "private-long-key",
      },
    ],
  };
  const response = await call("one", "/config", config);
  const data = await response.json();
  expect(response.status).toBe(200);
  expect(JSON.stringify(data)).not.toContain("private-long-key");
  expect((await (await call("two", "/config")).json()).nodes).toEqual([]);
  const task = await (
    await call("one", "/jobs", {
      id: "private-task",
      request: { messages: [] },
    })
  ).json();
  expect(task.state).toBe("invalid");
  expect((await call("two", "/jobs/private-task")).status).toBe(404);
});
test("keys survive masked config edits and server storage reload", () => {
  const store = new Store(path.join(dir, "persist"));
  const c = store.save({
    enabled: true,
    loop: false,
    nodes: [
      {
        name: "a",
        url: "https://example.com/v1",
        model: "a",
        key: "persist-key",
      },
    ],
  });
  store.save({ ...c, loop: true });
  expect(new Store(path.join(dir, "persist")).config.nodes[0].key).toBe(
    "persist-key",
  );
  expect(JSON.stringify(store.publicConfig())).not.toContain("persist-key");
});
test("rejects duplicate node IDs, credential URLs and recursive endpoints before overwriting", () => {
  const store = new Store(path.join(dir, "validation"));
  const n = { id: "a", name: "a", url: "https://example.com/v1", model: "a" };
  expect(() => store.save({ nodes: [n, n] })).toThrow("ID");
  expect(() =>
    store.save({
      nodes: [{ ...n, url: "https://secret:pass@example.com/v1" }],
    }),
  ).toThrow("API");
  expect(() =>
    store.save({
      nodes: [{ ...n, url: "http://sillytavern-failover.invalid/v1" }],
    }),
  ).toThrow("上游");
  expect(store.config.nodes).toEqual([]);
});
