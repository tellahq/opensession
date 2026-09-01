import { measureSessionPerf } from "../../lib/session-performance";

export class SessionShellTiming {
  private recorded = false;
  constructor(private readonly startedAt: number) {}
  record() {
    if (this.recorded) return;
    this.recorded = true;
    measureSessionPerf("shell_to_transcript_ms", this.startedAt);
  }
}
