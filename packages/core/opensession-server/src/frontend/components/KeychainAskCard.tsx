import { useState } from "react";
import { ASK_CARD_SHELL } from "../lib/ask-card-classes";
import { AGENT_NAME } from "../lib/brand";
import { answerKeychainAsk } from "../lib/api/settings";
import {
  reloadKeychainAsks,
  type SessionKeychainAsk,
} from "../lib/keychain-ask-store";
import { useKeychainAsks } from "../hooks/useKeychainAsks";
import { Button } from "../ui/button";

type Decision = Parameters<typeof answerKeychainAsk>[1];

/**
 * A keychain ask this session made for a credential the viewer owns
 * (opensession-keychain request_credential). Only the owner ever gets one:
 * the server returns these asks to nobody else, and the answer goes through
 * the same owner-checked route as Settings. The Slack DM stays open too, and
 * whichever the owner answers first settles both.
 */
export function KeychainAskCard({ sessionId }: { sessionId: string }) {
  const asks = useKeychainAsks(sessionId);
  return (
    <>
      {asks.map((ask) => (
        <AskCard key={ask.id} sessionId={sessionId} ask={ask} />
      ))}
    </>
  );
}

function summary(ask: SessionKeychainAsk): string {
  if (ask.requestedMode === "release")
    return `${AGENT_NAME} will see the password: it types it into the sign-in page itself. Release only a test account.`;
  if (ask.run)
    return `Runs this script until it exits or times out, within the credential's limits. The script never sees the secret, and every call is audited.`;
  return `The secret is never shown to the session. Calls go through the keychain broker within the credential's limits, and each one is audited.`;
}

function AskCard({
  sessionId,
  ask,
}: {
  sessionId: string;
  ask: SessionKeychainAsk;
}) {
  const [busy, setBusy] = useState<Decision | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function submit(decision: Decision) {
    setBusy(decision);
    setError(null);
    try {
      await answerKeychainAsk(ask.id, decision);
      reloadKeychainAsks(sessionId);
    } catch (caught) {
      setBusy(null);
      setError(
        caught instanceof Error
          ? caught.message
          : "Couldn't answer the request",
      );
    }
  }

  const login = ask.requestedMode === "release";
  const choices: Array<{ decision: Decision; label: string }> = login
    ? [{ decision: "release", label: "Release password" }]
    : ask.run
      ? [{ decision: "run", label: "Allow run" }]
      : ask.requestedMode === "standing"
        ? [
            { decision: "once", label: "Allow once" },
            { decision: "standing", label: "Allow 7 days" },
          ]
        : [
            { decision: "standing", label: "Allow 7 days" },
            { decision: "once", label: "Allow once" },
          ];

  return (
    <section className={ASK_CARD_SHELL} aria-label="Keychain request">
      <div className="flex items-center gap-2">
        <span
          aria-hidden="true"
          className="h-1.5 w-1.5 shrink-0 rounded-full bg-green shadow-[0_0_0_3px_var(--green-soft)]"
        />
        <span className="text-label font-semibold text-dim">
          {login
            ? `${AGENT_NAME} wants the password for your login`
            : ask.run
              ? `${AGENT_NAME} wants to run a script with your credential`
              : `${AGENT_NAME} wants to borrow your credential`}
        </span>
      </div>

      <div className="flex flex-col gap-1">
        {ask.credentials.map((c, index) => (
          <p
            key={index}
            className="m-0 text-body leading-6 text-fg [overflow-wrap:anywhere]"
          >
            <span className="font-semibold">{c.service}</span>
            {c.kind === "login" ? (
              <>
                : {c.username} on {c.loginUrl}
              </>
            ) : c.host ? (
              <> for {c.host}</>
            ) : null}
          </p>
        ))}
        <p className="m-0 text-supporting text-fg [overflow-wrap:anywhere]">
          {ask.purpose}
        </p>
        {ask.run && (
          <p className="m-0 font-mono text-meta text-dim [overflow-wrap:anywhere]">
            {ask.run.command}
          </p>
        )}
        <p className="m-0 text-meta text-dim">
          Asked by {ask.requestedBy}
          {!login && !ask.run
            ? ` for ${ask.requestedMode === "once" ? "one call" : "7 days"}`
            : ""}
        </p>
      </div>

      <p className="m-0 text-meta text-faint">{summary(ask)}</p>

      {error && (
        <p className="m-0 text-meta text-red" role="alert">
          {error}
        </p>
      )}

      {/* The mode the agent asked for is the primary choice. */}
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button
          variant="soft"
          size="lg"
          disabled={busy !== null}
          onClick={() => void submit("decline")}
        >
          Decline
        </Button>
        {choices.map((choice, index) => (
          <Button
            key={choice.decision}
            variant={index === choices.length - 1 ? "primary" : "soft"}
            size="lg"
            disabled={busy !== null}
            onClick={() => void submit(choice.decision)}
          >
            {choice.label}
          </Button>
        ))}
      </div>
    </section>
  );
}
