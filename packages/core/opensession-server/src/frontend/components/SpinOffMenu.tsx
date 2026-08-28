import { toast } from "../ui/toast";
import { AGENT_NAME } from "../lib/brand";
import React, { useRef, useState } from "react";
import { Button } from "../ui/button";
import { Menu, MENU_ICON } from "../ui/menu";
import { Modal } from "../ui/modal";
import { IconChevronRight, IconSparkle } from "./icons";
import type { UnifiedSession, TranscriptEntry } from "../lib/types";
import { getCurrentUser } from "./UserPicker";
import { Field, fieldClasses } from "../ui/input";
import { noAutofill } from "../lib/composer-autofill";
import { composerSessionRef } from "../lib/share-link";
import type { NewSessionPrefill } from "../lib/new-session-link";

type Flavor = "build" | "learnings" | "analyze";

interface Props {
  session: UnifiedSession;
  entries: TranscriptEntry[];
  send: (msg: any) => void;
  connected: boolean;
  /** Open the new-session composer prefilled — the one flavor that writes no
      prompt of its own. */
  onOpenNewSession: (prefill: NewSessionPrefill) => void;
}

/**
 * Spin a new session off the current transcript:
 *  - build:     ask → code handoff with conversation context (Devin's "spin-off")
 *  - learnings: code session that feeds durable learnings back into the repo's docs as a PR
 *  - analyze:   ask session reviewing what went well/wrong + better prompt
 *
 * A fourth row spins nothing off itself: it opens the new-session composer with
 * a link to this session already in the draft, for when the handoff is one the
 * person wants to word themselves.
 */
