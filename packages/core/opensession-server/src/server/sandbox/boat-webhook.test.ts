import { afterAll, describe, expect, test } from "bun:test";
import { createHmac } from "crypto";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  BOAT_WEBHOOK_PATH,
  BOAT_WEBHOOK_SECRET_REF,
  boatWebhookRoutes,
  firstDelivery,
  parseBoatWebhookEvent,
  verifyBoatSignature,
} from "./boat-webhook";

const secret = "whsec_test";
const sign = (delivery: string, timestamp: string, body: string) =>
  `v1=${createHmac("sha256", secret).update(`${delivery}.${timestamp}.${body}`).digest("hex")}`;

describe("Boat webhook signatures", () => {
  const body = new TextEncoder().encode('{"id":"evt_1"}');
  const now = 1_790_000_000;
  const base = {
    body,
    delivery: "evt_1",
    timestamp: String(now),
    secret,
    nowSeconds: now,
  };

  test("accepts Boat's HMAC over delivery, timestamp, and raw body", () => {
    expect(
      verifyBoatSignature({
        ...base,
        signature: sign("evt_1", String(now), '{"id":"evt_1"}'),
      }),
    ).toBe(true);
  });

  test("rejects another body, delivery, secret, or a stale timestamp", () => {
    const signature = sign("evt_1", String(now), '{"id":"evt_1"}');
    expect(
      verifyBoatSignature({
        ...base,
        body: new TextEncoder().encode('{"id":"evt_2"}'),
        signature,
      }),
    ).toBe(false);
    expect(verifyBoatSignature({ ...base, delivery: "evt_2", signature })).toBe(
      false,
    );
    expect(
      verifyBoatSignature({ ...base, secret: "whsec_other", signature }),
    ).toBe(false);
    expect(
      verifyBoatSignature({ ...base, nowSeconds: now + 301, signature }),
    ).toBe(false);
    expect(verifyBoatSignature({ ...base, signature: "v1=zz" })).toBe(false);
  });
});

test("parses only well-formed sandbox events", () => {
  expect(
    parseBoatWebhookEvent(
      JSON.stringify({
        id: "evt_1",
        type: "sandbox.ready",
        data: { sandbox: { id: "bx_1" }, state: "ready" },
      }),
    )?.data.sandbox.id,
  ).toBe("bx_1");
  expect(parseBoatWebhookEvent("{")).toBeNull();
  expect(
    parseBoatWebhookEvent(
      JSON.stringify({
        id: "evt_1",
        type: "sandbox.ready",
        data: { sandbox: { id: "../x" } },
      }),
    ),
  ).toBeNull();
});

test("a repeated delivery id is handled once", () => {
  expect(firstDelivery("evt_dupe", 1_000)).toBe(true);
  expect(firstDelivery("evt_dupe", 2_000)).toBe(false);
  expect(firstDelivery("evt_dupe", 1_000 + 61 * 60_000)).toBe(true);
});

describe("Boat webhook route", () => {
  const dir = mkdtempSync(join(tmpdir(), "boat-webhook-"));
  const store = join(dir, "workspace-secrets.json");
  const previous = process.env.OPENSESSION_WORKSPACE_SECRETS_STORE;
  process.env.OPENSESSION_WORKSPACE_SECRETS_STORE = store;
  afterAll(() => {
    if (previous === undefined)
      delete process.env.OPENSESSION_WORKSPACE_SECRETS_STORE;
    else process.env.OPENSESSION_WORKSPACE_SECRETS_STORE = previous;
    rmSync(dir, { recursive: true, force: true });
  });
  const handler = boatWebhookRoutes().get(`POST ${BOAT_WEBHOOK_PATH}`)!;
  const deliver = (headers: Record<string, string>, body: string) =>
    handler(
      new Request(`http://127.0.0.1${BOAT_WEBHOOK_PATH}`, {
        method: "POST",
        headers,
        body,
      }),
      new URL(`http://127.0.0.1${BOAT_WEBHOOK_PATH}`),
    );

  test("waits for a secret, rejects a bad signature, accepts a good one once", async () => {
    const body = JSON.stringify({
      id: "evt_route",
      type: "sandbox.hydrated",
      data: { sandbox: { id: `bx_unknown${Date.now()}` } },
    });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const headers = {
      "x-ascii-delivery": "evt_route",
      "x-ascii-timestamp": timestamp,
      "x-ascii-signature": sign("evt_route", timestamp, body),
    };
    // No secret stored yet: Boat retries later.
    expect((await deliver(headers, body)).status).toBe(503);
    writeFileSync(
      store,
      JSON.stringify({
        version: 1,
        secrets: [
          {
            id: BOAT_WEBHOOK_SECRET_REF,
            purpose: "sandbox.box.webhook",
            value: secret,
            createdAt: "",
            updatedAt: "",
          },
        ],
      }),
    );
    expect(
      (
        await deliver(
          { ...headers, "x-ascii-signature": `v1=${"0".repeat(64)}` },
          body,
        )
      ).status,
    ).toBe(401);
    expect((await deliver(headers, body)).status).toBe(204);
    // A retry of the same delivery is acknowledged without acting twice.
    expect((await deliver(headers, body)).status).toBe(204);
  });
});
