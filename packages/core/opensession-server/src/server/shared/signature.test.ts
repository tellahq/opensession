import { describe, expect, it } from "bun:test";
import { createHmac } from "node:crypto";
import {
  verifyGitHubSignature,
  verifyLinearSignature,
  verifyPlainSignature,
  verifySlackSignature,
  verifyStripeSignature,
} from "./signature";

const SECRET = "test-signing-secret";
const BODY = JSON.stringify({ event: "ping", value: 42 });

function hmacHex(secret: string, data: string): string {
  return createHmac("sha256", secret).update(data, "utf8").digest("hex");
}

describe("verifySlackSignature", () => {
  const freshTs = () => Math.floor(Date.now() / 1000).toString();
  const sign = (body: string, ts: string, secret = SECRET) =>
    "v0=" + hmacHex(secret, `v0:${ts}:${body}`);

  it("accepts a valid signature with a fresh timestamp", () => {
    const ts = freshTs();
    expect(verifySlackSignature(BODY, ts, sign(BODY, ts), SECRET)).toBe(true);
  });

  it("rejects a tampered body", () => {
    const ts = freshTs();
    const sig = sign(BODY, ts);
    expect(verifySlackSignature(BODY + "x", ts, sig, SECRET)).toBe(false);
  });

  it("rejects a signature made with the wrong secret", () => {
    const ts = freshTs();
    const sig = sign(BODY, ts, "wrong-secret");
    expect(verifySlackSignature(BODY, ts, sig, SECRET)).toBe(false);
  });

  it("rejects an expired timestamp (outside the 5-minute window)", () => {
    const oldTs = (Math.floor(Date.now() / 1000) - 600).toString();
    // Even a correctly-computed signature is rejected once the window passes.
    expect(verifySlackSignature(BODY, oldTs, sign(BODY, oldTs), SECRET)).toBe(
      false,
    );
  });

  it("rejects a future timestamp outside the window", () => {
    const futureTs = (Math.floor(Date.now() / 1000) + 600).toString();
    expect(
      verifySlackSignature(BODY, futureTs, sign(BODY, futureTs), SECRET),
    ).toBe(false);
  });

  it("rejects malformed / empty / wrong-length signatures without throwing", () => {
    const ts = freshTs();
    expect(verifySlackSignature(BODY, ts, "", SECRET)).toBe(false);
    expect(verifySlackSignature(BODY, ts, "v0=abc", SECRET)).toBe(false);
    expect(verifySlackSignature(BODY, ts, "garbage", SECRET)).toBe(false);
    expect(verifySlackSignature(BODY, ts, sign(BODY, ts) + "00", SECRET)).toBe(
      false,
    );
  });

  it("rejects a non-numeric timestamp", () => {
    const timestamp = "not-a-timestamp";
    expect(
      verifySlackSignature(BODY, timestamp, sign(BODY, timestamp), SECRET),
    ).toBe(false);
  });

  it("rejects a timestamp with trailing non-numeric content", () => {
    const timestamp = `${freshTs()}seconds`;
    expect(
      verifySlackSignature(BODY, timestamp, sign(BODY, timestamp), SECRET),
    ).toBe(false);
  });

  it("rejects signatures made with an empty secret", () => {
    const ts = freshTs();
    expect(verifySlackSignature(BODY, ts, sign(BODY, ts, ""), "")).toBe(false);
  });
});

describe("verifyGitHubSignature", () => {
  const sign = (body: string, secret = SECRET) =>
    "sha256=" + hmacHex(secret, body);

  it("accepts a valid signature", () => {
    expect(verifyGitHubSignature(BODY, sign(BODY), SECRET)).toBe(true);
  });

  it("rejects a tampered body", () => {
    expect(verifyGitHubSignature(BODY + "x", sign(BODY), SECRET)).toBe(false);
  });

  it("rejects a signature made with the wrong secret", () => {
    expect(verifyGitHubSignature(BODY, sign(BODY, "nope"), SECRET)).toBe(false);
  });

  it("rejects malformed / empty / wrong-length signatures without throwing", () => {
    expect(verifyGitHubSignature(BODY, "", SECRET)).toBe(false);
    expect(verifyGitHubSignature(BODY, "sha256=", SECRET)).toBe(false);
    expect(verifyGitHubSignature(BODY, "sha256=deadbeef", SECRET)).toBe(false);
    expect(verifyGitHubSignature(BODY, sign(BODY).slice(0, -2), SECRET)).toBe(
      false,
    );
  });

  it("rejects signatures made with an empty secret", () => {
    expect(verifyGitHubSignature(BODY, sign(BODY, ""), "")).toBe(false);
  });
});

