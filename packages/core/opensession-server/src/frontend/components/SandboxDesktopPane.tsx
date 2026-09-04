import { type ReactNode, useCallback, useEffect, useState } from "react";
import { ApiError } from "../lib/api/request";
import {
  openSandboxDesktop,
  sandboxAction,
  type SandboxDesktopLink,
} from "../lib/api/sandboxes";
import { errorMessage } from "../lib/error-message";
import { Button } from "../ui/button";
import { PageLoader } from "../ui/page-loader";
import { IconArrowUpRight, IconBox, IconRestore } from "./icons";

/** Re-mint this long before a signed desktop URL expires (Daytona: 1h). */
const REMINT_LEAD_MS = 60_000;

type DesktopState =
  | { phase: "loading" }
  | { phase: "ready"; link: SandboxDesktopLink }
  | { phase: "asleep" }
  | { phase: "error"; message: string };

/**
 * The Sandbox desktop as a center pane: the same live screen the agent drives
 * through `opensession-desktop`, embedded so a person can watch or take over
 * without leaving the session. The URL is minted per mount and never stored.
 */
export function SandboxDesktopPane({ sessionId }: { sessionId: string }) {
  const [state, setState] = useState<DesktopState>({ phase: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [frameLoading, setFrameLoading] = useState(true);
  const [waking, setWaking] = useState(false);

  const reload = useCallback(() => {
    setState({ phase: "loading" });
    setFrameLoading(true);
    setAttempt((n) => n + 1);
  }, []);

  useEffect(() => {
    let cancelled = false;
    openSandboxDesktop(sessionId)
      .then((link) => {
        if (!cancelled) setState({ phase: "ready", link });
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        if (cause instanceof ApiError && cause.status === 409)
          setState({ phase: "asleep" });
        else
          setState({
            phase: "error",
            message: errorMessage(cause, "Could not open the desktop"),
          });
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, attempt]);

  // A signed URL stops working after its TTL; fetch a fresh one just before.
  const expiresAt = state.phase === "ready" ? state.link.expiresAt : undefined;
  useEffect(() => {
    if (!expiresAt) return;
    const delay = Math.max(1_000, expiresAt - REMINT_LEAD_MS - Date.now());
    const timer = setTimeout(reload, delay);
    return () => clearTimeout(timer);
  }, [expiresAt, reload]);

  function wake() {
    setWaking(true);
    sandboxAction(sessionId, "resume")
      .then(reload)
      .catch((cause: unknown) => {
        setState({
          phase: "error",
          message: errorMessage(cause, "Could not wake the sandbox"),
        });
      })
      .finally(() => setWaking(false));
  }

  const url = state.phase === "ready" ? state.link.url : null;

  return (
    <div className="flex h-full min-h-0 flex-col bg-panel">
      <div className="flex min-h-11 items-center gap-2 border-b border-divider px-3 py-1.5">
        <span
          className={`h-2 w-2 shrink-0 rounded-full ${url ? "bg-green" : "bg-line-strong"}`}
          aria-hidden="true"
        />
        <div className="flex min-w-0 flex-1 items-center gap-2 text-supporting text-dim">
          <IconBox size={16} className="shrink-0 opacity-60" />
          <span className="truncate">
            Sandbox desktop
            {state.phase === "asleep" ? " · asleep" : ""}
          </span>
        </div>
        <Button
          variant="ghost"
          size="md"
          icon={<IconRestore size={16} />}
          onClick={reload}
          disabled={state.phase === "loading"}
          aria-label="Reload the desktop"
          title="Reload"
        />
        <Button
          variant="ghost"
          size="md"
          icon={<IconArrowUpRight size={16} />}
          disabled={!url}
          onClick={() => {
            if (url) window.open(url, `desktop-${sessionId}`, "noopener");
          }}
          aria-label="Open the desktop in a separate browser window"
          title="Open in browser"
        />
      </div>
      <div className="relative min-h-0 flex-1 bg-surface">
        {state.phase === "loading" || (url && frameLoading) ? (
          <div
            role="status"
            aria-label="Loading the desktop"
            className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center bg-panel"
          >
            <PageLoader className="text-dim" />
          </div>
        ) : null}
        {state.phase === "asleep" ? (
          <DesktopNotice
            title="The sandbox is asleep"
            detail="Wake it to see its desktop. It sleeps again between turns."
            action={
              <Button
                variant="default"
                size="md"
                onClick={wake}
                disabled={waking}
              >
                {waking ? "Waking…" : "Wake sandbox"}
              </Button>
            }
          />
        ) : state.phase === "error" ? (
          <DesktopNotice
            title="Desktop unavailable"
            detail={state.message}
            action={
              <Button variant="default" size="md" onClick={reload}>
                Try again
              </Button>
            }
          />
        ) : url ? (
          <iframe
            key={`${url}#${attempt}`}
            className="block h-full w-full border-0 bg-surface"
            src={url}
            title="Sandbox desktop"
            onLoad={() => setFrameLoading(false)}
            allow="clipboard-read; clipboard-write; fullscreen; autoplay"
            sandbox="allow-scripts allow-same-origin allow-forms allow-modals allow-downloads"
          />
        ) : null}
      </div>
    </div>
  );
}

function DesktopNotice({
  title,
  detail,
  action,
}: {
  title: string;
  detail: string;
  action: ReactNode;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 p-8 text-center">
      <IconBox size={40} className="text-dim" />
      <div className="flex flex-col items-center gap-1">
        <div className="text-base font-medium text-fg">{title}</div>
        <div className="max-w-sm text-xs leading-relaxed text-dim">
          {detail}
        </div>
      </div>
      {action}
    </div>
  );
}
