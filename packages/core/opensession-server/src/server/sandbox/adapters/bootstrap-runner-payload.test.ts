import { describe, expect, test } from "bun:test";
import {
  DEFAULT_RUNNER_REPO_URL,
  releaseTag,
  resolveRunnerPayload,
} from "./bootstrap";

const release = { version: "0.4.55", commit: "abc1234" };

describe("runner payload resolution", () => {
  test("a release install with no origin falls back to the public repo at its release tag", () => {
    // Issue #245: `install.sh` unpacks a release tarball, not a git checkout.
    const payload = resolveRunnerPayload({ origin: "", release });
    expect(payload).toEqual({
      repoUrl: DEFAULT_RUNNER_REPO_URL,
      pin: "v0.4.55",
      pinIsTag: true,
      source: "release",
    });
  });

  test("an ad-hoc release build without a tag is unpinned", () => {
    const payload = resolveRunnerPayload({
      origin: "",
      release: { version: "0.1.0+abc1234", commit: "abc1234" },
    });
    expect(payload.repoUrl).toBe(DEFAULT_RUNNER_REPO_URL);
    expect(payload.pin).toBeUndefined();
    expect(payload.pinIsTag).toBe(false);
    expect(payload.source).toBe("release");
  });

  test("an explicit runnerSha wins over the release tag", () => {
    const payload = resolveRunnerPayload({
      origin: "",
      release,
      runnerSha: "deadbeef",
    });
    expect(payload.pin).toBe("deadbeef");
    expect(payload.pinIsTag).toBe(false);
    expect(payload.source).toBe("release");
  });

  test("a source checkout keeps its origin, converting ssh to https", () => {
    const payload = resolveRunnerPayload({
      origin: "git@github.com:someone/opensession.git",
      release: null,
      runnerSha: "abc",
    });
    expect(payload).toEqual({
      repoUrl: "https://github.com/someone/opensession.git",
      pin: "abc",
      source: "origin",
    });
  });

  test("runnerRepoUrl overrides the origin and is credential-scrubbed", () => {
    const payload = resolveRunnerPayload({
      origin: "git@github.com:someone/fork.git",
      release: null,
      runnerRepoUrl:
        "https://x-access-token:secret@github.com/tellahq/opensession.git",
    });
    expect(payload.repoUrl).toBe(DEFAULT_RUNNER_REPO_URL);
    expect(payload.source).toBe("config");
  });

  test("runnerBundleUrl takes precedence over every clone source", () => {
    const payload = resolveRunnerPayload({
      origin: "https://github.com/someone/fork.git",
      release,
      runnerBundleUrl: "https://example.com/runner.tgz",
      runnerSha: "abc",
    });
    expect(payload).toEqual({
      bundleUrl: "https://example.com/runner.tgz",
      pin: "abc",
      source: "bundle",
    });
  });

  test("a source checkout without any https-reachable origin still fails loudly", () => {
    expect(() =>
      resolveRunnerPayload({ origin: "/srv/git/opensession", release: null }),
    ).toThrow(/no https-reachable origin/);
    expect(() => resolveRunnerPayload({ origin: "", release: null })).toThrow(
      /runnerRepoUrl or runnerBundleUrl/,
    );
  });

  test("releaseTag only accepts published semver versions", () => {
    expect(releaseTag("0.4.55")).toBe("v0.4.55");
    expect(releaseTag("1.0.0-rc.1")).toBe("v1.0.0-rc.1");
    expect(releaseTag("0.1.0+abc1234")).toBeUndefined();
    expect(releaseTag(undefined)).toBeUndefined();
  });
});
