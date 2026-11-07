import { useSyncExternalStore } from "react";
import { transcribeClip } from "./api/automations";
import type {
  HuddleRoom,
  HuddleSignalData,
  WSClientMessage,
  WSServerMessage,
} from "./types";

/**
 * The browser's half of a huddle (server/huddles.ts): one voice call at a
 * time, browser to browser over WebRTC. Every person in the call holds a
 * connection to every other (a mesh), which keeps a server out of the audio
 * path and suits the handful of people a huddle holds.
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
}

interface Snapshot {
  rooms: HuddleRoom[];
  call: HuddleCall | null;
  /** People with a session open right now: who an invite can reach. */
  online: string[];
}

type Send = (message: WSClientMessage) => void;
type AddHandler = (handler: (msg: WSServerMessage) => void) => () => void;

interface Peer {
  pc: RTCPeerConnection;
  audio: HTMLAudioElement;
  pending: RTCIceCandidateInit[];
}

/** Talking, on WebRTC's 0-1 `audioLevel` scale. */
const SPEAKING_LEVEL = 0.02;
/** How long each notes clip runs before it is transcribed. */
const NOTE_CLIP_MS = 20_000;

let snapshot: Snapshot = { rooms: [], call: null, online: [] };
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
const peers = new Map<string, Peer>();
let meterTimer: number | undefined;
let recorder: MediaRecorder | null = null;
let clipTimer: number | undefined;
let inviteHandler: ((invite: HuddleInvite) => void) | null = null;
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
      setCall({ peerId: msg.peerId, status: "live" });
      for (const peerId of msg.peers) void callPeer(peerId);
      break;
    case "huddle_signal":
      void onSignal(msg.from, msg.data);
      break;
    case "huddle_invite":
      if (snapshot.call?.roomId === msg.roomId) return;
      inviteHandler?.(msg);
      break;
    case "huddle_invite_result":
      if (msg.delivered === 0)
        noticeHandler?.(`${msg.to} isn't online right now.`);
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

/** Join (or start) a huddle. Leaves the one this browser is in. */
export async function joinHuddle(target: {
  roomId: string;
  label: string;
  sessionId?: string;
}): Promise<void> {
  if (!send) return;
  if (snapshot.call?.roomId === target.roomId) return;
  if (snapshot.call) leaveHuddle();
  set({
    call: {
      roomId: target.roomId,
      label: target.label,
      sessionId: target.sessionId ?? null,
      status: "connecting",
      peerId: null,
      muted: false,
      speaking: [],
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

// ── Peers ───────────────────────────────────────────────────────────────────

function peer(peerId: string): Peer {
  const existing = peers.get(peerId);
  if (existing) return existing;
  const pc = new RTCPeerConnection({ iceServers });
  const audio = new Audio();
  audio.autoplay = true;
  const entry: Peer = { pc, audio, pending: [] };
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
  const { pc } = peer(peerId);
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
}

function closePeer(entry: Peer) {
  entry.pc.close();
  entry.audio.srcObject = null;
}

function closePeers() {
  for (const entry of peers.values()) closePeer(entry);
  peers.clear();
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
        void transcribeClip(audio)
          .then((text) => {
            const said = text.trim();
            if (said)
              send?.({ type: "huddle_note", text: said.slice(0, 2000) });
          })
          .catch(() => {});
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
