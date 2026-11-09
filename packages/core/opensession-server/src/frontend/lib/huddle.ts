import { useSyncExternalStore } from "react";
import { os1Shell } from "./os1-shell";
import { transcribeClip } from "./api/automations";
import { errorMessage } from "./error-message";
import type {
  HuddleChatMessage,
  HuddleRoom,
  HuddleSignalData,
  WSClientMessage,
  WSServerMessage,
} from "./types";

/**
 * The browser's half of a huddle (server/huddles.ts): one voice call at a
 * time, browser to browser over WebRTC, with screen sharing and a text chat.
 * Every person in the call holds a connection to every other (a mesh), which
 * keeps a server out of the audio and video path and suits the handful of
 * people a huddle holds.
 *
 * Each connection carries a video slot from the start, empty until someone
 * shares. Sharing puts the screen into the slot of every connection, so it
 * starts and stops without renegotiating; the server's `sharing` flag says
 * whose slot has a picture in it.
 *
 * The call lives here, not in a component, so it keeps going while the
 * person moves between sessions; HuddleDock shows it wherever they are.
 */

export interface HuddleCall {
  roomId: string;
  label: string;
  sessionId: string | null;
  status: "connecting" | "live";
  /** This browser's id in the room, once the server has seated it. */
  peerId: string | null;
  muted: boolean;
  /** Peer ids (including this one) whose audio is above a talking level. */
  speaking: string[];
  /** This browser's shared screen, while it shares one. */
  screen: MediaStream | null;
  chat: HuddleChatMessage[];
  chatOpen: boolean;
  /** Chat messages from others since the chat was last open. */
  unread: number;
}

interface Snapshot {
  rooms: HuddleRoom[];
  call: HuddleCall | null;
  /** People with a session open right now: who an invite can reach. */
  online: string[];
  /** Each peer's video slot, keyed by peer id. It shows a picture only while
   *  that member is `sharing`. */
  screens: Record<string, MediaStream>;
}

type Send = (message: WSClientMessage) => void;
type AddHandler = (handler: (msg: WSServerMessage) => void) => () => void;

interface Peer {
  pc: RTCPeerConnection;
  audio: HTMLAudioElement;
  pending: RTCIceCandidateInit[];
  /** The video slot this browser fills with its screen while sharing. */
  video: RTCRtpSender | null;
}

/** Talking, on WebRTC's 0-1 `audioLevel` scale. */
const SPEAKING_LEVEL = 0.02;
/** How long each notes clip runs before it is transcribed. */
const NOTE_CLIP_MS = 20_000;

let snapshot: Snapshot = { rooms: [], call: null, online: [], screens: {} };
const listeners = new Set<() => void>();
function set(next: Partial<Snapshot>) {
  snapshot = { ...snapshot, ...next };
  for (const listener of listeners) listener();
}
function setCall(patch: Partial<HuddleCall>) {
  if (snapshot.call) set({ call: { ...snapshot.call, ...patch } });
}

let send: Send | null = null;
let iceServers: RTCIceServer[] = [];
let local: MediaStream | null = null;
let screen: MediaStream | null = null;
const peers = new Map<string, Peer>();
let meterTimer: number | undefined;
let recorder: MediaRecorder | null = null;
let clipTimer: number | undefined;
let inviteHandler: ((invite: HuddleInvite) => void) | null = null;
/** This browser's clips go to the transcriber one at a time, so a slow
 *  server holds at most one of them per person (server/transcribe.ts). */
let notesChain: Promise<void> = Promise.resolve();
/** Said once per call, so a broken transcriber doesn't toast every clip. */
let notesFailureShown = false;
let noticeHandler: ((text: string) => void) | null = null;

export interface HuddleInvite {
  roomId: string;
  label: string;
  sessionId: string | null;
  from: string;
}

/**
 * Connect the call to the app's socket. Returns the unbind. `onInvite` is
 * how a teammate's invite reaches the person; `onNotice` reports what the
 * call cannot do (a full room, a missing microphone).
 */
export function bindHuddles(opts: {
  send: Send;
  addHandler: AddHandler;
  connected: boolean;
  onInvite: (invite: HuddleInvite) => void;
  onNotice: (text: string) => void;
}): () => void {
  send = opts.send;
  inviteHandler = opts.onInvite;
  noticeHandler = opts.onNotice;
  const off = opts.addHandler(handle);
  if (opts.connected) {
    opts.send({ type: "huddles_subscribe" });
    // A reconnect drops this socket from its room on the server: take the
    // seat again rather than talk into a call nobody hears.
    const call = snapshot.call;
    if (call) {
      closePeers();
      opts.send({
        type: "huddle_join",
        roomId: call.roomId,
        label: call.label,
        sessionId: call.sessionId ?? undefined,
      });
    }
  }
  return () => {
    off();
    send = null;
  };
}

