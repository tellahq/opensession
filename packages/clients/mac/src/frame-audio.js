// Browser tab sound (the web app's lib/frame-audio.ts). The app keeps framed
// pages playing after you switch workspaces, and those pages are
// cross-origin, so the app cannot hear which one is making sound. The shell
// adds this reporter to each page the app window frames directly; it tells
// the app whether the page is playing, and pauses it when the app asks.

// Runs in the framed page. It says only "playing" or "not", only to its own
// parent's origin, and only obeys a pause from that parent.
//
// A page makes sound two ways: a media element (<audio>, <video>, or a
// `new Audio()` that never joins the document) or Web Audio, where a source
// node plays into an AudioContext. Editors and games use the second, and no
// element shows it, so the reporter counts the sources each context has
// started and not yet ended. A context is audible while it runs with one.
function frameAudioReporter() {
  if (window.__os1FrameAudio || window.parent === window) return;
  window.__os1FrameAudio = true;
  const parentOrigin = location.ancestorOrigins?.[0];
  if (!parentOrigin) return;
  const mediaEvents = [
    "play",
    "playing",
    "pause",
    "ended",
    "volumechange",
    "emptied",
  ];
  // Elements played while outside the document; querySelectorAll misses them.
  const detached = new Set();
  // Started, not yet ended, source nodes per AudioContext.
  const sources = new Map();
  const media = () => [
    ...document.querySelectorAll("audio, video"),
    ...detached,
  ];
  const playing = (el) => !el.paused && !el.ended && !el.muted && el.volume > 0;
  const sounding = (context) =>
    context.state === "running" && sources.get(context) > 0;
  let audible = false;
  const report = () => {
    const now = media().some(playing) || [...sources.keys()].some(sounding);
    if (now === audible) return;
    audible = now;
    window.parent.postMessage(
      { type: "opensession:audio", audible },
      parentOrigin,
    );
  };
  // Media events do not bubble, so listen in the capture phase.
  for (const type of mediaEvents) document.addEventListener(type, report, true);

  const play = window.HTMLMediaElement?.prototype.play;
  if (play) {
    window.HTMLMediaElement.prototype.play = function (...args) {
      if (!this.isConnected && !detached.has(this)) {
        detached.add(this);
        const settle = () => {
          if (this.paused || this.ended) {
            detached.delete(this);
            for (const type of mediaEvents) {
              this.removeEventListener(type, settle);
            }
          }
          report();
        };
        for (const type of mediaEvents) this.addEventListener(type, settle);
      }
      return play.apply(this, args);
    };
  }

  // AudioBufferSourceNode has its own start (it takes an offset), so it is
  // wrapped apart from the base class the other sources share.
  const counted = (start) =>
    function (...args) {
      const result = start.apply(this, args);
      const context = this.context;
      if (!sources.has(context)) {
        sources.set(context, 0);
        context.addEventListener("statechange", () => {
          if (context.state === "closed") sources.delete(context);
          report();
        });
      }
      sources.set(context, sources.get(context) + 1);
      this.addEventListener(
        "ended",
        () => {
          if (sources.has(context)) {
            sources.set(context, sources.get(context) - 1);
          }
          report();
        },
        { once: true },
      );
      report();
      return result;
    };
  for (const name of ["AudioScheduledSourceNode", "AudioBufferSourceNode"]) {
    const proto = window[name]?.prototype;
    if (proto && Object.hasOwn(proto, "start")) {
      proto.start = counted(proto.start);
    }
  }

  // An element removed while playing fires nothing the document hears.
  setInterval(report, 2000);
  report();
  window.addEventListener("message", (event) => {
    if (event.source !== window.parent || event.origin !== parentOrigin) return;
    if (event.data?.type !== "opensession:pause-audio") return;
    for (const el of media()) if (playing(el)) el.pause();
    // Suspending is Web Audio's pause; the page's own controls resume it.
    for (const context of sources.keys()) {
      if (sounding(context)) context.suspend().catch(() => {});
    }
  });
}

const FRAME_AUDIO_SCRIPT = `(${frameAudioReporter.toString()})();`;

module.exports = { FRAME_AUDIO_SCRIPT, frameAudioReporter };