describe("verifyLinearSignature", () => {
  const sign = (body: string, secret = SECRET) => hmacHex(secret, body);

  it("accepts a valid signature", () => {
    expect(verifyLinearSignature(BODY, sign(BODY), SECRET)).toBe(true);
  });

  it("rejects a tampered body", () => {
    expect(verifyLinearSignature(BODY + "x", sign(BODY), SECRET)).toBe(false);
  });

  it("rejects a signature made with the wrong secret", () => {
    expect(verifyLinearSignature(BODY, sign(BODY, "nope"), SECRET)).toBe(false);
  });

  it("rejects malformed / empty / wrong-length signatures without throwing", () => {
    expect(verifyLinearSignature(BODY, "", SECRET)).toBe(false);
    expect(verifyLinearSignature(BODY, "deadbeef", SECRET)).toBe(false);
    expect(verifyLinearSignature(BODY, sign(BODY) + "00", SECRET)).toBe(false);
  });

  it("rejects when the secret is empty (fail closed)", () => {
    expect(verifyLinearSignature(BODY, hmacHex("", BODY), "")).toBe(false);
  });
});

describe("verifyPlainSignature", () => {
  const sign = (body: string, secret = SECRET) => hmacHex(secret, body);

  it("accepts a valid signature", () => {
    expect(verifyPlainSignature(BODY, sign(BODY), SECRET)).toBe(true);
  });

  it("rejects a tampered body", () => {
    expect(verifyPlainSignature(BODY + "x", sign(BODY), SECRET)).toBe(false);
  });

  it("rejects a signature made with the wrong secret", () => {
    expect(verifyPlainSignature(BODY, sign(BODY, "nope"), SECRET)).toBe(false);
  });

  it("rejects malformed / empty / wrong-length signatures without throwing", () => {
    expect(verifyPlainSignature(BODY, "", SECRET)).toBe(false);
    expect(verifyPlainSignature(BODY, "deadbeef", SECRET)).toBe(false);
    expect(verifyPlainSignature(BODY, sign(BODY).slice(0, -2), SECRET)).toBe(
      false,
    );
  });

  it("rejects when the secret is empty (fail closed)", () => {
    expect(verifyPlainSignature(BODY, hmacHex("", BODY), "")).toBe(false);
  });
});

describe("verifyStripeSignature", () => {
  const freshTs = () => Math.floor(Date.now() / 1000);
  const sign = (body: string, ts: number, secret = SECRET) =>
    hmacHex(secret, `${ts}.${body}`);
  const header = (body: string, ts: number, secret = SECRET) =>
    `t=${ts},v1=${sign(body, ts, secret)}`;

  it("accepts a valid signature", () => {
    const ts = freshTs();
    expect(verifyStripeSignature(BODY, header(BODY, ts), SECRET)).toBe(true);
  });

  it("accepts when any of multiple v1 candidates matches (secret rotation)", () => {
    const ts = freshTs();
    const rotated = `t=${ts},v1=${sign(BODY, ts, "old-secret")},v1=${sign(BODY, ts)}`;
    expect(verifyStripeSignature(BODY, rotated, SECRET)).toBe(true);
  });

  it("rejects when no v1 candidate matches", () => {
    const ts = freshTs();
    const bad = `t=${ts},v1=${sign(BODY, ts, "old-secret")},v1=${sign(BODY, ts, "other")}`;
    expect(verifyStripeSignature(BODY, bad, SECRET)).toBe(false);
  });

  it("rejects a tampered body", () => {
    const ts = freshTs();
    expect(verifyStripeSignature(BODY + "x", header(BODY, ts), SECRET)).toBe(
      false,
    );
  });

  it("rejects an expired timestamp (outside the 5-minute tolerance)", () => {
    const oldTs = freshTs() - 600;
    expect(verifyStripeSignature(BODY, header(BODY, oldTs), SECRET)).toBe(
      false,
    );
  });

  it("rejects a non-numeric timestamp", () => {
    const ts = freshTs();
    const sig = sign(BODY, ts);
    expect(verifyStripeSignature(BODY, `t=abc,v1=${sig}`, SECRET)).toBe(false);
  });

  it("rejects malformed / empty headers without throwing", () => {
    const ts = freshTs();
    expect(verifyStripeSignature(BODY, "", SECRET)).toBe(false);
    expect(verifyStripeSignature(BODY, "garbage", SECRET)).toBe(false);
    expect(verifyStripeSignature(BODY, `t=${ts}`, SECRET)).toBe(false); // no v1
    expect(verifyStripeSignature(BODY, `v1=${sign(BODY, ts)}`, SECRET)).toBe(
      false,
    ); // no t
    expect(verifyStripeSignature(BODY, `t=${ts},v1=deadbeef`, SECRET)).toBe(
      false,
    ); // wrong length
    expect(verifyStripeSignature(BODY, `t=${ts},v1=`, SECRET)).toBe(false);
  });

  it("rejects when the secret is empty (fail closed)", () => {
    const ts = freshTs();
    expect(
      verifyStripeSignature(BODY, `t=${ts},v1=${sign(BODY, ts, "")}`, ""),
    ).toBe(false);
  });
});
