import { describe, expect, test } from "bun:test";
import { parseRunnerBootstrapConfig } from "./runner-bootstrap";

describe("Runner bootstrap configuration", () => {
  test("admits only named, pinned operator targets", () => {
    const parsed = parseRunnerBootstrapConfig({
      ssh: [
        {
          id: "mac-mini",
          label: "Office Mac mini",
          host: "mac-mini.tailnet",
          user: "runner",
          fingerprint: "SHA256:abc",
          knownHostsPath: "/etc/opensession/runner-known-hosts",
          runnerCommand: "/opt/opensession/bin/opensession",
        },
      ],
      kubernetes: [
        {
          id: "gpu-devbox",
          label: "GPU devbox",
          context: "prod-gpu",
          namespace: "runners",
          workload: "gpu-runner",
          manifestPath: "/etc/opensession/runners/gpu-devbox.yaml",
          container: "runner",
        },
      ],
    });
    expect(parsed.ssh[0]?.host).toBe("mac-mini.tailnet");
    expect(parsed.kubernetes[0]?.workload).toBe("gpu-runner");
  });

  test("rejects raw commands and unpinned or malformed targets", () => {
    const parsed = parseRunnerBootstrapConfig({
      ssh: [
        {
          id: "bad",
          label: "Bad",
          host: "host;whoami",
          user: "runner",
          fingerprint: "not-pinned",
          knownHostsPath: "relative",
        },
      ],
      kubernetes: [
        {
          id: "bad gpu",
          label: "Bad",
          context: "ctx",
          namespace: "default",
          workload: "pod/name",
          manifestPath: "runner.yaml",
        },
      ],
    });
    expect(parsed.ssh).toEqual([]);
    expect(parsed.kubernetes).toEqual([]);
  });
});
