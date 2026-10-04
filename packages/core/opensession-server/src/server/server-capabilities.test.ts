import { expect, test } from "bun:test";
import {
  CAPABILITY_KEYS,
  decodeServerDescriptor,
  supportsCapability,
} from "@tellahq/opensession-protocol/capabilities";
import {
  SERVER_DESCRIPTOR,
  serverCapabilitiesResponse,
} from "./server-capabilities";

// Deliberate compatibility lock. Adding keys is fine; removing/renaming one
// requires an explicit compatibility decision, not a incidental refactor.
test("advertised keys remain additive", () => {
  expect([...CAPABILITY_KEYS].sort()).toEqual([
    "commandResults",
    "deskVoice",
    "sessionCreateIdempotency",
    "sessionListSlices",
    "sessionVoice",
  ]);
  expect(Object.keys(SERVER_DESCRIPTOR.capabilities).sort()).toEqual(
    [...CAPABILITY_KEYS].sort(),
  );
});

test("HTTP bootstrap returns the same process-constant descriptor as hello", async () => {
  const response = serverCapabilitiesResponse();
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(await response.json()).toEqual(SERVER_DESCRIPTOR);
  expect(await serverCapabilitiesResponse().json()).toEqual(SERVER_DESCRIPTOR);
});

test("absent, false, malformed and future capability values are safe", () => {
  expect(decodeServerDescriptor(null)).toBeNull();
  expect(supportsCapability(null, "deskVoice")).toBe(false);
  const descriptor = decodeServerDescriptor({
    serverVersion: "future",
    protocolVersion: 2,
    capabilities: {
      deskVoice: "true",
      sessionVoice: false,
      commandResults: 2,
      unknown: true,
    },
  });
  expect(descriptor?.capabilities).toEqual({
    sessionVoice: false,
    commandResults: 2,
  });
  expect(supportsCapability(descriptor, "deskVoice")).toBe(false);
  expect(supportsCapability(descriptor, "sessionVoice")).toBe(false);
  expect(supportsCapability(descriptor, "commandResults", 2)).toBe(true);
  expect(supportsCapability(descriptor, "commandResults", 3)).toBe(false);
  expect(supportsCapability(SERVER_DESCRIPTOR, "commandResults", 2)).toBe(
    false,
  );
});
