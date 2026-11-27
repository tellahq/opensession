import type RFB from "@novnc/novnc";
import { useEffect, useRef, useState } from "react";
import { getWebSocketUrl } from "../lib/api/request";
import { loadNoVnc } from "../lib/novnc-loader";
import { Button } from "../ui/button";
import { PageLoader } from "../ui/page-loader";

export type VncPhase =
  | { phase: "connecting" }
  | { phase: "connected" }
  | { phase: "closed"; reason: string };

/** The stream endpoint on this origin, next to the app socket. */
export function vncStreamUrl(streamPath: string): string {
  return getWebSocketUrl().replace(/\/ws$/, "") + streamPath;
}

/**
 * A desktop streamed over VNC through this server (Mac VMs): noVNC draws the
 * remote screen into a canvas and sends the mouse and keyboard back. The
 * password never leaves memory; it is handed to the client at connect time.
 */
export function VncDesktop({
  streamPath,
  password,
  onPhase,
  onRetry,
}: {
  streamPath: string;
  password: string;
  onPhase?: (phase: VncPhase) => void;
  onRetry: () => void;
}) {
  const screen = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<VncPhase>({ phase: "connecting" });

  useEffect(() => {
    const target = screen.current;
    if (!target) return;
    let live = true;
    const report = (next: VncPhase) => {
      if (!live) return;
      setState(next);
      onPhase?.(next);
    };
    report({ phase: "connecting" });
    let rfb: RFB | null = null;
    void loadNoVnc().then(
      ({ default: RFBClient }) => {
        if (!live) return;
        const client = new RFBClient(target, vncStreamUrl(streamPath), {
          credentials: { password },
          shared: true,
        });
        rfb = client;
        client.scaleViewport = true;
        client.resizeSession = false;
        client.showDotCursor = true;
        client.background = "transparent";
        client.addEventListener("connect", () =>
          report({ phase: "connected" }),
        );
        client.addEventListener("credentialsrequired", () =>
          client.sendCredentials({ password }),
        );
        client.addEventListener("securityfailure", (event) => {
          report({
            phase: "closed",
            reason: event.detail.reason || "The display refused the connection",
          });
        });
        client.addEventListener("disconnect", (event) => {
          setState((current) =>
            current.phase === "closed"
              ? current
              : {
                  phase: "closed",
                  reason: event.detail.clean
                    ? "The display closed"
                    : "Lost the connection to the display",
                },
          );
        });
      },
      () =>
        report({ phase: "closed", reason: "Couldn't load the desktop viewer" }),
    );
    return () => {
      live = false;
      try {
        rfb?.disconnect();
      } catch {}
    };
  }, [streamPath, password, onPhase]);

  return (
    <div className="relative h-full w-full">
      <div
        ref={screen}
        className="h-full w-full"
        data-testid="vnc-screen"
        aria-label="Sandbox desktop"
      />
      {state.phase === "connecting" ? (
        <div
          role="status"
          aria-label="Connecting to the desktop"
          className="pointer-events-none absolute inset-0 z-sticky flex items-center justify-center bg-panel"
        >
          <PageLoader className="text-dim" />
        </div>
      ) : null}
      {state.phase === "closed" ? (
        <div className="absolute inset-0 z-sticky flex flex-col items-center justify-center gap-3 bg-panel p-8 text-center">
          <div className="text-base font-medium text-fg">{state.reason}</div>
          <Button variant="default" size="md" onClick={onRetry}>
            Reconnect
          </Button>
        </div>
      ) : null}
    </div>
  );
}
