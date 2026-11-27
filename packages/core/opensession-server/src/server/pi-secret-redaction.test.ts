import { describe, expect, test } from "bun:test";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  containsRedactedPlaceholder,
  piSecretRedactionTools,
  redactSecretsInText,
} from "./pi-secret-redaction";

function makeFakeJwt(): string {
  const header = Buffer.from(
    JSON.stringify({ alg: "HS256", typ: "JWT" }),
  ).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({ sub: "user_123", role: "admin" }),
  ).toString("base64url");
  const sig = "a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6";
  return `${header}.${payload}.${sig}`;
}

describe("redactSecretsInText", () => {
  test("redacts high-signal provider keys with typed placeholders", () => {
    const awsKey = ["AKIA", "IOSFODNN7EXAMPLE"].join("");
    const ghToken = ["ghp_", "AbCdEf1234567890".repeat(3)].join("");
    const anthropicKey = [
      "sk-ant-api03-",
      "xYz1234567890abcdef".repeat(2),
    ].join("");
    const stripeLive = ["sk_live_", "9876543210abcdefghij1234"].join("");
    const jwt = makeFakeJwt();

    const input = [
      `AWS_ACCESS_KEY_ID=${awsKey}`,
      `GH_TOKEN=${ghToken}`,
      `ANTHROPIC_API_KEY=${anthropicKey}`,
      `STRIPE_KEY=${stripeLive}`,
      `TOKEN=${jwt}`,
    ].join("\n");

    const res = redactSecretsInText(input, { allowDisable: false });
    expect(res.text).toContain("AWS_ACCESS_KEY_ID=[REDACTED:aws-access-key]");
    expect(res.text).toContain("GH_TOKEN=[REDACTED:github-token]");
    expect(res.text).toContain("ANTHROPIC_API_KEY=[REDACTED:anthropic-key]");
    expect(res.text).toContain("STRIPE_KEY=[REDACTED:stripe-key]");
    expect(res.text).toContain("TOKEN=[REDACTED:jwt]");
    expect(res.redactedTypes).toEqual(
      expect.arrayContaining([
        "aws-access-key",
        "github-token",
        "anthropic-key",
        "stripe-key",
        "jwt",
      ]),
    );
  });

  test("redacts PEM private key body while preserving BEGIN/END structure", () => {
    const pem = [
      "-----BEGIN RSA PRIVATE KEY-----",
      "MIIEpAIBAAKCAQEAv1234567890abcdef+/=",
      "SecondLineOfKeyMaterial0123456789+/=",
      "-----END RSA PRIVATE KEY-----",
    ].join("\n");

    const res = redactSecretsInText(pem, { allowDisable: false });
    expect(res.text).toBe(
      [
        "-----BEGIN RSA PRIVATE KEY-----",
        "[REDACTED:private-key]",
        "[REDACTED:private-key]",
        "-----END RSA PRIVATE KEY-----",
      ].join("\n"),
    );
    expect(res.redactedTypes).toEqual(["private-key"]);
  });

  test("redacts URL passwords and Bearer tokens while sparing placeholders", () => {
    const realUrl = "postgres://admin:S3cr3tP4ssw0rd99@db.example.com:5432/app";
    const placeholderUrl = "postgres://admin:changeme_local@localhost:5432/app";
    const authHeader =
      "Authorization: Bearer super_secret_bearer_token_9876543210";

    const res = redactSecretsInText(
      `${realUrl}\n${placeholderUrl}\n${authHeader}`,
      {
        allowDisable: false,
      },
    );
    expect(res.text).toContain(
      "postgres://admin:[REDACTED:url-credential]@db.example.com:5432/app",
    );
    expect(res.text).toContain(placeholderUrl);
    expect(res.text).toContain("Authorization: Bearer [REDACTED:bearer-token]");
  });

  test("strips invisible Unicode tag characters used in prompt injection", () => {
    const hidden =
      "hello" + String.fromCodePoint(0xe0069, 0xe0067, 0xe006e) + "world";
    const res = redactSecretsInText(hidden, { allowDisable: false });
    expect(res.text).toBe("helloworld");
    expect(res.strippedInvisibleTags).toBe(6); // 3 astral code points = 6 UTF-16 code units
  });

  test("leaves ordinary code, Stripe test keys, and non-JWT base64 untouched", () => {
    const input = [
      "const key = 'sk_test_1234567890abcdefghijklmnop';",
      "const sha = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';",
      "const url = 'https://example.com/docs/v1';",
    ].join("\n");
    const res = redactSecretsInText(input, { allowDisable: false });
    expect(res.text).toBe(input);
    expect(res.redactedTypes).toEqual([]);
  });
});

describe("piSecretRedactionTools", () => {
  test("redacts text results while preserving image blocks", async () => {
    const awsKey = ["AKIA", "IOSFODNN7EXAMPLE"].join("");
    const tool: ToolDefinition<any, any, any> = {
      name: "read",
      label: "read",
      description: "read",
      parameters: {} as any,
      execute: async () => ({
        content: [
          { type: "text", text: `key=${awsKey}` },
          { type: "image", mimeType: "image/png", data: awsKey },
        ],
        details: {},
      }),
    };
    const [wrapped] = piSecretRedactionTools([tool]);
    const res = await wrapped!.execute(
      "c1",
      { path: ".env" },
      undefined,
      undefined,
      {} as any,
    );
    expect((res.content[0] as { text: string }).text).toBe(
      "key=[REDACTED:aws-access-key]",
    );
    expect((res.content[1] as { data: string }).data).toBe(awsKey);
  });

  test("redacts thrown errors and appends edit guidance when edit input has a redacted placeholder", async () => {
    const ghToken = ["ghp_", "ZyXwVu9876543210".repeat(3)].join("");
    const editTool: ToolDefinition<any, any, any> = {
      name: "edit",
      label: "edit",
      description: "edit",
      parameters: {} as any,
      execute: async () => {
        throw new Error(`Could not find oldText matching token=${ghToken}`);
      },
    };
    const [wrapped] = piSecretRedactionTools([editTool]);
    expect(
      containsRedactedPlaceholder({
        edits: [{ oldText: "[REDACTED:github-token]" }],
      }),
    ).toBe(true);

    let caught: Error | undefined;
    try {
      await wrapped!.execute(
        "c2",
        {
          path: ".env",
          edits: [
            { oldText: "TOKEN=[REDACTED:github-token]", newText: "TOKEN=new" },
          ],
        },
        undefined,
        undefined,
        {} as any,
      );
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).toBeDefined();
    expect(caught!.message).toContain("[REDACTED:github-token]");
    expect(caught!.message).not.toContain(ghToken);
    expect(caught!.message).toContain("secret redaction");
  });
});
