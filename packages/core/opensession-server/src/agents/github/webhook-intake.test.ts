import { afterAll, describe, expect, test } from "bun:test";
import { createHmac } from "crypto";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const isIsolatedChild =
  process.env.OPENSESSION_WEBHOOK_INTAKE_TEST_CHILD === "1";

if (!isIsolatedChild) {
  describe("handleGithubWebhook", () => {
    test("runs request checks in an isolated process", () => {
      const result = Bun.spawnSync(
        [process.execPath, "test", import.meta.path],
        {
          env: { ...process.env, OPENSESSION_WEBHOOK_INTAKE_TEST_CHILD: "1" },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      expect(result.exitCode).toBe(0);
    });
  });
} else {
  const scratch = mkdtempSync(join(tmpdir(), "opensession-github-intake-"));
  const previousStateDir = process.env.OPENSESSION_STATE_DIR;
  const previousSecret = process.env.GITHUB_WEBHOOK_SECRET;
  const previousGithubEnabled = process.env.ENABLE_GITHUB_AGENT;
  const previousSlackEnabled = process.env.ENABLE_SLACK_AGENT;
  process.env.OPENSESSION_STATE_DIR = scratch;
  process.env.GITHUB_WEBHOOK_SECRET = "webhook-intake-test-secret";
  process.env.ENABLE_GITHUB_AGENT = "true";
  process.env.ENABLE_SLACK_AGENT = "false";
  const previousConfig = process.env.OPENSESSION_CONFIG;
  const configPath = join(scratch, "config.json");
  await Bun.write(
    configPath,
    JSON.stringify({
      integrations: {
        github: {
          apps: [
            {
              id: "personal1",
              owner: "octocat",
              appSlug: "open-session-octocat",
              oauthClientId: "Iv-personal",
              webhookSecret: "personal-app-secret",
            },
            {
              id: "nosecret",
              owner: "other",
              appSlug: "open-session-other",
              oauthClientId: "Iv-other",
            },
          ],
        },
      },
    }),
  );
  process.env.OPENSESSION_CONFIG = configPath;
  await (await import("../../server/config")).getConfigAsync();

  const { handleAdditionalAppGithubWebhook, handleGithubWebhook } =
    await import("./webhook-intake");
  const {
    claimGithubDelivery,
    githubDeliveriesStore,
    loadGithubDeliveries,
    releaseGithubDelivery,
  } = await import("./webhook-deliveries");
  const { writeJsonAtomic } = await import("../../server/shared/atomic-write");

  afterAll(() => {
    if (previousStateDir === undefined)
      delete process.env.OPENSESSION_STATE_DIR;
    else process.env.OPENSESSION_STATE_DIR = previousStateDir;
    if (previousSecret === undefined) delete process.env.GITHUB_WEBHOOK_SECRET;
    else process.env.GITHUB_WEBHOOK_SECRET = previousSecret;
    if (previousGithubEnabled === undefined)
      delete process.env.ENABLE_GITHUB_AGENT;
    else process.env.ENABLE_GITHUB_AGENT = previousGithubEnabled;
    if (previousSlackEnabled === undefined)
      delete process.env.ENABLE_SLACK_AGENT;
    else process.env.ENABLE_SLACK_AGENT = previousSlackEnabled;
    if (previousConfig === undefined) delete process.env.OPENSESSION_CONFIG;
    else process.env.OPENSESSION_CONFIG = previousConfig;
    rmSync(scratch, { recursive: true, force: true });
  });

  function signature(body: string): string {
    return `sha256=${createHmac("sha256", process.env.GITHUB_WEBHOOK_SECRET!).update(body).digest("hex")}`;
  }

  describe("handleGithubWebhook", () => {
    test("rejects an invalid signature", async () => {
      const response = await handleGithubWebhook(
        new Request("http://localhost/github/webhook", {
          method: "POST",
          body: "{}",
          headers: { "x-hub-signature-256": "sha256=invalid" },
        }),
      );

      expect(response.status).toBe(401);
    });

    test("rejects a body over the 1 MiB limit before signature verification", async () => {
      const response = await handleGithubWebhook(
        new Request("http://localhost/github/webhook", {
          method: "POST",
          body: "x",
          headers: { "content-length": String(1024 * 1024 + 1) },
        }),
      );

      expect(response.status).toBe(413);
    });

    test("returns retryable failure while the same delivery is still admitting", async () => {
      const body = "{}";
      const deliveryId = "in-flight-delivery";
      expect(await claimGithubDelivery(deliveryId)).toBe("claimed");
      const response = await handleGithubWebhook(
        new Request("http://localhost/github/webhook", {
          method: "POST",
          body,
          headers: {
            "x-hub-signature-256": signature(body),
            "x-github-delivery": deliveryId,
            "x-github-event": "pull_request",
          },
        }),
      );
      releaseGithubDelivery(deliveryId);

      expect(response.status).toBe(503);
    });

    test("returns a duplicate response for a persisted signed delivery without dispatching", async () => {
      const body = JSON.stringify({ action: "opened" });
      const deliveryId = "persisted-duplicate";
      writeJsonAtomic(
        githubDeliveriesStore(),
        [[deliveryId, Date.now() + 60_000]],
        false,
      );
      await loadGithubDeliveries(true);

      const response = await handleGithubWebhook(
        new Request("http://localhost/github/webhook", {
          method: "POST",
          body,
          headers: {
            "x-hub-signature-256": signature(body),
            "x-github-delivery": deliveryId,
            "x-github-event": "pull_request",
          },
        }),
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true, duplicate: true });
    });
  });

  describe("handleAdditionalAppGithubWebhook", () => {
    function appRequest(path: string, body: string, secret: string) {
      const url = new URL(`http://localhost${path}`);
      return {
        url,
        req: new Request(url, {
          method: "POST",
          body,
          headers: {
            "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
            "x-github-delivery": `app-${path}-${secret}`,
            "x-github-event": "ping",
          },
        }),
      };
    }

    test("verifies an additional App's delivery with that App's own secret", async () => {
      const ok = appRequest(
        "/github/webhook/personal1",
        "{}",
        "personal-app-secret",
      );
      expect(
        (await handleAdditionalAppGithubWebhook(ok.req, ok.url)).status,
      ).toBe(200);
      // The primary App's secret does not open another App's path.
      const wrong = appRequest(
        "/github/webhook/personal1",
        "{}",
        process.env.GITHUB_WEBHOOK_SECRET!,
      );
      expect(
        (await handleAdditionalAppGithubWebhook(wrong.req, wrong.url)).status,
      ).toBe(401);
    });

    test("answers 404 for an unknown App or one without a secret", async () => {
      for (const path of [
        "/github/webhook/unknown",
        "/github/webhook/nosecret",
        "/github/webhook/personal1/extra",
      ]) {
        const { req, url } = appRequest(path, "{}", "personal-app-secret");
        expect((await handleAdditionalAppGithubWebhook(req, url)).status).toBe(
          404,
        );
      }
    });
  });
}
