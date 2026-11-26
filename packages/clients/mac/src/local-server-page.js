// The page a window waits on while the app's own server starts. main.js
// navigates the window to the app once the server answers, so this page only
// has to say what is happening and offer a way out when it fails.
const bridge = window.os1 && window.os1.localServer;
const title = document.getElementById("title");
const message = document.getElementById("message");
const progress = document.getElementById("progress");
const actions = document.getElementById("actions");
const status = document.getElementById("status");
const STARTING = message.textContent;

const megabytes = (bytes) => Math.round(bytes / 1e6);

function show(state) {
  if (!state) return;
  const failed = state.state === "failed";
  // A download the first start waits for (local-tools.js).
  const step = failed ? null : state.step;
  const measured = !!step && step.total > 0;
  title.textContent = failed
    ? "Couldn’t start Open Session"
    : "Starting Open Session";
  message.textContent = failed
    ? state.error || "The server on this Mac did not start."
    : step
      ? `Downloading ${step.label}. This only happens the first time.`
      : STARTING;
  progress.hidden = !measured;
  progress.value = measured ? step.done / step.total : 0;
  actions.hidden = !failed;
  status.textContent = failed
    ? "The logs say what went wrong."
    : measured
      ? `${megabytes(step.done)} of ${megabytes(step.total)} MB`
      : "";
}

document.getElementById("retry").addEventListener("click", () => {
  show({ state: "starting" });
  bridge && bridge.retry();
});
document
  .getElementById("logs")
  .addEventListener("click", () => bridge && bridge.logs());
document.getElementById("change").addEventListener("click", () => {
  if (window.os1 && window.os1.server) window.os1.server.open();
});

if (bridge) {
  bridge.onState(show);
  bridge.status().then(show, () => {});
}
