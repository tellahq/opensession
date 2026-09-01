/**
 * Announce-then-stop guard (pure parts). The instruction-layer fix
 * (28731464, "Finish your turns") still lets an occasional turn end cleanly
 * on a plan sentence with zero tool calls — seen again 2026-07-12 in
 * bks-019f533e ("Research is complete… Now let me read the exact code…"),
 * where the session then sat idle overnight until the user typed "continue".
 * run-session.ts uses this detector to send ONE bounded auto-continue when a
 * clean turn ends on an announced next action.
 */

/** Sentinel user for the auto-continue turn (also keys the one-nudge guard). */
export const AUTO_CONTINUE_USER = "auto-continue";

export const AUTO_CONTINUE_PROMPT =
  "[auto-continue] Your previous turn ended by announcing a next step without " +
  "executing it. Continue now: perform the step you announced, and keep working " +
  "until the task is done or you are genuinely blocked on input only the human " +
  "can give.";

/**
 * Variant for turns that ended on a FABRICATED tool transcript (see
 * looksLikeFabricatedToolTranscript in runner-shared.ts): the model narrated
 * a tool call — and often its result — as text and stopped, convinced the
 * call was in flight (bks-019fad97, 2026-07-29: a raw `<invoke …>` block as
 * the final message). The runner's mid-turn steer can't help when the turn
 * ends right after, so the nudge carries the correction itself.
 */
export const AUTO_CONTINUE_FABRICATED_PROMPT =
  "[auto-continue] Your previous turn ended with what looks like a tool-call " +
  "transcript written out as text. None of it was executed: you authored it, " +
  "and every value in it is fabricated. Re-read the genuine tool results " +
  "earlier in the conversation, actually invoke the tools you only narrated, " +
  "and keep working until the task is done or you are genuinely blocked on " +
  "input only the human can give.";

/**
 * In-runner retry nudge for a turn whose FINAL model completion came back
 * completely empty — zero content blocks, stopReason "stop" (2026-08-21
 * os-01a02486: GLM-5.3's pre-release OpenRouter route ended a 10-minute turn on
 * `content: []` with all-zero usage; pi settled it as a clean turn and the
 * user had to ask "done?"). pi-runner sends this once via session.prompt();
 * the fence keeps it out of the rendered transcript.
 */
export const EMPTY_REPLY_RETRY_PROMPT =
  "[empty-response] Your previous reply reached the engine completely empty — " +
  "no text and no tool calls. Send your final answer for the user's last " +
  "message now: the summary, result, or question you intended to deliver.";

/**
 * Redelivery nudge for user messages a dead turn never read. A busy-send
 * steer is a noReply engine-history append the running turn only picks up at
 * its NEXT LLM step — so when that turn dies first (wedged subagent, abort,
 * provider error), the message sits in the history unprocessed while the
 * receipt has already reconciled away as "delivered" (2026-08-03
 * bks-019fc798: "continue" steered into a wedged oracle turn was silently
 * swallowed; the user had to notice and re-send it). run-session.ts detects
 * the stranded shape (trailing user entries with no assistant reply after an
 * errored turn) and fires ONE redelivery turn carrying this prompt.
 */
export const ORPHANED_STEER_PROMPT =
  "[auto-continue] Your previous turn was interrupted before it could read " +
  "the user's most recent message(s), which are already in this conversation " +
  "just above. Read and address them now, and keep working until the task is " +
  "done or you are genuinely blocked on input only the human can give.";

/**
 * Auto-retry nudge for turns terminated by an engine-bridge wedge (subagent
 * stall / liveness guard: a NEW provider request hung with zero output while
 * established streams kept flowing). The engine state is preserved, so the
 * session can simply continue — but the reattach-path guard has no retry
 * machinery and the primary path surfaces the error once its bounded retry is
 * spent, leaving the session parked on "send again to continue" until a human
 * does (2026-08-03: repeated wedged @oracle-fable / worker-task turns).
 * run-session.ts fires ONE continuation per distinct failure text; the prompt
 * teaches graceful degradation so a second wedge doesn't strand the task.
 */
export const WEDGE_RETRY_PROMPT =
  "[auto-continue] Your previous turn was cut short by an engine stall: a " +
  "sub-agent/provider request produced no output and was aborted. Your work " +
  "and conversation state are preserved. Re-attempt the interrupted step now. " +
  "If a task/oracle consult stalls again or the same failure repeats, proceed " +
  "without it, note explicitly that you skipped it, and finish the task.";

