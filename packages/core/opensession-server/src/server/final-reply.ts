/**
 * The part of a turn's assistant text that answers the person: the text after
 * the turn's last tool call. Text written between tool calls is working
 * narration ("Checking the logs next."); the session shows it live, so
 * external mirrors (a Slack thread, a Plain discussion) post only the answer.
 *
 * A turn that ends on a tool call has no trailing text; then the last
 * non-empty stretch of text stands in for the answer.
 */
export class FinalReplyText {
  private current = "";
  private previous = "";

  /** A streamed assistant text chunk. */
  text(chunk: string | undefined): void {
    if (!chunk) return;
    this.current += chunk;
  }

  /** A tool call ends the current stretch of text. */
  toolUse(): void {
    if (this.current.trim()) this.previous = this.current;
    this.current = "";
  }

  get value(): string {
    return (this.current.trim() ? this.current : this.previous).trim();
  }
}
