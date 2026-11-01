import React, { useEffect, useState } from "react";
import { useSessionShipResource } from "../hooks/useApiResources";
import { AGENT_NAME } from "../lib/brand";
import type {
  DirectShip,
  SessionShipInfo,
  ShipButton,
  ShipModeReason,
  WSClientMessage,
} from "../lib/types";
import { fullTime } from "../lib/time";
import { cn } from "../ui/cn";
import { Button } from "../ui/button";
import { toast } from "../ui/toast";
import { Tooltip } from "../ui/tooltip";
import { getCurrentUser } from "./UserPicker";
import { IconPullRequest, IconRocket } from "./icons";

type ShippableInfo = Extract<SessionShipInfo, { available: true }>;

/** Why a Direct choice fell back to the PR flow, as a short clause. */
function forcedPrReason(reason: ShipModeReason): string | undefined {
  switch (reason) {
    case "open-pr":
      return "this branch already has a PR";
    case "stacked":
      return "this branch is stacked";
    case "existing-branch":
      return "this branch came from a PR";
    case "pstack":
      return "pstack sessions open PRs";
    case "automation":
      return "automations open PRs";
    default:
      return undefined;
  }
}

/** Where Ship sends the change, in the person's terms. */
export function shipDestination(info: ShippableInfo): string {
  if (info.checkout === "shared")
    return `Pushes to ${info.target} from this checkout`;
  if (info.mode === "direct") return `Pushes to ${info.target}`;
  const forced =
    info.requested === "direct" ? forcedPrReason(info.reason) : undefined;
  const base = info.openPr
    ? `Updates PR #${info.openPr.number}`
    : info.buttons[0]?.label === "Push branch"
      ? "Pushes the branch for review"
      : "Opens a pull request";
  return forced ? `${base}, since ${forced}` : base;
}

/** The newest ship, and whether the remote has confirmed it. */
export function latestDirectShip(
  info: SessionShipInfo | undefined,
): DirectShip | undefined {
  return info?.available ? info.ships.at(-1) : undefined;
}

function useShipInfo(sessionId: string, refreshTick?: string | number) {
  const { data } = useSessionShipResource(sessionId, {
    revision: refreshTick ?? null,
  });
  return data;
}

/**
 * Ship plus the repository's own buttons (`shipActions` in config). Each one
 * sends its prompt to the session's agent, the way Create PR always has; the
 * server decides what Ship says for this session's ship mode.
 */
export function ShipActions({
  sessionId,
  canSend,
  send,
  refreshTick,
  layout = "row",
  className,
}: {
  sessionId: string;
  canSend: boolean;
  send?: (msg: WSClientMessage) => void;
  /** Refetch when this changes (git events, a new diff). */
  refreshTick?: string | number;
  /** "row" is the Changes panel's own band; "inline" sits in a toolbar. */
  layout?: "row" | "inline";
  className?: string;
}) {
  const info = useShipInfo(sessionId, refreshTick);
  const [sent, setSent] = useState<string | null>(null);
  useEffect(() => {
    if (!sent) return;
    const timer = setTimeout(() => setSent(null), 6000);
    return () => clearTimeout(timer);
  }, [sent]);
  if (!info?.available || !send) return null;
  const destination = shipDestination(info);
  const run = (button: ShipButton) => {
    if (!canSend) return;
    send({
      type: "prompt",
      sessionId,
      user: getCurrentUser(),
      content: button.prompt,
    });
    setSent(button.id);
    toast(
      button.primary
        ? `Asked ${AGENT_NAME} to ${button.label === "Ship" ? "ship" : button.label.toLowerCase()}`
        : `Sent “${button.label}” to ${AGENT_NAME}`,
    );
  };
  const busyHint = `${AGENT_NAME} is working. You can ship once the current run finishes.`;
  const buttons = info.buttons.map((button) => {
    const control = (
      <Button
        key={button.id}
        variant={button.primary ? "primary" : "default"}
        size="sm"
        className="phone:min-h-11 phone:px-3.5 phone:text-sm"
        icon={
          button.primary ? (
            info.mode === "direct" ? (
              <IconRocket size={18} />
            ) : (
              <IconPullRequest size={18} />
            )
          ) : undefined
        }
        disabled={!canSend || sent === button.id}
        onClick={() => run(button)}
      >
        {sent === button.id
          ? button.primary
            ? "Shipping…"
            : "Sent"
          : button.label}
      </Button>
    );
    return canSend ? (
      control
    ) : (
      <Tooltip key={button.id} label={busyHint}>
        <span className="inline-flex">{control}</span>
      </Tooltip>
    );
  });
  if (layout === "inline")
    return (
      <span className={cn("inline-flex items-center gap-2", className)}>
        {buttons}
      </span>
    );
  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-2 border-b border-divider px-3.5 py-2.5 phone:px-4 phone:py-3",
        className,
      )}
      role="group"
      aria-label="Ship"
    >
      {buttons}
      <span className="ml-auto min-w-0 text-meta text-dim phone:w-full phone:ml-0">
        {destination}
      </span>
    </div>
  );
}

/**
 * The workspace's latest direct ship: pushed, then confirmed on the remote's
 * default branch. Offers the shipped-change Slack composer once confirmed.
 */
export function DirectShipNotice({
  sessionId,
  refreshTick,
  onShare,
  className,
}: {
  sessionId: string;
  refreshTick?: string | number;
  onShare?: () => void;
  className?: string;
}) {
  const info = useShipInfo(sessionId, refreshTick);
  const ship = latestDirectShip(info);
  if (!ship) return null;
  const shipped = !!ship.shippedAt;
  const count = ship.commits.length;
  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-x-2 gap-y-1.5 rounded-xl bg-panel px-3.5 py-2.5 text-label",
        className,
      )}
      role="status"
    >
      <IconRocket
        size={18}
        className={shipped ? "shrink-0 text-green" : "shrink-0 text-dim"}
      />
      <span className="font-medium text-fg">
        {shipped ? `Shipped to ${ship.target}` : `Pushed to ${ship.target}`}
      </span>
      <span className="font-mono text-meta text-dim">
        {ship.sha.slice(0, 7)}
      </span>
      <span className="text-meta text-dim">
        {count} commit{count === 1 ? "" : "s"} ·{" "}
        {shipped ? fullTime(ship.shippedAt!) : "confirming on the remote"}
      </span>
      {shipped && onShare && (
        <Button
          variant="default"
          size="sm"
          className="ml-auto phone:min-h-11"
          onClick={onShare}
        >
          Share in Slack
        </Button>
      )}
    </div>
  );
}
