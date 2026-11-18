import { describe, expect, test } from "bun:test";
import { foreignHostViolation } from "./web-auth";

const on = { OPENSESSION_LOOPBACK_HOSTS_ONLY: "1" };
const request = (host: string | null) =>
  new Request("http://127.0.0.1:47850/api/sessions", {
    headers: host === null ? {} : { host },
  });

describe("foreignHostViolation", () => {
  test("is off unless the server is machine-local", () => {
    expect(foreignHostViolation(request("os.example.test"), {})).toBeNull();
    expect(
      foreignHostViolation(request("os.example.test"), {
        OPENSESSION_LOOPBACK_HOSTS_ONLY: "0",
      }),
    ).toBeNull();
  });

  test("accepts every name for this machine", () => {
    for (const host of [
      "127.0.0.1:47850",
      "localhost:47850",
      "LOCALHOST",
      "[::1]:47850",
      "portal-abc.localhost:47850",
    ]) {
      expect(foreignHostViolation(request(host), on)).toBeNull();
    }
  });

  test("refuses a domain re-pointed at this machine", () => {
    expect(foreignHostViolation(request("rebind.example.test:47850"), on)).toBe(
      "host rebind.example.test",
    );
    expect(foreignHostViolation(request("127.0.0.1.example.test"), on)).toBe(
      "host 127.0.0.1.example.test",
    );
    expect(foreignHostViolation(request("notlocalhost"), on)).toBe(
      "host notlocalhost",
    );
  });

  test("refuses a request that names no usable host", () => {
    expect(foreignHostViolation(request(null), on)).toBe("no host");
    expect(foreignHostViolation(request("a b"), on)).toBe("malformed host");
  });
});
