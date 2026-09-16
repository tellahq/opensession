import { randomBytes } from "node:crypto";
import { isGithubAccountId } from "../../shared/access-scope";
import { deny } from "./errors";

export const PERSONAL_CONNECTION_DISCLOSURE = Object.freeze({
  version: "shared-host-v2",
  text: "Your connection is personal, but the server is shared. Other Open Session users can use agents on this server to read your repository files, GitHub credentials, and session data. Server operators and anyone with administrator (root) access can also read them. Only connect repositories you trust these people and this server with.",
});
export const DISCLOSURE_OPERATION = "create_personal_github_app";
export interface ConnectionAcknowledgement {
  version: string;
  ownerGithubAccountId: number;
  browserSessionId: string;
  origin: string;
  operation: typeof DISCLOSURE_OPERATION;
  acceptedAt: number;
  expiresAt: number;
}
export type ConnectionContext = Pick<
  ConnectionAcknowledgement,
  "ownerGithubAccountId" | "browserSessionId" | "origin"
>;

export function acknowledgementMatches(
  ack: ConnectionAcknowledgement | undefined,
  context: ConnectionContext,
  now: number,
): boolean {
  return (
    !!ack &&
    ack.version === PERSONAL_CONNECTION_DISCLOSURE.version &&
    ack.ownerGithubAccountId === context.ownerGithubAccountId &&
    ack.browserSessionId === context.browserSessionId &&
    ack.origin === context.origin &&
    ack.operation === DISCLOSURE_OPERATION &&
    ack.acceptedAt <= now &&
    ack.expiresAt > now
  );
}

export function createConnectionDisclosure(now: () => number) {
  const receipts = new Map<string, ConnectionAcknowledgement>();
  return {
    acknowledge(
      context: ConnectionContext,
      input: { version: unknown; accepted: unknown },
    ) {
      if (
        !isGithubAccountId(context.ownerGithubAccountId) ||
        !context.browserSessionId ||
        context.browserSessionId.length > 256 ||
        input.version !== PERSONAL_CONNECTION_DISCLOSURE.version ||
        input.accepted !== true
      )
        return deny(
          "disclosure_required",
          "Read and accept the current shared-server disclosure before connecting.",
        );
      try {
        if (new URL(context.origin).origin !== context.origin)
          throw new Error();
      } catch {
        return deny("request_invalid", "Invalid connection origin.");
      }
      for (const [key, ack] of receipts)
        if (ack.expiresAt <= now()) receipts.delete(key);
      if (
        receipts.size >= 64 ||
        [...receipts.values()].filter(
          (ack) => ack.ownerGithubAccountId === context.ownerGithubAccountId,
        ).length >= 3
      )
        return deny("manifest_limit", "Too many pending connections.");
      const receipt = randomBytes(32).toString("base64url");
      const ack: ConnectionAcknowledgement = {
        ...context,
        operation: DISCLOSURE_OPERATION,
        version: PERSONAL_CONNECTION_DISCLOSURE.version,
        acceptedAt: now(),
        expiresAt: now() + 15 * 60_000,
      };
      receipts.set(receipt, ack);
      return {
        ok: true as const,
        disclosureReceipt: receipt,
        expiresAt: ack.expiresAt,
      };
    },
    cancelOwner(owner: number) {
      for (const [key, ack] of receipts)
        if (ack.ownerGithubAccountId === owner) receipts.delete(key);
    },
    consume(context: ConnectionContext, receipt: string | undefined) {
      const ack = receipt ? receipts.get(receipt) : undefined;
      if (receipt) receipts.delete(receipt);
      return acknowledgementMatches(ack, context, now()) ? ack! : null;
    },
  };
}
