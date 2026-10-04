import { useEffect, useRef, useState } from "react";
import * as AgentResourceRuntime from "../lib/agent-resource-runtime";
import { getCurrentUser } from "./UserPicker";
import {
  formatResourceBytes,
  formatResourcePercent,
} from "../lib/server-resource-chart";
import { formatBytes } from "../lib/images";
import { Button } from "../ui/button";

/** Mounted only while diagnostics is open, on desktop and phone. */
export function AgentResourcePanel() {
  const [state, setState] = useState<AgentResourceRuntime.ResourceState>({
    status: "loading",
  });
  const [error, setError] = useState<string | null>(null);
  const runtime = useRef<ReturnType<
    typeof AgentResourceRuntime.makeAgentResourceRuntime
  > | null>(null);
  useEffect(() => {
    const active = AgentResourceRuntime.makeAgentResourceRuntime(
      setState,
      setError,
    );
    runtime.current = active;
    return () => {
      runtime.current = null;
      active.dispose();
    };
  }, []);
  const rows = AgentResourceRuntime.resourceSessions(state);
  return (
    <section aria-label="Agent resources" className="space-y-3 px-4 py-3">
      <h3 className="m-0 text-supporting font-medium text-fg">
        Agent resources
      </h3>
      <p className="m-0 text-meta text-dim" role="status">
        {state.status === "loading"
          ? "Collecting samples…"
          : state.status === "unavailable"
            ? "Metrics unavailable. Retrying…"
            : `Host CPU ${formatResourcePercent(state.sample.host.cpu)} · Memory ${formatResourceBytes(state.sample.host.usedMemory)} of ${formatResourceBytes(state.sample.host.totalMemory)}`}
      </p>
      {state.status === "ready" && rows.length === 0 && (
        <p className="text-meta text-dim">No tracked local processes.</p>
      )}
      {rows.map((row) => (
        <div
          key={row.sessionId}
          className="flex flex-wrap items-center justify-between gap-2 border-b border-line py-2"
        >
          <div className="min-w-0 flex-1">
            <span
              className="block truncate text-supporting text-fg"
              title={row.sessionId}
            >
              {row.sessionId}
            </span>
            <span className="text-meta tabular-nums text-dim">
              {formatResourcePercent(row.cpu)} CPU · {formatBytes(row.rss)} RSS
              · {row.runs} {row.runs === 1 ? "run" : "runs"}
            </span>
          </div>
          {state.status === "ready" && (
            <div className="order-last w-full space-y-1 text-meta text-dim">
              {state.sample.runs
                .filter((run) => run.sessionId === row.sessionId)
                .map((run) => (
                  <p key={run.runId} className="m-0 tabular-nums">
                    {run.kind === "agent"
                      ? "Agent"
                      : run.kind === "portal"
                        ? "Portal"
                        : run.kind === "shell"
                          ? "Shell"
                          : "Script"}{" "}
                    · PID {run.pid} · {formatResourcePercent(run.cpu)} CPU ·{" "}
                    {formatBytes(run.rss)} RSS
                  </p>
                ))}
            </div>
          )}
          <Button
            variant="ghost"
            size="sm"
            className="min-h-11 shrink-0"
            disabled={!row.agent}
            onClick={() =>
              runtime.current?.stopSession(row.sessionId, getCurrentUser())
            }
          >
            Stop agent
          </Button>
        </div>
      ))}
      {error && (
        <p role="alert" className="text-meta text-dim">
          {error}
        </p>
      )}
      <p className="m-0 text-meta text-faint">
        Updates while visible. CPU uses one core as 100%. Shared memory may be
        counted more than once. Stop agent does not stop portals, scripts or
        shells.
      </p>
    </section>
  );
}
