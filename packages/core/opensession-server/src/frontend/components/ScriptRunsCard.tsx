import { useEffect, useRef, useState } from "react";
import type { ScriptRunWire } from "@tellahq/opensession-protocol/session";
import { BASE_PATH } from "../lib/base";
import { elapsedSince, formatDuration } from "../lib/time";
import { useSessionSocket } from "../hooks/useSessionSocket";
import { Button } from "../ui/button";
import { useConfirm } from "../ui/confirm";
import { Disclosure } from "../ui/disclosure";
import { PulseDot } from "../ui/status";
import { cn } from "../ui/cn";
import { SCRIPT_CARD_SHELL, SCRIPT_OUTPUT } from "../lib/script-card-classes";

/** An ended run stays on screen this long, so its outcome is seen. */
const ENDED_VISIBLE_MS = 15 * 60_000;
const OUTPUT_POLL_MS = 3_000;

/**
 * Script runs of this session (start_script, run_with_credential): long
 * scripts and migrations Open Session supervises. They keep running through
 * server restarts, so the card is fed from the server's registry, not from
 * the turn: it loads the list on mount and follows `script_runs` frames.
 */
export function ScriptRunsCard({ sessionId }: { sessionId: string }) {
  const { addHandler } = useSessionSocket();
  const [runs, setRuns] = useState<ScriptRunWire[]>([]);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let live = true;
    fetch(`${BASE_PATH}/api/scripts?sessionId=${encodeURIComponent(sessionId)}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((body) => {
        if (live && body?.runs) setRuns(body.runs);
      })
      .catch(() => {});
    const off = addHandler((message) => {
      if (message.type === "script_runs" && message.sessionId === sessionId)
        setRuns(message.runs);
    });
    return () => {
      live = false;
      off();
    };
  }, [sessionId, addHandler]);

  // Oldest first, and running runs last: the card sits at the end of the
  // transcript, so what is still going stays next to the composer.
  const visible = runs
    .filter(
      (run) =>
        run.state === "running" ||
        (run.endedAt && now - Date.parse(run.endedAt) < ENDED_VISIBLE_MS),
    )
    .sort(
      (a, b) =>
        Number(a.state === "running") - Number(b.state === "running") ||
        a.startedAt.localeCompare(b.startedAt),
    );
  const anyRunning = visible.some((run) => run.state === "running");

  // One clock for every row: elapsed time while running, and ended rows
  // leaving after their window.
  useEffect(() => {
    if (!visible.length) return;
    const timer = setInterval(
      () => setNow(Date.now()),
      anyRunning ? 1_000 : 30_000,
    );
    return () => clearInterval(timer);
  }, [visible.length, anyRunning]);

  if (!visible.length) return null;
  return (
    <div className="flex flex-col">
      {visible.map((run) => (
        <ScriptRunRow key={run.id} run={run} now={now} />
      ))}
    </div>
  );
}

/** What the card says about a run, and the colour of its dot. */
interface RunOutcome {
  text: string;
  tone: Tone;
}

function outcome(run: ScriptRunWire): RunOutcome {
  const took = run.endedAt
    ? formatDuration(Date.parse(run.endedAt) - Date.parse(run.startedAt))
    : null;
  const after = took ? ` after ${took}` : "";
  switch (run.state) {
    case "running":
      return { text: run.stopping ? "Stopping" : "Running", tone: "running" };
    case "exited":
      return run.exitCode === 0
        ? { text: `Finished${after}`, tone: "ok" }
        : {
            text: `Exited with code ${run.exitCode ?? "?"}${after}`,
            tone: "bad",
          };
    case "failed":
      return { text: "Couldn't run", tone: "bad" };
    case "timed_out":
      return { text: `Hit its time limit${after}`, tone: "bad" };
    case "stopped":
      return { text: `Stopped${after}`, tone: "quiet" };
    case "revoked":
      return { text: "Stopped: its credential was revoked", tone: "bad" };
    case "lost":
      return { text: "Lost track of it", tone: "bad" };
  }
}

type Tone = "running" | "ok" | "bad" | "quiet";

const DOT: Record<Exclude<Tone, "running">, string> = {
  ok: "bg-green",
  bad: "bg-red",
  quiet: "bg-faint",
};

function ScriptRunRow({ run, now }: { run: ScriptRunWire; now: number }) {
  const [confirm, confirmDialog] = useConfirm();
  const [error, setError] = useState<string | null>(null);
  const { text, tone } = outcome(run);
  const running = run.state === "running";
  const deadline = new Date(run.deadline);

  async function stop() {
    setError(null);
    const res = await fetch(
      `${BASE_PATH}/api/scripts/${encodeURIComponent(run.id)}/stop`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId: run.sessionId }),
      },
    ).catch(() => null);
    if (!res?.ok) {
      const body = await res?.json().catch(() => null);
      setError(body?.error ? `Couldn't stop: ${body.error}` : "Couldn't stop.");
    }
  }

  return (
    <section className={SCRIPT_CARD_SHELL} aria-label={`Script: ${run.title}`}>
      <div className="flex min-w-0 items-center gap-2.5">
        {tone === "running" ? (
          <PulseDot />
        ) : (
          <span
            aria-hidden
            className={cn("size-2 shrink-0 rounded-full", DOT[tone])}
          />
        )}
        <span className="min-w-0 flex-1 truncate text-label font-semibold text-fg">
          {run.title}
        </span>
        {running && (
          <span className="shrink-0 text-meta text-dim tabular-nums">
            {elapsedSince(Date.parse(run.startedAt), now)}
          </span>
        )}
      </div>

      <p className="m-0 text-supporting text-dim [overflow-wrap:anywhere]">
        {text}
        {running &&
          !run.stopping &&
          ` · stops by ${deadline.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`}
        {run.error && !running ? ` · ${run.error}` : ""}
      </p>

      {run.credentials?.map((credential) => (
        <CredentialCalls key={credential.grantId} credential={credential} />
      ))}

      <Disclosure
        title="Output"
        actions={
          running && !run.stopping ? (
            <Button
              variant="soft"
              size="sm"
              className="phone:min-h-11"
              onClick={() =>
                confirm({
                  title: "Stop this script?",
                  description:
                    "It's asked to stop now and killed after 10 seconds. Work it already did stays done.",
                  confirmLabel: "Stop",
                  destructive: true,
                  onConfirm: () => void stop(),
                })
              }
            >
              Stop
            </Button>
          ) : undefined
        }
      >
        <ScriptOutput run={run} />
      </Disclosure>

      {error && (
        <p className="m-0 text-meta text-red" role="alert">
          {error}
        </p>
      )}
      {confirmDialog}
    </section>
  );
}

