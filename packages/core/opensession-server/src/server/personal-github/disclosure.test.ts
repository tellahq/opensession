import { expect, test } from "bun:test";
import {
  acknowledgementMatches,
  createConnectionDisclosure,
  PERSONAL_CONNECTION_DISCLOSURE,
} from "./disclosure";

test("v2 disclosure explicitly names other users' agents and refuses v1 consent", () => {
  expect(PERSONAL_CONNECTION_DISCLOSURE.version).toBe("shared-host-v2");
  expect(PERSONAL_CONNECTION_DISCLOSURE.text).toBe(
    "Your connection is personal, but the server is shared. Other Open Session users can use agents on this server to read your repository files, GitHub credentials, and session data. Server operators and anyone with administrator (root) access can also read them. Only connect repositories you trust these people and this server with.",
  );
  const context = {
    ownerGithubAccountId: 101,
    browserSessionId: "synthetic-browser",
    origin: "https://synthetic.invalid",
  };
  const service = createConnectionDisclosure(() => 1000);
  expect(
    service.acknowledge(context, { version: "shared-host-v1", accepted: true }),
  ).toMatchObject({ ok: false, code: "disclosure_required" });
  const accepted = service.acknowledge(context, {
    version: "shared-host-v2",
    accepted: true,
  });
  if (!accepted.ok) throw new Error(accepted.code);
  const ack = service.consume(context, accepted.disclosureReceipt)!;
  expect(acknowledgementMatches(ack, context, 1000)).toBe(true);
  expect(
    acknowledgementMatches(
      { ...ack, version: "shared-host-v1" },
      context,
      1000,
    ),
  ).toBe(false);
});
