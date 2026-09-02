import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  fetchRecentPrs,
  relativeTime,
  type OpenPr,
  type RecentPr,
} from "../lib/api";
import {
  CHIP_SELECTOR,
  applyChipCommit,
  cachedChipCommit,
  cachedChipSession,
  cachedOpenPrs,
  cachedRecentPr,
  cachedRecentPrs,
  cacheRecentPrs,
  chipCommitResolved,
  chipPr,
  chipPrIsWorthShowing,
  chipTarget,
  loadChipCommit,
  loadChipSession,
  loadOpenPrs,
  loadRecentPr,
  type ChipPr,
  type ChipTarget,
} from "../lib/chip-hover";
import type { CommitDetails } from "../lib/api";
import { setKnownRepoPrStates } from "../lib/markdown";
import { prStatusDisplay } from "../lib/pr-status";
import { PR_STATE_TEXT } from "../lib/pr-tone-classes";
import { providerFromUrl } from "../lib/provider";
import { repoLabel } from "../lib/repo-label";
import { compactNum, prettyReview } from "../lib/sidebar-hover";
import type { UnifiedSession } from "../lib/types";
import { Popover } from "../ui/popover";
import {
  CardFooter,
  CardLink,
  CardPrChip,
  CardRows,
  RowCardPopup,
  checksLabel,
  osReviewLabel,
} from "./SidebarRowCards";
import { pointerCanHover } from "../lib/pointer";
import { SessionCardBody } from "./sidebar/HoverCards";
import { IconGitCommit, IconGitMerge, IconPullRequest } from "./icons";

/**
 * Hover cards for the chips inside rendered markdown: a session reference
 * (`os-019f…`), a PR mention (`opensession#128`) and a commit sha
 * (`4ed1ef09`).
 *
 * Same card a sidebar row raises, driven the same way the workspace list
 * drives its one: markdown.ts renders these chips into an HTML string, so they
 * can't each own a popover, and one document-level watcher raises a single
 * card off whichever chip the pointer is dwelling on. That also means it
 * covers every markdown surface at once (transcript, review, notes, ask
 * cards) rather than only the transcript it was asked for.
 *
 * A chip whose subject this client can't name keeps its own tooltip and gets
 * no card: "Open the review for webapp #3662" is what the chip already
 * promises, and a card that repeats it is a card that got in the way.
 */

/** Dwell before the first card. Longer than a tooltip's: a pointer crossing a
 *  paragraph passes over chips it isn't asking about. */
const DWELL_MS = 340;
/** Moving between chips while a card is up: the question has already been
 *  asked, so answering the next one is nearly immediate. Instant would flash
 *  three cards on the way across a line. */
const SWITCH_MS = 120;
/** Grace on the way out, so the pointer can cross the gap into the card. */
const CLOSE_MS = 140;

/** Marks the card's own subtree, so hovering it holds it open. */
const CARD_ATTR = "data-chip-card";
const PR_STATES_REFRESH_MS = 60_000;

function syncRepoPrStates(open: OpenPr[], recent: RecentPr[]): void {
  cacheRecentPrs(recent);
  setKnownRepoPrStates([
    ...cachedRecentPrs(),
    ...open.map((pr) => ({ ...pr, state: "OPEN" as const })),
  ]);
}

type ChipCard =
  | { key: string; kind: "session"; session: UnifiedSession }
  | { key: string; kind: "pr"; pr: ChipPr }
  | { key: string; kind: "commit"; commit: CommitDetails };