export function SpinOffMenu({
  session,
  entries,
  send,
  connected,
  onOpenNewSession,
}: Props) {
  const [flavor, setFlavor] = useState<Flavor | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [branch, setBranch] = useState("");
  const [task, setTask] = useState("");
  const [starting, setStarting] = useState(false);
  const branchRef = useRef<HTMLInputElement>(null);

  const isAsk = session.mode === "ask";
  const hasContent = entries.some((e) => e.type === "assistant");
  if (!hasContent) return null;

  function pick(f: Flavor) {
    setMenuOpen(false);
    setFlavor(f);
    if (f === "build") {
      setBranch(suggestBranch(session.title));
      setTask("Implement what we discussed above.");
    } else if (f === "learnings") {
      setBranch(`opensession-learnings-${dateStamp()}`);
      setTask("");
    }
  }

  function openLinkedSession() {
    onOpenNewSession({
      // A reference, not a transcript: the new session reads this one through
      // the link when it needs to, instead of carrying a copy that goes stale.
      // The trailing space parks the caret clear of the chip.
      prompt: `${composerSessionRef(session)} `,
      mode: session.mode ?? "code",
      ...(session.repo ? { repo: session.repo } : {}),
    });
  }

  function start() {
    if (!flavor || starting) return;
    setStarting(true);

    const context = buildContext(entries, flavor === "build" ? 6000 : 9000);
    const me = getCurrentUser();

    try {
    if (flavor === "analyze") {
      send({
        type: "create_session",
        mode: "ask",
        branch: "",
        user: me,
        createWorkspace: {},
        prompt:
          `Analyze this finished ${AGENT_NAME} session ("${session.title}") and report:\n` +
          `1. What was asked and what was delivered.\n` +
          `2. What went wrong or was wasted effort (wrong paths, retries, misunderstandings).\n` +
          `3. A rewritten version of the original prompt that would likely have succeeded in one shot.\n` +
          `4. Whether any repo docs (docs/kb/**, AGENTS.md, CLAUDE.md) could be updated to prevent ` +
          `the mistakes you found. Quote the concrete text you would add.\n\n` +
          `## Conversation\n\n${context}`,
      });
      return;
    }

    if (flavor === "learnings") {
      send({
        type: "create_session",
        mode: "code",
        branch,
        user: me,
        createWorkspace: {},
        prompt:
          `Feed the durable learnings from a ${AGENT_NAME} session back into this repo's documentation.\n\n` +
          `## Conversation (session "${session.title}")\n\n${context}\n\n## Task\n\n` +
          `Extract durable, non-obvious learnings from the conversation above: gotchas, architecture facts, ` +
          `runbook steps, conventions, anything a teammate or future agent session would benefit from knowing. ` +
          `Check whether each is already documented; skip session-specific noise. Add the genuinely new ones to ` +
          `the right place (docs/kb/**, AGENTS.md, CLAUDE.md, or a package README), keeping each addition ` +
          `short and factual, matching the surrounding style.` +
          (task.trim() ? `\n\nExtra guidance from ${me}: ${task.trim()}` : "") +
          `\n\nWhen done, commit on this branch and open a PR titled "docs: learnings from ${AGENT_NAME} session" ` +
          `with a body summarizing what you added and why. Do NOT merge the PR.`,
      });
      return;
    }

    // build
    send({
      type: "create_session",
      mode: "code",
      branch,
      user: me,
      prompt:
        `This coding session was spun off from an Ask session ("${session.title}"). ` +
        `The conversation below is context. The codebase exploration already happened there, ` +
        `so trust its conclusions but re-verify file paths before editing.\n\n` +
        `## Ask conversation\n\n${context}\n\n## Task\n\n${task.trim() || "Implement what was discussed above."}`,
    });
    } catch (error) {
      setStarting(false);
      toast(error instanceof Error ? error.message : String(error), { variant: "error" });
    }
  }

  const needsBranch = flavor === "build" || flavor === "learnings";
  const canStart = connected && !starting && (!needsBranch || branch.trim());

  // Two-line rows in a flush-edged popup (no inner padding, divider between rows).
  const itemCls =
    "flex-col items-start gap-0.5 rounded-none border-b border-line px-3.5 py-2.5 last:border-b-0";

  // The menu's own field look — the primitive's corner/fill/focus, plus the
  // accent halo this surface authored.
  const fieldCls = fieldClasses(
    "lg",
    "border-line-strong text-sm focus:shadow-[0_0_0_3px_var(--accent-soft)]",
  );

  const flavorMeta: Record<Flavor, { title: string; description: string }> = {
    build: {
      title: "Build this",
      description: "Start a coding session with this conversation as context.",
    },
    learnings: {
      title: "Capture learnings → docs PR",
      description: `${AGENT_NAME} adds what was learned here to ${session.repo || "the repository"} docs, as a PR to review.`,
    },
    analyze: {
      title: "Analyze session",
      description: "What went well, what didn't, and a prompt that would have worked in one shot.",
    },
  };

  return (
    <>
      <Menu.SubmenuRoot open={menuOpen} onOpenChange={setMenuOpen}>
        <Menu.SubmenuTrigger title="Spin off a new session from this one">
          {/* Not the branch glyph: Fork sits directly above this row in
              the session menu and owns it. Spin off hands the transcript to
              a fresh agent run rather than branching this one. */}
          <IconSparkle size={20} className={MENU_ICON} />
          <span className="grow">Spin off</span>
          <IconChevronRight size={16} className="text-faint" />
        </Menu.SubmenuTrigger>
        <Menu.Popup className="w-80 overflow-hidden" contentClassName="p-0">
          {isAsk && (
            <Menu.Item closeOnClick={false} onClick={() => pick("build")} className={itemCls}>
              <span className="text-label font-semibold text-fg">Build this</span>
              <span className="text-supporting leading-[1.4] text-faint">Start a coding session with this conversation as context</span>
            </Menu.Item>
          )}
          <Menu.Item closeOnClick={false} onClick={() => pick("learnings")} className={itemCls}>
            <span className="text-label font-semibold text-fg">Capture learnings → docs PR</span>
            <span className="text-supporting leading-[1.4] text-faint">{AGENT_NAME} adds what was learned here to {session.repo || "the repository"} docs</span>
          </Menu.Item>
          <Menu.Item closeOnClick={false} onClick={() => pick("analyze")} className={itemCls}>
            <span className="text-label font-semibold text-fg">Analyze session</span>
            <span className="text-supporting leading-[1.4] text-faint">What went well, what didn't, and a better prompt</span>
          </Menu.Item>
          {/* Closes the whole menu rather than opening the form above: there is
              nothing to fill in here, the composer IS the form. */}
          <Menu.Item onClick={openLinkedSession} className={itemCls}>
            <span className="text-label font-semibold text-fg">Reference this session</span>
            <span className="text-supporting leading-[1.4] text-faint">Opens the new-session composer with a link to this one — you write the prompt</span>
          </Menu.Item>
        </Menu.Popup>
      </Menu.SubmenuRoot>

      {/* The form used to be an absolutely-positioned panel inside this menu
          popup — which clips overflow, so a 380px form in a ≤300px menu was
          sawn down to a sliver of its own buttons. It's a form opened from a
          menu row, so it takes the same shape as the sibling action
          dialog: ui/modal, which portals out of the menu and brings the shared
          focus trap, Escape/backdrop dismissal and enter/exit motion. */}
      <Modal.Root
        open={flavor !== null}
        onOpenChange={(next) => {
          if (!next && !starting) setFlavor(null);
        }}
        disablePointerDismissal={starting}
      >
        <Modal.Content
          widthClassName="max-w-[28rem]"
          initialFocus={needsBranch ? branchRef : undefined}
        >
          <Modal.Header
            title={flavor ? flavorMeta[flavor].title : ""}
            description={flavor ? flavorMeta[flavor].description : undefined}
          />

          {needsBranch && (
            <Field label="Branch">
              <input
                ref={branchRef}
                className={`${fieldCls} h-10`}
                value={branch}
                onChange={(e) => setBranch(e.target.value)}
                disabled={starting}
              />
            </Field>
          )}

          {flavor !== "analyze" && (
            <Field label={flavor === "build" ? "Task" : "Extra guidance (optional)"}>
              <textarea
                className={`${fieldCls} resize-y py-2 leading-relaxed`}
                value={task}
                onChange={(e) => setTask(e.target.value)}
                rows={3}
                {...noAutofill}
                disabled={starting}
                placeholder={flavor === "learnings" ? "e.g. focus on the deploy gotchas we hit" : ""}
              />
            </Field>
          )}

          <Modal.Footer>
            {starting && (
              <span className="text-supporting text-faint">
                Starting the session. We'll take you there automatically.
              </span>
            )}
            <div className="flex-1" />
            <Button onClick={() => setFlavor(null)} disabled={starting}>
              Cancel
            </Button>
            <Button
              className="border-accent bg-accent-soft text-accent hover:border-accent hover:text-accent"
              onClick={start}
              disabled={!canStart}
            >
              {starting ? "Starting…" : "Start session"}
            </Button>
          </Modal.Footer>
        </Modal.Content>
      </Modal.Root>
    </>
  );
}

/** Compact the conversation: always keep the opening message, then fill from the end. */
function buildContext(entries: TranscriptEntry[], budget: number): string {
  const turns = entries
    .filter((e) => e.type === "user" || e.type === "assistant")
    .map((e) => {
      const who = e.type === "user" ? "User" : AGENT_NAME;
      const limit = e.type === "user" ? 700 : 1500;
      return `**${who}:** ${truncate(e.content.trim(), limit)}`;
    });

  if (turns.length === 0) return "(empty)";

  const first = turns[0];
  const rest: string[] = [];
  let used = first.length;
  for (let i = turns.length - 1; i >= 1; i--) {
    if (used + turns[i].length > budget) break;
    rest.unshift(turns[i]);
    used += turns[i].length;
  }
  const skipped = turns.length - 1 - rest.length;
  return [first, skipped > 0 ? `*(… ${skipped} earlier messages omitted …)*` : null, ...rest]
    .filter(Boolean)
    .join("\n\n");
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max) + "…";
}

function suggestBranch(title: string): string {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 32);
  return slug ? `${slug}` : `from-ask-${dateStamp()}`;
}

function dateStamp(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;
}
