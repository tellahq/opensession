import { prCheckGroups } from "../../lib/pr-commit-days";
import { checkClass, formatCheckDuration } from "../../lib/pr-status-derive";
import { CHECK_TEXT } from "../../lib/pr-tone-classes";
import type { PrCheck } from "../../lib/types";
import { Button } from "../../ui/button";
import { cn } from "../../ui/cn";
import { IconArrowUpRight, IconCheck, IconSparkle, IconX } from "../icons";

interface Summary {
  passed: number;
  failed: number;
  pending: number;
  total: number;
  deployments: PrCheck[];
  checks: PrCheck[];
}

/**
 * A pull request's Checks tab: where it stands in one line, then every check
 * under its workflow, failing and running ones first, each linking out to
 * its run.
 */
export function PrChecksPage({
  summary,
  onFixChecks,
}: {
  summary: Summary;
  /** Ask the session's agent to fix the failing checks. */
  onFixChecks?: () => void;
}) {
  const groups = [
    ...(summary.deployments.length
      ? [{ name: "Deployments", checks: summary.deployments }]
      : []),
    ...prCheckGroups(summary.checks).map((group) => ({
      name: group.name || "Other checks",
      checks: group.checks,
    })),
  ];
  const tone =
    summary.failed > 0
      ? "check-failure"
      : summary.pending > 0
        ? "check-pending"
        : "check-success";
  const headline =
    summary.total === 0
      ? "No checks on this pull request"
      : summary.failed > 0
        ? "Some checks were not successful"
        : summary.pending > 0
          ? "Some checks haven't completed yet"
          : "All checks have passed";
  const counts = [
    summary.failed > 0 && `${summary.failed} failing`,
    summary.pending > 0 && `${summary.pending} in progress`,
    summary.passed > 0 && `${summary.passed} successful`,
  ].filter(Boolean);

  return (
    <main className="min-h-0 flex-1 overflow-y-auto bg-surface">
      <div className="flex w-full flex-col gap-6 py-6">
        <header className="flex items-center gap-3 px-6">
          {summary.total > 0 && (
            <span
              className={cn(
                "grid size-9 shrink-0 place-items-center rounded-full bg-control",
                CHECK_TEXT[tone],
              )}
            >
              <StatusGlyph rank={tone} />
            </span>
          )}
          <div className="min-w-0 flex-1">
            <h2 className="m-0 text-item-title font-semibold text-fg">
              {headline}
            </h2>
            {counts.length > 0 && (
              <p className="m-0 text-supporting text-dim">
                {counts.join(", ")}
              </p>
            )}
          </div>
          {summary.failed > 0 && onFixChecks && (
            <Button
              variant="default"
              size="sm"
              icon={<IconSparkle size={20} />}
              onClick={onFixChecks}
            >
              Fix checks
            </Button>
          )}
        </header>
        {groups.map((group) => (
          <section key={group.name} className="flex flex-col gap-2">
            <h3 className="m-0 px-6 text-supporting font-semibold text-dim">
              {group.name}
            </h3>
            <ul className="m-0 list-none divide-y divide-divider overflow-hidden border-y border-divider p-0">
              {group.checks.map((check, index) => (
                <CheckItem key={`${check.name}:${index}`} check={check} />
              ))}
            </ul>
          </section>
        ))}
      </div>
    </main>
  );
}

function StatusGlyph({ rank }: { rank: string }) {
  if (rank === "check-success") return <IconCheck size={20} aria-hidden />;
  if (rank === "check-failure") return <IconX size={20} aria-hidden />;
  return (
    <span
      aria-hidden
      className={cn(
        "size-2 rounded-full bg-current",
        rank === "check-pending" && "pr-check-mark-pending animate-live",
      )}
    />
  );
}

const RANK_LABEL = {
  "check-success": "Successful",
  "check-failure": "Failing",
  "check-pending": "In progress",
  "check-neutral": "Skipped",
} as const;

function CheckItem({ check }: { check: PrCheck }) {
  const rank = checkClass(check.status, check.conclusion);
  const duration = formatCheckDuration(check);
  const detail =
    rank === "check-success" && duration
      ? `Successful in ${duration}`
      : RANK_LABEL[rank];
  const row = (
    <>
      <span
        className={cn(
          "grid size-5 shrink-0 place-items-center",
          CHECK_TEXT[rank] || "text-faint",
        )}
      >
        <StatusGlyph rank={rank} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-label font-semibold text-fg">
          {check.name}
        </span>
        <span className="block truncate text-meta text-dim">{detail}</span>
      </span>
      {check.url && (
        <span className="inline-flex shrink-0 items-center gap-0.5 text-meta text-faint group-hover:text-fg">
          Details
          <IconArrowUpRight dense size={14} aria-hidden />
        </span>
      )}
    </>
  );
  return (
    <li>
      {check.url ? (
        <a
          className="group flex min-w-0 items-center gap-3 px-6 py-2.5 text-inherit no-underline hover:bg-hover"
          href={check.url}
          target="_blank"
          rel="noopener"
        >
          {row}
        </a>
      ) : (
        <div className="flex min-w-0 items-center gap-3 px-6 py-2.5">{row}</div>
      )}
    </li>
  );
}
