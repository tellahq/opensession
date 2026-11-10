// Browser tab sound (the web app's lib/frame-audio.ts). The app keeps framed
// pages playing after you switch workspaces, and those pages are
// cross-origin, so the app cannot hear which one is making sound. The shell
// adds this reporter to each page the app window frames directly; it tells
// the app whether the page is playing, and pauses it when the app asks.

// Runs in the framed page. It says only "playing" or "not", only to its own
// parent's origin, and only obeys a pause from that parent.
function frameAudioReporter() {
  if (window.__os1FrameAudio || window.parent === window) return;
  window.__os1FrameAudio = true;
  const parentOrigin = location.ancestorOrigins?.[0];
  if (!parentOrigin) return;
  const media = () => Array.from(document.querySelectorAll("audio, video"));
  const playing = (el) => !el.paused && !el.ended && !el.muted && el.volume > 0;
  let audible = false;
  const report = () => {
    const now = media().some(playing);
    if (now === audible) return;
    audible = now;
    window.parent.postMessage(
      { type: "opensession:audio", audible },
      parentOrigin,
    );
  };
  // Media events do not bubble, so listen in the capture phase.
  for (const type of [
    "play",
    "playing",
    "pause",
    "ended",
    "volumechange",
    "emptied",
  ]) {
    document.addEventListener(type, report, true);
  }
  // An element removed while playing fires nothing the document hears.
  setInterval(report, 2000);
  report();
  window.addEventListener("message", (event) => {
    if (event.source !== window.parent || event.origin !== parentOrigin) return;
    if (event.data?.type !== "opensession:pause-audio") return;
    for (const el of media()) if (playing(el)) el.pause();
  });
}

const FRAME_AUDIO_SCRIPT = `(${frameAudioReporter.toString()})();`;

module.exports = { FRAME_AUDIO_SCRIPT, frameAudioReporter };
