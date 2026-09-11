import {
  deskNavigationConnectionSchema,
  type DeskNavigationConnection,
  type DeskNavigationBinding,
  type DeskNavigationConnect,
} from "../../shared/desk-navigation";
import { DeskNavigationClient } from "./desk-navigation-client";
import { showDeskTarget } from "./desk-show";
import { BASE_PATH } from "./base";

const API = `${BASE_PATH}/api/desk/navigation`;

export class DeskTextNavigationClient {
  private connection: {
    connectionId: string;
    token: string;
    client: DeskNavigationClient;
  } | null = null;
  private connecting: Promise<void> | null = null;
  private stopped = false;

  constructor(private readonly sessionId: string) {}

  get disposed() {
    return this.stopped;
  }

  private async post(
    path: "connect" | "bind" | "disconnect",
    body:
      | DeskNavigationConnection
      | DeskNavigationBinding
      | DeskNavigationConnect,
  ) {
    return fetch(`${API}/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(2_000),
    });
  }

  private async connect() {
    const response = await this.post("connect", { sessionId: this.sessionId });
    if (!response.ok) return;
    const connection = deskNavigationConnectionSchema.parse(
      await response.json(),
    );
    if (this.stopped) {
      void this.post("disconnect", connection).catch(() => {});
      return;
    }
    const client = new DeskNavigationClient(
      connection.connectionId,
      connection.token,
      (target) => !document.hidden && !this.stopped && showDeskTarget(target),
      (body, signal) =>
        fetch(`${API}/poll`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal,
        }),
    );
    this.connection = { ...connection, client };
  }

  /** Register the existing prompt requestId before WebSocket intake. This is
   * optional: a signed-out or disconnected client can still send ordinary text.
   */
  async prepare(requestId: string): Promise<void> {
    if (this.stopped) return;
    try {
      if (!this.connection?.client.active) {
        this.connecting ??= this.connect();
        await this.connecting;
        this.connecting = null;
      }
      const connection = this.connection;
      if (!connection || this.stopped) return;
      const response = await this.post("bind", {
        connectionId: connection.connectionId,
        token: connection.token,
        requestId,
      });
      if (response.ok && !this.stopped) void connection.client.start();
      else connection.client.stop();
    } catch {
      this.connecting = null;
      // Navigation is optional, never a reason to lose the person's message.
    }
  }

  dispose(): void {
    this.stopped = true;
    const connection = this.connection;
    if (!connection) return;
    connection.client.stop();
    void fetch(`${API}/disconnect`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        connectionId: connection.connectionId,
        token: connection.token,
      }),
      keepalive: true,
    }).catch(() => {});
    this.connection = null;
  }
}
