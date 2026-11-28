import { useState } from "react";
import { ASK_CARD_SHELL } from "../lib/ask-card-classes";
import { BASE_PATH } from "../lib/base";
import { AGENT_NAME } from "../lib/brand";
import type { ForceMergeRequest } from "../lib/force-merge-store";
import { useForceMerge } from "../hooks/useForceMerge";
import { Button } from "../ui/button";
import { HoldToConfirmButton } from "../ui/hold-to-confirm-button";

/** POST an answer. Outside the component so its throws stay out of React
 *  Compiler's way. */
async function answer(
  sessionId: string,
  requestId: string,
  action: "confirm" | "cancel",
): Promise<void> {
  const res = await fetch(
    `${BASE_PATH}/api/force-merge/${requestId}/${action}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId }),
    },
  );
  const data = await res.json().catch(() => ({}));
  if (!res.ok && !data?.result)
    throw new Error(data?.error || "Couldn't answer the force merge");
}

function bypassLabel(b: ForceMergeRequest["bypass"][number]): string {
  if (b.kind !== "check") return b.detail;
  const state =
    b.state === "failing"
      ? "failing"
      : b.state === "pending"
        ? "still running"
        : "not reported";
  return `${b.name} ${state}${b.required ? " (required)" : ""}`;
}

/**
 * The agent asked the person driving this session to force merge a PR
 * (opensession-repos force_merge_pull_request). Everything on the card
 * except the reason comes from GitHub, read by the server. Every viewer sees
 * it and may cancel; only the driver can confirm, and the merge runs as them.
 */
export function ForceMergeCard({ sessionId }: { sessionId: string }) {
  const open = useForceMerge(sessionId);
  if (!open) return null;
  return (
    <RequestCard
      key={open.request.id}
      sessionId={sessionId}
      request={open.request}
      canConfirm={open.canConfirm}
    />
  );
}

function RequestCard({
  sessionId,
  request,
  canConfirm,
}: {
  sessionId: string;
  request: ForceMergeRequest;
  canConfirm: boolean;
}) {
  const [busy, setBusy] = useState<"confirm" | "cancel" | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function submit(action: "confirm" | "cancel") {
    setBusy(action);
    setError(null);
    try {
      await answer(sessionId, request.id, action);
      // The resolved broadcast closes the card for every viewer.
    } catch (caught) {
      setBusy(null);
      setError(
        caught instanceof Error
          ? caught.message
          : "Couldn't answer the force merge",
      );
    }
  }

  return (
    <section className={ASK_CARD_SHELL} aria-label="Force merge request">
      <div className="flex items-center gap-2">
        <span
          aria-hidden="true"
          className="h-1.5 w-1.5 shrink-0 rounded-full bg-red shadow-halo-red"
        />
        <span className="text-label font-semibold text-dim">
          {AGENT_NAME} wants to force merge a pull request
        </span>
      </div>

      <div className="flex flex-col gap-1">
        <p className="m-0 text-body leading-6 text-fg [overflow-wrap:anywhere]">
          <a
            href={request.url}
            target="_blank"
            rel="noreferrer"
            className="font-semibold text-fg hover:underline"
          >
            {request.ghRepo}#{request.number}
          </a>{" "}
          {request.title}
        </p>
        <p className="m-0 text-meta text-dim [overflow-wrap:anywhere]">
          {request.head} into {request.base} · {request.method}
        </p>
        <p className="m-0 font-mono text-meta text-dim [overflow-wrap:anywhere]">
          Head {request.headSha}
        </p>
      </div>

      <div className="flex flex-col gap-1.5">
        <span className="text-label font-semibold text-dim">
          {request.bypass.length ? "Bypasses" : "Nothing to bypass"}
        </span>
        {request.bypass.length > 0 && (
          <ul className="m-0 flex list-none flex-col gap-1 p-0">
            {request.bypass.map((b, index) => (
              <li
                key={index}
                className="flex min-w-0 items-baseline gap-2 text-supporting text-fg"
              >
                <span
                  aria-hidden="true"
                  className="h-1.5 w-1.5 shrink-0 translate-y-[-1px] rounded-full bg-red"
                />
                <span className="min-w-0 [overflow-wrap:anywhere]">
                  {b.kind === "check" ? "Check " : ""}
                  {bypassLabel(b)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="flex flex-col gap-1">
        <span className="text-label font-semibold text-dim">Reason</span>
        <p className="m-0 text-supporting text-fg [overflow-wrap:anywhere]">
          {request.reason}
        </p>
      </div>

      <p className="m-0 text-meta text-faint">
        {canConfirm
          ? "Merges with your GitHub account at this exact commit. A push before it lands cancels the merge. A comment on the PR records the reason."
          : `Waiting for ${request.driver} to confirm.`}
      </p>

      {error && (
        <p className="m-0 text-meta text-red" role="alert">
          {error}
        </p>
      )}

      <div className="flex items-center justify-end gap-2">
        <Button
          variant="soft"
          size="lg"
          disabled={busy !== null}
          onClick={() => void submit("cancel")}
        >
          Cancel
        </Button>
        {canConfirm && (
          <HoldToConfirmButton
            variant="danger-strong"
            size="lg"
            disabled={busy !== null}
            busy={busy === "confirm"}
            label="Hold to merge anyway"
            holdingLabel="Keep holding…"
            busyLabel="Merging…"
            onConfirm={() => void submit("confirm")}
          />
        )}
      </div>
    </section>
  );
}