function handle(msg: WSServerMessage) {
  switch (msg.type) {
    case "global_presence": {
      const online = [...new Set(msg.viewing.map((v) => v.user))].sort();
      if (online.join() !== snapshot.online.join()) set({ online });
      break;
    }
    case "huddles":
      set({ rooms: msg.rooms });
      syncPeers(msg.rooms);
      syncNotes();
      break;
    case "huddle_joined":
      if (snapshot.call?.roomId !== msg.roomId) return;
      iceServers = msg.iceServers;
      setCall({ peerId: msg.peerId, status: "live", chat: msg.chat ?? [] });
      for (const peerId of msg.peers) void callPeer(peerId);
      // Seated again after a reconnect while sharing.
      if (screen) send?.({ type: "huddle_share", on: true });
      break;
    case "huddle_chat": {
      const call = snapshot.call;
      if (call?.roomId !== msg.roomId) return;
      if (call.chat.some((m) => m.id === msg.message.id)) return;
      const mine =
        call.peerId !== null &&
        msg.message.user.toLowerCase() === myName(call)?.toLowerCase();
      setCall({
        chat: [...call.chat, msg.message].slice(-200),
        unread: call.chatOpen || mine ? call.unread : call.unread + 1,
      });
      break;
    }
    case "huddle_signal":
      void onSignal(msg.from, msg.data);
      break;
    case "huddle_invite":
      if (snapshot.call?.roomId === msg.roomId) return;
      inviteHandler?.(msg);
      break;
    case "huddle_invite_result":
      if (msg.delivered === 0)
        noticeHandler?.(
          `${msg.to} isn't in the app right now. The invite is in their notifications.`,
        );
      break;
    case "huddle_error":
      noticeHandler?.(msg.message);
      leaveHuddle();
      break;
  }
}

export function useHuddles(): Snapshot {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => snapshot,
    () => snapshot,
  );
}

export function huddleRoom(roomId: string): HuddleRoom | null {
  return snapshot.rooms.find((room) => room.roomId === roomId) ?? null;
}

/** The name the server seated this browser under. */
function myName(call: HuddleCall): string | undefined {
  return huddleRoom(call.roomId)?.members.find((m) => m.peerId === call.peerId)
    ?.user;
}

/** Join (or start) a huddle. Leaves the one this browser is in. */
export async function joinHuddle(target: {
  roomId: string;
  label: string;
  sessionId?: string;
}): Promise<void> {
  if (!send) return;
  if (snapshot.call?.roomId === target.roomId) return;
  if (snapshot.call) leaveHuddle();
  notesFailureShown = false;
  set({
    call: {
      roomId: target.roomId,
      label: target.label,
      sessionId: target.sessionId ?? null,
      status: "connecting",
      peerId: null,
      muted: false,
      speaking: [],
      screen: null,
      chat: [],
      chatOpen: false,
      unread: 0,
    },
  });
  try {
    local = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true },
    });
  } catch {
    set({ call: null });
    noticeHandler?.("Allow microphone access to join the huddle.");
    return;
  }
  // Left (or switched) while the permission prompt was up.
  if (snapshot.call?.roomId !== target.roomId) {
    stopLocal();
    return;
  }
  startMeters();
  send?.({
    type: "huddle_join",
    roomId: target.roomId,
    label: target.label,
    sessionId: target.sessionId,
  });
}

export function leaveHuddle(): void {
  if (!snapshot.call) return;
  send?.({ type: "huddle_leave" });
  closePeers();
  stopNotes();
  stopLocal();
  stopScreen();
  window.clearInterval(meterTimer);
  meterTimer = undefined;
  set({ call: null });
}

export function setHuddleMuted(muted: boolean): void {
  if (!snapshot.call) return;
  for (const track of local?.getAudioTracks() ?? []) track.enabled = !muted;
  setCall({ muted });
  send?.({ type: "huddle_mute", muted });
  syncNotes();
}

export function setHuddleNotes(on: boolean): void {
  send?.({ type: "huddle_notes", on });
}

export function inviteToHuddle(name: string): void {
  send?.({ type: "huddle_invite", to: name });
}

export function sendHuddleChat(text: string): void {
  const said = text.trim();
  if (said && snapshot.call) send?.({ type: "huddle_chat", text: said });
}

export function setHuddleChatOpen(open: boolean): void {
  if (!snapshot.call) return;
  setCall(open ? { chatOpen: true, unread: 0 } : { chatOpen: false });
}

// ── Screen sharing ──────────────────────────────────────────────────────────