function CredentialCalls({
  credential,
}: {
  credential: NonNullable<ScriptRunWire["credentials"]>[number];
}) {
  const percent = credential.maxCalls
    ? Math.min(100, Math.floor((credential.calls / credential.maxCalls) * 100))
    : 0;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex min-w-0 items-baseline justify-between gap-3 text-meta text-dim">
        <span className="min-w-0 truncate">{credential.service}</span>
        <span className="shrink-0 tabular-nums">
          {credential.calls.toLocaleString()} of{" "}
          {credential.maxCalls.toLocaleString()} calls
          {credential.denied
            ? ` · ${credential.denied.toLocaleString()} refused`
            : ""}
        </span>
      </div>
      <div
        role="progressbar"
        aria-label={`${credential.service} calls`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        className="h-1 overflow-hidden rounded-full bg-fg/8"
      >
        <div
          className="h-full rounded-full bg-fg transition-[width] duration-300 motion-reduce:transition-none"
          style={{ width: `${percent}%` }}
        />
      </div>
    </div>
  );
}

/** The end of the log, refreshed while the run is going. Mounted only while
 *  the disclosure is open. */
function ScriptOutput({ run }: { run: ScriptRunWire }) {
  const [output, setOutput] = useState<string | null>(null);
  const preRef = useRef<HTMLPreElement>(null);
  const running = run.state === "running";

  useEffect(() => {
    let live = true;
    const load = () =>
      fetch(
        `${BASE_PATH}/api/scripts/${encodeURIComponent(run.id)}?sessionId=${encodeURIComponent(run.sessionId)}`,
      )
        .then((res) => (res.ok ? res.json() : null))
        .then((body) => {
          if (live && body?.run) setOutput(body.run.outputTail ?? "");
        })
        .catch(() => {});
    void load();
    if (!running) return () => void (live = false);
    const timer = setInterval(load, OUTPUT_POLL_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [run.id, run.sessionId, running]);

  // Follow the end, like a terminal.
  useEffect(() => {
    const pre = preRef.current;
    if (pre) pre.scrollTop = pre.scrollHeight;
  }, [output]);

  return (
    <div className="flex flex-col gap-2">
      <pre ref={preRef} className={SCRIPT_OUTPUT}>
        {output === null
          ? "Loading…"
          : output.trim()
            ? output
            : "No output yet."}
      </pre>
      <span className="text-meta text-faint [overflow-wrap:anywhere]">
        <span className="font-mono">{run.command}</span>
      </span>
    </div>
  );
}
