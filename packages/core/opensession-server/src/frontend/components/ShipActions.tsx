import React, { useEffect, useState } from "react";
import { useSessionShipResource } from "../hooks/useApiResources";
import { AGENT_NAME } from "../lib/brand";
import type {
  DirectShip,
  SessionShipInfo,
  ShipButton,
  WSClientMessage,
} from "../lib/types";
import { fullTime } from "../lib/time";
import { cn } from "../ui/cn";
import { Button } from "../ui/button";
import { toast } from "../ui/toast";
import { Tooltip } from "../ui/tooltip";
import { getCurrentUser } from "./UserPicker";
import { IconPullRequest, IconRocket } from "./icons";

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
 * Ship plus the repository's own buttons (`shipActions` in config), inline in
 * Review's no-PR toolbar. Each one sends its prompt to the session's agent;
 * the server decides what Ship says for this session's ship mode.
 */
export function ShipActions({
  sessionId,
  canSend,
  send,
  refreshTick,
  className,
}: {
  sessionId: string;
  canSend: boolean;
  send?: (msg: WSClientMessage) => void;
  /** Refetch when this changes (git events, a new diff). */
  refreshTick?: string | number;
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
        className="phone:px-3.5 phone:text-sm"
        icon={
          button.primary ? (
            info.mode === "direct" ? (
              <IconRocket size={20} />
            ) : (
              <IconPullRequest size={20} />
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
  return (
    <span className={cn("inline-flex items-center gap-2", className)}>
      {buttons}
    </span>
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
        size={20}
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
          className="ml-auto"
          onClick={onShare}
        >
          Share in Slack
        </Button>
      )}
    </div>
  );
}