/** Browsers that can capture a screen: desktop ones, not phones. */
export function canShareScreen(): boolean {
  return (
    !!navigator.mediaDevices && "getDisplayMedia" in navigator.mediaDevices
  );
}

export async function startScreenShare(): Promise<void> {
  if (!snapshot.call || screen) return;
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 15, max: 30 } },
      audio: false,
    });
  } catch (error) {
    // Closing the picker (or macOS refusing screen recording) is NotAllowed:
    // nothing to say. Anything else means this app can't capture at all,
    // which in the desktop app means a build from before it learned to.
    if (error instanceof DOMException && error.name === "NotAllowedError")
      return;
    noticeHandler?.(
      os1Shell()
        ? "This version of the desktop app can't share your screen. Update the app, or share from a browser."
        : `Couldn't share your screen: ${errorMessage(error, "not supported here")}`,
    );
    return;
  }
  const [track] = stream.getVideoTracks();
  if (!snapshot.call || !track) {
    for (const t of stream.getTracks()) t.stop();
    return;
  }
  // Text and code stay sharp; a dropped frame matters less.
  track.contentHint = "detail";
  // The browser's own "Stop sharing" bar ends the track.
  track.onended = () => stopScreenShare();
  screen = stream;
  for (const entry of peers.values())
    void entry.video?.replaceTrack(track).catch(() => {});
  setCall({ screen: stream });
  send?.({ type: "huddle_share", on: true });
}

export function stopScreenShare(): void {
  if (!screen) return;
  stopScreen();
  setCall({ screen: null });
  send?.({ type: "huddle_share", on: false });
}

function stopScreen() {
  if (!screen) return;
  for (const track of screen.getTracks()) track.stop();
  screen = null;
  for (const entry of peers.values())
    void entry.video?.replaceTrack(null).catch(() => {});
}

// ── Peers ───────────────────────────────────────────────────────────────────

function peer(peerId: string): Peer {
  const existing = peers.get(peerId);
  if (existing) return existing;
  const pc = new RTCPeerConnection({ iceServers });
  const audio = new Audio();
  audio.autoplay = true;
  const entry: Peer = { pc, audio, pending: [], video: null };
  peers.set(peerId, entry);
  for (const track of local?.getTracks() ?? [])
    if (local) pc.addTrack(track, local);
  pc.onicecandidate = (event) =>
    send?.({
      type: "huddle_signal",
      to: peerId,
      data: {
        candidate: event.candidate
          ? {
              candidate: event.candidate.candidate,
              sdpMid: event.candidate.sdpMid,
              sdpMLineIndex: event.candidate.sdpMLineIndex,
            }
          : null,
      },
    });
  pc.ontrack = (event) => {
    if (event.track.kind === "video") {
      set({
        screens: {
          ...snapshot.screens,
          [peerId]: new MediaStream([event.track]),
        },
      });
      return;
    }
    const [stream] = event.streams;
    if (!stream) return;
    audio.srcObject = stream;
    void audio.play().catch(() => {});
  };
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === "failed")
      noticeHandler?.(
        "Couldn't connect the audio to someone in the huddle. Your networks may not reach each other.",
      );
  };
  return entry;
}

/** The newcomer offers to everyone already inside (server/huddles.ts). */
async function callPeer(peerId: string) {
  const entry = peer(peerId);
  const { pc } = entry;
  // The video slot, so sharing later needs no new offer.
  const slot = pc.addTransceiver("video", { direction: "sendrecv" });
  entry.video = slot.sender;
  if (screen)
    await slot.sender.replaceTrack(screen.getVideoTracks()[0] ?? null);
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  send?.({
    type: "huddle_signal",
    to: peerId,
    data: { sdp: { type: "offer", sdp: offer.sdp ?? "" } },
  });
}

async function onSignal(from: string, data: HuddleSignalData) {
  if (!snapshot.call || !local) return;
  const entry = peer(from);
  const { pc } = entry;
  if (data.sdp) {
    await pc.setRemoteDescription(data.sdp);
    // Answer the offerer's video slot with one of our own, so either side
    // can share. Older clients offer none; their calls stay voice only.
    if (data.sdp.type === "offer" && !entry.video) {
      const slot = pc
        .getTransceivers()
        .find((t) => t.receiver.track.kind === "video");
      if (slot) {
        slot.direction = "sendrecv";
        entry.video = slot.sender;
        if (screen)
          await slot.sender
            .replaceTrack(screen.getVideoTracks()[0] ?? null)
            .catch(() => {});
      }
    }
    for (const candidate of entry.pending.splice(0))
      await pc.addIceCandidate(candidate).catch(() => {});
    if (data.sdp.type === "offer") {
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      send?.({
        type: "huddle_signal",
        to: from,
        data: { sdp: { type: "answer", sdp: answer.sdp ?? "" } },
      });
    }
    return;
  }
  if (data.candidate) {
    if (pc.remoteDescription)
      await pc.addIceCandidate(data.candidate).catch(() => {});
    else entry.pending.push(data.candidate);
  }
}

