// Exposed to the Open Session web app. The frontend can feature-detect `window.os1`
// to route its app-badge updates through the dock (navigator.setAppBadge in a
// service worker doesn't reach Electron's dock badge).
const { contextBridge, ipcRenderer } = require("electron");

// Realtime voice: a signed native helper owns the microphone and speaker
// through Apple's voice-processing engine (echo cancellation, per-session
// input/output choice, other-audio ducking). The renderer exchanges 48 kHz
// mono Float32 PCM in both directions and never opens the microphone itself.
// Device ids are persistent CoreAudio UIDs; "" means the system default.
//
// The namespace exists only when the main process found the packaged helper
// and passed the flag below, so its presence is the capability check: a dev
// run without the helper keeps the frontend's browser path.
//
// Both directions are flow controlled without the frontend taking part:
// every microphone packet is acknowledged here after delivery, and the main
// process acknowledges every push. Beyond the caps, packets are dropped
// rather than queued in IPC.
const VOICE_AUDIO_FLAG = "--os1-voice-audio";
const MAX_OUTSTANDING_PUSHES = 16;

function voiceAudioBridge() {
  if (!process.argv.includes(VOICE_AUDIO_FLAG)) return {};
  let outstandingPushes = 0;
  const listeners = new Set();
  ipcRenderer.on("os1:voice-audio-push-ack", () => {
    outstandingPushes = Math.max(0, outstandingPushes - 1);
  });
  ipcRenderer.on("os1:voice-audio-audio", (_event, payload) => {
    for (const listener of listeners) {
      try {
        listener(payload);
      } catch {}
    }
    ipcRenderer.send("os1:voice-audio-audio-ack", payload?.id);
  });
  return {
    voiceAudio: {
      devices: () => ipcRenderer.invoke("os1:voice-audio-devices"),
      start: (id, options) => {
        outstandingPushes = 0;
        return ipcRenderer.invoke("os1:voice-audio-start", id, {
          inputDeviceId: String(options?.inputDeviceId ?? ""),
          outputDeviceId: String(options?.outputDeviceId ?? ""),
          ducking: options?.ducking === true,
        });
      },
      push: (id, samples) => {
        if (outstandingPushes >= MAX_OUTSTANDING_PUSHES) return;
        outstandingPushes += 1;
        ipcRenderer.send("os1:voice-audio-push", id, samples);
      },
      setPaused: (id, paused) =>
        ipcRenderer.send("os1:voice-audio-pause", id, paused === true),
      clearPlayback: (id) => ipcRenderer.send("os1:voice-audio-clear", id),
      stop: (id) => {
        outstandingPushes = 0;
        ipcRenderer.send("os1:voice-audio-stop", id);
      },
      onAudio: (cb) => {
        listeners.add(cb);
        return () => listeners.delete(cb);
      },
      onError: (cb) => {
        const listener = (_event, payload) => cb(payload);
        ipcRenderer.on("os1:voice-audio-error", listener);
        return () =>
          ipcRenderer.removeListener("os1:voice-audio-error", listener);
      },
    },
  };
}