export function ChipHoverCards({ sessions }: { sessions: UnifiedSession[] }) {
  const [hover, setHover] = useState<{
    el: HTMLElement;
    target: ChipTarget;
  } | null>(null);
  // What the card says, keyed by the chip it was resolved for: a chip whose
  // subject needs a fetch resolves after the dwell, and the card only opens
  // once the answer belongs to the chip still under the pointer.
  const [card, setCard] = useState<ChipCard | null>(null);
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The listeners below are bound once; this is how they read current state.
  const hoverRef = useRef(hover);
  useLayoutEffect(() => {
    hoverRef.current = hover;
  });

  function cancelTimers() {
    if (openTimer.current) clearTimeout(openTimer.current);
    if (closeTimer.current) clearTimeout(closeTimer.current);
    openTimer.current = null;
    closeTimer.current = null;
  }
  function close() {
    cancelTimers();
    setHover(null);
  }
  function scheduleClose() {
    if (openTimer.current) clearTimeout(openTimer.current);
    openTimer.current = null;
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(() => setHover(null), CLOSE_MS);
  }
  function enter(el: HTMLElement, target: ChipTarget, immediate = false) {
    if (hoverRef.current?.target.key === target.key) {
      cancelTimers();
      return;
    }
    cancelTimers();
    const delay = immediate ? 0 : hoverRef.current ? SWITCH_MS : DWELL_MS;
    if (!delay) {
      setHover({ el, target });
      return;
    }
    openTimer.current = setTimeout(() => setHover({ el, target }), delay);
  }
  const api = useRef({ enter, scheduleClose, close, cancelTimers });
  useLayoutEffect(() => {
    api.current = { enter, scheduleClose, close, cancelTimers };
  });
  useEffect(() => cancelTimers, []);

  // A PR mention should carry state before someone has to hover it. Sessions
  // only cover PRs opened by loaded workspaces, so fold in the repo-wide open
  // and recent PR caches as a second source for standalone references.
  useEffect(() => {
    let alive = true;
    const refresh = () => {
      void Promise.all([
        loadOpenPrs(),
        fetchRecentPrs(undefined, { days: 7, limit: 500 }),
      ])
        .then(([open, recent]) => {
          if (alive) syncRepoPrStates(open, recent);
        })
        .catch(() => {});
    };
    refresh();
    const timer = setInterval(refresh, PR_STATES_REFRESH_MS);
    return () => {
      alive = false;
      clearInterval(timer);
      setKnownRepoPrStates([]);
    };
  }, []);

  // Resolve what the dwelled-on chip is about. The session list answers most
  // chips outright; the rest fall back to a cached fetch (an archived session,
  // a PR no loaded session owns).
  useEffect(() => {
    if (!hover) return;
    const target = hover.target;
    let alive = true;
    if (target.kind === "session") {
      const known =
        sessions.find(
          (s) => s.id === target.id || s.aliasIds?.includes(target.id),
        ) || cachedChipSession(target.id);
      if (known) {
        setCard({ key: target.key, kind: "session", session: known });
        return;
      }
      void loadChipSession(target.id).then((session) => {
        if (alive && session)
          setCard({ key: target.key, kind: "session", session });
      });
      return () => {
        alive = false;
      };
    }
    if (target.kind === "commit") {
      const el = hover.el;
      const known = cachedChipCommit(target.sha, target.repo);
      if (known) {
        setCard({ key: target.key, kind: "commit", commit: known });
        return;
      }
      // Already asked and no checkout had it: the reference keeps its own
      // tooltip and stops looking like one that leads anywhere.
      if (chipCommitResolved(target.sha, target.repo)) {
        applyChipCommit(el, null);
        return;
      }
      void loadChipCommit(target.sha, target.repo).then((commit) => {
        // The correction lands either way: the pointer having moved on
        // does not make the answer less true for the next hover.
        applyChipCommit(el, commit);
        if (alive && commit)
          setCard({ key: target.key, kind: "commit", commit });
      });
      return () => {
        alive = false;
      };
    }
    const recent = cachedRecentPr(target.repo, target.number);
    const known = chipPr(
      target.repo,
      target.number,
      sessions,
      cachedOpenPrs(),
      recent ? [recent] : [],
    );
    if (chipPrIsWorthShowing(known))
      setCard({ key: target.key, kind: "pr", pr: known });
    // Revalidate even when the synchronous sources can name it. The old path
    // returned above and froze the first open-PR snapshot forever, which is how
    // a merged PR kept an Open card and then lost its card once archived.
    void Promise.all([loadOpenPrs(), loadRecentPr(target.repo, target.number)])
      .then(([openPrs, recentPr]) => {
        if (!alive) return;
        syncRepoPrStates(openPrs, recentPr ? [recentPr] : []);
        const filled = chipPr(
          target.repo,
          target.number,
          sessions,
          openPrs,
          recentPr ? [recentPr] : [],
        );
        if (chipPrIsWorthShowing(filled)) {
          setCard({ key: target.key, kind: "pr", pr: filled });
        } else {
          setCard((current) => (current?.key === target.key ? null : current));
        }
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [hover, sessions]);

  const open = !!hover && card?.key === hover.target.key;

  // The chip's `title` is the card's own summary in one line. Both at once
  // puts an OS tooltip over the card that replaced it, so the attribute steps
  // aside while the card is up and comes back when it goes.
  useEffect(() => {
    if (!open || !hover) return;
    const el = hover.el;
    const title = el.getAttribute("title");
    if (title === null) return;
    el.removeAttribute("title");
    return () => {
      if (el.getAttribute("title") === null) el.setAttribute("title", title);
    };
  }, [open, hover]);

  useEffect(() => {
    // Touch has no dwell, and a tap that raised a card would cover the thing
    // the same tap just opened. The sidebar rows hold back for this reason
    // too. Keyboard focus still opens one (below).
    if (!pointerCanHover()) return;
    const onOver = (e: Event) => {
      if (!(e.target instanceof Element)) return;
      if (e.target.closest(`[${CARD_ATTR}]`)) {
        api.current.cancelTimers();
        return;
      }
      const closest = e.target.closest(CHIP_SELECTOR);
      const el = closest instanceof HTMLElement ? closest : null;
      const target = el && chipTarget(el);
      if (!el || !target) {
        api.current.scheduleClose();
        return;
      }
      api.current.enter(el, target);
    };
    const onFocusIn = (e: FocusEvent) => {
      if (!(e.target instanceof Element)) return;
      const closest = e.target.closest(CHIP_SELECTOR);
      const el = closest instanceof HTMLElement ? closest : null;
      // Only a keyboard arrival: a click focuses the chip too, and it is
      // already opening what the card would have described.
      if (!el || !el.matches(":focus-visible")) return;
      const target = chipTarget(el);
      if (target) api.current.enter(el, target, true);
    };
    const onFocusOut = () => api.current.scheduleClose();
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") api.current.close();
    };
    // Following a chip navigates away from what the card describes.
    const onClick = (e: MouseEvent) => {
      if (e.target instanceof Element && e.target.closest(CHIP_SELECTOR))
        api.current.close();
    };
    const onLeave = () => api.current.scheduleClose();
    document.addEventListener("pointerover", onOver);
    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("focusout", onFocusOut);
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("click", onClick);
    document.addEventListener("mouseleave", onLeave);
    return () => {
      document.removeEventListener("pointerover", onOver);
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("focusout", onFocusOut);
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("click", onClick);
      document.removeEventListener("mouseleave", onLeave);
    };
  }, []);

  return (
    <Popover.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) close();
      }}
    >
      {open &&
        hover &&
        card && (
          // Under the chip rather than beside it: the chip sits inline in a
          // paragraph, and a card off in the margin points at a word instead
          // of standing under it. Base UI flips it above when there is no room.
          <RowCardPopup
            anchor={hover.el}
            side="bottom"
            align="start"
            sideOffset={8}
          >
            <div
              {...{ [CARD_ATTR]: "" }}
              onMouseEnter={cancelTimers}
              onMouseLeave={scheduleClose}
            >
              {card.kind === "session" ? (
                <SessionCardBody session={card.session} />
              ) : card.kind === "commit" ? (
                <CommitChipCardBody commit={card.commit} />
              ) : (
                <PrChipCardBody pr={card.pr} />
              )}
            </div>
          </RowCardPopup>
        )}
    </Popover.Root>
  );
}

