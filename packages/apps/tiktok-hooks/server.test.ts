import { afterAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "tiktok-hooks-api-test-"));

const { startDashboard } = await import("./server");
const dashboard = await startDashboard({ homeDir: home, port: 0 });
const { server } = dashboard;
const db = new Database(join(home, "hooks.sqlite"));

const url = `http://127.0.0.1:${server.port}/api/hooks/1`;

db.run(
  `INSERT INTO hooks (id, url, creator, title, hook, transcript, kind, source, saved_at)
   VALUES ('1', 'https://www.tiktok.com/@creator/video/1', 'creator', 'Title',
           'Hook', 'Transcript', 'question', 'manual', '2026-09-11')`,
);

afterAll(() => {
  dashboard.close();
  db.close();
  rmSync(home, { recursive: true, force: true });
});

test.each(["toString", "constructor", "__proto__", "unknown-kind"])(
  "PATCH rejects non-taxonomy kind %s without changing the hook",
  async (kind) => {
    const before = db.query("SELECT * FROM hooks WHERE id = '1'").get();

    const response = await fetch(url, {
      method: "PATCH",
      body: JSON.stringify({ kind }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "unknown kind" });
    expect(db.query("SELECT * FROM hooks WHERE id = '1'").get()).toEqual(
      before,
    );
  },
);

test("PATCH accepts a taxonomy kind and persists the manual override", async () => {
  const response = await fetch(url, {
    method: "PATCH",
    body: JSON.stringify({ kind: "contrarian" }),
  });

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ id: "1", kind: "contrarian" });
  expect(
    db.query("SELECT kind, kind_reason FROM hooks WHERE id = '1'").get(),
  ).toEqual({
    kind: "contrarian",
    kind_reason: "Set by hand in the dashboard",
  });
});

test("starting twice reuses the dashboard", async () => {
  expect(await startDashboard({ homeDir: home, port: 0 })).toBe(dashboard);
});

test("dashboard and API work behind the published app prefix", async () => {
  const base = `http://127.0.0.1:${server.port}/d/tiktok-hooks`;
  const page = await fetch(`${base}/`);
  expect(page.status).toBe(200);
  expect(await page.text()).toContain("<html");
  const response = await fetch(`${base}/api/hooks`);
  expect(response.status).toBe(200);
  const payload = await response.json();
  expect(payload.hooks).toHaveLength(1);
  expect(payload.hooks[0].id).toBe("1");
});