/** Drop the connections to people who left. */
function syncPeers(rooms: HuddleRoom[]) {
  const call = snapshot.call;
  if (!call) return;
  const room = rooms.find((r) => r.roomId === call.roomId);
  const present = new Set(room?.members.map((m) => m.peerId) ?? []);
  for (const [peerId, entry] of peers)
    if (!present.has(peerId)) {
      closePeer(entry);
      peers.delete(peerId);
    }
  const screens = Object.fromEntries(
    Object.entries(snapshot.screens).filter(([peerId]) => peers.has(peerId)),
  );
  if (Object.keys(screens).length !== Object.keys(snapshot.screens).length)
    set({ screens });
}

function closePeer(entry: Peer) {
  entry.pc.close();
  entry.audio.srcObject = null;
}

function closePeers() {
  for (const entry of peers.values()) closePeer(entry);
  peers.clear();
  set({ screens: {} });
}

function stopLocal() {
  for (const track of local?.getTracks() ?? []) track.stop();
  local = null;
}

// ── Who is talking ──────────────────────────────────────────────────────────

/**
 * Who is talking, from each connection's own stats: the level of what this
 * browser sends (`media-source`) and of what each peer sends it
 * (`inbound-rtp`). No audio graph needed. Alone in a call there is nobody to
 * show it to, so there is nothing to read.
 */
function startMeters() {
  window.clearInterval(meterTimer);
  meterTimer = window.setInterval(() => void readLevels(), 250);
}

async function readLevels() {
  const call = snapshot.call;
  if (!call) return;
  let mine = 0;
  const speaking: string[] = [];
  for (const [peerId, entry] of peers) {
    const stats = await entry.pc.getStats().catch(() => null);
    stats?.forEach(
      (report: RTCStats & { kind?: string; audioLevel?: number }) => {
        if (report.kind !== "audio") return;
        const level = report.audioLevel ?? 0;
        if (report.type === "media-source") mine = Math.max(mine, level);
        if (report.type === "inbound-rtp" && level > SPEAKING_LEVEL)
          speaking.push(peerId);
      },
    );
  }
  const now = snapshot.call;
  if (!now || now.roomId !== call.roomId) return;
  if (now.peerId && !now.muted && mine > SPEAKING_LEVEL)
    speaking.unshift(now.peerId);
  if (speaking.join() !== now.speaking.join()) setCall({ speaking });
}

// ── Notes ───────────────────────────────────────────────────────────────────

/**
 * While the room has notes on, each person transcribes their own microphone
 * in short clips and hands the text to the server, which summarizes the call
 * when it ends. Muted means nothing is recorded.
 */
function syncNotes() {
  const call = snapshot.call;
  const room = call ? huddleRoom(call.roomId) : null;
  const want = !!(room?.notes && call && !call.muted && local);
  if (want && !recorder) startNotes();
  if (!want && recorder) stopNotes();
}

function startNotes() {
  if (!local || !("MediaRecorder" in window)) return;
  const stream = local;
  // Clips still being transcribed after leaving name their room, so the
  // server can file them into its summary (server/huddles.ts).
  const roomId = snapshot.call?.roomId;
  const clip = () => {
    if (snapshot.call === null || local !== stream) return;
    const chunks: Blob[] = [];
    const rec = new MediaRecorder(stream);
    recorder = rec;
    rec.ondataavailable = (event) => {
      if (event.data.size) chunks.push(event.data);
    };
    rec.onstop = () => {
      const audio = new Blob(chunks, { type: rec.mimeType || "audio/webm" });
      if (audio.size > 2_000)
        notesChain = notesChain.then(() =>
          transcribeClip(audio)
            .then((text) => {
              const said = text.trim();
              if (said)
                send?.({
                  type: "huddle_note",
                  text: said.slice(0, 2000),
                  roomId,
                });
            })
            .catch((error) => {
              if (notesFailureShown) return;
              notesFailureShown = true;
              noticeHandler?.(
                `Huddle notes couldn't transcribe your microphone: ${errorMessage(error, "transcription failed")}`,
              );
            }),
        );
      if (recorder === rec) clip();
    };
    rec.start();
    clipTimer = window.setTimeout(() => {
      if (rec.state === "recording") rec.stop();
    }, NOTE_CLIP_MS);
  };
  clip();
}

function stopNotes() {
  const rec = recorder;
  recorder = null;
  window.clearTimeout(clipTimer);
  // Stopping flushes the clip in progress, which still gets transcribed.
  if (rec?.state === "recording") rec.stop();
}
