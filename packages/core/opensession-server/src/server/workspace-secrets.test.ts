import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  deleteWorkspaceSecret,
  putWorkspaceSecret,
  resolveWorkspaceSecret,
  workspaceSecretExists,
} from "./workspace-secrets";

let scratch = "";
let previous: string | undefined;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "opensession-workspace-secrets-"));
  previous = process.env.OPENSESSION_WORKSPACE_SECRETS_STORE;
  process.env.OPENSESSION_WORKSPACE_SECRETS_STORE = join(
    scratch,
    "secrets.json",
  );
});

afterEach(() => {
  if (previous === undefined)
    delete process.env.OPENSESSION_WORKSPACE_SECRETS_STORE;
  else process.env.OPENSESSION_WORKSPACE_SECRETS_STORE = previous;
  rmSync(scratch, { recursive: true, force: true });
});

describe("workspace secrets", () => {
  test("creates, rotates, resolves and deletes an opaque 0600 secret", () => {
    const ref = putWorkspaceSecret("sandbox.daytona", "first");
    expect(ref).toMatch(/^wssec-/);
    expect(resolveWorkspaceSecret(ref)).toBe("first");
    expect(
      statSync(process.env.OPENSESSION_WORKSPACE_SECRETS_STORE!).mode & 0o777,
    ).toBe(0o600);

    expect(putWorkspaceSecret("sandbox.daytona", "second", ref)).toBe(ref);
    expect(resolveWorkspaceSecret(ref)).toBe("second");
    expect(workspaceSecretExists(ref)).toBe(true);
    expect(
      readFileSync(process.env.OPENSESSION_WORKSPACE_SECRETS_STORE!, "utf-8"),
    ).not.toContain("daytona-secret");

    expect(deleteWorkspaceSecret(ref)).toBe(true);
    expect(workspaceSecretExists(ref)).toBe(false);
  });
});
