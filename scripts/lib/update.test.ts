import { describe, expect, spyOn, test } from "bun:test";
import {
  classifyTopology,
  parseRemotes,
  parseSha256Checksum,
  restartReleaseWithRollback,
} from "./update";
import { mkdtempSync, readlinkSync, rmSync, symlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const UPSTREAM_HTTPS = "https://github.com/tellahq/opensession.git";
const UPSTREAM_SSH = "git@github.com:tellahq/opensession.git";
const FORK = "git@github.com:acme/opensession.git";

describe("parseSha256Checksum", () => {
  const digest = "a".repeat(64);

  test("accepts sha256sum sidecars and bare digests", () => {
    expect(
      parseSha256Checksum(`${digest}  opensession-linux-x64.tar.gz\n`),
    ).toBe(digest);
    expect(parseSha256Checksum(digest.toUpperCase())).toBe(digest);
  });

  test("rejects malformed or non-SHA-256 values", () => {
    expect(parseSha256Checksum("not-a-checksum file.tar.gz")).toBeUndefined();
    expect(parseSha256Checksum("a".repeat(63))).toBeUndefined();
    expect(parseSha256Checksum("")).toBeUndefined();
  });
});

describe("parseRemotes", () => {
  test("parses fetch remotes and ignores push duplicates", () => {
    const out = [
      `origin\t${FORK} (fetch)`,
      `origin\t${FORK} (push)`,
      `upstream\t${UPSTREAM_HTTPS} (fetch)`,
      `upstream\t${UPSTREAM_HTTPS} (push)`,
    ].join("\n");
    expect(parseRemotes(out)).toEqual([
      { name: "origin", url: FORK },
      { name: "upstream", url: UPSTREAM_HTTPS },
    ]);
  });

  test("empty input parses to no remotes", () => {
    expect(parseRemotes("")).toEqual([]);
  });
});

describe("classifyTopology", () => {
  test("origin = fork + upstream remote → fork topology from that remote", () => {
    for (const url of [UPSTREAM_HTTPS, UPSTREAM_SSH]) {
      expect(
        classifyTopology([
          { name: "origin", url: FORK },
          { name: "upstream", url },
        ]),
      ).toEqual({ source: "upstream", kind: "fork" });
    }
  });

  test("the upstream remote may have any name", () => {
    expect(
      classifyTopology([
        { name: "origin", url: FORK },
        { name: "tella", url: UPSTREAM_SSH },
      ]),
    ).toEqual({ source: "tella", kind: "fork" });
  });

  test("origin-only clone of the upstream project stays ff-only", () => {
    expect(classifyTopology([{ name: "origin", url: UPSTREAM_HTTPS }])).toEqual(
      {
        source: "origin",
        kind: "origin",
      },
    );
  });

  test("origin IS the upstream project even with extra remotes → ff-only origin", () => {
    // Both remotes point at the project (e.g. our own instance): fork-merge
    // semantics would be wrong; plain ff from origin is.
    expect(
      classifyTopology([
        { name: "origin", url: UPSTREAM_SSH },
        { name: "mirror", url: UPSTREAM_HTTPS },
      ]),
    ).toEqual({ source: "origin", kind: "origin" });
  });

  test("fork origin without an upstream remote stays ff-only against origin", () => {
    expect(classifyTopology([{ name: "origin", url: FORK }])).toEqual({
      source: "origin",
      kind: "origin",
    });
  });

  test("no remotes at all → conservative default", () => {
    expect(classifyTopology([])).toEqual({ source: "origin", kind: "origin" });
  });
});

describe.each(["restart", "health"])(
  "release rollback after %s failure",
  (failure) => {
    test.each(["healthy", "restart fails", "health fails"])(
      "rollback: %s",
      async (outcome) => {
        const dir = mkdtempSync(join(tmpdir(), "opensession-rollback-test-"));
        const src = join(dir, "src");
        const previous = join(dir, "previous");
        symlinkSync(join(dir, "candidate"), src);
        const messages: string[] = [];
        const log = spyOn(console, "log").mockImplementation((message) => {
          messages.push(String(message));
        });
        const calls: string[] = [];
        let restarts = 0;
        try {
          const code = await restartReleaseWithRollback(
            src,
            previous,
            {},
            {
              healthBaseUrl: async () => "http://127.0.0.1:3850",
              service: {
                isInstalled: async () => true,
                restartExecutor: async () => {
                  calls.push("executor");
                  return 0;
                },
                control: async () => {
                  calls.push("restart");
                  restarts++;
                  if (restarts === 2) expect(readlinkSync(src)).toBe(previous);
                  if (restarts === 1) return failure === "restart" ? 1 : 0;
                  return outcome === "restart fails" ? 1 : 0;
                },
                waitHealthy: async () => {
                  calls.push("health");
                  return restarts === 2 && outcome === "healthy";
                },
              },
            },
          );
          expect(code).toBe(1); // An unsuccessful update still fails after recovery.
          expect(readlinkSync(src)).toBe(previous);
          const output = messages.join("\n");
          if (outcome === "healthy")
            expect(output).toContain("verified healthy");
          else {
            expect(output).toContain("rollback did not come back healthy");
            expect(output).toContain("opensession restart");
            expect(output).not.toContain("verified healthy");
          }
          expect(calls).toEqual([
            "executor",
            "restart",
            ...(failure === "health" ? ["health"] : []),
            "executor",
            "restart",
            ...(outcome === "restart fails" ? [] : ["health"]),
          ]);
        } finally {
          log.mockRestore();
          rmSync(dir, { recursive: true, force: true });
        }
      },
    );
  },
);