/**
 * The card body for a commit reference. Built from the same parts as the PR
 * card below, because the question is the same one: what is this, who wrote
 * it, and did it land. The subject line is what the transcript's sha was
 * standing in for all along, so it gets the weight; the message body follows
 * it, clamped, because a commit's real explanation is usually in there.
 */
function CommitChipCardBody({ commit }: { commit: CommitDetails }) {
  const rows: Array<[string, React.ReactNode]> = [];
  if (commit.author) rows.push(["Author", commit.author]);
  rows.push(["Repo", repoLabel(commit.repo)]);
  // The lede, unwrapped. A message body is hard-wrapped at 72 columns and
  // carries whole sections under it, and a clamp over that spends one of its
  // three lines on a blank line and the third on an ellipsis alone.
  const lede = commit.body
    ?.split(/\n\s*\n/, 1)[0]
    ?.replace(/\s+/g, " ")
    .trim();

  return (
    <>
      <div className="flex min-w-0 items-center gap-[7px]">
        <span className="min-w-0 flex-1 truncate text-meta text-dim">
          <span className="text-green">+{compactNum(commit.additions)}</span>{" "}
          <span className="text-red">-{compactNum(commit.deletions)}</span>
          {commit.filesChanged > 0 && (
            <span className="text-faint">
              {" "}
              · {commit.filesChanged}{" "}
              {commit.filesChanged === 1 ? "file" : "files"}
            </span>
          )}
        </span>
        <span className="flex shrink-0 items-center">
          <IconGitCommit className="text-dim" size={20} />
        </span>
      </div>

      <div className="mt-[5px] text-label font-semibold leading-[1.3]">
        {commit.title}
      </div>

      {lede && (
        <div className="mt-[3px] line-clamp-3 text-supporting leading-[1.4] text-dim">
          {lede}
        </div>
      )}

      {/* Whether it shipped, in the same slot the PR card puts its state. */}
      <div
        className={`mt-[3px] text-meta font-medium ${
          commit.onDefaultBranch ? "text-green" : "text-faint"
        }`}
      >
        {commit.onDefaultBranch
          ? `On ${commit.defaultBranch}`
          : `Not on ${commit.defaultBranch} yet`}
      </div>

      <CardRows rows={rows} />

      <CardFooter
        time={`Committed ${relativeTime(commit.committedAt)}`}
        timeTitle={new Date(commit.committedAt).toLocaleString()}
      >
        {commit.url && (
          <CardLink href={commit.url} title="Open on GitHub">
            <span className="font-mono text-[0.95em]">{commit.shortSha}</span>
          </CardLink>
        )}
      </CardFooter>
    </>
  );
}

