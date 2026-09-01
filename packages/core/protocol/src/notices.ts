/**
 * Transcript notice classification — the single place that decides how a
 * transcript entry reads.
 *
 * A session transcript carries more than a conversation. Workers report back,
 * workflows announce they finished, another session sends a heads-up, the
 * runner rotates an account, the engine compacts its context, a service
 * restart resumes a run. All of those arrive as ORDINARY entries — most of
 * them as `user` turns, because the engine has to act on them — and every one
 * of them would otherwise render as words the human appears to have typed.
 *
 * This module turns such an entry into a `notice`: a title, a tone, and at
 * most one body and one action. Nine bespoke renderings collapse into one.
 *
 * Two rules make it work:
 *
 *  1. **Classify on the way out, not on the way in.** `classifyEntries` runs
 *     when entries are read for a client, so the thousands of notices already
 *     persisted (with no marker at all, in some cases) are classified by the
 *     same code as a message that lands a second from now. That is why every
 *     detector below keeps a legacy fallback next to its sentinel.
 *  2. **Strip the plumbing into the metadata.** The sentinel, the `[Name] `
 *     delivery prefix, the "💬 X answered" header — a reader never has a use
 *     for any of it, so `content` comes out as exactly the body to render and
 *     the presentation lives in `notice` / `sender`.
 *
 * It lives in the protocol package because three clients need the same
 * answer: the server tags entries for the web and native apps, and the web
 * composer reuses the detectors for messages still in flight (an outbox item
 * has never been near the server, but must read the same as the entry it is
 * about to become).
 */

import type { TranscriptEntry } from "./session";

/**
 * How loudly a notice reads.
 *
 * These lines are free text on the wire — the `<runner-notice>` marker carries
 * no metadata, and the thousands already persisted never will — so the tone is
 * derived from the stable phrasings the writing call sites use. Anything
 * unrecognised stays neutral: a miss costs a grey pill where a red one
 * belonged, never a false alarm on a routine notice.
 */
export type NoticeTone = "error" | "warn" | "info";

/** The run is over and it did not do what was asked — a human has to act. */
const ERROR_PATTERNS: RegExp[] = [
  // run-session.ts, both terminal-failure choke points.
  /^run (failed|stopped):/,
  // The per-turn time limit (turnTimeoutNotice in pi-config.ts). The
  // second form is the wording used before 2026-07-31 — transcripts keep it
  // forever, so it keeps its colour.
  /^stopped after \d/,
  /^turn stopped after \d+ minutes?\b/,
  // A sandbox workspace that has no host checkout to fall back to.
  /\bno host fallback\b/,
  // Legacy frontend build wording, retained for older persisted notices.
  /^frontend rebuild failed\b/,
];

/** Something went sideways, but the work continued — worth noticing, not alarming. */
const WARN_PATTERNS: RegExp[] = [
  /^sandbox unavailable\b/,
  /^couldn't\b/,
  /^this session's worktree\b/,
  // A recoverable background rebuild: clients keep using the prior bundle.
  /^app update paused\b/,
  // Automatic fallback recovered the run, so this is notable but not fatal.
  /^switched .+ · (?:out of credits|hit a transient engine error)$/,
  // A workflow run that ended badly (workflow-runner.ts). The wording used to
  // carry its own ⚠️/⏹️, which the glyph strip below now removes, so the tone
  // is the only thing left to say it did not finish cleanly.
  /^workflow "[^"]*" (?:failed|cancelled|canceled|stopped|error)\b/,
];

/**
 * Leading glyph some notices already carry. Producers reach for an emoji as a
 * status marker (a merged PR, a finished deploy, a workflow that failed), but
 * a transcript renders `notice.title` verbatim, so those land as emoji in the
 * middle of the UI's own icon set. Strip them here and let the presentation
 * say it: `tone` colours the pill and draws the alert glyph, `icon` names a
 * real interface icon for the neutral ones.
 */
const LEADING_GLYPH_RE = /^[\s⚠️❌🚨✅🔀🚀🔁🔍⏹️]+/u;

export function stripNoticeGlyph(content: string): string {
  return content.replace(LEADING_GLYPH_RE, "");
}

export function noticeTone(content: string): NoticeTone {
  const text = stripNoticeGlyph(content || "").toLowerCase();
  if (!text) return "info";
  if (ERROR_PATTERNS.some((re) => re.test(text))) return "error";
  if (WARN_PATTERNS.some((re) => re.test(text))) return "warn";
  return "info";
}

