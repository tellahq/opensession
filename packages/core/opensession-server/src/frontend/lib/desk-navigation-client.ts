import {
  deskNavigationPollSchema,
  type DeskNavigationRequest,
} from "../../shared/desk-navigation";
import { BASE_PATH } from "./base";
import { showDeskTarget } from "./desk-show";

/** Runs only inside the browser that owns this call. The token lives in memory
 * and requests use the current sign-in cookie, so sign-out/re-login fails shut.
 */
export class DeskNavigationClient {
  private readonly abort = new AbortController();
  private started = false;
  private lastResult: { id: string; shown: boolean } | null = null;

  constructor(
    private readonly liveSessionId: string,
    private readonly token: string,
    private readonly show = showDeskTarget,
    private readonly request: (
      body: DeskNavigationRequest,
      signal: AbortSignal,
    ) => Promise<Response> = async (body, signal) => {
      const response = await fetch(
        `${BASE_PATH}/api/desk/voice/live/navigation`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal,
        },
      );
      if (!response.ok) throw new Error("Voice navigation disconnected");
      return response;
    },
  ) {}

  /** One bounded poll. Retries acknowledge the previous result, never navigate twice. */
  async poll(): Promise<void> {
    if (this.abort.signal.aborted) return;
    const raw = await this.request(
      { action: "poll", liveSessionId: this.liveSessionId, token: this.token },
      this.abort.signal,
    );
    if (this.abort.signal.aborted) return;
    if (!raw.ok) throw new Error("Voice navigation disconnected");
    const { command } = deskNavigationPollSchema.parse(await raw.json());
    if (this.abort.signal.aborted) return;
    if (!command || command.expiresAt <= Date.now()) return;
    if (this.lastResult?.id !== command.id) {
      this.lastResult = { id: command.id, shown: this.show(command.target) };
    }
    if (this.abort.signal.aborted) return;
    const ack = await this.request(
      {
        action: "ack",
        liveSessionId: this.liveSessionId,
        token: this.token,
        commandId: command.id,
        shown: this.lastResult.shown,
      },
      this.abort.signal,
    );
    if (!ack.ok) throw new Error("Voice navigation disconnected");
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    try {
      while (!this.abort.signal.aborted) {
        await this.poll();
        await new Promise<void>((resolve) => {
          if (this.abort.signal.aborted) return resolve();
          const finish = () => {
            clearTimeout(timer);
            this.abort.signal.removeEventListener("abort", finish);
            resolve();
          };
          const timer = setTimeout(finish, 750);
          this.abort.signal.addEventListener("abort", finish, { once: true });
        });
      }
    } catch {
      // No blind retry after an auth failure or changed login. A new call gets
      // a new capability. Pending actions time out honestly on the server.
      this.stop();
    }
  }

  stop(): void {
    this.abort.abort();
  }
}