contextBridge.exposeInMainWorld("os1", {
  desktop: true,
  // Capability flag rather than `desktop` alone: the remotely served frontend
  // must stay opaque in older shell builds that do not provide native material.
  materialBackdrop: true,
  setBadge: (count) => ipcRenderer.send("os1:set-badge", Number(count) || 0),
  clearBadge: () => ipcRenderer.send("os1:set-badge", 0),
  // Raise the app from a notification click. The web app calls window.focus()
  // for this, which a renderer cannot honour on macOS: a background or hidden
  // window stays where it is, so the click routed the app to the right session
  // behind whatever the person was actually looking at.
  focusWindow: () => ipcRenderer.send("os1:focus-window"),
  // A screenshot of this window inside rect (CSS pixels), for a Browser tab
  // comment: the page cannot read a framed cross-origin page's pixels.
  capturePage: (rect) => ipcRenderer.invoke("os1:capture-page", rect),
  organizations: {
    inlineAdd: true,
    list: () => ipcRenderer.invoke("os1:organizations-list"),
    switch: (id) => ipcRenderer.send("os1:organizations-switch", id),
    // `activate` false adds the account without switching this window to it.
    add: (url, check = true, activate = true) =>
      ipcRenderer.invoke("os1:organizations-add", url, check, activate),
    remove: (id) => ipcRenderer.invoke("os1:organizations-remove", id),
    manage: () => ipcRenderer.send("os1:organizations-manage"),
  },
  // Local shell windows only. The main process checks the exact packaged page
  // and main frame; remote servers cannot enumerate profiles or set bindings.
  tailnet: {
    choose: () => ipcRenderer.send("os1:tailnet-choose"),
    settings: () => ipcRenderer.invoke("os1:tailnet-settings"),
    save: (id, profileId, connect) =>
      ipcRenderer.invoke("os1:tailnet-save", id, profileId, connect),
    state: () => ipcRenderer.invoke("os1:tailnet-state"),
    action: (action) => ipcRenderer.invoke("os1:tailnet-action", action),
    onState: (cb) => {
      const listener = (_event, state) => cb(state);
      ipcRenderer.on("os1:tailnet-state", listener);
      return () => ipcRenderer.removeListener("os1:tailnet-state", listener);
    },
  },
  // Electron does not connect Chromium's Web Speech API to a recognition
  // service. Stream the renderer's microphone PCM to the shell's signed native
  // helper instead, which uses Apple's on-device recognizer when available.
  dictation: {
    start: (id, sampleRate, language) =>
      ipcRenderer.invoke("os1:dictation-start", id, sampleRate, language),
    push: (id, samples) => ipcRenderer.send("os1:dictation-audio", id, samples),
    finish: (id) => ipcRenderer.invoke("os1:dictation-finish", id),
    cancel: (id) => ipcRenderer.send("os1:dictation-cancel", id),
    onText: (cb) => {
      const listener = (_event, payload) => cb(payload);
      ipcRenderer.on("os1:dictation-text", listener);
      return () => ipcRenderer.removeListener("os1:dictation-text", listener);
    },
  },
  ...voiceAudioBridge(),
  // Folders on this Mac that the server's sessions may reach (local-folders.js
  // in the main process). The web app names a grant and a folder-relative
  // path; the main process owns the paths and checks every one.
  localFolders: {
    device: () => ipcRenderer.invoke("os1:local-folders-device"),
    list: () => ipcRenderer.invoke("os1:local-folders-list"),
    pick: () => ipcRenderer.invoke("os1:local-folders-pick"),
    update: (id, patch) =>
      ipcRenderer.invoke("os1:local-folders-update", id, {
        ...(Array.isArray(patch?.sessionIds)
          ? { sessionIds: patch.sessionIds.map(String) }
          : {}),
        ...(typeof patch?.readOnly === "boolean"
          ? { readOnly: patch.readOnly }
          : {}),
      }),
    remove: (id) => ipcRenderer.invoke("os1:local-folders-remove", id),
    op: (id, op, args) =>
      ipcRenderer.invoke("os1:local-folders-op", id, op, args),
    onChange: (cb) => {
      const listener = () => cb();
      ipcRenderer.on("os1:local-folders-changed", listener);
      return () =>
        ipcRenderer.removeListener("os1:local-folders-changed", listener);
    },
  },
  // Which Open Session server this shell talks to. Only the shell's own
  // file:// pages (setup.html, offline.html) call these, and main.js refuses
  // them from anywhere else: the app served BY a server must not be able to
  // repoint the shell at another one.
  server: {
    open: () => ipcRenderer.send("os1:server-open"),
    cancel: () => ipcRenderer.send("os1:server-cancel"),
    probe: (url) => ipcRenderer.invoke("os1:server-probe", url),
    save: (url) => ipcRenderer.invoke("os1:server-save", url),
  },
  // "This Mac": the server the app runs itself. The shell's own pages only;
  // main.js refuses these from any page a server supplies.
  localServer: {
    status: () => ipcRenderer.invoke("os1:local-server-status"),
    use: () => ipcRenderer.invoke("os1:local-server-use"),
    retry: () => ipcRenderer.send("os1:local-server-retry"),
    logs: () => ipcRenderer.send("os1:local-server-logs"),
    onState: (cb) => {
      const listener = (_event, state) => cb(state);
      ipcRenderer.on("os1:local-server-state", listener);
      return () =>
        ipcRenderer.removeListener("os1:local-server-state", listener);
    },
  },
  // App auto-update (Squirrel.Mac, driven by main.js). `onState(cb)` reports
  // the current state immediately and again on every change, and returns an
  // unsubscribe. States: idle | available (= downloading) | downloaded.
  // `install()` restarts the app into a downloaded update.
  updates: {
    onState: (cb) => {
      const listener = (_e, state) => cb(state);
      ipcRenderer.on("os1:update-state", listener);
      ipcRenderer
        .invoke("os1:update-state")
        .then(cb)
        .catch(() => {});
      return () => ipcRenderer.removeListener("os1:update-state", listener);
    },
    install: () => ipcRenderer.send("os1:update-install"),
  },
});
