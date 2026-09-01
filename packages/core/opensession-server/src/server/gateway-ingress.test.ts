import { expect, test } from "bun:test";
import { inheritedIngressSocketFd } from "./gateway-ingress";

test("stable ingress accepts only its own systemd descriptor", () => {
  expect(
    inheritedIngressSocketFd({ LISTEN_PID: "42", LISTEN_FDS: "1" }, 42),
  ).toBe(3);
  expect(
    inheritedIngressSocketFd({ LISTEN_PID: "41", LISTEN_FDS: "1" }, 42),
  ).toBeUndefined();
  expect(
    inheritedIngressSocketFd({ LISTEN_PID: "42", LISTEN_FDS: "0" }, 42),
  ).toBeUndefined();
});