/** Failure text of a mid-turn engine wedge (stall guards, silent bridge). */
export function isWedgeFailure(runFailure: string | null | undefined): boolean {
  if (!runFailure) return false;
  return /wedged|produced no output|went silent/i.test(runFailure);
}

/**
 * Fenced context appended to a prompt that was delivered by ABORTING the
 * running turn (busy-send interrupt). The engine has no mid-turn steer (see
 * "why pi stops": every busy-send is an abort, and the truncated turn
 * left in history primes a short acknowledge-then-stop reply — the main
 * announce-then-stop trigger). This note reframes the delivery as a steer so
 * the model folds it into the work in progress instead of parking. Remove
 * when the engine gains real mid-turn steering (pi v2 delivery:"steer").
 */
export const INTERRUPT_STEER_NOTE =
  "Delivery note: the user sent this while your previous turn was still " +
  "executing; that turn was interrupted to deliver it. Treat it as a mid-task " +
  "steer — fold it into the work in progress and continue executing in THIS " +
  "turn: pick up any interrupted step that is still needed, act on the new " +
  "message, and keep working until done or genuinely blocked. Do not end the " +
  "turn on a bare acknowledgment or an announcement of what you will do.";

/**
 * Does the reply's final sentence read as a next action the model was about
 * to take ("Now let me read the exact code…", "I'll rebase and then open the
 * PR") rather than a completion, question, or handoff to the human?
 * Deliberately narrow — a false positive costs a wasted turn, so anything
 * question-shaped or waiting-on-the-human returns false.
 */
export function announcesNextAction(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  const tail = trimmed.slice(-400);
  const sentences = tail.split(/(?<=[.!?])\s+/);
  const last = (sentences[sentences.length - 1] || "").trim();
  if (!last || last.length < 12) return false;
  if (last.includes("?")) return false;
  // Waiting on the human is a legitimate stop, not an announce-then-stop.
  if (
    /\b(let me know|blocked on|waiting for|awaiting|your call|if you (?:want|prefer|disagree)|say the word|shall i|should i|want me to|i['’]ll (?:wait|hold|leave|stop))\b/i.test(
      last,
    )
  )
    return false;
  if (
    /\b(let me|i['’]ll|i will|i need to|i['’]m going to|i['’]m about to|next,? i|now i['’]m|now i will)\b/i.test(
      last,
    )
  )
    return true;
  // Passive implementation announcements can omit the model as actor, e.g.
  // "Now the init effect's deps need `uploadsReady` added…". Keep this to
  // concrete mutation/verification verbs so explanatory "users need to…"
  // sentences do not trigger another turn.
  if (
    /^(?:now|next),?\s+.{1,180}\bneeds?\s+.{1,120}\b(?:added|updated|changed|fixed|implemented|removed|verified|checked|tested|run)\b/i.test(
      last,
    )
  )
    return true;
  // Noun-phrase step announcements ("Next: where the render path turns X
  // into Y.", "Then: the fallback check.") — 2026-08-03 bks-019fc72d ended
  // its turn on one after a mid-turn tool loss and parked; no first-person
  // verb and no gerund, so every pattern above misses the shape.
  if (/^(?:next(?:\s+step|\s+up)?|then|after that)\s*:\s+\S/i.test(last))
    return true;
  // Bare gerund announcements ("Fetching the review comments on #4791.",
  // "Now running the tests.") — seen 2026-07-12 in bks-019f54f8, where the
  // first-person patterns above missed and the session parked. The verb must
  // be followed by an object-ish token so completion shapes ("Testing
  // complete.", "Everything is working.") and -ing non-verbs ("During the
  // run…") stay out.
  const gerund =
    /^(?:(?:now|next|first|then|ok(?:ay)?),?\s+)?([a-z]+ing)\s+(\S.*)/i.exec(
      last,
    );
  if (!gerund) return false;
  if (NON_VERB_ING.has(gerund[1].toLowerCase())) return false;
  return (
    /^(?:the|a|an|this|that|these|those|it|its|my|our|your|all|both|each|some|more|on)\b/i.test(
      gerund[2],
    ) || /^[A-Z0-9`"'@[#]/.test(gerund[2])
  );
}

/** -ing words that open sentences without being an action the model is taking. */
const NON_VERB_ING = new Set([
  "during",
  "nothing",
  "everything",
  "anything",
  "something",
  "warning",
  "pending",
  "assuming",
  "regarding",
  "according",
  "meaning",
  "interesting",
]);
