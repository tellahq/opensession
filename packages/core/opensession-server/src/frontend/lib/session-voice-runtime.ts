import {
  SessionVoiceClient,
  type SessionVoiceState,
} from "./session-voice-client";
import {
  SessionVoiceReplies,
  SessionVoiceAgentReply,
  sessionVoiceRequests,
} from "./session-voice-replies";
import { sessionVoiceContext } from "../../shared/session-voice";
import { promptOutbox, type PromptOutboxInput } from "./prompt-outbox";
import { getCurrentUser } from "../components/UserPicker";
import { orderTranscriptEntries } from "./transcript-state";
import type { SessionVoiceLevels } from "./session-voice-audio";
import type { TranscriptEntry, WSServerMessage } from "./types";

type VoiceClient = Pick<
  SessionVoiceClient,
  "start" | "stop" | "setPaused" | "updateContext" | "agentReply"
>;
interface VoiceDependencies {
  createClient: (
    options: ConstructorParameters<typeof SessionVoiceClient>[0],
  ) => VoiceClient;
  enqueue: (input: PromptOutboxInput) => string | void;
  currentUser: () => string;
}
const defaults: VoiceDependencies = {
  createClient: (options) => new SessionVoiceClient(options),
  enqueue: (input) => {
    return promptOutbox.enqueue(input).clientId;
  },
  currentUser: getCurrentUser,
};
export interface SessionVoiceSnapshot {
  sessionId: string | null;
  title: string;
  state: SessionVoiceState;
  active: boolean;
  sourceVisible: boolean;
  error: string | null;
}
interface VoiceStart {
  sessionId: string;
  title: string;
  entries: TranscriptEntry[];
  busy: boolean;
}

/** One browser call, owned above routed session views. Browsing never destroys
 * it or changes its source thread; only an explicit new call replaces it. */
export class SessionVoiceRuntime {
  readonly levels: SessionVoiceLevels = { current: { input: 0, output: 0 } };
  private snapshot: SessionVoiceSnapshot = {
    sessionId: null,
    title: "",
    state: "idle",
    active: false,
    sourceVisible: false,
    error: null,
  };
  private listeners = new Set<() => void>();
  private views = new Map<symbol, { sessionId: string; visible: boolean }>();
  private client: VoiceClient | null = null;
  private entries: TranscriptEntry[] = [];
  private busy = false;
  private user = "";
  private updates: SessionVoiceReplies | null = null;
  private agentReplies: SessionVoiceAgentReply[] = [];
  private requests = sessionVoiceRequests();
  private narratedReplies = new Set<string>();
  constructor(private deps: VoiceDependencies = defaults) {}

  getSnapshot = () => this.snapshot;
  isActive = () => this.snapshot.active;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private publish(patch: Partial<SessionVoiceSnapshot>) {
    const next = { ...this.snapshot, ...patch };
    if (
      next.sessionId === this.snapshot.sessionId &&
      next.title === this.snapshot.title &&
      next.state === this.snapshot.state &&
      next.active === this.snapshot.active &&
      next.sourceVisible === this.snapshot.sourceVisible &&
      next.error === this.snapshot.error
    )
      return;
    this.snapshot = next;
    for (const listener of this.listeners) listener();
  }

  setView(token: symbol, sessionId: string, visible: boolean) {
    this.views.set(token, { sessionId, visible });
    this.refreshVisibility();
  }
  removeView(token: symbol) {
    this.views.delete(token);
    this.refreshVisibility();
  }
  private refreshVisibility() {
    this.publish({
      sourceVisible: [...this.views.values()].some(
        (view) => view.sessionId === this.snapshot.sessionId && view.visible,
      ),
    });
  }

