import { repoLabel } from "../lib/repo-label";
import React, { useCallback, useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import type { PrDetails, WSClientMessage } from "../lib/types";
import {
  deriveHeadline,
  summarizeChecks,
  type PrHeadline,
} from "../lib/pr-headline";
import {
  refChipText,
  refLabel,
  refTone,
  summarizePrSeries,
  worstPrRef,
  type SessionPrRef,
} from "../lib/pr-refs";
import {
  archiveSessionApi,
  gitPullApi,
  gitPushApi,
  mergePrApi,
  mergePrStackApi,
} from "../lib/api";
import { stackLayersTopFirst, stackMergePlan } from "../lib/pr-stack";
import { PR_WEBHOOK_FALLBACK_POLL_MS } from "../lib/poll";
import {
  useSessionGitResource,
  useSessionPrResource,
  useSessionShipResource,
} from "../hooks/useApiResources";
import { getCurrentUser } from "./UserPicker";
import { isApple } from "../lib/platform";
import { sessionPrPresentation } from "../lib/session-prs";
import { errorMessage } from "../lib/error-message";
import {
  prChipClass,
  prChipExternalClass,
  PR_BAR,
  PR_BAR_BG,
  PR_BAR_CHECKING,
  PR_BAR_ERROR,
  PR_BAR_IN_CARD,
  PR_BAR_STACK,
  PR_BAR_STATE,
  PR_CHIP_SEAM,
  PR_HEAD,
  PR_HEAD_BTN,
  PR_HEAD_ERROR,
  PR_SIB_DOT,
  PR_SIB_DOT_BG,
  PR_BAR_STATE_TEXT,
  PR_STATE_TEXT,
  PR_SUMMARY_BAND_BG,
} from "../lib/pr-tone-classes";
// The summary variant renders into the workspace summary card, so it borrows
// that card's row grammar rather than inventing a third one. The strip owns
// the PR state machine; the card owns how a row in it looks.
import {
  WS_SUMMARY_BAND,
  WS_SUMMARY_BAND_PAD,
  WS_SUMMARY_LABEL,
  WS_SUMMARY_STATUS_ROW,
} from "../lib/workspace-summary-classes";
import { Tooltip } from "../ui/tooltip";
import { ContextMenu, Menu, MENU_ICON } from "../ui/menu";
import { TextShimmer } from "../ui/text-shimmer";
import { duration, ease } from "../ui/motion";
import { sendPrPrompt, usePromptPending } from "../lib/pr-prompt-pending";
import { Skeleton, SkeletonBar } from "../ui/state";
import { cn } from "../ui/cn";
import { useSessionPendingCreation } from "../hooks/useSessionPendingCreation";
import { useShortcutLabel } from "../hooks/useShortcutBindings";
import {
  useDeferredMergeDeadline,
  useDeferredMergePhase,
} from "../hooks/useDeferredMerge";
import {
  cancelDeferredMergeByKey,
  deferredMergeKey,
  mergeFailedMessage,
  scheduleDeferredMerge,
} from "../lib/deferred-merge";
import { toast } from "../ui/toast";
import { useConfirm } from "../ui/confirm";
import { prCapabilities, providerFromUrl } from "../lib/provider";
import {
  MERGE_CHOICE_LABEL,
  MERGE_CHOICE_SHORT,
  MERGE_CHOICE_TITLE,
  mergeChoices,
} from "../lib/merge-choices";
import { BrandMark } from "./BrandTile";
import { PrChecksPopover } from "./PrChecksPopover";
import { PrSeriesRows } from "./PrSeriesRows";
import { MergeUndoControl } from "./pr/MergeUndoControl";
import { PrStackChip } from "./pr/StackPopover";
import {
  IconArrowDown,
  IconArrowUp,
  IconArrowUpRight,
  IconPullRequest,
  IconRocket,
  IconGitMerge,
  IconCopy,
  IconHash,
  IconCheck,
  IconPlus,
  IconArchive,
  IconSparkle,
  IconChevronDown,
  IconWarningTriangle,
} from "./icons";

/**
 * Conductor-style status strip at the top of the right Workspace panel: the PR
 * number as a linked pill, one derived headline ("Ready to merge", "Merged",
 * "Checks running", "Ahead by 2 commits"…), and a single primary action on the
 * right (Merge / Push / Create PR / Archive).
 *
 * One departure from Conductor: sessions push automatically, so Push is a
 * fallback for stray local commits rather than the main flow, and "Create PR"
 * asks the session to do it (commit → push → PR with a real description)
 * instead of minting a bare PR from the header.
 */

export type { SessionPrRef } from "../lib/pr-refs";
// Re-exported so the strip stays the one import site for PR-ref presentation.
export { refTone } from "../lib/pr-refs";
export { summarizeChecks } from "../lib/pr-headline";

interface Props {
  sessionId: string;
  /** Primary repo id (for multi-repo sessions the header tracks the primary). */
  repo?: string;
  archived?: boolean;
  /**
   * Every PR this session spans (`session.prs`: primary branch + attached
   * repos + linked + footer-discovered). The headline and the primary action
   * stay on the primary branch's PR — that's the one this worktree can push,
   * pull and merge — while the rest ride along as chips, so a session that
   * shipped one feature as four PRs shows all four. No extra fetch: the refs
   * come enriched from the server's bulk PR cache.
   */
  prs?: SessionPrRef[];
  /** Prompt the session (Create PR / Resolve conflicts) — WS `prompt` message. */
  send?: (msg: WSClientMessage) => void;
  /** Clicking the headline jumps to the PR tab; a chip jumps to that PR. */
  onOpenPrTab?: (ref?: { repo: string; branch: string }) => void;
  /** Open a GitHub stack layer that is not one of this session's PR targets. */
  onOpenStackPr?: (repo: string, branch: string) => void;
  /** Open the primary PR directly on its Checks tab. */
  onOpenChecksTab?: () => void;
  /** Archive via the owning viewer so it can select the neighboring sidebar row. */
  onArchive?: () => void;
  /** Start a new session in this workspace (the tab strip's "+", as a labelled
	    button). Offered beside Archive once the PR has landed, so a merged
	    session is a fork in the road rather than a dead end: file it away, or
	    keep going in a fresh session. Left unset in the session header, which
	    carries its own "+". */
  onNewSession?: () => void;
  /**
   * - "bar" is the panel's own strip.
   * - "header" renders just the PR chip + primary action while the panel is
   *   closed.
   * - "summary" renders the primary PR and its action in the workspace
   *   summary card, followed by the other PRs in its stack. It is a variant
   *   rather than a copy because everything behind that action belongs to this
   *   component: headline derivation, the stack merge plan, deferred merge,
   *   the prompt-the-session paths, and busy state. A second implementation is
   *   a second thing that can be wrong about whether a merge is in flight.
   */
  variant?: "bar" | "header" | "summary";
  /** Optional element rendered inside the strip, left of the PR chip (bar
	    variant only) so it shares the strip's tone background — e.g. the globe
	    staging-deploy icon in the Workspace panel. */
  leading?: React.ReactNode;
  /**
   * Summary variant only: marks that belong to this PR but are not the strip's
   * to derive, rendered at the head of the status row before the state glyph.
   * Today that is the preview environment the PR deployed. It shares the row
   * because it shares the subject: one line for the state of the work and the
   * place to try it, not a tinted row with a loose link under it.
   *
   * The row is the band's only line, so anything passed here has to be a mark
   * rather than a labelled row. There is nowhere for a second label to go.
   */
  children?: React.ReactNode;
  /** Live run state — when it falls from running→idle the header refetches, so
	    it reflects the just-finished turn (and any auto-push) immediately. */
  running?: boolean;
  /** Bumped by the viewer on a `git_pushed` or matching `pr_updated` broadcast. */
  refreshTick?: number;
}

// The button is a Motion element (its width glides between labels), so the
// DOM drag and animation handlers, which Motion types differently, are not
// part of its surface. No caller passes them.
interface PrBarButtonProps extends Omit<
  React.ButtonHTMLAttributes<HTMLButtonElement>,
  | "onDrag"
  | "onDragStart"
  | "onDragEnd"
  | "onAnimationStart"
  | "onAnimationEnd"
  | "onAnimationIteration"
> {
  tone:
    | "green"
    | "purple"
    | "red"
    | "status-red"
    | "status-yellow"
    | "secondary"
    | "purple-dashed"
    | "solid";
  icon?: React.ReactNode;
  /** The session is carrying this action out: the glyph drops away and the
   *  label shimmers until the work is done. The shimmer alone says it is
   *  under way, so there is no spinner and no trailing ellipsis. */
  working?: boolean;
}

/** The label and glyph crossfade with a short rise, while the button's width
 *  glides to the new label's (a Motion layout animation on the button), so
 *  "Fix checks" turning into "Fixing" reads as one control changing its mind
 *  rather than a second button replacing it. */
const SWAP_MOTION = {
  initial: { opacity: 0, y: 5, filter: "blur(2px)" },
  animate: { opacity: 1, y: 0, filter: "blur(0px)" },
  // The old label clears out faster than the new one settles, so the two
  // never sit on top of each other long enough to read as a smear.
  exit: {
    opacity: 0,
    y: -5,
    filter: "blur(2px)",
    transition: { type: "tween", duration: duration.micro * 0.7, ease },
  },
  transition: { type: "tween", duration: duration.base, ease },
} as const;
const LAYOUT_TRANSITION = {
  layout: { type: "spring", duration: duration.large, bounce: 0 },
} as const;

function PrBarButton({
  tone,
  icon,
  working = false,
  className = "",
  children,
  ...props
}: PrBarButtonProps) {
  const glyph = working ? null : icon;
  // The label crossfades and the width glides when the work starts or ends.
  // Any other change of label (Merge to Merging…) is the same control, and
  // the strip moving around it is not this button's to animate, so the layout
  // animation runs on this and nothing else.
  const phase = working ? "working" : "idle";
  const tones = {
    green:
      "bg-[var(--green)] border-[color-mix(in_srgb,var(--green)_78%,black)] text-white",
    purple:
      "bg-[var(--purple)] border-[color-mix(in_srgb,var(--purple)_78%,black)] text-white",
    // The fix on a red band (Resolve, Fix checks). Like the card pill below,
    // it takes no shadow: on the tinted band a grey shadow only smudges.
    red: "bg-[var(--red)] border-[color-mix(in_srgb,var(--red)_78%,black)] text-white shadow-none",
    // The fix for a review state (Address feedback): red ink on the
    // card's own surface, so it reads as a clean cut-out of the tinted band
    // rather than a second, darker tint of the same pink. The hairline is
    // enough lift: a grey shadow on the pink band only reads as a smudge.
    "status-red":
      "border-line bg-popup text-red shadow-none hover:bg-[color-mix(in_srgb,var(--red)_6%,var(--popup-surface))] hover:brightness-100",
    "status-yellow":
      "border-[color-mix(in_srgb,var(--yellow)_35%,transparent)] bg-[color-mix(in_srgb,var(--yellow)_10%,var(--control-surface))] text-yellow hover:bg-[color-mix(in_srgb,var(--yellow)_16%,var(--control-surface))] hover:brightness-100",
    solid:
      "bg-[var(--text)] text-[var(--bg)] border-[color-mix(in_srgb,var(--text)_84%,transparent)]",
    // The neutral action (Ship, Create PR, Unarchive). The grey fill and the
    // hairline already say "press me" against the strip, so it takes no
    // shadow and no strong edge: stacked on the fill, those two only smudged
    // its bottom edge.
    secondary:
      "bg-raised text-fg border-line shadow-none hover:bg-hover hover:brightness-100",
    // The open outline beside a filled button: purple ink on the strip's own
    // band, dashed, so it reads as the road not yet taken next to the solid
    // action. Nothing to fill and nothing to lift, so it drops the shadow.
    "purple-dashed":
      "border-dashed border-[color-mix(in_srgb,var(--purple)_45%,transparent)] bg-transparent text-purple shadow-none hover:bg-[color-mix(in_srgb,var(--purple)_10%,transparent)] hover:brightness-100",
  } as const;
  return (
    <motion.button
      type="button"
      layout
      layoutDependency={phase}
      transition={LAYOUT_TRANSITION}
      className={cn(
        "inline-flex min-h-[30px] items-center justify-center gap-1.5 rounded-full border px-3 py-[5px] text-label leading-none font-semibold whitespace-nowrap smooth-shadow-sm transition-[background-color,border-color,color,filter,transform] duration-micro ease-standard hover:brightness-[1.08] active:scale-press-plate active:brightness-[0.98] focus-visible:outline-2 focus-visible:outline-[var(--accent-ink)] focus-visible:outline-offset-2 disabled:cursor-default disabled:opacity-60 disabled:shadow-none",
        tones[tone],
        // A leading glyph carries its own margin: the icon set draws in a
        // 4.75–19.25 span of a 24 grid, so an 18px box holds ~3.5px of
        // empty on each side. Equal padding therefore lands the ink 3.5px
        // deeper on the left than the label sits from the right edge, and
        // the pair reads as pushed. Pay the padding back on the icon side,
        // and close the inner gap so the two read as one group rather than
        // two things. Icon-only callers override px themselves, so this
        // never lands on a lone glyph.
        glyph && "gap-1 pl-[6.5px]",
        // Pressed is still the state, not "unavailable": the shimmer says it
        // is in hand, so it keeps its full colour.
        working && "disabled:opacity-100",
        className,
      )}
      aria-busy={working || undefined}
      {...props}
    >
      {glyph && (
        <motion.span
          layout
          layoutDependency={phase}
          transition={LAYOUT_TRANSITION}
          className="relative inline-flex size-[18px] shrink-0 items-center justify-center [&_svg]:block [&_svg]:stroke-[1.7]"
        >
          <AnimatePresence initial={false} mode="popLayout">
            <motion.span
              key={phase}
              className="inline-flex items-center justify-center"
              {...SWAP_MOTION}
            >
              {glyph}
            </motion.span>
          </AnimatePresence>
        </motion.span>
      )}
      {/* Centered on the cap band, not on the em box: `text-box` trims the
			    line box down to cap height and baseline, so the flex centering
			    lands the ink itself in the middle of the button and beside the
			    icon, whatever font the platform picks. Browsers without
			    `text-box` (Firefox) center the em box, which lands within a pixel
			    of it.

			    No nudge on top of that: a half pixel down was once added by eye,
			    but measured, it left the word 0.6px under centre and beside a
			    glyph that sits centred, so it read as low. An icon-only button
			    has no label: an empty span would
			    still take the flex gap and push the glyph off center. */}
      {children != null && (
        <motion.span
          layout
          layoutDependency={phase}
          transition={LAYOUT_TRANSITION}
          className="relative inline-flex"
        >
          <AnimatePresence initial={false} mode="popLayout">
            <motion.span
              key={phase}
              className="inline-block [text-box:trim-both_cap_alphabetic]"
              {...SWAP_MOTION}
            >
              {children}
            </motion.span>
          </AnimatePresence>
        </motion.span>
      )}
    </motion.button>
  );
}

// The open-PR chord's handler lives in SessionViewer; the chip only
// advertises whatever it is bound to.

/**
 * The rows every right-click menu about a pull request offers: open it where it
 * lives, and take its link or its number away with you. Written once because
 * two surfaces carry the same menu: the strip's `#1234` chip and the summary
 * card's PR band. A copy action that says "Copied" in one place and
 * nothing in the other is two implementations of one gesture.
 *
 * The rows keep the popup open after a copy (`closeOnClick={false}`) so the
 * checkmark is visible where it was clicked, which is the whole confirmation.
 */
function PrCopyItems({ pr }: { pr: PrDetails }) {
  const [copied, setCopied] = useState<"link" | "number" | null>(null);
  const provider = providerFromUrl(pr.url);
  const openChord = useShortcutLabel("open-pr");
  const copyChord = useShortcutLabel("pr-copy-link");

  const copy = (kind: "link" | "number", text: string) => {
    navigator.clipboard?.writeText(text).then(() => {
      setCopied(kind);
      setTimeout(() => setCopied(null), 1500);
    });
  };

  return (
    <>
      <ContextMenu.Item
        render={
          <a
            href={pr.url}
            target="_blank"
            rel="noopener"
            className="no-underline"
          />
        }
      >
        <IconArrowUpRight size={20} className={MENU_ICON} />
        <span className="grow">Open on {provider.name}</span>
        {openChord && <ContextMenu.Shortcut>{openChord}</ContextMenu.Shortcut>}
      </ContextMenu.Item>
      <ContextMenu.Item
        closeOnClick={false}
        onClick={() => copy("link", pr.url)}
      >
        {copied === "link" ? (
          <IconCheck size={20} className="text-green" />
        ) : (
          <IconCopy size={20} className={MENU_ICON} />
        )}
        <span className="grow">
          {copied === "link" ? "Copied" : "Copy link"}
        </span>
        {copyChord && <ContextMenu.Shortcut>{copyChord}</ContextMenu.Shortcut>}
      </ContextMenu.Item>
      <ContextMenu.Item
        closeOnClick={false}
        onClick={() => copy("number", `#${pr.number}`)}
      >
        {copied === "number" ? (
          <IconCheck size={20} className="text-green" />
        ) : (
          <IconHash size={20} className={MENU_ICON} />
        )}
        <span className="grow">
          {copied === "number" ? "Copied" : "Copy number"}
        </span>
      </ContextMenu.Item>
    </>
  );
}

/**
 * The PR chip links to Open Session's review by default. GitHub remains a
 * separate outbound action, while the context menu holds copy actions.
 */
function PrNumberChip({
  pr,
  tone,
  size,
  onOpenPrTab,
}: {
  pr: PrDetails;
  tone: PrHeadline["tone"];
  /** The strip and the session header size the pair differently. */
  size: "bar" | "head";
  onOpenPrTab?: () => void;
}) {
  const provider = providerFromUrl(pr.url);
  const prChord = useShortcutLabel("open-pr");

  return (
    <div className="inline-flex items-center">
      <ContextMenu.Root>
        <ContextMenu.Trigger
          render={
            <button
              type="button"
              className={`${prChipClass(tone, size)} ${PR_CHIP_SEAM}`}
              onClick={onOpenPrTab}
              title={`Review #${pr.number}: ${pr.title}`}
            />
          }
        >
          {/* Cap band plus the same half pixel as the action button beside
					    it, so the pair reads level. */}
          <span className="translate-y-[0.5px] [text-box:trim-both_cap_alphabetic]">
            #{pr.number}
          </span>
        </ContextMenu.Trigger>
        <ContextMenu.Popup>
          <PrCopyItems pr={pr} />
        </ContextMenu.Popup>
      </ContextMenu.Root>
      <Tooltip
        label={
          prChord
            ? `Open on ${provider.name} (${prChord})`
            : `Open on ${provider.name}`
        }
      >
        <a
          className={`${prChipExternalClass(tone, size)} ${PR_CHIP_SEAM}`}
          href={pr.url}
          target="_blank"
          rel="noopener"
          aria-label={`Open pull request #${pr.number} on ${provider.name}`}
        >
          <IconArrowUpRight size={20} />
        </a>
      </Tooltip>
    </div>
  );
}

/**
 * The session's other PRs, as compact tone-coloured chips after the primary
 * one. Their tone IS the aggregate signal — a red #72 beside a green "Ready to
 * merge" reads at a glance — and clicking one opens it in the Review tab, which
 * is where per-PR review and merge belong. Past `maxInline` (0 in the session
 * header, where there's no room) they collapse into a `+N` menu.
 */
function PrRefChips({
  refs,
  maxInline,
  primaryRepo,
  onOpen,
}: {
  refs: SessionPrRef[];
  maxInline: number;
  primaryRepo?: string;
  onOpen?: (ref: { repo: string; branch: string }) => void;
}) {
  if (refs.length === 0) return null;
  const inline = refs.slice(0, maxInline);
  const rest = refs.slice(maxInline);
  // The overflow chip carries the worst tone in the hidden set, so a failing
  // PR still shows red even while collapsed.
  const restTone = rest.some((r) => refTone(r) === "red")
    ? "red"
    : rest.some((r) => refTone(r) === "yellow")
      ? "yellow"
      : rest.every((r) => r.state === "MERGED")
        ? "purple"
        : rest.some((r) => refTone(r) === "green")
          ? "green"
          : "muted";
  return (
    <div className="inline-flex min-w-0 items-center gap-1">
      {inline.map((ref) => (
        <Tooltip key={`${ref.repo} ${ref.branch}`} label={refLabel(ref)}>
          <button
            type="button"
            className={prChipClass(refTone(ref), "sib")}
            onClick={() => onOpen?.(ref)}
          >
            {refChipText(ref, primaryRepo)}
          </button>
        </Tooltip>
      ))}
      {rest.length > 0 && (
        <Menu.Root>
          <Menu.Trigger
            render={
              <button
                type="button"
                className={prChipClass(restTone, "sib")}
                aria-label={`${rest.length} more pull request${rest.length === 1 ? "" : "s"}`}
              />
            }
          >
            +{rest.length}
          </Menu.Trigger>
          <Menu.Popup>
            {rest.map((ref) => (
              <Menu.Item
                key={`${ref.repo} ${ref.branch}`}
                onClick={() => onOpen?.(ref)}
              >
                <span
                  className={`${PR_SIB_DOT} ${PR_SIB_DOT_BG[refTone(ref)]}`}
                />
                <span className="grow">
                  {repoLabel(ref.repo)} #{ref.number}
                </span>
              </Menu.Item>
            ))}
          </Menu.Popup>
        </Menu.Root>
      )}
    </div>
  );
}

export function PrStatusBar({
  sessionId,
  repo,
  archived,
  prs,
  send,
  onOpenPrTab,
  onOpenStackPr,
  onOpenChecksTab,
  onArchive,
  onNewSession,
  variant = "bar",
  leading,
  children,
  running,
  refreshTick,
}: Props) {
  const presentation = sessionPrPresentation(prs);
  // A tab with no PR of its own can receive several workspace PRs from sibling
  // sessions. Pick one of those explicitly rather than falling through to this
  // tab's unrelated branch, which made the workspace summary say “Create PR”.
  const presented = presentation.primary ?? worstPrRef(presentation.additional);
  const promoted = presented?.source !== "primary" ? presented : undefined;
  const targetRepo = promoted?.repo || repo;
  const targetBranch = promoted?.branch;
  // A new tab's id is unknown to the server until its create lands. Asking
  // earlier caches a 404 that reads as "Session not found" in the card.
  const pendingCreation = useSessionPendingCreation();
  const prResource = useSessionPrResource(sessionId, targetRepo, targetBranch, {
    enabled: !pendingCreation,
    refreshInterval: PR_WEBHOOK_FALLBACK_POLL_MS,
  });
  const gitResource = useSessionGitResource(sessionId, repo, {
    enabled: !promoted && !pendingCreation,
    refreshInterval: PR_WEBHOOK_FALLBACK_POLL_MS,
  });
  const pr = prResource.data ?? null;
  const git = gitResource.data ?? null;
  // Only the no-PR action depends on how the session ships: Create PR, or
  // Ship straight to the default branch (ship-mode.ts on the server).
  const shipResource = useSessionShipResource(sessionId, {
    enabled: !pendingCreation && !promoted && !prResource.isLoading && !pr,
    revision: refreshTick ?? null,
  });
  const ship = shipResource.data?.available ? shipResource.data : null;
  const directShip =
    ship?.mode === "direct" && ship.checkout === "worktree"
      ? ship.buttons.find((button) => button.primary)
      : undefined;
  // A failed PR read and a branch with no PR both land here as a null `pr`.
  // Keep them apart: only the second one may claim "No PR open" and offer to
  // create one. SWR keeps the last good value, so this is only true when there
  // is nothing to show at all.
  const prUnavailable = Boolean(prResource.error) && !prResource.data;
  const prLoadError = prUnavailable
    ? errorMessage(prResource.error, "Couldn’t load pull request.")
    : null;
  const { mutate: reloadPr } = prResource;
  const { mutate: reloadGit } = gitResource;
  const mergeKey = deferredMergeKey(pr?.url);
  const mergePhase = useDeferredMergePhase(mergeKey);
  const mergeDeadline = useDeferredMergeDeadline(mergeKey);
  const loaded =
    !pendingCreation &&
    !prResource.isLoading &&
    (Boolean(promoted) || !gitResource.isLoading);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isArchived, setIsArchived] = useState(!!archived);
  const [confirmForce, forceConfirmation] = useConfirm();

  useEffect(() => setIsArchived(!!archived), [archived]);

  // SWR's mutate is stable, so the refetch effects below can list `load`
  // without re-arming on every render.
  const hasPromoted = promoted != null;
  const load = useCallback(async () => {
    await Promise.all([
      reloadPr(),
      hasPromoted ? Promise.resolve() : reloadGit(),
    ]);
  }, [reloadPr, reloadGit, hasPromoted]);

  // Refetch the instant a turn ends (running→idle) or an auto-push lands
  // (refreshTick bump), so "Ahead by N commits" clears without waiting on a
  // webhook or fallback poll. Skip initial mount/true edges: load() above covers
  // those. Track the previous run state so only the falling edge
  // triggers (a turn *starting* can't change the pushed/ahead state).
  const prevRunning = React.useRef(running);
  useEffect(() => {
    const fell = prevRunning.current && !running;
    prevRunning.current = running;
    if (fell) load();
  }, [running, load]);
  useEffect(() => {
    if (refreshTick) load();
  }, [refreshTick, load]);

  const headline = deriveHeadline(pr, git, prUnavailable);

  // "Fixing" lasts as long as the prompt the press sent: through the queue
  // and its own turn (lib/pr-prompt-pending). Once the PR leaves the state the
  // action was for, the strip has moved on whatever the session is doing.
  const promptKey = `${sessionId}\u0000${pr?.url ?? targetRepo ?? ""}`;
  const pendingPrompt = usePromptPending(promptKey);
  const prompted =
    pendingPrompt?.headline === headline.key ? pendingPrompt : undefined;

  // Everything except the primary branch's PR (which the headline covers):
  // attached repos, manual links, and PRs discovered through their body
  // footer. Numberless refs are branches with no PR yet — nothing to chip.
  const siblings = presentation.additional;
  // A real GitHub stack is returned with the primary PR detail rather than in
  // session.prs. Expand its other layers into the same compact rows used by a
  // multi-repo series, preferring enriched session refs when both sources know
  // the layer (those refs include check counts and review state).
  const stackRows: SessionPrRef[] =
    pr?.stack && targetRepo
      ? stackLayersTopFirst(pr.stack)
          .filter((layer) => !layer.current)
          .map(
            (layer) =>
              siblings.find(
                (ref) => ref.repo === targetRepo && ref.number === layer.number,
              ) || {
                repo: targetRepo,
                branch: layer.headRefName,
                source: "discovered" as const,
                number: layer.number,
                url: layer.url,
                title: layer.title,
                state: layer.state,
                isDraft: layer.isDraft,
              },
          )
      : [];
  const stackNumbers = new Set(stackRows.map((ref) => ref.number));
  const stackTargets = new Set(
    stackRows.map((ref) => `${ref.repo}\0${ref.branch}`),
  );
  const openStatusRow = (ref: { repo: string; branch: string }) => {
    if (onOpenStackPr && stackTargets.has(`${ref.repo}\0${ref.branch}`)) {
      onOpenStackPr(ref.repo, ref.branch);
      return;
    }
    onOpenPrTab?.(ref);
  };
  const statusRows = [
    ...stackRows,
    ...siblings.filter(
      (ref) => ref.repo !== targetRepo || !stackNumbers.has(ref.number),
    ),
  ];
  // Slack/Linear sessions carry no explicit `repo` — fall back to the primary
  // ref's, so cross-repo chips still get their repo hint.
  const primaryRepoId =
    targetRepo || (prs || []).find((r) => r.source === "primary")?.repo;
  const openSiblings = statusRows.filter(
    (r) => r.state !== "MERGED" && r.state !== "CLOSED",
  ).length;
  // A feature shipped as N PRs is only done when they've all landed — so the
  // merged headline counts the series, and Archive waits for the last one.
  const seriesAllMerged =
    statusRows.length > 0 && statusRows.every((r) => r.state === "MERGED");
  // Nothing on this session's own branch, but it owns PRs elsewhere: "No PR
  // open" would be a lie with three rows sitting under it, and a bare count in
  // the neutral tone hides a failing PR one row down — so the strip borrows the
  // series' own worst tone and says how much of it is still open.
  const series = !pr ? summarizePrSeries(siblings) : null;
  const headlineTone = series ? series.tone : headline.tone;
  const headlineLabel =
    headline.key === "merged" && statusRows.length > 0
      ? seriesAllMerged
        ? `All ${statusRows.length + 1} merged`
        : `Merged · ${openSiblings} of ${statusRows.length + 1} open`
      : series
        ? series.label
        : headline.label;

  // An OPEN PR with checks keeps the headline as the checks control. The
  // headline still reports the most important state, while hover previews every
  // check and click opens Review's Checks tab.
  //
  // Once the PR has landed or been closed, its checks are history: they cannot
  // change, nobody is waiting on them, and "4 checks" in green beside Merged
  // reads as live state that still needs watching. So a settled PR drops the
  // count and goes back to opening its own tab.
  const checksSummary = summarizeChecks(pr);
  const prSettled = pr?.state === "MERGED" || pr?.state === "CLOSED";
  const checksPr = pr && !prSettled && checksSummary.total > 0 ? pr : null;
  const checksTone =
    checksSummary.failed > 0
      ? "text-red"
      : checksSummary.pending > 0
        ? "text-yellow"
        : checksSummary.passed > 0
          ? "text-green"
          : "text-faint";
  const checksLabel = `${checksSummary.total} check${checksSummary.total === 1 ? "" : "s"}`;
  // "2 checks failed" and "3 checks pending…" already give the count that
  // matters, so a total beside them would only say "checks" twice.
  const headlineCountsChecks =
    headline.key === "failing" || headline.key === "running";

  async function run<Result>(name: string, fn: () => Promise<Result>) {
    if (busy) return;
    setBusy(name);
    setError(null);
    await (async () => {
      await fn();
      await load();
    })()
      .catch(async (error) => {
        setError(errorMessage(error, `${name} failed`));
      })
      .finally(async () => {
        setBusy(null);
      });
  }

  // Merging a stack layer means merging everything under it — GitHub takes the
  // whole set atomically, and a single-PR merge of a layer with open layers
  // below it is refused outright. So the action follows the stack whenever
  // there is more than one layer to take, and stays a plain merge otherwise
  // (a bottom layer, or one whose lower layers have already landed).
  const stackPlan = stackMergePlan(pr);
  const stackMerge =
    stackPlan && stackPlan.layers.length > 1 && !stackPlan.blockedBy
      ? stackPlan
      : null;

  function handleMerge() {
    if (!mergeKey || busy) return;
    if (mergePhase === "scheduled") {
      cancelDeferredMergeByKey(mergeKey);
      return;
    }
    if (mergePhase !== "idle") return;
    // Two branches rather than one conditional expression: the two calls
    // resolve to differently shaped results, and inferring `run`'s type
    // parameter from that union depends on check order (the Vercel build
    // rejected it while a fresh `tsc` accepted it).
    const prNumber = pr?.number;
    scheduleDeferredMerge(mergeKey, async () => {
      await run("merge", async () => {
        try {
          if (stackMerge) {
            await mergePrStackApi(
              sessionId,
              "squash",
              targetRepo,
              targetBranch,
            );
          } else {
            await mergePrApi(sessionId, "squash", targetRepo, targetBranch);
          }
        } catch (error) {
          // This strip may be gone by now (another session or workspace), so
          // the failure also goes to a toast that outlives it.
          toast(
            mergeFailedMessage(prNumber, errorMessage(error, "unknown error")),
            { variant: "error" },
          );
          throw error;
        }
      });
    });
  }

  // Branch protection holds the merge: let the host land it once the rules
  // pass, or go around them with the viewer's own rights. Auto-merge is a host
  // setting the person can turn off again, so it takes no confirm.
  function handleAutoMerge() {
    const prNumber = pr?.number;
    void run("auto-merge", async () => {
      const result = await mergePrApi(
        sessionId,
        "squash",
        targetRepo,
        targetBranch,
        { mode: "auto" },
      );
      toast(
        result.merged
          ? `Merged #${prNumber}`
          : `#${prNumber} will merge when ready`,
      );
    });
  }

  function handleForceMerge(bypasses: string[]) {
    if (!pr || !mergeKey || busy || mergePhase !== "idle") return;
    const { number: prNumber, headRefOid: headSha } = pr;
    const host = providerFromUrl(pr.url)?.name ?? "host";
    confirmForce({
      title: `Force merge #${prNumber}?`,
      description: `Squash into ${pr.baseRefName} now${bypasses.length ? `, skipping ${bypasses.join(", ")}` : ""}, using your ${host} permissions.`,
      confirmLabel: "Force merge",
      destructive: true,
      onConfirm: () =>
        scheduleDeferredMerge(mergeKey, async () => {
          await run("merge", async () => {
            try {
              await mergePrApi(sessionId, "squash", targetRepo, targetBranch, {
                mode: "admin",
                headSha,
              });
            } catch (error) {
              toast(
                mergeFailedMessage(
                  prNumber,
                  errorMessage(error, "unknown error"),
                ),
                { variant: "error" },
              );
              throw error;
            }
          });
        }),
    });
  }

  // Session-driven actions: ask the agent instead of doing bare git plumbing —
  // a session-authored PR gets a real title/description, and conflict
  // resolution needs judgment, not a button.
  function promptSession(label: string, content: string) {
    if (!send) return;
    sendPrPrompt(send, {
      key: promptKey,
      sessionId,
      user: getCurrentUser(),
      label,
      headline: headline.key,
      content,
    });
  }

  // The strip is where this branch stands against the remote and the base: the
  // PR, or failing that the commits still to push or pull. So it stands down
  // for the two states that hold neither.
  //
  //  - Clean: level with the upstream, the base and the working tree. One
  //    muted "Up to date" over a link to an empty PR tab.
  // Shared-checkout sessions stay on main by default. Their optional branch
  // move lives in the session's overflow menu rather than this status card.
  const noPr = !pr && statusRows.length === 0;
  const empty =
    noPr &&
    (headline.key === "clean" ||
      (!!git?.sharedCheckout && headline.key === "no-pr"));

  // The strip still holds its place while the PR fetch runs (Kent: a topbar
  // that blinks in and out of existence shouldn't exist), so a session that
  // has a PR doesn't pop the bar in a GitHub round-trip late. Only when the
  // session's refs already say a PR is coming, though: reserving the row for a
  // session that turns out to have nothing is the same blink, pointed the
  // other way.
  if (!loaded) {
    if (variant === "summary")
      // No tone to paint yet, so the band holds its shape without a fill
      // rather than guessing a colour it may have to take back.
      return (
        <div className={WS_SUMMARY_BAND}>
          <Skeleton label="Loading PR status">
            <div className={WS_SUMMARY_STATUS_ROW}>
              <SkeletonBar className="size-4 shrink-0 rounded-full" />
              <SkeletonBar className="w-[58%]" />
            </div>
          </Skeleton>
          {children}
        </div>
      );
    if (variant === "header" || !(prs || []).some((ref) => ref.number))
      return null;
    return (
      <div
        className={`pr-bar wco-chrome ${PR_BAR} ${PR_BAR_BG.muted} ${PR_BAR_IN_CARD}`}
      >
        {leading}
        <span className={`pr-bar-checking ${PR_BAR_CHECKING}`}>
          Checking status…
        </span>
      </div>
    );
  }
  if (empty) return null;

  // Header mode: only once a PR exists — the chip is the anchor; a bare
  // Create PR/Push button in the chrome would just be noise. A session whose
  // PRs all live elsewhere (nothing on its own branch) still gets its chips.
  if (variant === "header" && !pr && siblings.length === 0) return null;

  // Primary action for the current headline (right side of the strip). In the
  // session header it sizes up to the header's other bordered controls, so the
  // chip and the action read as a matched pair.
  // The summary card's band is one line, so its action is a small pill: at
  // the strip's 30px it set the band's height on its own.
  const actionBtn =
    variant === "header"
      ? PR_HEAD_BTN
      : variant === "summary"
        ? "min-h-6 py-0 pr-2.5 text-meta"
        : "";
  function withMergeUndo(button: React.ReactNode) {
    if (mergePhase !== "scheduled") return button;
    return (
      <span className="inline-flex shrink-0 items-center gap-1">
        <MergeUndoControl
          className={
            variant === "header"
              ? undefined
              : variant === "summary"
                ? "min-h-6"
                : "min-h-[30px]"
          }
          deadline={mergeDeadline}
          onUndo={handleMerge}
        />
        {button}
      </span>
    );
  }
  function renderAction(): React.ReactNode {
    return (
      <>
        {renderActionButton()}
        {forceConfirmation}
      </>
    );
  }
  // Fix checks leads with the sparkle, which reaches nearer its box's edge
  // than the glyph padding allows for, so on the card the label sat 1.6px
  // left of centre, and on the header's even padding as far right. These
  // pads leave equal room either side of the ink.
  const fixPad =
    variant === "header" ? "pl-[13px] pr-[15px]" : "pl-[8px] pr-[10.5px]";
  function renderActionButton(): React.ReactNode {
    if (prompted) {
      const tone: PrBarButtonProps["tone"] =
        headline.key === "conflicts" || headline.key === "failing"
          ? "red"
          : headline.key === "no-pr"
            ? "secondary"
            : "status-red";
      return (
        <PrBarButton className={actionBtn} tone={tone} working disabled>
          <TextShimmer
            className={
              tone === "red"
                ? "text-[color-mix(in_srgb,white_70%,var(--red))] [--text-shimmer-highlight:white]"
                : "[--text-shimmer-highlight:var(--text)]"
            }
          >
            {prompted.label}
          </TextShimmer>
        </PrBarButton>
      );
    }
    switch (headline.key) {
      case "merged": {
        // Landed work is a fork in the road: file the session away, or keep
        // going in a fresh one. Don't offer to archive a session that still
        // has open PRs in its series just because the primary one landed.
        // The new session stands either way, since the branch is behind it.
        const canArchive = !isArchived && openSiblings === 0;
        if (!onNewSession && !canArchive && !isArchived) return null;
        return (
          <div className="flex items-center gap-2">
            {onNewSession && (
              <PrBarButton
                className={cn(
                  actionBtn,
                  "@max-[440px]:px-1.5 @max-[440px]:gap-0",
                )}
                // The open outline: carrying the work on is the choice
                // beside the filed-away one, not the same weight as it.
                tone="purple-dashed"
                icon={<IconPlus size={20} />}
                onClick={onNewSession}
                title="Start a new session in this workspace"
                aria-label="Continue"
              >
                {/* The label is the first thing to go on a narrow panel: the
								    headline beside it is what the strip exists to say. */}
                <span className="@max-[440px]:hidden">Continue</span>
              </PrBarButton>
            )}
            {isArchived ? (
              <Tooltip label="Unarchive session" side="bottom">
                <PrBarButton
                  className={actionBtn}
                  tone="secondary"
                  icon={<IconArchive size={20} />}
                  aria-label="Unarchive session"
                  disabled={!!busy}
                  onClick={() =>
                    run("unarchive", async () => {
                      if (onArchive) onArchive();
                      else await archiveSessionApi(sessionId, false);
                      setIsArchived(false);
                    })
                  }
                >
                  {busy === "unarchive" ? "Unarchiving…" : "Archived"}
                </PrBarButton>
              </Tooltip>
            ) : canArchive ? (
              <PrBarButton
                className={actionBtn}
                // The merged strip's own purple, filled: archiving is what
                // a landed PR is for, and the band around it already says
                // purple, so the button is that colour rather than a neutral.
                tone="purple"
                icon={<IconArchive size={20} />}
                disabled={!!busy}
                onClick={() =>
                  run("archive", async () => {
                    if (onArchive) onArchive();
                    else await archiveSessionApi(sessionId, true);
                    setIsArchived(true);
                  })
                }
              >
                {busy === "archive" ? "Archiving…" : "Archive"}
              </PrBarButton>
            ) : null}
          </div>
        );
      }
      case "ahead":
        return (
          <PrBarButton
            className={actionBtn}
            tone="solid"
            icon={<IconArrowUp size={20} />}
            disabled={!!busy}
            onClick={() => run("push", () => gitPushApi(sessionId, repo))}
          >
            {busy === "push" ? "Pushing…" : "Push"}
          </PrBarButton>
        );
      case "behind":
      case "behind-base":
        return (
          <PrBarButton
            className={actionBtn}
            tone="solid"
            icon={<IconArrowDown size={20} />}
            disabled={!!busy}
            title={
              headline.key === "behind-base"
                ? `Merge the latest origin/${git?.baseBranch || "main"}`
                : "Fast-forward to the branch's upstream"
            }
            onClick={() =>
              run("pull", () =>
                gitPullApi(sessionId, repo, headline.key === "behind-base"),
              )
            }
          >
            {busy === "pull" ? "Pulling…" : "Pull"}
          </PrBarButton>
        );
      case "conflicts":
        return send ? (
          <PrBarButton
            className={actionBtn}
            tone="red"
            onClick={() =>
              promptSession(
                "Resolving",
                `The PR has merge conflicts with ${pr?.baseRefName || git?.baseBranch || "main"}. Rebase this branch on the latest origin/${pr?.baseRefName || git?.baseBranch || "main"}, resolve the conflicts, and push.`,
              )
            }
          >
            Resolve
          </PrBarButton>
        ) : null;
      // "N checks pending…" / "N checks failed" IS the affordance: hovering the
      // headline shows the checks, clicking it opens Review's Checks tab. A
      // View checks button beside it would be the same action twice.
      case "running":
        return null;
      case "failing":
        return send ? (
          <PrBarButton
            className={cn(actionBtn, fixPad)}
            tone="red"
            icon={<IconSparkle size={20} />}
            onClick={() =>
              promptSession(
                "Fixing",
                `Investigate the failing checks on PR #${pr?.number}, fix the failures, run the relevant tests, commit the changes, and push them.`,
              )
            }
          >
            Fix checks
          </PrBarButton>
        ) : null;
      case "changes-requested":
        return send ? (
          <PrBarButton
            className={actionBtn}
            tone="status-red"
            onClick={() =>
              promptSession(
                "Addressing feedback",
                `Address the requested changes on PR #${pr?.number}, run the relevant tests, commit the changes, and push them.`,
              )
            }
          >
            Address feedback
          </PrBarButton>
        ) : null;
      // The PR read failed, so the one thing not to offer is Create PR — the
      // branch may well have a PR already. Retry is the only honest action.
      case "unavailable":
        return (
          <PrBarButton
            className={actionBtn}
            tone="status-yellow"
            onClick={() => void reloadPr()}
          >
            Retry
          </PrBarButton>
        );
      case "no-pr":
        if (!send) return null;
        if (directShip)
          return (
            <PrBarButton
              className={actionBtn}
              tone="secondary"
              icon={<IconRocket size={20} />}
              title={`Push to ${ship?.target ?? "the default branch"} after the checks pass`}
              onClick={() => promptSession("Shipping", directShip.prompt)}
            >
              Ship
            </PrBarButton>
          );
        return (
          <PrBarButton
            className={actionBtn}
            tone="secondary"
            icon={<IconPullRequest size={20} />}
            onClick={() =>
              promptSession(
                "Creating PR",
                "Commit any remaining work, push the branch, and open a PR for it.",
              )
            }
          >
            Create PR
          </PrBarButton>
        );
      case "ready": {
        const mergeScheduled = mergePhase === "scheduled";
        // The five-second window already reads as merging: the button holds
        // its place and label, and the undo glyph lands in front of it so
        // nothing the user just pressed moves.
        const merging =
          mergeScheduled || mergePhase === "running" || busy === "merge";
        const mergeButton = (
          <PrBarButton
            className={actionBtn}
            tone="green"
            icon={!merging ? <IconGitMerge size={20} /> : undefined}
            disabled={!!busy || merging}
            onClick={handleMerge}
            title={
              stackMerge
                ? `Squash and merge ${stackMerge.layers
                    .map((l) => `#${l.number}`)
                    .join(
                      ", ",
                    )} into ${pr?.stack?.baseRefName || "the base branch"}, all or nothing`
                : "Squash and merge this PR into its base branch"
            }
          >
            {merging
              ? stackMerge
                ? "Merging stack…"
                : "Merging…"
              : stackMerge
                ? "Merge stack"
                : "Merge"}
            {stackMerge && !merging && (
              <span className="ml-1.5 rounded-full bg-white/20 px-1.5 tabular-nums">
                {stackMerge.layers.length}
              </span>
            )}
          </PrBarButton>
        );
        if (!mergeScheduled) return mergeButton;
        return withMergeUndo(mergeButton);
      }
      // The host refuses a plain merge, so Merge would only fail. Offer what
      // gets it through instead: auto-merge once the rules pass, and force
      // merge behind the chevron. With auto-merge already on there is nothing
      // to press; the headline says it will land.
      case "blocked": {
        if (!pr || pr.autoMerge) return null;
        const choices = mergeChoices(
          pr,
          checksSummary,
          prCapabilities(pr.capabilities),
        );
        const canAuto = choices.all.includes("auto");
        const canForce = choices.all.includes("force");
        if (mergePhase !== "idle" || busy === "merge")
          return withMergeUndo(
            <PrBarButton className={actionBtn} tone="green" disabled>
              Merging…
            </PrBarButton>,
          );
        const forceItem = (
          <Menu.Item
            onClick={() => handleForceMerge(choices.bypasses)}
            className="text-red data-[highlighted]:bg-red-soft"
          >
            <IconWarningTriangle size={20} className="text-red" />
            <span className="min-w-0 flex-1 truncate">
              {MERGE_CHOICE_LABEL.force}
            </span>
          </Menu.Item>
        );
        if (!canAuto)
          return canForce ? (
            <Menu.Root>
              <Menu.Trigger
                render={
                  <PrBarButton
                    className={actionBtn}
                    tone="status-yellow"
                    disabled={!!busy}
                    title="Merge options"
                  />
                }
              >
                Merge
                <IconChevronDown size={20} className="-mr-0.5 opacity-60" />
              </Menu.Trigger>
              <Menu.Popup align="end" sideOffset={6} className="min-w-[200px]">
                {forceItem}
              </Menu.Popup>
            </Menu.Root>
          ) : null;
        return (
          <span className="inline-flex shrink-0 items-center gap-1">
            <PrBarButton
              className={actionBtn}
              tone="green"
              disabled={!!busy}
              onClick={handleAutoMerge}
              title={MERGE_CHOICE_TITLE.auto}
            >
              {busy === "auto-merge" ? "Turning on…" : MERGE_CHOICE_SHORT.auto}
            </PrBarButton>
            {canForce && (
              <Menu.Root>
                <Menu.Trigger
                  // The glyph rides in the icon slot, not the label's
                  // cap-trimmed span, so it sits in the middle of the box.
                  // A soft square, not a pill: at 30px wide a pill is a disc.
                  render={
                    <PrBarButton
                      className={cn(
                        actionBtn,
                        "w-[30px] rounded-md border-transparent bg-transparent px-0 text-dim",
                      )}
                      tone="secondary"
                      disabled={!!busy}
                      aria-label="Merge options"
                      title="Merge options"
                      icon={<IconChevronDown size={20} />}
                    />
                  }
                />
                <Menu.Popup
                  align="end"
                  sideOffset={6}
                  className="min-w-[200px]"
                >
                  {forceItem}
                </Menu.Popup>
              </Menu.Root>
            )}
          </span>
        );
      }
      default:
        return null;
    }
  }

  // The summary card: one row for the PR, the way a sidebar row carries its
  // own subtext. One row for all of it, including the preview deploy, which
  // leads the row as a mark instead of taking a line of its own to say a name
  // the globe already says. Where the work stands is the line that matters, so
  // the headline follows the mark, with the check count beside it, and the PR
  // number and title sit under it as secondary, in the same order as the series
  // rows below. The title is the part that gives way on a narrow card.
  //
  // The row is a div holding two targets rather than one row-wide button,
  // which is the card's only departure from "the whole row is the target". It
  // has to be: the label opens the PR (or its checks) and the button beside it
  // merges, pushes or pulls, and a button inside a button is not a thing.
  if (variant === "summary") {
    // The label is the button, rather than a button wrapping it: it has to
    // carry the row's truncation and its flex share, and a `display:contents`
    // wrapper would drop the focus ring with the box.
    const labelClass = cn(
      WS_SUMMARY_LABEL,
      // Sized to its words rather than the row's spare room, so the PR's
      // number sits right after the headline. Centred rather than on the
      // baseline: the phone card makes the link 44px tall, and a baseline row
      // rides to the top of that box.
      "flex flex-initial cursor-pointer items-center gap-1.5 rounded-sm border-none bg-transparent p-0 text-left focus-ring",
    );
    const provider = pr ? providerFromUrl(pr.url) : null;
    const externalHint = provider
      ? `${isApple ? "⌘" : "Ctrl"}-click opens in ${provider.name}`
      : undefined;
    // One line: the state, which PR it is (the provider's mark and number),
    // then the action at the far end. The PR's title lives in the hover: it
    // mostly repeats the session's own title, and as a second line it made
    // the band twice as tall as the rows under it.
    // A passing total adds nothing next to "Ready to merge" and took the
    // headline's room, and hovering lists every check anyway. So the count
    // only shows while it still needs watching: something pending or failed
    // that the headline doesn't already count.
    const showChecksCount =
      checksPr &&
      !headlineCountsChecks &&
      (checksSummary.failed > 0 || checksSummary.pending > 0);
    const headlineBody = (
      <>
        <span className="min-w-0 truncate text-item-title text-fg">
          {headlineLabel}
        </span>
        {showChecksCount && (
          <span className={cn("shrink-0 text-meta", checksTone)}>
            {checksLabel}
          </span>
        )}
      </>
    );
    function openInReview(
      event: React.MouseEvent<HTMLAnchorElement>,
      open?: () => void,
    ) {
      // Keep the anchor's native destination for modified and middle clicks.
      // A plain click stays in context in Open Session's Review tab.
      if (
        !open ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      )
        return;
      event.preventDefault();
      open();
    }
    // The provider mark makes the modified-click destination visible without
    // competing with the state or the primary action.
    const prNumber = pr && provider && (
      <Tooltip
        label={
          <span className="flex flex-col gap-0.5">
            <span>{pr.title || `#${pr.number}`}</span>
            {externalHint && (
              <span className="font-normal text-tooltip-fg/60">
                {externalHint}
              </span>
            )}
          </span>
        }
        side="bottom"
        align="start"
        multiline
      >
        <a
          className="flex shrink-0 items-center gap-1 rounded-sm text-meta text-faint no-underline hover:text-dim focus-ring"
          href={pr.url}
          target="_blank"
          rel="noopener"
          onClick={(event) =>
            openInReview(event, onOpenPrTab ? () => onOpenPrTab() : undefined)
          }
        >
          <BrandMark name={provider.key} size={12} className="shrink-0" />
          <span>#{pr.number}</span>
        </a>
      </Tooltip>
    );
    // The row's contents, held apart from the element that carries them: with
    // a PR the row is a right-click target and so has to be a ContextMenu
    // trigger, and without one it is a plain div. Same children either way.
    const rowBody = (
      <>
        {/* The preview environment this PR deployed leads the row, at the far
            end from Merge, Push or Pull: a 28px link next to the merge button
            was too easy to hit by mistake. Renders nothing when the PR has
            no preview, and the row closes up. */}
        {children}
        {/* When checks exist, the headline is their control: hovering lists
				    them and clicking opens Review's Checks tab. The PR's own title
				    stays as the native fallback. */}
        {checksPr ? (
          <PrChecksPopover
            // This checks preview belongs above the standing summary popup.
            // Keep its parent open while the pointer moves into the preview.
            nested
            checks={checksPr.checks}
            trigger={
              <a
                className={cn(labelClass, "no-underline")}
                href={checksPr.url}
                target="_blank"
                rel="noopener"
                title={`#${checksPr.number} · ${checksPr.title}. ${externalHint}`}
                onClick={(event) => openInReview(event, onOpenChecksTab)}
              >
                {headlineBody}
              </a>
            }
          />
        ) : pr ? (
          <Tooltip
            label={
              <span className="flex flex-col gap-0.5">
                <span>Open review</span>
                {pr.title && (
                  <span className="font-normal text-tooltip-fg/60">
                    {pr.title}
                  </span>
                )}
                {externalHint && (
                  <span className="font-normal text-tooltip-fg/60">
                    {externalHint}
                  </span>
                )}
              </span>
            }
            side="bottom"
            align="start"
            multiline
          >
            <a
              className={cn(labelClass, "no-underline")}
              href={pr.url}
              target="_blank"
              rel="noopener"
              onClick={(event) =>
                openInReview(
                  event,
                  onOpenPrTab ? () => onOpenPrTab() : undefined,
                )
              }
            >
              {headlineBody}
            </a>
          </Tooltip>
        ) : (
          <Tooltip
            label={prLoadError || "Open the Review tab"}
            side="bottom"
            align="start"
            multiline={Boolean(prLoadError)}
          >
            <button
              type="button"
              className={labelClass}
              onClick={() => onOpenPrTab?.()}
            >
              {headlineBody}
            </button>
          </Tooltip>
        )}
        {prNumber}
        <span className="ml-auto flex shrink-0 items-center empty:hidden">
          {renderAction()}
        </span>
      </>
    );
    // Without a preview mark, give the headline a small step from the band's
    // left edge. With the small pill, the row only needs the card's own pitch,
    // and 4px gaps leave "Ready to merge" whole beside a preview mark, the
    // number and Merge in the 300px card.
    const summaryRowClass = cn(
      WS_SUMMARY_STATUS_ROW,
      "min-h-8 gap-1",
      "[&&:not(:has([data-summary-preview]))]:pl-3",
    );
    const primarySummary = (
      <div
        className={cn(
          WS_SUMMARY_BAND,
          PR_SUMMARY_BAND_BG[headlineTone],
          // Only a band with a fill needs room inside it.
          headlineTone !== "muted" && WS_SUMMARY_BAND_PAD,
        )}
      >
        {pr ? (
          // Right-click anywhere on the band, not only on the two words that
          // happen to be a link: the whole row is about one pull request, so
          // that is the target for taking its link away. Same menu as the
          // strip's `#1234` chip.
          <ContextMenu.Root>
            <ContextMenu.Trigger render={<div className={summaryRowClass} />}>
              {rowBody}
            </ContextMenu.Trigger>
            <ContextMenu.Popup>
              <PrCopyItems pr={pr} />
            </ContextMenu.Popup>
          </ContextMenu.Root>
        ) : (
          <div className={summaryRowClass}>{rowBody}</div>
        )}
        {prLoadError && (
          <p
            role="alert"
            className="mx-5 mb-2 mt-1 text-meta leading-snug text-yellow"
          >
            {prLoadError}
          </p>
        )}
        {/* Two lines at most: the headline and its button already say what
            to do next, so a long host refusal keeps the rest in its title. */}
        {error && (
          <p
            role="alert"
            title={error}
            className="mx-5 mb-2 mt-1 line-clamp-2 text-meta leading-snug text-red"
          >
            {error}
          </p>
        )}
      </div>
    );
    if (statusRows.length === 0) return primarySummary;
    return (
      <>
        {primarySummary}
        <PrSeriesRows
          refs={statusRows}
          primaryRepo={primaryRepoId}
          onOpen={openStatusRow}
          variant="summary"
          sessionId={sessionId}
          refreshTick={refreshTick}
          onPrompt={
            send
              ? (content) =>
                  send({
                    type: "prompt",
                    sessionId,
                    user: getCurrentUser(),
                    content,
                  })
              : undefined
          }
        />
      </>
    );
  }

  if (variant === "header") {
    return (
      <div className={PR_HEAD}>
        {/* Left of the PR chip: a stack layer's first fact is that it is one
				    of several, and the merge action takes the whole set. */}
        {pr && (
          <PrStackChip
            pr={pr}
            tone={headline.tone}
            size="head"
            headline={headlineLabel}
            repo={primaryRepoId}
            onOpenPr={(r, branch) => onOpenPrTab?.({ repo: r, branch })}
          />
        )}
        {pr && (
          <PrNumberChip
            pr={pr}
            tone={headline.tone}
            size="head"
            onOpenPrTab={() => onOpenPrTab?.()}
          />
        )}
        {/* No room for a row of chips in the session header — the siblings
				    collapse into one `+N` menu in their worst tone. */}
        <PrRefChips
          refs={siblings}
          maxInline={0}
          primaryRepo={primaryRepoId}
          onOpen={onOpenPrTab}
        />
        {headline.key === "running" && pr && (
          <PrChecksPopover
            checks={pr.checks}
            trigger={
              <button
                type="button"
                className={`${PR_BAR_STATE} ${PR_STATE_TEXT[headline.tone]}`}
                onClick={onOpenChecksTab}
              >
                {headlineLabel}
              </button>
            }
          />
        )}
        {error && (
          <span className={PR_HEAD_ERROR} title={error}>
            {error}
          </span>
        )}
        {renderAction()}
      </div>
    );
  }

  // The primary row is the session's own branch — the one this worktree can
  // push, pull and merge. Its other PRs stack underneath, one row each.
  const primaryRow = (
    <div
      className={`pr-bar wco-chrome ${PR_BAR} ${PR_BAR_BG[headlineTone]} ${PR_BAR_IN_CARD}`}
    >
      {leading}
      {pr && (
        <PrStackChip
          pr={pr}
          tone={headlineTone}
          size="bar"
          headline={headlineLabel}
          repo={primaryRepoId}
          onOpenPr={(r, branch) => onOpenPrTab?.({ repo: r, branch })}
        />
      )}
      {pr && (
        <PrNumberChip
          pr={pr}
          tone={headlineTone}
          size="bar"
          onOpenPrTab={() => onOpenPrTab?.()}
        />
      )}
      {checksPr ? (
        <PrChecksPopover
          checks={checksPr.checks}
          trigger={
            <button
              type="button"
              className={`${PR_BAR_STATE} ${PR_BAR_STATE_TEXT[headlineTone]}`}
              onClick={onOpenChecksTab}
            >
              {headlineLabel}
            </button>
          }
        />
      ) : (
        (headline.key !== "no-pr" || statusRows.length > 0) && (
          <Tooltip
            label={prLoadError || "Open the PR tab"}
            multiline={Boolean(prLoadError)}
          >
            <button
              className={`${PR_BAR_STATE} ${PR_BAR_STATE_TEXT[headlineTone]}`}
              onClick={() => onOpenPrTab?.()}
            >
              {headlineLabel}
            </button>
          </Tooltip>
        )
      )}
      <span className="flex-1" />
      {error && (
        <span className={PR_BAR_ERROR} title={error}>
          {error}
        </span>
      )}
      {renderAction()}
    </div>
  );
  if (statusRows.length === 0) return primaryRow;
  return (
    <div className={PR_BAR_STACK}>
      {primaryRow}
      <PrSeriesRows
        refs={statusRows}
        primaryRepo={primaryRepoId}
        onOpen={onOpenPrTab}
      />
    </div>
  );
}