/**
 * The icon a neutral status line earns, in place of the emoji it used to open
 * with. Derived from the phrasing, like the tone above and for the same
 * reason: the lines are free text on the wire, and the ones already persisted
 * carry no metadata at all.
 */
export function noticeIcon(content: string): NoticeIcon | undefined {
  const text = stripNoticeGlyph(content || "").toLowerCase();
  // session-notify.ts, every merge wording it has shipped: the current
  // "PR #12 merged by …", and the "was (just) merged into main" forms that
  // preceded it, which thousands of transcripts still hold.
  if (/^pr #\d+ merged\b/.test(text) || /\bmerged into\b/.test(text))
    return "merge";
  if (/^pr #\d+ deployed\b/.test(text) || /^deploy(ment)?\b/.test(text))
    return "deploy";
  if (/^workflow "[^"]*" finished\b/.test(text)) return "done";
  return undefined;
}

/** What produced this notice. Carried for the clients that special-case one
 *  (the composer dims a workflow nudge) and for debugging a mis-classified
 *  entry — never for a per-kind rendering, which is the thing this replaces. */
export type NoticeKind =
  | "system"
  | "recap"
  | "compaction"
  | "worker-report"
  | "review-handoff"
  | "workflow"
  | "session-notice"
  | "recovery"
  /** A model-visible payload the harness injected into a prompt (a handoff,
   *  the repos note, an attached session's excerpt). Recorded so the model's
   *  input is reconstructable from the log; NOT conversation, so servers drop
   *  it from the default projection (see dropContextInjections). The notice
   *  exists for the debug/replay reader that asks for them anyway. */
  | "context-injection"
  /** Model-visible input that STANDS between turns rather than riding one: the
   *  run's tool surface, the engine's standing instructions. Recorded once per
   *  session per source and again only when its content hash changes, so a
   *  multi-KB blob is not copied onto every turn. Same "not conversation"
   *  discipline as context-injection, and the same projections drop it. */
  | "standing-context"
  /** A question card that has been answered: what was asked, what was on
   *  offer, and what the human picked. The card itself is transient (it is
   *  removed the moment it resolves), so without this the transcript kept no
   *  trace that the run had ever stopped to ask. */
  | "ask";

/**
 * How a client renders the entry's `content` underneath the title:
 *  - absent: the title IS the whole notice (short operational lines).
 *  - "inline": always shown — a recap exists to be read without a tap.
 *  - "collapsed": behind a show/hide toggle, for the long ones.
 */
export type NoticeBody = "inline" | "collapsed";

/**
 * An interface icon for a notice that carries a state but no alarm: a merged
 * PR, a finished deploy, a workflow that completed. An `info` notice has no
 * tone colour to speak with, and these lines used to open with an emoji
 * instead. Clients map the name to their own icon set; an unknown name, or
 * none, renders as plain text.
 */
export type NoticeIcon = "merge" | "deploy" | "done";

/** Exact read-only data behind an answered AskUserQuestion card. Versioned so
 *  a newer server can extend the record while older clients keep rendering the
 *  markdown fallback in the entry's `content`. */
export interface AnsweredAskData {
  version: 1;
  questions: Array<{
    question: string;
    header?: string;
    options?: Array<{ label: string; description?: string }>;
    multiSelect?: boolean;
    answer: string;
  }>;
}

/** Validate the optional structured ask payload at the parser/classifier
 *  boundary. A malformed or future version falls back to the markdown record. */
export function parseAnsweredAskData(
  value: unknown,
): AnsweredAskData | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as { version?: unknown; questions?: unknown };
  if (
    record.version !== 1 ||
    !Array.isArray(record.questions) ||
    !record.questions.length
  )
    return undefined;
  const questions: AnsweredAskData["questions"] = [];
  for (const valueQuestion of record.questions) {
    if (!valueQuestion || typeof valueQuestion !== "object") return undefined;
    const q = valueQuestion as Record<string, unknown>;
    if (typeof q.question !== "string" || typeof q.answer !== "string")
      return undefined;
    let options: AnsweredAskData["questions"][number]["options"];
    if (q.options !== undefined) {
      if (!Array.isArray(q.options)) return undefined;
      options = [];
      for (const valueOption of q.options) {
        if (!valueOption || typeof valueOption !== "object") return undefined;
        const option = valueOption as Record<string, unknown>;
        if (typeof option.label !== "string") return undefined;
        if (
          option.description !== undefined &&
          typeof option.description !== "string"
        )
          return undefined;
        options.push({
          label: option.label,
          ...(typeof option.description === "string"
            ? { description: option.description }
            : {}),
        });
      }
    }
    if (q.header !== undefined && typeof q.header !== "string")
      return undefined;
    if (q.multiSelect !== undefined && typeof q.multiSelect !== "boolean")
      return undefined;
    questions.push({
      question: q.question,
      answer: q.answer,
      ...(typeof q.header === "string" ? { header: q.header } : {}),
      ...(options ? { options } : {}),
      ...(typeof q.multiSelect === "boolean"
        ? { multiSelect: q.multiSelect }
        : {}),
    });
  }
  return { version: 1, questions };
}

export interface EntryNotice {
  kind: NoticeKind;
  /** One line, always visible. Never empty. */
  title: string;
  tone: NoticeTone;
  /** Only on `info` notices. A toned one already draws its alert glyph. */
  icon?: NoticeIcon;
  body?: NoticeBody;
  /** Present only for an answered question card. Clients that understand it
   *  render a read-only card; older clients keep using title + body. */
  ask?: AnsweredAskData;
  /** At most one action, rendered at the end of the body. */
  link?: { label: string; sessionId: string };
}

// ---------------------------------------------------------------------------
// Detectors. Each returns the stripped body, or null when it doesn't match.
// ---------------------------------------------------------------------------

/**
 * A teammate's answer that the human-in-the-loop feature (human-asks.ts)
 * routed back into a session. Not a notice: it's someone talking, so it keeps
 * a bubble — but credited to them, not to the session driver.
 *
 * Tolerant of an optional "[Name] " steer prefix, and of both the current
 * 💬 + **bold** format and the older :speech_balloon: + *italic* (or bare,
 * when copied from rendered text) forms.
 */
const HEAD =
  "(?:\\[[^\\]]+\\]\\s*)?(?:💬|:speech_balloon:)\\s*\\*{0,2}\\s*(.+?)\\s*\\*{0,2}\\s+(?:answered|replied)\\b";
const HUMAN_REPLY_RE = new RegExp("^" + HEAD);
const HUMAN_REPLY_HEADER = new RegExp("^" + HEAD + "[^\\n]*\\n+");

export function parseHumanReply(
  content?: string,
): { name: string; body: string; viaSlack: boolean } | null {
  if (!content) return null;
  const m = content.match(HUMAN_REPLY_RE);
  if (!m) return null;
  const body = content.replace(HUMAN_REPLY_HEADER, "").trim();
  return {
    name: m[1].trim(),
    body,
    viaSlack: /\(via Slack\)/i.test(content.split("\n", 1)[0]),
  };
}

/**
 * The plain "[Name] " prefix the server prepends when a *named* teammate
 * drives someone else's session — a steer, interrupt, batch-queued prompt, or
 * a cross-session `send_to_session`. That turn IS the driver, so it keeps a
 * normal bubble; only the credit changes.
 *
 * Kept deliberately strict (single-line, brace-free name ≤40 chars) so an
 * ordinary prompt that opens with "[WIP] …" isn't mistaken for an attribution.
 */
const ATTRIBUTION_RE = /^\[([^\]\n{}]{1,40})\]\s+([\s\S]*)$/;

