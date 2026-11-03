import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const scratch = mkdtempSync(join(tmpdir(), "opensession-github-webhook-"));
const previousStateDir = process.env.OPENSESSION_STATE_DIR;
process.env.OPENSESSION_STATE_DIR = scratch;

const {
  claimGithubDelivery,
  githubDeliveriesStore,
  loadGithubDeliveries,
  isGithubDeliveryProcessed,
  flushGithubDeliveries,
  markGithubDeliveryProcessed,
  releaseGithubDelivery,
} = await import("./webhook-deliveries");
const { writeJsonAtomic } = await import("../../server/shared/atomic-write");

afterAll(() => {
  if (previousStateDir === undefined) delete process.env.OPENSESSION_STATE_DIR;
  else process.env.OPENSESSION_STATE_DIR = previousStateDir;
  rmSync(scratch, { recursive: true, force: true });
});

describe("GitHub delivery replay protection", () => {
  test("hydrates a persisted delivery before explicit startup", async () => {
    const deliveryId = "github-delivery-before-startup";
    writeJsonAtomic(
      githubDeliveriesStore(),
      [[deliveryId, Date.now() + 60_000]],
      false,
    );

    // The check itself performs the one-time hydration.
    expect(await isGithubDeliveryProcessed(deliveryId)).toBe(true);
  });

  test("persists delivery ids at the legacy Slack-store path and restores them after a reload", async () => {
    const deliveryId = "github-delivery-persists";
    await markGithubDeliveryProcessed(deliveryId);
    await flushGithubDeliveries();
    expect(githubDeliveriesStore()).toBe(
      `${scratch}/.slack-sessions/github-deliveries.json`,
    );
    expect(await isGithubDeliveryProcessed(deliveryId)).toBe(true);

    // A forced load clears the in-memory map first, mirroring a restart.
    await loadGithubDeliveries(true);
    expect(await isGithubDeliveryProcessed(deliveryId)).toBe(true);
  });

  test("drops expired delivery ids when restoring the persistent store", async () => {
    writeJsonAtomic(githubDeliveriesStore(), [["expired-delivery", 0]], false);
    await loadGithubDeliveries(true);
    expect(await isGithubDeliveryProcessed("expired-delivery")).toBe(false);
  });

  test("deduplicates in-flight admission but releases a failed claim", async () => {
    const deliveryId = "github-delivery-in-flight";
    expect(await claimGithubDelivery(deliveryId)).toBe("claimed");
    expect(await claimGithubDelivery(deliveryId)).toBe("in_flight");
    expect(await isGithubDeliveryProcessed(deliveryId)).toBe(false);

    releaseGithubDelivery(deliveryId);
    expect(await claimGithubDelivery(deliveryId)).toBe("claimed");
    await markGithubDeliveryProcessed(deliveryId);
    expect(await isGithubDeliveryProcessed(deliveryId)).toBe(true);
    expect(await claimGithubDelivery(deliveryId)).toBe("processed");
  });
});