/**
 * The card body for a PR mention. Same shape and wording as the Pull requests
 * row's card (SidebarRowCards), minus the review queue's bucket. A chip is a
 * reference to a PR, not a row in someone's queue, so the state line is the
 * one every PR surface derives (lib/pr-refs) and the session that opened it
 * takes the row the queue would have spent on why it is waiting.
 */
function PrChipCardBody({ pr }: { pr: ChipPr }) {
  const status = prStatusDisplay(pr);
  const tone = status.tone;
  const rows: Array<[string, React.ReactNode]> = [];
  if (pr.author) rows.push(["Author", pr.author]);
  rows.push(["Repo", repoLabel(pr.repo)]);
  if (pr.reviewDecision) rows.push(["Review", prettyReview(pr.reviewDecision)]);
  if (pr.osReview) rows.push(["OS review", osReviewLabel(pr.osReview)]);
  const checks = checksLabel(pr.checks);
  if (checks) rows.push(["Checks", checks]);
  if (pr.reviewRequested?.length)
    rows.push(["Requested", pr.reviewRequested.join(", ")]);
  if (pr.session) rows.push(["Session", pr.session.title]);
  if (pr.createdAt) rows.push(["Opened", relativeTime(pr.createdAt)]);

  return (
    <>
      {/* What changed, if we know it, and the branch it changed on when we
			    don't, which is the head the sidebar's PR and session cards carry. */}
      <div className="flex min-w-0 items-center gap-[7px]">
        <span className="min-w-0 flex-1 truncate text-meta text-dim">
          {pr.additions != null && pr.deletions != null ? (
            <>
              <span className="text-green">+{compactNum(pr.additions)}</span>{" "}
              <span className="text-red">-{compactNum(pr.deletions)}</span>
            </>
          ) : (
            pr.branch
          )}
        </span>
        {pr.isDraft && (
          <span className="shrink-0 text-meta text-faint">draft</span>
        )}
        <span className="flex shrink-0 items-center">
          {pr.state === "MERGED" ? (
            <IconGitMerge className="text-purple" size={20} />
          ) : (
            <IconPullRequest className={PR_STATE_TEXT[tone]} size={20} />
          )}
        </span>
      </div>

      <div className="mt-[5px] text-label font-semibold leading-[1.3]">
        {pr.title}
      </div>

      <div className={`mt-[3px] text-meta font-medium ${PR_STATE_TEXT[tone]}`}>
        {status.label}
      </div>

      <CardRows rows={rows} />

      <CardFooter
        time={pr.updatedAt ? `Updated ${relativeTime(pr.updatedAt)}` : ""}
        timeTitle={
          pr.updatedAt ? new Date(pr.updatedAt).toLocaleString() : undefined
        }
      >
        {pr.url && <CardPrChip url={pr.url} number={pr.number} tone={tone} />}
      </CardFooter>
    </>
  );
}