export function parseAttribution(
  content?: string,
): { name: string; body: string } | null {
  if (!content) return null;
  const m = content.match(ATTRIBUTION_RE);
  if (!m) return null;
  return { name: m[1].trim(), body: m[2] };
}

export function isGitHubAttribution(name?: string | null): boolean {
  return name === "GitHub" || name === "GitHub (automation)";
}

/**
 * A review handoff (agents/github/handoff.ts): an unsatisfied PR review's
 * findings pushed into the owning session. Arrives as a GitHub-attributed user
 * turn; the sentinel is kept in sync with REVIEW_HANDOFF_SENTINEL in
 * agents/github/prompts.ts, with the pre-sentinel "🔍 This session's PR #…"
 * opener as the fallback for handoffs delivered before it shipped.
 */
const REVIEW_HANDOFF_SENTINEL = "<!--os:review-handoff-->";
const LEGACY_HANDOFF_RE = /^🔍 This session'?s PR #\d+/;

export function parseReviewHandoff(
  body?: string,
): { prNumber: number | null; body: string } | null {
  if (!body) return null;
  let text = body;
  if (text.startsWith(REVIEW_HANDOFF_SENTINEL)) {
    text = text.slice(REVIEW_HANDOFF_SENTINEL.length).replace(/^\n+/, "");
  } else if (!LEGACY_HANDOFF_RE.test(text)) {
    return null;
  }
  const pr = text.match(/PR #(\d+)/);
  return { prNumber: pr ? parseInt(pr[1], 10) : null, body: text };
}

/**
 * Strip the "[Name] " prefix deliverToSession prepends, so the detectors below
 * work on both the delivered form and a bare body. Wider than ATTRIBUTION_RE's
 * 40-char cap on purpose: a worker is attributed as "worker <session-id>",
 * which is 47 chars and so never parses as an attribution — the very reason
 * those turns used to render as raw "[worker os-…] …" in the human's bubble.
 */
const ATTR_PREFIX_RE = /^\[[^\]\n]{1,80}\]\s*/;

