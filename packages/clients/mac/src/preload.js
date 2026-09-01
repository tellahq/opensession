// Exposed to the Open Session web app. The frontend can feature-detect `window.os1`
// to route its app-badge updates through the dock (navigator.setAppBadge in a
// service worker doesn't reach Electron's dock badge).
const { contextBridge, ipcRenderer } = require("electron");

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
  organizations: {
    inlineAdd: true,
    list: () => ipcRenderer.invoke("os1:organizations-list"),
    switch: (id) => ipcRenderer.send("os1:organizations-switch", id),
    add: (url, check = true) =>
      ipcRenderer.invoke("os1:organizations-add", url, check),
    manage: () => ipcRenderer.send("os1:organizations-manage"),
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
