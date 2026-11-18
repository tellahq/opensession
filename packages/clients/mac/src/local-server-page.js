// The page a window waits on while the app's own server starts. main.js
// navigates the window to the app once the server answers, so this page only
// has to say what is happening and offer a way out when it fails.
const bridge = window.os1 && window.os1.localServer;
const title = document.getElementById("title");
const message = document.getElementById("message");
const actions = document.getElementById("actions");
const status = document.getElementById("status");
const STARTING = message.textContent;

function show(state) {
  if (!state) return;
  const failed = state.state === "failed";
  title.textContent = failed
    ? "Couldn’t start Open Session"
    : "Starting Open Session";
  message.textContent = failed
    ? state.error || "The server on this Mac did not start."
    : STARTING;
  actions.hidden = !failed;
  status.textContent = failed ? "The logs say what went wrong." : "";
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
