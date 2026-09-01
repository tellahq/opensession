import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { CodexAccount } from "./codex-accounts";
import {
  enableOpenaiFastMode,
  buildOpenaiRemoteSeedUpload,
  buildSeededOpenaiAuth,
  supportsOpenaiFastMode,
} from "./openai-auth";

describe("OpenAI auth", () => {
  test("advertises priority-tier variants for current ChatGPT models", () => {
    expect(supportsOpenaiFastMode("pi/openai/gpt-5.6-sol")).toBe(true);
    expect(supportsOpenaiFastMode("openai/gpt-5.6-terra")).toBe(true);
    expect(supportsOpenaiFastMode("gpt-5.6-luna")).toBe(true);
    expect(supportsOpenaiFastMode("pi/anthropic/claude-fable-5")).toBe(false);
  });

  test("adds the priority service tier after Pi's existing payload hook", async () => {
    const agent = {
      onPayload: async (
        payload: unknown,
      ): Promise<Record<string, unknown>> => ({
        ...(payload as Record<string, unknown>),
        existing_hook: true,
      }),
    };
    const payload = { model: "gpt-5.6-sol", stream: true };
    enableOpenaiFastMode(agent);

    expect(await agent.onPayload(payload)).toEqual({
      model: "gpt-5.6-sol",
      stream: true,
      existing_hook: true,
      service_tier: "priority",
    });
    expect(payload).toEqual({ model: "gpt-5.6-sol", stream: true });
  });

  test("round-trips the projected remote seed without copying host credentials", () => {
    const root = mkdtempSync(join(tmpdir(), "opensession-openai-seed-"));
    const hostHome = join(root, "host-only-codex-home");
    const remoteRoot = join(root, "remote-seeds");
    const expires = (Math.floor(Date.now() / 1000) + 3600) * 1000;
    const access = `h.${Buffer.from(JSON.stringify({ exp: expires / 1000 })).toString("base64url")}.s`;
    const homeAccount: CodexAccount = {
      id: "remote-account",
      name: "Remote account",
      kind: "home",
      value: hostHome,
      createdAt: "2026-08-20T00:00:00.000Z",
    };
    const apiKeyAccount: CodexAccount = {
      id: "scoped-api-key",
      name: "Scoped API key",
      kind: "api_key",
      value: "test-selected-remote-key",
      createdAt: "2026-08-20T00:00:00.000Z",
    };
    try {
      mkdirSync(hostHome, { recursive: true });
      writeFileSync(
        join(hostHome, "auth.json"),
        JSON.stringify({
          tokens: {
            access_token: access,
            refresh_token: "host-refresh-must-not-cross",
            id_token: "host-id-token-must-not-cross",
            account_id: "provider-account-id",
          },
        }),
      );

      const upload = buildOpenaiRemoteSeedUpload([homeAccount, apiKeyAccount]);
      expect(upload.accounts).toEqual([
        { ...homeAccount, value: "opensession-remote-seed" },
        apiKeyAccount,
      ]);
      expect(upload.skipped).toEqual([]);
      const serialized = JSON.stringify({
        accounts: upload.accounts,
        seeds: upload.seeds,
      });
      expect(serialized).toContain(apiKeyAccount.value);
      expect(serialized).not.toContain(hostHome);
      expect(serialized).not.toContain("host-refresh-must-not-cross");
      expect(serialized).not.toContain("host-id-token-must-not-cross");
      expect(upload.seeds).toHaveLength(1);
      expect(
        upload.seeds.some((seed) => seed.accountId === apiKeyAccount.id),
      ).toBe(false);

      const seed = upload.seeds[0];
      const accountDir = join(remoteRoot, seed.accountId);
      mkdirSync(accountDir, { recursive: true });
      writeFileSync(join(accountDir, "auth.json"), seed.content);
      expect(buildSeededOpenaiAuth(upload.accounts[0], remoteRoot)).toEqual({
        seeded: {
          openai: {
            type: "oauth",
            access,
            refresh: "codex-managed-no-refresh",
            expires,
            accountId: "provider-account-id",
          },
        },
      });

      const expired = JSON.parse(seed.content);
      expired.openai.expires = Date.now() - 1;
      writeFileSync(join(accountDir, "auth.json"), JSON.stringify(expired));
      expect(buildSeededOpenaiAuth(upload.accounts[0], remoteRoot)).toEqual({
        error: 'ChatGPT account "Remote account" has an expired access token',
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("projects only designated account fields and never spreads unknown host data", () => {
    const selected = {
      id: "selected",
      name: "Selected",
      kind: "api_key",
      value: "sk-selected",
      owner: "Alex",
      createdAt: "2026-08-20T00:00:00.000Z",
      futureHostSecret: "must-not-cross",
      hostCredentialPath: "/home/ubuntu/.codex-secret",
    } as CodexAccount;
    const other = {
      id: "other",
      name: "Other",
      kind: "api_key",
      value: "sk-other",
      createdAt: "2026-08-20T00:00:00.000Z",
    } satisfies CodexAccount;

    const upload = buildOpenaiRemoteSeedUpload(
      [selected, other],
      [selected.id],
      "Alex",
    );
    expect(upload.accounts).toEqual([
      {
        id: "selected",
        name: "Selected",
        kind: "api_key",
        value: "sk-selected",
        owner: "Alex",
        createdAt: "2026-08-20T00:00:00.000Z",
      },
    ]);
    const serialized = JSON.stringify(upload);
    expect(serialized).not.toContain("sk-other");
    expect(serialized).not.toContain("must-not-cross");
    expect(serialized).not.toContain("/home/ubuntu");
  });
});
