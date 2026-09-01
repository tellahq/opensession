/**
 * What "Continue" sends after a run failed.
 *
 * A terminal failure leaves the session idle with nothing to act on but a red
 * notice telling you to send the prompt again, so the transcript's error pill
 * offers this as one press (MessageBubble's NoticeRow). It is an ordinary
 * prompt, deliberately: a fresh turn on the same session is exactly what
 * retyping would do, and the wording mirrors the runner's own restart
 * continuation (RESUME_CONTINUATION_PROMPT in agent-runner.ts) so a run that
 * died mid-task picks the work back up instead of starting it over.
 *
 * Kept short because it lands in the transcript as your own message.
 */
export const CONTINUE_AFTER_FAILURE_PROMPT =
  "Continue where you left off and finish the task. If the work was already done, post the final summary.";
