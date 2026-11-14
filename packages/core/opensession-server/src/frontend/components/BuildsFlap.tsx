import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type { SessionBuildWire } from "@tellahq/opensession-protocol/session";
import { BASE_PATH } from "../lib/base";
import { checkToneClass } from "../lib/pr-checks";
import {
  buildGroupUrl,
  buildsFlapStatus,
  buildVisual,
  createBuildsClock,
  hiddenBuildGroupKeys,
  isBuildLive,
  hideBuildGroup,
  hideKey,
  visibleBuildGroups,
  type BuildGroup,
  type BuildsClock,
  type RolloutApp,
} from "../lib/session-builds";
import { composerQueue } from "../lib/composer-classes";
import { elapsedSince, formatDuration } from "../lib/time";
import { useSessionSocket } from "../hooks/useSessionSocket";
import { Button } from "../ui/button";
import { cn } from "../ui/cn";
import { Tooltip } from "../ui/tooltip";
import { CheckStatusIcon } from "./CheckStatusIcon";
import { IconChevronDown, IconX } from "./icons";

const RESYNC_WHILE_LIVE_MS = 60_000;

/**
 * GitHub Actions runs and rollouts the session follows (server/
 * session-builds.ts): the CI of its branch and, once its PR merged, the
 * deploy of the merge commit. Fed from webhooks by the server, so the hook
 * loads the list on mount and follows `session_builds` frames.
 *
 * Frames are not replayed: one sent while the socket was down, or while the
 * tab slept, is gone. So the hook loads the list again on every reconnect,
 * when the tab comes back into view, and now and then while a build runs.
 *
 * Shown as a flap tucked behind the composer, one summary row per commit,
 * rather than as a card in the transcript: a build is status, like the run
 * status flap, and its runs unfold only on request. Returns null when there
 * is nothing to show, so the phone composer can still rest as a pill.
 */
