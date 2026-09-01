import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  publishGatewayBackendPort,
  readGatewayBackendPort,
} from "./gateway-routing";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

test("gateway backend selection is atomic and fail-closed", () => {
  const state = mkdtempSync(join(tmpdir(), "gateway-routing-"));
  roots.push(state);
  expect(readGatewayBackendPort(state)).toBe(0);
  publishGatewayBackendPort(state, 43123);
  expect(readGatewayBackendPort(state)).toBe(43123);
  publishGatewayBackendPort(state, Number.NaN);
  expect(readGatewayBackendPort(state)).toBe(0);
});
