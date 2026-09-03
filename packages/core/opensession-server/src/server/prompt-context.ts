/**
 * Injected prompt context vs. what the human typed.
 *
 * The model needs a lot of injected context on a turn — the system preamble
 * (especially for Codex, which has no separate system channel so it all rides
 * on the user turn), the repos note, and the engine-switch handoff transcript.
 * All of that is plumbing: it belongs in the model's input but NOT in the
 * rendered conversation, where it reads as a giant unexplained "You" message.
 *
 * We fence injected blocks with these sentinels. The runners keep them in the
 * prompt sent to the model; the transcript parser strips fenced blocks so the
 * UI shows only the human's actual message (the model-switch divider already
 * conveys that the engine changed). Sentinels are inert tag-like text the model
 * simply reads as context.
 *
 * **Model-visible means logged.** Hiding a block from the rendered transcript
 * must not make it unrecoverable: everything fenced here is recorded as a
 * `context-injection` transcript entry at the moment it reaches an engine
 * (src/server/context-log.ts), so what the model saw is reconstructable from
 * the append-only store. That is why the open sentinel carries an optional
 * `source` attribute — the fence is the wire format the logger reads, so a
 * block is attributed by construction rather than by a bookkeeping call the
 * next injection site can forget. An untagged block still logs, as "unknown".
 */
export const CTX_OPEN = "<opensession:context>";
export const CTX_CLOSE = "</opensession:context>";
// Pre-rename fence pair. Old transcripts (and attached-session inlines of them)
// carry these forever: stripping and neutralization must keep handling both.
const LEGACY_CTX_OPEN = "<backstage:context>";
const LEGACY_CTX_CLOSE = "</backstage:context>";

/**
 * Where an injected block came from. Recorded on the `context-injection`
 * transcript entry so a replay can tell the repos note from a handoff without
 * re-deriving it from the text. Add a member rather than inventing a free
 * string: the taxonomy is what makes the log queryable.
 */
export type ContextSource =
  | "preamble"
  | "handoff"
  | "memory"
  | "repos-note"
  | "attached-session-excerpt"
  | "external-refs"
  | "ticket"
  | "auto-continue"
  | "background-wait"
  | "restart-recovery"
  | "steer-note"
  | "uploads-note"
  | "pinned-goal"
  | "session"
  | "unknown";

const SOURCES = new Set<string>([
  "preamble",
  "handoff",
  "memory",
  "repos-note",
  "attached-session-excerpt",
  "external-refs",
  "ticket",
  "auto-continue",
  "background-wait",
  "restart-recovery",
  "steer-note",
  "uploads-note",
  "pinned-goal",
  "session",
  "unknown",
]);

/** Read a source label off the wire, falling back to "unknown" for anything
 *  an older (or newer) writer put there. */
export function asContextSource(
  value: string | undefined | null,
): ContextSource {
  return value && SOURCES.has(value) ? (value as ContextSource) : "unknown";
}

// Any fence open tag, with or without attributes, either sentinel generation.
const OPEN_TAG_RE = /<(?:opensession|backstage):context(?:\s[^>]*)?>/g;
const CLOSE_TAG_RE = /<\/(?:opensession|backstage):context>/g;

/** Fence a block of injected context so it renders invisibly in the transcript.
 *  `source` is recorded on the block's context-injection log entry. */
export function wrapContext(body: string, source?: ContextSource): string {
  // Neutralize any fence sentinels inside the body: a nested
  // <opensession:context> marker in inlined content (e.g. an attached session's
  // transcript that literally contains the string) would otherwise let that
  // content break out of the fence and inject unfenced instructions into the
  // agent — a prompt-injection vector. A sentinel inside a fenced block is
  // never legitimate, so replacing the angle brackets is always safe. Matched
  // as a pattern, not as two literals: an open tag may carry attributes, and
  // `<opensession:context source="x">` would otherwise sail through.
  const safe = neutralizeContextSentinels(body);
  const open = source ? `<opensession:context source="${source}">` : CTX_OPEN;
  return `${open}\n${safe}\n${CTX_CLOSE}`;
}

/** Make context fence text inert before applying an exact output budget. */
export function neutralizeContextSentinels(body: string): string {
  return body
    .replace(OPEN_TAG_RE, (t) => `‹${t.slice(1, -1)}›`)
    .replace(CLOSE_TAG_RE, (t) => `‹${t.slice(1, -1)}›`);
}

const STRIP_RE =
  /<(?:opensession|backstage):context(?:\s[^>]*)?>[\s\S]*?<\/(?:opensession|backstage):context>\n*/g;
// Before injected context was fenced, pinned goals were appended directly to
// user prompts. Keep those stored turns clean too, not only prompts created
// after the fence migration.
const LEGACY_PINNED_GOAL_RE =
  /(?:^|\n\n)\[Pinned session goal — keep working toward it and note how this turn advanced it: [\s\S]*\]\s*$/;
// A delivery attribution ("[Name] ", added when a prompt is handed to the
// engine) with nothing left after the fence is stripped: the whole turn was
// plumbing, so the prefix is all the transcript would carry. Left in, it
// rendered as an authored-but-empty bubble — a bare identity dot labelled
// "auto-continue" above the next message (2026-07-30).
const ATTRIBUTION_ONLY_RE = /^\[[^\]\n]{1,80}\]$/;

/** Cheap pre-test shared by strip/parse: does this text hold a fence at all? */
function hasFence(text: string): boolean {
  return (
    text.includes("<opensession:context") || text.includes("<backstage:context")
  );
}

/** Remove fenced context blocks and legacy unfenced injections for display. */
export function stripContext(text: string): string {
  if (!text) return text;
  const withoutLegacyGoal = text.replace(LEGACY_PINNED_GOAL_RE, "");
  const shown = hasFence(withoutLegacyGoal)
    ? withoutLegacyGoal.replace(STRIP_RE, "").trimStart()
    : withoutLegacyGoal;
  return ATTRIBUTION_ONLY_RE.test(shown.trim()) ? "" : shown;
}

/** Is this prompt nothing but injected context — plumbing the human never
 *  typed (the auto-continue nudge, see auto-continue.ts)? Such a turn takes no
 *  delivery attribution: there'd be no message to attribute it to. */
export function isContextOnly(text: string): boolean {
  return !!text.trim() && !stripContext(text).trim();
}

/** Preserve a teammate's identity in the stored transcript and model input.
 *  Bare user turns belong to the session owner, so every other sender needs an
 *  explicit prefix before the intake row is persisted. */
export function withPromptAttribution(
  text: string,
  sender: string | undefined,
  owner: string | null | undefined,
): string {
  if (
    !sender ||
    sender === owner ||
    isContextOnly(text) ||
    text.startsWith(`[${sender}] `)
  ) {
    return text;
  }
  return `[${sender}] ${text}`;
}

const BLOCK_RE =
  /<(?:opensession|backstage):context(\s[^>]*)?>([\s\S]*?)<\/(?:opensession|backstage):context>/g;

/** Every fenced block in a prompt body, in order, with its declared source.
 *  This is the read side of `wrapContext` — what context-log.ts records. */
export function parseContextBlocks(
  text: string,
): Array<{ source: ContextSource; body: string }> {
  if (!text || !hasFence(text)) return [];
  const out: Array<{ source: ContextSource; body: string }> = [];
  for (const m of text.matchAll(BLOCK_RE)) {
    const body = m[2].trim();
    if (!body) continue;
    out.push({
      source: asContextSource(m[1]?.match(/source="([^"]*)"/)?.[1]),
      body,
    });
  }
  return out;
}
