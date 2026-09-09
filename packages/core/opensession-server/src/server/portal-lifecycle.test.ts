import { describe, expect, test } from "bun:test";
import {
  establishedPorts,
  HostPortalActivity,
  PORTAL_IDLE_MS,
  portalCapacityProblem,
} from "./portal-lifecycle";

const healthy = {
  meminfo: "MemTotal: 100000000 kB\nMemAvailable: 50000000 kB\n",
};

describe("host Portal admission", () => {
  test("allows healthy hosts with or without a configured cgroup budget", () => {
    expect(portalCapacityProblem(healthy)).toBeNull();
    expect(
      portalCapacityProblem({ ...healthy, current: "500", high: "max" }),
    ).toBeNull();
    expect(
      portalCapacityProblem({ ...healthy, current: "500", high: "1000" }),
    ).toBeNull();
  });
  test("rejects memory starvation and malformed availability", () => {
    expect(
      portalCapacityProblem({
        meminfo: "MemTotal: 100000000 kB\nMemAvailable: 1000000 kB",
      }),
    ).toContain("nearly full");
    expect(portalCapacityProblem({ meminfo: "" })).toContain(
      "could not be measured",
    );
  });
  test("rejects sustained reclaim stalls, not old swap usage", () => {
    expect(
      portalCapacityProblem({
        ...healthy,
        pressure: "some avg10=90.00\nfull avg10=10.00 avg60=4.00",
      }),
    ).toContain("stalled");
    expect(
      portalCapacityProblem({
        ...healthy,
        pressure: "some avg10=5.00\nfull avg10=0.00 avg60=90.00",
      }),
    ).toBeNull();
  });
  test("reserves headroom before the aggregate soft limit", () => {
    expect(
      portalCapacityProblem({ ...healthy, current: "899", high: "1000" }),
    ).toBeNull();
    expect(
      portalCapacityProblem({ ...healthy, current: "900", high: "1000" }),
    ).toContain("preview memory budget");
  });
});

describe("Portal idle activity", () => {
  test("expiry counts from discovery, not an ancient process start time", () => {
    const activity = new HostPortalActivity();
    activity.observe(4000, "old-process", 100);
    expect(activity.idle(4000, "old-process", 100 + PORTAL_IDLE_MS - 1)).toBe(
      false,
    );
    expect(activity.idle(4000, "old-process", 100 + PORTAL_IDLE_MS)).toBe(true);
  });
  test("HTTP traffic extends the window but repeated observation does not", () => {
    const activity = new HostPortalActivity();
    activity.observe(4000, "a", 0);
    activity.observe(4000, "a", PORTAL_IDLE_MS - 1);
    expect(activity.idle(4000, "a", PORTAL_IDLE_MS)).toBe(true);
    activity.touch(4000, PORTAL_IDLE_MS);
    expect(activity.idle(4000, "a", 2 * PORTAL_IDLE_MS - 1)).toBe(false);
  });
  test("a replacement process gets its own idle window", () => {
    const activity = new HostPortalActivity();
    activity.observe(4000, "a", 0);
    activity.observe(4000, "b", PORTAL_IDLE_MS);
    expect(activity.idle(4000, "a", 2 * PORTAL_IDLE_MS)).toBe(false);
    expect(activity.idle(4000, "b", PORTAL_IDLE_MS + 1)).toBe(false);
    activity.retain(new Set());
    activity.touch(4000, 3 * PORTAL_IDLE_MS);
    expect(activity.idle(4000, "b", 4 * PORTAL_IDLE_MS)).toBe(false);
  });
  test("recognizes established IPv4/IPv6 server ports, not listeners or peers", () => {
    expect(
      establishedPorts([
        "sl local_address rem_address st\n0: 0100007F:0FA0 0100007F:CB22 01\n1: 0100007F:0FA1 00000000:0000 0A",
        "sl local_address rem_address st\n0: 00000000000000000000000001000000:0FA2 00000000000000000000000001000000:CAAA 01\nmalformed",
      ]),
    ).toEqual(new Set([4000, 4002]));
  });
});
