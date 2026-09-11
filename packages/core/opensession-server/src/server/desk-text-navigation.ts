import { DeskVoiceNavigation } from "./desk-voice-navigation";
import type { DeskNavigationRequest } from "../shared/desk-navigation";

const CONNECTION_TTL_MS = 60_000;
const PROMPT_TTL_MS = 5 * 60_000;
const MAX_CONNECTIONS = 128;
const MAX_PROMPTS = 512;

type Connection = {
  id: string;
  sessionId: string;
  login: string;
  navigation: DeskVoiceNavigation;
  touchedAt: number;
};
type Prompt = { connection: Connection; accepted: boolean; expiresAt: number };
type Turn = {
  connection: Connection;
  sessionId: string;
  promptEntryId: string;
};

/** Ephemeral browser authority, never persisted with the prompt or exposed to
 * the model. A restart loses the capability rather than replaying navigation.
 */
export class DeskTextNavigation {
  private readonly connections = new Map<string, Connection>();
  private readonly prompts = new Map<string, Prompt>();
  private readonly turns = new Map<string, Turn>();

  constructor(private readonly now = Date.now) {}

  private remove(connection: Connection) {
    connection.navigation.close();
    this.connections.delete(connection.id);
    for (const [id, prompt] of this.prompts) {
      if (prompt.connection === connection) this.prompts.delete(id);
    }
    for (const [id, turn] of this.turns) {
      if (turn.connection === connection) this.turns.delete(id);
    }
  }

  private prune() {
    for (const connection of this.connections.values()) {
      if (this.now() - connection.touchedAt > CONNECTION_TTL_MS)
        this.remove(connection);
    }
    for (const [id, prompt] of this.prompts) {
      if (prompt.expiresAt <= this.now()) this.prompts.delete(id);
    }
  }

  connect(sessionId: string, login: string) {
    this.prune();
    if (!login || this.connections.size >= MAX_CONNECTIONS) return null;
    const connection: Connection = {
      id: crypto.randomUUID(),
      sessionId,
      login: login.toLowerCase(),
      navigation: new DeskVoiceNavigation(login),
      touchedAt: this.now(),
    };
    this.connections.set(connection.id, connection);
    return { connectionId: connection.id, token: connection.navigation.token };
  }

  private owned(login: string, connectionId: string, token: string) {
    this.prune();
    const connection = this.connections.get(connectionId);
    if (
      !connection ||
      !login ||
      connection.login !== login.toLowerCase() ||
      connection.navigation.token !== token
    )
      return null;
    connection.touchedAt = this.now();
    return connection;
  }

  bind(
    login: string,
    connectionId: string,
    token: string,
    requestId: string,
  ): boolean {
    const connection = this.owned(login, connectionId, token);
    if (!connection || this.prompts.size >= MAX_PROMPTS) return false;
    const existing = this.prompts.get(requestId);
    // A different tab must not overwrite an already registered message.
    if (existing) return existing.connection === connection;
    this.prompts.set(requestId, {
      connection,
      accepted: false,
      expiresAt: this.now() + PROMPT_TTL_MS,
    });
    return true;
  }

  /** Called only after the authenticated WebSocket has validated the prompt.
   * Registering over HTTP alone cannot authorize a later machine-delivered turn.
   */
  accept(sessionId: string, requestId: string, login: string | undefined) {
    this.prune();
    const prompt = this.prompts.get(requestId);
    const accepted =
      !!prompt &&
      !!login &&
      prompt.connection.sessionId === sessionId &&
      prompt.connection.login === login.toLowerCase();
    if (accepted) prompt.accepted = true;
  }

  /** A steer from another browser, native client, or machine invalidates the
   * old turn's UI authority before that content reaches the running model. */
  steer(sessionId: string, requestId: string) {
    this.prune();
    const prompt = this.prompts.get(requestId);
    const connection =
      prompt?.accepted && prompt.connection.sessionId === sessionId
        ? prompt.connection
        : undefined;
    if (connection) this.prompts.delete(requestId);
    for (const [key, turn] of this.turns) {
      if (turn.sessionId === sessionId && turn.connection !== connection) {
        turn.connection.navigation.cancelPending();
        this.turns.delete(key);
      }
    }
  }

  /** A queue batch may navigate only if every source message came from the
   * same verified browser. Mixed tabs or machine messages fail closed.
   */
  begin(
    sessionId: string,
    promptEntryId: string | undefined,
    sourceMessageIds: string[] = [],
  ): () => void {
    this.prune();
    if (!promptEntryId || sourceMessageIds.length === 0) return () => {};
    const prompts = sourceMessageIds.map((id) => this.prompts.get(id));
    const connection = prompts[0]?.connection;
    for (const id of sourceMessageIds) {
      if (this.prompts.get(id)?.connection.sessionId === sessionId)
        this.prompts.delete(id);
    }
    if (
      !connection ||
      connection.sessionId !== sessionId ||
      !prompts.every((p) => p?.accepted && p.connection === connection)
    )
      return () => {};
    const key = `${sessionId}:${promptEntryId}`;
    const turn: Turn = { connection, sessionId, promptEntryId };
    this.turns.set(key, turn);
    return () => {
      if (this.turns.get(key) !== turn) return;
      connection.navigation.cancelPending();
      this.turns.delete(key);
    };
  }

  forTurn(
    sessionId: string,
    promptEntryId: string | undefined,
  ): Pick<DeskVoiceNavigation, "show"> | undefined {
    this.prune();
    if (!promptEntryId) return undefined;
    const key = `${sessionId}:${promptEntryId}`;
    const turn = this.turns.get(key);
    if (!turn) return undefined;
    return {
      show: (target) => {
        this.prune();
        if (this.turns.get(key) !== turn)
          return Promise.resolve({
            shown: false,
            error: "This text turn can no longer navigate its browser.",
          });
        return turn.connection.navigation.show(target);
      },
    };
  }

  handle(login: string, request: DeskNavigationRequest) {
    const connection = this.owned(login, request.connectionId, request.token);
    if (!connection) return null;
    const result = connection.navigation.handle(login, request);
    if (!result || request.action !== "poll") return result;
    const pending =
      [...this.prompts.values()].some((p) => p.connection === connection) ||
      [...this.turns.values()].some((t) => t.connection === connection);
    if (!pending) {
      this.remove(connection);
      return { command: null, finished: true };
    }
    return result;
  }

  disconnect(login: string, connectionId: string, token: string): boolean {
    const connection = this.owned(login, connectionId, token);
    if (!connection) return false;
    this.remove(connection);
    return true;
  }
}

export const deskTextNavigation = new DeskTextNavigation();
