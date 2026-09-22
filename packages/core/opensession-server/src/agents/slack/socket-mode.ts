/** Outbound Slack intake. No sockets, requests or timers exist until start(). */
export interface SlackSocketModeDependencies {
  dispatchEvent: (payload: unknown) => Promise<void>;
  dispatchInteractive: (payload: unknown) => Promise<void>;
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  createSocket?: (url: string) => WebSocket;
  random?: () => number;
  setTimeout?: typeof setTimeout;
  clearTimeout?: typeof clearTimeout;
  warn?: (message: string) => void;
}

type SocketState =
  | "stopped"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "link_disabled";
interface Connection {
  socket: WebSocket;
  ready: boolean;
}

/** Explicit opt-in avoids activating obsolete app tokens left by older installs. */
export function slackSocketModeEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env.SLACK_SOCKET_MODE === "true";
}

export class SlackSocketMode {
  private state: SocketState = "stopped";
  private active?: Connection;
  private candidate?: Connection;
  private attempt?: AbortController;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private attemptTimer?: ReturnType<typeof setTimeout>;
  private failures = 0;
  private readonly fetch;
  private readonly createSocket;
  private readonly random;
  private readonly later;
  private readonly clear;
  private readonly warn;

  constructor(
    private readonly token: string,
    private readonly deps: SlackSocketModeDependencies,
  ) {
    this.fetch = deps.fetch ?? fetch;
    this.createSocket =
      deps.createSocket ?? ((url: string) => new WebSocket(url));
    this.random = deps.random ?? Math.random;
    this.later = deps.setTimeout ?? setTimeout;
    this.clear = deps.clearTimeout ?? clearTimeout;
    // Never log an exception, response body, ticket URL or token from this transport.
    this.warn =
      deps.warn ??
      ((message: string) => console.warn(`[slack/socket] ${message}`));
  }

  start(): void {
    if (this.state !== "stopped") return;
    if (!this.token.startsWith("xapp-")) {
      this.warn(
        "SLACK_SOCKET_MODE requires a SLACK_APP_TOKEN beginning with xapp-",
      );
      return;
    }
    this.state = "connecting";
    this.connect();
  }

  stop(): void {
    this.state = "stopped";
    this.clear(this.retryTimer);
    this.retryTimer = undefined;
    this.cancelAttempt();
    const active = this.active;
    this.active = undefined;
    active?.socket.close();
    this.failures = 0;
  }

  health(): { state: SocketState; connected: boolean } {
    return { state: this.state, connected: !!this.active };
  }

  private cancelAttempt(): void {
    const attempt = this.attempt;
    this.attempt = undefined;
    attempt?.abort();
    this.clear(this.attemptTimer);
    this.attemptTimer = undefined;
    const candidate = this.candidate;
    this.candidate = undefined;
    candidate?.socket.close();
  }

  private connect(): void {
    if (
      this.state === "stopped" ||
      this.state === "link_disabled" ||
      this.attempt ||
      this.retryTimer
    )
      return;
    const attempt = new AbortController();
    this.attempt = attempt;
    this.state = this.active ? "reconnecting" : "connecting";
    // Covers both ticket acquisition and the WebSocket hello, including a hung handshake.
    this.attemptTimer = this.later(() => this.failed(attempt), 30_000);
    void this.open(attempt).catch(() => this.failed(attempt));
  }

