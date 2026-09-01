import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  claimPreviewPathLease,
  releasePreviewPathLease,
} from "./preview-path-leases";

const roots: string[] = [];

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "preview-path-leases-"));
  roots.push(root);
  return join(root, "leases.json");
}

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe("preview path leases", () => {
  test("keeps a mutable staging record exclusive across sessions", () => {
    const file = fixture();
    const first = claimPreviewPathLease(
      {
        key: "video:vid_fixture",
        sessionId: "session-a",
        path: "/video/vid_fixture/edit",
      },
      { file, now: 1_000 },
    );
    const conflict = claimPreviewPathLease(
      {
        key: "video:vid_fixture",
        sessionId: "session-b",
        path: "/video/vid_fixture/edit?status=Subtitles",
      },
      { file, now: 2_000 },
    );

    expect(first.ok).toBe(true);
    expect(conflict).toEqual({ ok: false, reason: "in_use" });
  });

  test("renews one session idempotently and replaces its previous record", () => {
    const file = fixture();
    const first = claimPreviewPathLease(
      {
        key: "video:first",
        sessionId: "session-a",
        path: "/video/first/edit",
      },
      { file, now: 1_000 },
    );
    const renewed = claimPreviewPathLease(
      {
        key: "video:first",
        sessionId: "session-a",
        path: "/video/first/edit?status=Subtitles",
      },
      { file, now: 2_000 },
    );
    const replacement = claimPreviewPathLease(
      {
        key: "video:second",
        sessionId: "session-a",
        path: "/video/second/edit",
      },
      { file, now: 3_000 },
    );
    const store = JSON.parse(readFileSync(file, "utf8"));

    expect(first.ok && renewed.ok && renewed.lease.id).toBe(
      first.ok ? first.lease.id : "",
    );
    expect(replacement.ok).toBe(true);
    expect(store.leases).toHaveLength(1);
    expect(store.leases[0]).toMatchObject({
      key: "video:second",
      sessionId: "session-a",
    });
  });

  test("reclaims expired records and fences release by lease id", () => {
    const file = fixture();
    const first = claimPreviewPathLease(
      {
        key: "video:fixture",
        sessionId: "session-a",
        path: "/video/fixture/edit",
        ttlMinutes: 10,
      },
      { file, now: 1_000 },
    );
    const second = claimPreviewPathLease(
      {
        key: "video:fixture",
        sessionId: "session-b",
        path: "/video/fixture/edit",
      },
      { file, now: 601_001 },
    );

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(
      releasePreviewPathLease("session-b", {
        file,
        now: 602_000,
        leaseId: "stale-lease",
      }),
    ).toBe(false);
    expect(
      releasePreviewPathLease("session-b", {
        file,
        now: 602_000,
        leaseId: second.ok ? second.lease.id : "",
      }),
    ).toBe(true);
  });

  test("validates keys and bounded reservation time", () => {
    const file = fixture();
    expect(() =>
      claimPreviewPathLease(
        {
          key: "\n",
          sessionId: "session-a",
          path: "/video/fixture/edit",
        },
        { file },
      ),
    ).toThrow("Exclusive preview key");
    expect(() =>
      claimPreviewPathLease(
        {
          key: "video:fixture",
          sessionId: "session-a",
          path: "/video/fixture/edit",
          ttlMinutes: 1,
        },
        { file },
      ),
    ).toThrow("between 10 minutes and 30 days");
  });
});
