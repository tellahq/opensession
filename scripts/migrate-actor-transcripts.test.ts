import { describe, expect, test } from "bun:test";
import { assertServicesStopped } from "./migrate-actor-transcripts";

const services = [
  "opensession.service",
  "opensession-executor.service",
  "opensession-session-kernel.service",
];

describe("actor transcript migration service guard", () => {
  test("requires every service to report explicit inactive", () => {
    const checked: string[] = [];
    assertServicesStopped((service) => {
      checked.push(service);
      return { exitCode: 3, stdout: "inactive\n", stderr: "" };
    });
    expect(checked).toEqual(services);
  });

  test("fails closed for every non-inactive transitional state", () => {
    for (const state of [
      "active",
      "activating",
      "deactivating",
      "unknown",
      "failed",
    ])
      expect(() =>
        assertServicesStopped(() => ({
          exitCode: state === "unknown" ? 3 : 0,
          stdout: `${state}\n`,
          stderr: "",
        })),
      ).toThrow("did not report explicit inactive state");
  });

  test("fails closed on systemctl and DBus errors", () => {
    for (const result of [
      { exitCode: 1, stdout: "", stderr: "Failed to connect to bus" },
      { exitCode: 1, stdout: "inactive\n", stderr: "Access denied" },
      { exitCode: 4, stdout: "inactive\n", stderr: "" },
    ])
      expect(() => assertServicesStopped(() => result)).toThrow(
        "did not report explicit inactive state",
      );
  });
});
