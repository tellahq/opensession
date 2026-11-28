import { useState } from "react";
import { relativeTime } from "../../lib/api/request";
import { prCommitDays } from "../../lib/pr-commit-days";
import type { Provider } from "../../lib/provider";
import type { PrCommit, PrDetails } from "../../lib/types";
import { Button } from "../../ui/button";
import { Tooltip } from "../../ui/tooltip";
import { IconArrowUpRight, IconDotsHorizontal } from "../icons";
import { UserAvatar } from "../UserAvatar";
import { CopyTextButton } from "./CopyTextButton";
import { CommitIcon } from "./PrViews";

/**
 * A pull request's Commits tab, in GitHub's shape: the commits by day, each
 * a row with its headline, who wrote it and when, and its short sha.
 */
export function PrCommitsPage({
  pr,
  provider,
  commitNotes,
}: {
  pr: PrDetails;
  provider: Provider;
  /** The host keeps git notes on commits (code.storage). */
  commitNotes?: boolean;
}) {
  const days = prCommitDays(pr.commits ?? []);
  return (
    <main className="min-h-0 flex-1 overflow-y-auto bg-surface">
      <div className="mx-auto flex w-full max-w-[1120px] flex-col gap-5 px-6 py-6">
        {days.length === 0 && (
          <p className="m-0 py-10 text-center text-supporting text-faint">
            No commits yet.
          </p>
        )}
        {days.map((day) => (
          <section key={day.label || "undated"} className="flex flex-col gap-2">
            <h2 className="m-0 flex items-center gap-2 px-1 text-supporting font-normal text-dim">
              <span className="inline-flex text-faint">
                <CommitIcon />
              </span>
              {day.label ? `Commits on ${day.label}` : "Commits"}
            </h2>
            <ol className="m-0 list-none divide-y divide-divider overflow-hidden rounded-xl border border-line/60 bg-surface p-0 smooth-shadow-sm">
              {day.commits.map((commit) => (
                <CommitRow
                  key={commit.oid}
                  commit={commit}
                  pr={pr}
                  provider={provider}
                  commitNotes={commitNotes}
                />
              ))}
            </ol>
          </section>
        ))}
      </div>
    </main>
  );
}

function CommitRow({
  commit,
  pr,
  provider,
  commitNotes,
}: {
  commit: PrCommit;
  pr: PrDetails;
  provider: Provider;
  commitNotes?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const body = commit.messageBody?.trim();
  const href =
    provider.key === "github" && pr.url
      ? `${pr.url}/commits/${commit.oid}`
      : undefined;
  return (
    <li className="group flex min-w-0 items-start gap-3 px-4 py-3 hover:bg-hover">
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1.5">
          {href ? (
            <a
              className="min-w-0 truncate text-label font-semibold text-fg no-underline hover:text-link hover:underline"
              href={href}
              target="_blank"
              rel="noopener"
              title={commit.messageHeadline}
            >
              {commit.messageHeadline}
            </a>
          ) : (
            <span
              className="min-w-0 truncate text-label font-semibold text-fg"
              title={commit.messageHeadline}
            >
              {commit.messageHeadline}
            </span>
          )}
          {body && (
            <Button
              variant="ghost"
              size="sm"
              aria-expanded={open}
              aria-label={open ? "Hide description" : "Show description"}
              icon={<IconDotsHorizontal size={20} aria-hidden />}
              onClick={() => setOpen(!open)}
            />
          )}
        </div>
        {open && body && (
          <pre className="m-0 mt-2 whitespace-pre-wrap break-words font-mono text-meta leading-relaxed text-dim">
            {body}
          </pre>
        )}
        {commitNotes &&
          commit.notes?.map((note) => (
            <p
              className="m-0 mt-1.5 whitespace-pre-wrap text-supporting leading-relaxed text-dim"
              key={note.ref}
            >
              {note.text}
            </p>
          ))}
        <div className="mt-1 flex min-w-0 items-center gap-1.5 text-meta text-dim">
          <UserAvatar
            name={commit.author || "Unknown"}
            login={provider.key === "github" ? commit.author : null}
            size={16}
            edge={false}
          />
          <span className="font-semibold text-fg">
            {commit.author || "Unknown"}
          </span>
          {commit.authoredDate && (
            <time
              dateTime={commit.authoredDate}
              title={new Date(commit.authoredDate).toLocaleString()}
            >
              committed {relativeTime(commit.authoredDate)}
            </time>
          )}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <code className="rounded-sm px-1 font-mono text-meta text-dim">
          {commit.oid.slice(0, 7)}
        </code>
        <CopyTextButton text={commit.oid} label="Copy full sha" />
        {href && (
          <Tooltip label={`Open on ${provider.name}`}>
            <a
              className="grid size-6 place-items-center rounded-sm text-faint no-underline hover:bg-hover hover:text-fg"
              href={href}
              target="_blank"
              rel="noopener"
              aria-label={`Open commit ${commit.oid.slice(0, 7)} on ${provider.name}`}
            >
              <IconArrowUpRight dense size={16} aria-hidden />
            </a>
          </Tooltip>
        )}
      </div>
    </li>
  );
}