/**
 * A worker's report to its parent (workerReportPayload in sessions-tools.ts):
 * a child session's findings, delivered as a user turn but authored by an
 * agent. Matched on the "worker <session-id>" attribution (carried since the
 * feature shipped, so old transcripts classify too) and/or the sentinel.
 */
const WORKER_ATTR_RE = /^\[worker\s+([^\]\s]+)\]\s*/;
const WORKER_SENTINEL_RE = /^<!--os:worker-report(?::([^\s>]+))?-->\s*/;
const LEGACY_WORKER_FAILURE_RE =
  /^Server notice:\s+(?=worker task `((?:os|bks)-[a-z0-9-]+)` ended in error without reporting back\.)/i;

/**
 * Notices stack: a worker whose whole job was a workflow reports back with the
 * workflow nudge as its body, so the turn carries both sentinels and the
 * matching detector only consumes its own. The markdown renderer escapes HTML,
 * so anything left over would render as a literal `<!--os:…-->` line.
 */
const LEADING_SENTINEL_RE = /^\s*<!--os:[a-z-]+(?::[^\s>]+)?-->\s*/;

function stripLeadingSentinels(text: string): string {
  let out = text;
  while (LEADING_SENTINEL_RE.test(out))
    out = out.replace(LEADING_SENTINEL_RE, "");
  return out;
}

export function parseWorkerReport(
  content?: string,
): { sessionId: string | null; body: string } | null {
  if (!content) return null;
  let text = content;
  let sessionId: string | null = null;
  const attr = text.match(WORKER_ATTR_RE);
  if (attr) {
    sessionId = attr[1];
    text = text.slice(attr[0].length);
  }
  const sentinel = text.match(WORKER_SENTINEL_RE);
  if (sentinel) {
    sessionId = sentinel[1] || sessionId;
    text = text.slice(sentinel[0].length);
  }
  const failure = text.match(LEGACY_WORKER_FAILURE_RE);
  if (failure) {
    sessionId = failure[1];
    text = text.slice(failure[0].length).replace(/^worker\b/i, "Worker");
  }
  if (!attr && !sentinel && !failure) return null;
  return { sessionId, body: stripLeadingSentinels(text).trim() };
}

/**
 * The "your workflow finished, pick the results up" nudge (wakeOwningSession
 * in workflow-runner.ts). Delivered attributed to the human who launched the
 * run, so without this it reads as a message they typed. The status-emoji
 * opener is the fallback for nudges delivered before the sentinel shipped.
 */
