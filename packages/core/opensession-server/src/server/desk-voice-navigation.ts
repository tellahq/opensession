import type {
  DeskNavigationCommand,
  DeskNavigationRequest,
  DeskShowTarget,
} from "../shared/desk-navigation";

export type DeskNavigationResult =
  | { shown: true }
  | { shown: false; error: string };

/** One browser capability per call, never included in prompts or transcripts.
 * The HTTP route requires both its token and the verified login that started it.
 * Nothing is broadcast to the user's other tabs or to a name-matched user.
 */
export class DeskVoiceNavigation {
  readonly token = crypto.randomUUID();
  private pending: {
    command: DeskNavigationCommand;
    finish: (result: DeskNavigationResult) => void;
  } | null = null;
  private closed = false;

  constructor(
    private readonly login: string,
    private readonly timeoutMs = 10_000,
  ) {}

  handle(
    login: string,
    request: DeskNavigationRequest,
  ): { command: DeskNavigationCommand | null } | { ok: boolean } | null {
    if (
      this.closed ||
      !login ||
      login.toLowerCase() !== this.login.toLowerCase() ||
      request.token !== this.token
    )
      return null;
    if (request.action === "poll")
      return { command: this.pending?.command ?? null };
    if (this.pending?.command.id !== request.commandId) return { ok: false };
    this.pending.finish(
      request.shown
        ? { shown: true }
        : { shown: false, error: "The voice window could not show that page." },
    );
    return { ok: true };
  }

  show(target: DeskShowTarget): Promise<DeskNavigationResult> {
    if (this.closed)
      return Promise.resolve({
        shown: false,
        error: "The voice call has ended.",
      });
    if (this.pending)
      return Promise.resolve({
        shown: false,
        error:
          "Another navigation is pending. Wait for it before opening another page.",
      });
    return new Promise((resolve) => {
      const timer = setTimeout(
        () =>
          finish({
            shown: false,
            error: "The voice window did not confirm navigation.",
          }),
        this.timeoutMs,
      );
      const finish = (result: DeskNavigationResult) => {
        clearTimeout(timer);
        this.pending = null;
        resolve(result);
      };
      this.pending = {
        command: {
          id: crypto.randomUUID(),
          target,
          expiresAt: Date.now() + this.timeoutMs,
        },
        finish,
      };
    });
  }

  close(): void {
    this.closed = true;
    this.pending?.finish({ shown: false, error: "The voice call has ended." });
  }
}