  private async open(attempt: AbortController): Promise<void> {
    const response = await this.fetch(
      "https://slack.com/api/apps.connections.open",
      {
        method: "POST",
        headers: { Authorization: `Bearer ${this.token}` },
        signal: attempt.signal,
        redirect: "error",
      },
    );
    if (this.attempt !== attempt) return;
    if (!response.ok) throw new Error("ticket request failed");
    const body = (await response.json()) as {
      ok?: boolean;
      url?: string;
      error?: string;
    };
    if (this.attempt !== attempt) return;
    if (body.error === "link_disabled") {
      this.disable();
      return;
    }
    if (!body.ok || typeof body.url !== "string")
      throw new Error("ticket refused");
    const url = new URL(body.url);
    // Slack supplies a single-use TLS ticket. Never connect to arbitrary ticket hosts.
    if (
      url.protocol !== "wss:" ||
      !url.hostname.endsWith(".slack.com") ||
      url.username ||
      url.password ||
      url.port
    ) {
      throw new Error("invalid ticket URL");
    }
    const connection: Connection = {
      socket: this.createSocket(url.href),
      ready: false,
    };
    this.candidate = connection;
    connection.socket.addEventListener("message", (event) => {
      void this.receive(connection, event.data).catch(() => {
        this.warn("Envelope handling failed");
      });
    });
    connection.socket.addEventListener("close", () =>
      this.closed(connection, attempt),
    );
    connection.socket.addEventListener("error", () =>
      this.closed(connection, attempt),
    );
  }

  private failed(attempt: AbortController): void {
    if (this.attempt !== attempt) return;
    this.cancelAttempt();
    this.warn("Connection failed; retrying with backoff");
    this.retry();
  }

  private retry(): void {
    if (
      this.state === "stopped" ||
      this.state === "link_disabled" ||
      this.attempt ||
      this.retryTimer
    )
      return;
    this.state = "reconnecting";
    const cap = Math.min(30_000, 1_000 * 2 ** Math.min(this.failures++, 5));
    this.retryTimer = this.later(
      () => {
        this.retryTimer = undefined;
        this.connect();
      },
      Math.floor(this.random() * cap),
    );
  }

  private closed(connection: Connection, attempt: AbortController): void {
    if (this.candidate === connection) {
      this.failed(attempt);
    } else if (this.active === connection) {
      this.active = undefined;
      connection.socket.close();
      this.retry();
    }
  }

  private disable(): void {
    this.stop();
    this.state = "link_disabled";
    this.warn("Socket Mode link disabled; restart after enabling it in Slack");
  }

  private async receive(connection: Connection, data: unknown): Promise<void> {
    if (connection !== this.active && connection !== this.candidate) return;
    if (typeof data !== "string") return;
    let envelope: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(data);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        return;
      envelope = parsed as Record<string, unknown>;
    } catch {
      return;
    }
    if (envelope.type === "hello") {
      if (connection !== this.candidate) return;
      this.clear(this.attemptTimer);
      this.attemptTimer = undefined;
      this.attempt = undefined;
      this.candidate = undefined;
      const old = this.active;
      this.active = connection;
      connection.ready = true;
      this.state = "connected";
      this.failures = 0;
      // Promote only after Slack's hello. Stale close/message callbacks cannot redial.
      old?.socket.close();
      return;
    }
    if (envelope.type === "disconnect") {
      if (envelope.reason === "link_disabled") this.disable();
      else if (connection === this.candidate && this.attempt)
        this.failed(this.attempt);
      else this.connect(); // warning / refresh_requested: keep the old socket until hello.
      return;
    }
    if (
      !connection.ready ||
      typeof envelope.envelope_id !== "string" ||
      !envelope.envelope_id ||
      !envelope.payload ||
      typeof envelope.payload !== "object"
    )
      return;
    const acknowledge = () => {
      if (connection === this.active && connection.socket.readyState === 1) {
        connection.socket.send(
          JSON.stringify({ envelope_id: envelope.envelope_id }),
        );
      }
    };
    if (envelope.type === "events_api") {
      // DM/mention intake persists before returning. Throwing deliberately leaves it unacked.
      await this.deps.dispatchEvent(envelope.payload);
      acknowledge();
    } else if (envelope.type === "interactive") {
      // Slow API calls must not cause Slack to replay a non-durable button press.
      acknowledge();
      await this.deps.dispatchInteractive(envelope.payload);
    }
  }
}