const WORKFLOW_SENTINEL_RE = /^<!--os:workflow-notice(?::([^\s>]+))?-->\s*/;
const LEGACY_WORKFLOW_RE = /^(?:✅|⚠️|⏹️)\s*Workflow\s+["“]/;

export function parseWorkflowNotice(
  content?: string,
): { runId: string | null; body: string } | null {
  if (!content) return null;
  const text = content.replace(ATTR_PREFIX_RE, "");
  const sentinel = text.match(WORKFLOW_SENTINEL_RE);
  const body = (sentinel ? text.slice(sentinel[0].length) : text).trim();
  if (!sentinel && !LEGACY_WORKFLOW_RE.test(body)) return null;
  // The notice must be the WHOLE message. A human typing while it lands gets
  // their words merged into the same turn ("<notice>\n\n<their question>") —
  // dimming those into a notice would hide what they actually asked, so a
  // merged turn stays an ordinary user bubble.
  if (/\n\s*\n/.test(body)) return null;
  const run = sentinel?.[1] || body.match(/\b(wf-[\w-]+)/)?.[1] || null;
  return { runId: run, body };
}

/**
 * The synthetic continuation prompt emitted after a service restart. Persisted
 * as a user turn because the engine must act on it, but operational metadata
 * rather than something the human typed. Matched on the stable sentence rather
 * than the persona name, so renamed personas and older transcripts classify
 * the same.
 */
const RECOVERY_NOTICE_RE =
  /^This session was interrupted by an? [^\n]{1,80} service restart mid-run\.\s/;

export function parseRecoveryNotice(content?: string): { body: string } | null {
  if (!content || !RECOVERY_NOTICE_RE.test(content)) return null;
  return { body: content };
}

/**
 * A message one agent sent into another session. New deliveries carry the
 * sentinel. The strict `agent <session-id>` attribution recovers messages
 * already stored before every send_to_session payload was marked.
 */
const SESSION_NOTICE_SENTINEL_RE = /^<!--os:session-notice-->\s*/;
const AGENT_ATTR_RE = /^\[agent\s+((?:os|bks)-[a-z0-9-]+)\]\s*/i;
const LEGACY_SESSION_NOTICE_RE =
  /^Heads-up from another session(?:\s*\([^\n)]*\))?:/i;

export function parseSessionNotice(
  content?: string,
): { body: string; sessionId: string | null } | null {
  if (!content) return null;
  let text = content;
  let sessionId: string | null = null;
  const agent = text.match(AGENT_ATTR_RE);
  if (agent) {
    sessionId = agent[1];
    text = text.slice(agent[0].length);
  } else {
    text = text.replace(ATTR_PREFIX_RE, "");
  }
  const sentinel = text.match(SESSION_NOTICE_SENTINEL_RE);
  const body = (sentinel ? text.slice(sentinel[0].length) : text).trim();
  if (!agent && !sentinel && !LEGACY_SESSION_NOTICE_RE.test(body)) return null;
  // Old co-released steers can share one entry with a real attributed human
  // prompt. Keep that mixed entry visible rather than hiding the prompt inside
  // a collapsed notice. New delegated messages drain alone at the queue layer.
  if (/\n\s*\n\[[^\]\n]{1,80}\]\s+/.test(body)) return null;
  return { body, sessionId };
}

/**
 * A turn that re-uploaded the whole conversation instead of reading it back
 * from the prompt cache (isLikelyPromptCacheMiss in events.ts).
 *
 * Worth a line in the transcript because it is the one cost event a reader can
 * act on: a miss re-sends every token of the conversation, so a turn that
 * should have cost cache reads costs roughly twenty times that. Written as an
 * ordinary runner notice, which classifies as a neutral (info) system line.
 * Nothing broke, and the run continued.
 *
 * The token count is the turn's `cacheCreationTokens`: what was actually
 * re-cached. Dropped below 1k, where "~0k" would say less than nothing.
 */