  start(source: VoiceStart) {
    this.stop();
    this.entries = source.entries;
    this.busy = source.busy;
    this.user = this.deps.currentUser();
    this.updates = new SessionVoiceReplies(source.entries);
    this.agentReplies = [];
    this.requests = sessionVoiceRequests();
    this.narratedReplies.clear();
    const client = this.deps.createClient({
      sessionId: source.sessionId,
      context: sessionVoiceContext(source.entries),
      levels: this.levels,
      onAgentRequest: (prompt) => {
        if (
          this.client !== client ||
          !this.snapshot.active ||
          this.snapshot.state === "paused" ||
          this.deps.currentUser() !== this.user
        )
          return false;
        const reply = new SessionVoiceAgentReply(
          prompt,
          this.entries,
          this.requests,
        );
        this.agentReplies.push(reply);
        try {
          // No routed composer closure: this still addresses the original
          // thread when its view has unmounted. The ordinary durable outbox
          // keeps auth, permission checks and retry semantics. Every task
          // steers: an idle agent starts a turn with it, a busy one folds it
          // into the running turn instead of holding it until that run ends.
          const messageId = this.deps.enqueue({
            sessionId: source.sessionId,
            content: prompt,
            user: this.user,
            busyMode: "steer",
          });
          if (messageId) {
            reply.messageId = messageId;
            this.requests.deliveryIds.add(messageId);
          }
          return true;
        } catch {
          this.agentReplies = this.agentReplies.filter(
            (pending) => pending !== reply,
          );
          return false;
        }
      },
      onState: (state, detail) => {
        if (this.client !== client) return;
        this.publish({
          state,
          active: state !== "idle" && state !== "error",
          error: state === "error" ? (detail ?? "Voice call failed.") : null,
        });
      },
    });
    this.client = client;
    this.publish({
      sessionId: source.sessionId,
      title: source.title,
      state: "connecting",
      active: true,
      error: null,
    });
    this.refreshVisibility();
    void client.start();
  }

  stop = () => {
    const client = this.client;
    this.client = null;
    client?.stop();
    this.agentReplies = [];
    this.requests = sessionVoiceRequests();
    this.narratedReplies.clear();
    this.publish({ active: false, state: "idle", error: null });
  };
  togglePause = () => this.client?.setPaused(this.snapshot.state !== "paused");
  dismissError = () => this.publish({ error: null });

  private observe() {
    if (!this.client || !this.snapshot.active) return;
    if (this.updates?.take(this.entries, this.busy))
      this.client.updateContext(sessionVoiceContext(this.entries));
    const completed = new Map<string, { reply: string; prompts: string[] }>();
    // Anchor every request first so an earlier one sees a later sibling's
    // entry as part of the same run rather than as the end of its turn.
    for (const pending of this.agentReplies) pending.anchor(this.entries);
    this.agentReplies = this.agentReplies.filter((pending) => {
      const reply = pending.take(this.entries, this.busy);
      if (reply === null || !pending.replyId) return true;
      const group = completed.get(pending.replyId);
      if (group) group.prompts.push(pending.prompt);
      else completed.set(pending.replyId, { reply, prompts: [pending.prompt] });
      return false;
    });
    for (const [id, { reply, prompts }] of completed) {
      // A later transcript batch can expose another delivery in a turn whose
      // shared answer was already narrated. Retire that request silently.
      this.client.agentReply(
        this.narratedReplies.has(id) ? null : reply,
        prompts.join("\n\n"),
        prompts.length,
      );
      this.narratedReplies.add(id);
    }
  }

  /** The app-level watch remains on the source even when the routed viewer
   * watches another thread. Streaming text is ignored until durable entries. */
  receive = (message: WSServerMessage) => {
    switch (message.type) {
      case "transcript_init":
      case "transcript_append": {
        if (message.sessionId && message.sessionId !== this.snapshot.sessionId)
          return;
        const byId = new Map(
          (message.type === "transcript_init" ? [] : this.entries).map(
            (entry) => [entry.id, entry],
          ),
        );
        for (const entry of message.entries) byId.set(entry.id, entry);
        this.entries = orderTranscriptEntries([...byId.values()]).slice(-500);
        this.observe();
        break;
      }
      case "stream_start":
        if (message.sessionId === this.snapshot.sessionId) this.busy = true;
        break;
      case "session_status":
        if (message.sessionId && message.sessionId !== this.snapshot.sessionId)
          return;
        this.busy = message.isRunning || !!message.safety;
        this.observe();
        break;
    }
  };
}

export const sessionVoice = new SessionVoiceRuntime();