export function useBuildsFlap(
  sessionId: string,
  connected: boolean,
): ReactNode {
  const { addHandler } = useSessionSocket();
  const [builds, setBuilds] = useState<SessionBuildWire[]>([]);
  // Ticks through a store rather than state: this hook runs in the session
  // view, which would otherwise re-render whole every second a build runs.
  const [clock] = useState(() => createBuildsClock());
  const [hidden, setHidden] = useState(() => hiddenBuildGroupKeys());
  const [reloads, setReloads] = useState(0);
  // Bumped by every frame: a load that started before a frame arrived is
  // older than what the card shows and must not replace it.
  const frameSeq = useRef(0);

  useEffect(() => {
    setBuilds([]);
    const off = addHandler((message) => {
      if (
        message.type === "session_builds" &&
        message.sessionId === sessionId
      ) {
        frameSeq.current++;
        setBuilds(message.builds);
      }
    });
    return off;
  }, [sessionId, addHandler]);

  useEffect(() => {
    if (!connected) return;
    let live = true;
    const seq = frameSeq.current;
    fetch(`${BASE_PATH}/api/builds?sessionId=${encodeURIComponent(sessionId)}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((body) => {
        if (live && body?.builds && seq === frameSeq.current)
          setBuilds(body.builds);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [sessionId, connected, reloads]);

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") setReloads((n) => n + 1);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, []);

  const flapStatus = useSyncExternalStore(clock.subscribe, () =>
    buildsFlapStatus(visibleBuildGroups(builds, hidden, clock.get())),
  );
  const anyLive = flapStatus === "live";

  // A missed final frame would leave a build running forever: while one
  // runs, check the list once a minute.
  useEffect(() => {
    if (!anyLive || !connected) return;
    const timer = setInterval(
      () => setReloads((n) => n + 1),
      RESYNC_WHILE_LIVE_MS,
    );
    return () => clearInterval(timer);
  }, [anyLive, connected]);

  // One clock for every row: elapsed time while running, and ended groups
  // leaving after their window.
  useEffect(() => {
    if (!builds.length) return;
    const timer = setInterval(
      () => clock.set(Date.now()),
      anyLive ? 1_000 : 30_000,
    );
    return () => clearInterval(timer);
  }, [builds.length, anyLive, clock]);

  if (flapStatus === "none") return null;
  return (
    <BuildsFlap
      builds={builds}
      hidden={hidden}
      clock={clock}
      onHide={(group) => {
        hideBuildGroup(group);
        setHidden((prev) => new Set(prev).add(hideKey(group)));
      }}
    />
  );
}

function BuildsFlap({
  builds,
  hidden,
  clock,
  onHide,
}: {
  builds: SessionBuildWire[];
  hidden: Set<string>;
  clock: BuildsClock;
  onHide: (group: BuildGroup) => void;
}) {
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  const now = useSyncExternalStore(clock.subscribe, clock.get);
  const groups = visibleBuildGroups(builds, hidden, now);
  return (
    // The run status flap's metrics (ComposerAgents), so the two read as one
    // family when they stack: same row height and bottom inset.
    <div className={cn(composerQueue, "gap-2.5 pb-[22px]")}>
      {groups.map((group, i) => (
        <BuildGroupFlap
          key={group.key}
          group={group}
          now={now}
          separated={i > 0}
          open={open.has(group.key)}
          onToggle={() =>
            setOpen((prev) => {
              const next = new Set(prev);
              if (!next.delete(group.key)) next.add(group.key);
              return next;
            })
          }
          onHide={() => onHide(group)}
        />
      ))}
    </div>
  );
}

function groupTitle(group: BuildGroup): string {
  const sha = group.sha.slice(0, 7);
  if (group.prNumber != null) {
    if (group.live) return `Deploying PR #${group.prNumber}`;
    return group.failed
      ? `Deploy of PR #${group.prNumber} failed`
      : `PR #${group.prNumber} deployed`;
  }
  if (group.live) return `Building ${sha}`;
  return group.failed ? `Build failed on ${sha}` : `Build passed on ${sha}`;
}

function groupSummary(group: BuildGroup): string {
  const rows = [
    ...group.workflows,
    ...group.rollouts.flatMap((a) => a.targets),
  ];
  const count = (pred: (r: SessionBuildWire) => boolean) =>
    rows.filter(pred).length;
  const parts = [
    [count((r) => r.state === "failure"), "failed"],
    [count((r) => r.state === "running" || r.state === "queued"), "running"],
    [count((r) => r.state === "success"), "passed"],
    [count((r) => r.state === "cancelled"), "cancelled"],
  ] as const;
  return parts
    .filter(([n]) => n > 0)
    .map(([n, label]) => `${n} ${label}`)
    .join(" · ");
}

function BuildGroupFlap({
  group,
  now,
  separated,
  open,
  onToggle,
  onHide,
}: {
  group: BuildGroup;
  now: number;
  separated: boolean;
  open: boolean;
  onToggle: () => void;
  onHide: () => void;
}) {
  const title = groupTitle(group);
  const visual = group.live ? "pending" : group.failed ? "failure" : "success";
  const hasDetail = group.workflows.length > 0 || group.rollouts.length > 0;
  return (
    // The summary row comes last so the runs unfold above it: the flap's
    // bottom is pinned to the composer, so the toggle stays where it was
    // clicked (same reasoning as ComposerAgents).
    <section
      className={cn(
        "flex min-w-0 flex-col gap-2.5",
        separated && "border-t border-line pt-2.5",
      )}
      aria-label={title}
    >
      {open && hasDetail && (
        <div className="flex max-h-[240px] flex-col gap-2.5 overflow-y-auto">
          {group.workflows.length > 0 && (
            <ul className="m-0 flex list-none flex-col gap-2 p-0">
              {group.workflows.map((run) => (
                <WorkflowRow key={run.id} run={run} now={now} />
              ))}
            </ul>
          )}
          {group.rollouts.length > 0 && (
            <div className="flex flex-col gap-2">
              <span className="text-meta font-medium text-dim">Rollouts</span>
              <ul className="m-0 flex list-none flex-col gap-2 p-0">
                {group.rollouts.map((app) => (
                  <RolloutRow key={app.app} app={app} now={now} />
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
      <div className="flex min-w-0 items-center gap-2">
        <span className={cn("shrink-0", checkToneClass(visual))}>
          <CheckStatusIcon kind={visual} />
        </span>
        <a
          href={buildGroupUrl(group)}
          target="_blank"
          rel="noreferrer"
          className="min-w-0 truncate text-label font-semibold text-fg no-underline hover:underline"
        >
          {title}
        </a>
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center justify-end gap-1.5 text-meta text-dim tabular-nums hover:text-fg disabled:cursor-default phone:-my-3 phone:min-h-11"
          aria-expanded={open}
          aria-label={open ? `Hide runs of ${title}` : `Show runs of ${title}`}
          disabled={!hasDetail}
          onClick={onToggle}
        >
          <span className="truncate phone:hidden">{groupSummary(group)}</span>
          {hasDetail && (
            <IconChevronDown
              size={16}
              className={cn(
                "flex-none text-faint transition-transform duration-[var(--dur)]",
                !open && "rotate-180",
              )}
            />
          )}
        </button>
        <Tooltip label="Close" side="top">
          <Button
            variant="ghost"
            size="sm"
            // Negative margins keep the touch target from growing the row.
            className="-my-1.5 -mr-1 shrink-0 phone:-my-3 phone:-mr-[13px] phone:min-h-11 phone:min-w-11"
            icon={<IconX size={16} />}
            aria-label="Close"
            onClick={onHide}
          />
        </Tooltip>
      </div>
    </section>
  );
}

function workflowStatus(run: SessionBuildWire, now: number): string {
  const jobs = run.jobs ? `${run.jobs.done}/${run.jobs.total} jobs` : null;
  const took = run.endedAt
    ? formatDuration(Date.parse(run.endedAt) - Date.parse(run.startedAt))
    : null;
  switch (run.state) {
    case "queued":
      return "Queued";
    case "running":
      return ["Running", jobs, elapsedSince(Date.parse(run.startedAt), now)]
        .filter(Boolean)
        .join(" · ");
    case "success":
      return took ? `Passed in ${took}` : "Passed";
    case "cancelled":
      return "Cancelled";
    case "failure":
      return took ? `Failed after ${took}` : "Failed";
  }
}

function ExternalTitle({ url, text }: { url?: string; text: string }) {
  if (!url)
    return (
      <span className="min-w-0 truncate text-supporting text-fg">{text}</span>
    );
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      className="min-w-0 truncate text-supporting text-fg no-underline hover:underline"
    >
      {text}
    </a>
  );
}

function WorkflowRow({ run, now }: { run: SessionBuildWire; now: number }) {
  const visual = buildVisual(run.state);
  // Show the failed job as soon as one fails, before the run ends.
  const failedDetail =
    run.detail && (run.state === "failure" || (run.jobs?.failed ?? 0) > 0)
      ? run.detail
      : null;
  return (
    <li className="flex min-w-0 flex-col gap-0.5">
      <div className="flex min-w-0 items-center gap-2">
        <span className={cn("shrink-0", checkToneClass(visual))}>
          <CheckStatusIcon kind={visual} />
        </span>
        <ExternalTitle url={run.url} text={run.title} />
        <span className="ml-auto shrink-0 text-meta text-dim tabular-nums">
          {workflowStatus(run, now)}
        </span>
      </div>
      {failedDetail && (
        <p className="m-0 pl-6 text-meta text-red [overflow-wrap:anywhere]">
          {failedDetail}
        </p>
      )}
    </li>
  );
}

function RolloutRow({ app, now }: { app: RolloutApp; now: number }) {
  return (
    <li className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5">
      <span className="min-w-0 truncate text-supporting text-fg">
        {app.app}
      </span>
      <span className="ml-auto flex flex-wrap items-center gap-1.5">
        {app.targets.map((target) => (
          <RolloutTarget key={target.id} target={target} now={now} />
        ))}
      </span>
    </li>
  );
}

function RolloutTarget({
  target,
  now,
}: {
  target: SessionBuildWire;
  now: number;
}) {
  const stale = target.state === "running" && !isBuildLive(target, now);
  const visual = stale ? "neutral" : buildVisual(target.state);
  const pill = cn(
    "inline-flex items-center gap-1.5 rounded-full bg-hover px-2 py-0.5 text-meta text-dim no-underline",
    target.url && "hover:text-fg",
  );
  const body = (
    <>
      <span className={cn("shrink-0 scale-75", checkToneClass(visual))}>
        <CheckStatusIcon kind={visual} />
      </span>
      {target.target}
    </>
  );
  const label = stale
    ? `No result reported for ${target.title} on ${target.target}`
    : target.detail || `${target.title} on ${target.target}`;
  return (
    <Tooltip label={label} side="top">
      {target.url ? (
        <a
          href={target.url}
          target="_blank"
          rel="noreferrer"
          className={pill}
          aria-label={label}
        >
          {body}
        </a>
      ) : (
        <span className={pill} aria-label={label}>
          {body}
        </span>
      )}
    </Tooltip>
  );
}