export function cacheMissNotice(cacheCreationTokens?: number): string {
  const head = "This turn re-uploaded the conversation";
  const tokens = cacheCreationTokens ?? 0;
  if (tokens < 1000) return head;
  return `${head} · ~${Math.round(tokens / 1000)}k tokens re-cached`;
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/**
 * Notices the transcript's raw form already identified (`entry.noticeKind`),
 * so all this end has to do is say how they read. A new one is a row here,
 * not a branch — and not a new field on the wire.
 */
const PARSED_NOTICES: Record<string, Omit<EntryNotice, "tone">> = {
  compaction: {
    kind: "compaction",
    title: "Context compacted",
  },
  recap: { kind: "recap", title: "Recap", body: "inline" },
  "context-injection": {
    kind: "context-injection",
    title: "Injected context",
    body: "collapsed",
  },
  "standing-context": {
    kind: "standing-context",
    title: "Standing context",
    body: "collapsed",
  },
};

/** The transcript's record of model-visible input the harness gave the engine:
 *  a payload injected into one prompt, or the standing context (tool surface,
 *  instructions) a session runs under (context-log.ts). Not conversation: a
 *  durable audit row, so every client-bound projection drops it. Both kinds
 *  answer to this one predicate on purpose — a new record kind inherits every
 *  exclusion instead of having to be added to each of them. */
export function isContextInjection(entry: TranscriptEntry): boolean {
  return (
    entry.noticeKind === "context-injection" ||
    entry.noticeKind === "standing-context" ||
    !!entry.contextInjection
  );
}

/** Drop injection records on the way to a client. Same "on the way out"
 *  discipline as classification: nothing is deleted, it just isn't
 *  conversation. Returns the same array when there was nothing to drop. */
export function dropContextInjections<T extends TranscriptEntry>(
  entries: T[],
): T[] {
  return entries.some(isContextInjection)
    ? entries.filter((e) => !isContextInjection(e))
    : entries;
}

/**
 * The durable record of an answered question card (asks.ts).
 *
 * One string carries both halves: a title line (the pick, which is what a
 * reader scanning the transcript wants) and a markdown body (the question and
 * the options it was chosen from, behind the show toggle). Keeping it in
 * `content` means the record rides the ordinary entry path with no new wire
 * field, and this pair is the only code that knows the layout.
 */
export function askRecordContent(title: string, body: string): string {
  return body ? `${title}\n${body}` : title;
}

function parseLegacyAnsweredAsk(body: string): AnsweredAskData | undefined {
  const questions: AnsweredAskData["questions"] = [];
  let current: AnsweredAskData["questions"][number] | undefined;
  let selected: string[] = [];
  const finish = () => {
    if (!current) return;
    current.answer = selected.join(", ");
    questions.push(current);
    current = undefined;
    selected = [];
  };

  for (const raw of body.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    if (
      line.startsWith("**") &&
      line.endsWith("**") &&
      !line.startsWith("- ")
    ) {
      finish();
      const combined = line.slice(2, -2).trim();
      const headed = combined.match(/^([^:*_`\[\]{}]{1,40}):\s+(.+)$/);
      current = {
        question: headed ? headed[2] : combined,
        ...(headed ? { header: headed[1].trim() } : {}),
        options: [],
        answer: "",
      };
      if (!current.question) return undefined;
      continue;
    }
    if (!current) return undefined;
    if (line === "- No answer.") continue;
    const typed = line.match(/^- \*\*(.+)\*\* \(typed\)$/);
    if (typed) {
      selected.push(typed[1]);
      continue;
    }
    const picked = line.match(/^- \*\*[A-Z-]\. (.+)\*\*$/);
    if (picked) {
      current.options!.push({ label: picked[1] });
      selected.push(picked[1]);
      continue;
    }
    const option = line.match(/^- [A-Z-]\. (.+)$/);
    if (option) {
      current.options!.push({ label: option[1] });
      continue;
    }
    return undefined;
  }
  finish();
  if (!questions.length) return undefined;
  for (const q of questions) {
    if (!q.options?.length) delete q.options;
    if (
      (q.options?.filter((o) => q.answer.split(", ").includes(o.label))
        .length ?? 0) > 1
    )
      q.multiSelect = true;
  }
  return { version: 1, questions };
}

export function parseAskRecord(
  content: string,
  structured?: unknown,
): {
  title: string;
  body: string;
  ask?: AnsweredAskData;
} {
  const nl = (content || "").indexOf("\n");
  const title = (nl === -1 ? content || "" : content.slice(0, nl)).trim();
  const body = nl === -1 ? "" : content.slice(nl + 1).trim();
  const ask = parseAnsweredAskData(structured) ?? parseLegacyAnsweredAsk(body);
  return { title, body, ...(ask ? { ask } : {}) };
}

/**
 * A status line whose whole notice is its own text: the title IS the body, and
 * the presentation is derived from the phrasing. One helper for the three
 * branches that build one, so a runner notice, a GitHub event and a workflow
 * result cannot drift into three different readings of the same sentence.
 */
function statusNotice(kind: NoticeKind, body: string): EntryNotice {
  const tone = noticeTone(body);
  const icon = tone === "info" ? noticeIcon(body) : undefined;
  return { kind, title: body, tone, ...(icon ? { icon } : {}) };
}

/**
 * Tag one entry with how it should read, stripping delivery plumbing out of
 * `content` as it goes. Returns the entry unchanged (same reference) when it
 * is an ordinary message — the common case, and what keeps this cheap enough
 * to run over a whole transcript on every read.
 *
 * Idempotent: an already-classified entry passes straight through, so running
 * it twice on the same payload (a re-send, a client re-classifying an outbox
 * item the server has since tagged) can't double-strip.
 */
export function classifyEntry(entry: TranscriptEntry): TranscriptEntry {
  // During a rolling deploy, an older server may already have classified an
  // ask into its generic title + markdown notice before the newer web bundle
  // receives it. Upgrade that one legacy shape client-side; every complete
  // notice and every attributed message stays idempotent by reference.
  if (entry.notice?.kind === "ask" && !entry.notice.ask) {
    const { ask } = parseAskRecord(
      `${entry.notice.title}\n${entry.content}`,
      entry.ask,
    );
    if (ask) return { ...entry, notice: { ...entry.notice, ask } };
  }
  if (entry.notice || entry.sender) return entry;

  if (entry.type === "system") {
    // An answered question: the title is the pick, the body is what it was
    // picked from. Not a PARSED_NOTICES row because its title is the record,
    // not a fixed label.
    if (entry.noticeKind === "ask") {
      const { title, body, ask } = parseAskRecord(entry.content, entry.ask);
      return {
        ...entry,
        content: body,
        notice: {
          kind: "ask",
          title,
          tone: "info",
          ...(body ? { body: "collapsed" as const } : {}),
          ...(ask ? { ask } : {}),
        },
      };
    }
    const parsed = entry.noticeKind && PARSED_NOTICES[entry.noticeKind];
    if (parsed) return { ...entry, notice: { tone: "info", ...parsed } };
    const content = stripNoticeGlyph(entry.content);
    return { ...entry, content, notice: statusNotice("system", content) };
  }

  if (entry.type !== "user") return entry;

  const recovery = parseRecoveryNotice(entry.content);
  if (recovery)
    return {
      ...entry,
      content: recovery.body,
      notice: {
        kind: "recovery",
        title: "Session resumed after a service restart",
        tone: "info",
      },
    };

  const worker = parseWorkerReport(entry.content);
  if (worker)
    return {
      ...entry,
      content: worker.body,
      notice: {
        kind: "worker-report",
        title: "Worker report",
        tone: "info",
        body: "collapsed",
        ...(worker.sessionId
          ? { link: { label: "Open worker", sessionId: worker.sessionId } }
          : {}),
      },
    };

  const workflow = parseWorkflowNotice(entry.content);
  if (workflow) {
    const body = stripNoticeGlyph(workflow.body);
    return { ...entry, content: body, notice: statusNotice("workflow", body) };
  }

  const sessionNotice = parseSessionNotice(entry.content);
  if (sessionNotice)
    return {
      ...entry,
      content: sessionNotice.body,
      notice: {
        kind: "session-notice",
        title: "Message from another session",
        tone: "info",
        body: "collapsed",
        ...(sessionNotice.sessionId
          ? {
              link: {
                label: "Open session",
                sessionId: sessionNotice.sessionId,
              },
            }
          : {}),
      },
    };

  // A teammate's routed-back answer keeps a bubble, credited to them.
  const human = parseHumanReply(entry.content);
  if (human)
    return {
      ...entry,
      content: human.body,
      sender: human.name,
      ...(human.viaSlack ? { senderVia: "slack" as const } : {}),
    };

  const attribution = parseAttribution(entry.content);
  if (!attribution) return entry;

  if (isGitHubAttribution(attribution.name)) {
    const handoff = parseReviewHandoff(attribution.body);
    if (handoff)
      return {
        ...entry,
        content: handoff.body,
        notice: {
          kind: "review-handoff",
          title: handoff.prNumber
            ? `PR #${handoff.prNumber} review feedback`
            : "PR review feedback",
          tone: "info",
          body: "collapsed",
        },
      };
    // Everything else GitHub says is a short status line ("merged into main").
    const body = stripNoticeGlyph(attribution.body);
    return { ...entry, content: body, notice: statusNotice("system", body) };
  }

  return { ...entry, content: attribution.body, sender: attribution.name };
}

/** Classify a batch; returns the same array when nothing needed tagging. */
export function classifyEntries(entries: TranscriptEntry[]): TranscriptEntry[] {
  let changed = false;
  const out = entries.map((e) => {
    const c = classifyEntry(e);
    if (c !== e) changed = true;
    return c;
  });
  return changed ? out : entries;
}
