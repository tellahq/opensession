/**
 * Quick replies: a ```choices fence listing one reply per line renders as a
 * row of chips. Picking one sends that text as the next message.
 *
 * The block is DOM built inside a markdown body, so it never imports React.
 * It talks to the session around it two ways, the same way `[data-asset-path]`
 * does: the chip carries a `data-choice` marker and the block carries the
 * entry id it belongs to (`data-choices-eid`), and the session viewer's
 * delegated click handler (hooks/useTranscriptBlocks.ts) does the sending.
 * Whether the chips are still current (no later user message) is decided by
 * the viewer from the transcript and published here per messages container,
 * so a block upgraded later reads the same answer the viewer would give.
 *
 * Where there is no session to send into (an asset preview, PR prose) the
 * chips render quiet: a chip that does nothing must not invite a click.
 */

import type { FenceUpgrader } from "./fence-upgraders";

export const CHOICES_BLOCK_CLASS = "md-choices";
export const CHOICE_CLASS = "md-choice";
/** The transcript container a block reads its scope from (MarkdownBody uses
 *  the same class as its lazy-upgrade root). */
const SCOPE_SELECTOR = ".viewer-messages";

const MAX_CHOICES = 12;
const MAX_CHOICE_LENGTH = 200;

/**
 * One reply per non-empty line; a leading `- `, `* ` or `1. ` is tolerated
 * and dropped. Null when the fence is not a usable list: empty, too many, or
 * a line long enough to be prose rather than a reply.
 */
export function parseChoices(source: string): string[] | null {
  const seen = new Set<string>();
  const choices: string[] = [];
  for (const raw of source.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const text = line.replace(/^(?:[-*+]|\d+[.)])(?:\s+|$)/, "").trim();
    if (!text || seen.has(text)) continue;
    if (text.length > MAX_CHOICE_LENGTH) return null;
    seen.add(text);
    choices.push(text);
  }
  if (choices.length === 0 || choices.length > MAX_CHOICES) return null;
  return choices;
}

interface EntryLike {
  id: string;
  type: string;
}

/**
 * The entries whose quick replies are still current: everything after the
 * last user message. A block in an earlier entry has been answered, by a chip
 * or by the composer, and goes quiet.
 */
export function openChoiceEntryIds(
  entries: readonly EntryLike[],
): ReadonlySet<string> {
  let lastUser = -1;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (entries[index]?.type === "user") {
      lastUser = index;
      break;
    }
  }
  return new Set(entries.slice(lastUser + 1).map((entry) => entry.id));
}

/** Per messages container: the entry ids whose chips are still live. */
const openEntries = new WeakMap<Element, ReadonlySet<string>>();

function applyQuiet(block: Element, quiet: boolean): void {
  if (quiet) block.setAttribute("data-quiet", "");
  else block.removeAttribute("data-quiet");
  for (const chip of block.querySelectorAll(`.${CHOICE_CLASS}`)) {
    if (chip instanceof HTMLButtonElement) chip.disabled = quiet;
  }
}

function isQuiet(block: Element): boolean {
  const scope = block.closest(SCOPE_SELECTOR);
  const open = scope ? openEntries.get(scope) : undefined;
  const eid = block.getAttribute("data-choices-eid");
  return !open || !eid || !open.has(eid);
}

/**
 * Publish which entries still take a quick reply, and bring every mounted
 * block under `container` in line. Called by the viewer whenever the
 * transcript changes.
 */
export function setOpenChoiceEntries(
  container: Element,
  open: ReadonlySet<string>,
): void {
  openEntries.set(container, open);
  for (const block of container.querySelectorAll(`.${CHOICES_BLOCK_CLASS}`))
    applyQuiet(block, isQuiet(block));
}

/** Quiet one block now, e.g. right after its chip was sent, ahead of the
 *  transcript catching up. */
export function quietChoicesBlock(block: Element): void {
  applyQuiet(block, true);
}

export const choicesUpgrader: FenceUpgrader = {
  langs: ["choices"],
  async upgrade({ pre, source, root, alive }) {
    const choices = parseChoices(source);
    if (!choices || !alive() || !root.contains(pre)) return false;
    const block = document.createElement("div");
    block.className = CHOICES_BLOCK_CLASS;
    block.setAttribute("role", "group");
    block.setAttribute("aria-label", "Quick replies");
    const eid = pre.closest("[data-eid]")?.getAttribute("data-eid");
    if (eid) block.dataset.choicesEid = eid;
    for (const choice of choices) {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = CHOICE_CLASS;
      chip.dataset.choice = "";
      // Untrusted text: never markup.
      chip.textContent = choice;
      block.append(chip);
    }
    pre.replaceWith(block);
    applyQuiet(block, isQuiet(block));
    return true;
  },
};
