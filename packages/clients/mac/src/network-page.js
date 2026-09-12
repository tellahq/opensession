const network = window.os1.network;
const form = document.getElementById("settings");
const organization = document.getElementById("organization");
const profile = document.getElementById("profile");
const mode = document.getElementById("mode");
const status = document.getElementById("status");
const save = document.getElementById("save");
const refresh = document.getElementById("refresh");
let accounts = [];
let profiles = [];
let loadingError = null;

function showBinding() {
  const account = accounts.find((item) => item.id === organization.value);
  profile.replaceChildren(new Option("Leave Tailscale unchanged", ""));
  for (const item of profiles) {
    profile.add(
      new Option(
        `${item.tailnet} · ${item.account}${item.selected ? " · Active account" : ""}`,
        item.id,
      ),
    );
  }
  if (
    account?.network &&
    !profiles.some((item) => item.id === account.network.profileId)
  ) {
    profile.add(
      new Option("Saved account unavailable", account.network.profileId),
    );
  }
  profile.value = account?.network?.profileId || "";
  mode.value = account?.network?.mode || "ask";
  mode.disabled = !profile.value;
  save.disabled = !account;
  status.textContent = loadingError || "";
}

function render(state) {
  if (!state) return;
  if (state.kind === "progress") {
    document.getElementById("title").textContent = `Switch to ${state.label}`;
    document.getElementById("description").textContent =
      "Cancelling stops the organization switch. It does not restore the previous network.";
    document.getElementById("close").textContent = "Cancel";
    status.textContent = state.message;
    return;
  }
  const selected = organization.value || state.accountId;
  accounts = state.accounts;
  profiles = state.profiles;
  loadingError = state.error;
  organization.replaceChildren(
    ...accounts.map((account) => new Option(account.label, account.id)),
  );
  if (accounts.some((account) => account.id === selected))
    organization.value = selected;
  form.hidden = false;
  showBinding();
}

async function load() {
  refresh.disabled = true;
  save.disabled = true;
  try {
    render(await network.state());
  } catch {
    status.textContent =
      "Couldn't load network settings. Close this window and try again.";
  } finally {
    refresh.disabled = false;
  }
}

organization.addEventListener("change", showBinding);
profile.addEventListener("change", () => {
  mode.disabled = !profile.value;
});
refresh.addEventListener("click", load);
form.addEventListener("submit", async (event) => {
  event.preventDefault();
  save.disabled = true;
  organization.disabled = true;
  profile.disabled = true;
  mode.disabled = true;
  refresh.disabled = true;
  const binding = profile.value
    ? { profileId: profile.value, mode: mode.value }
    : null;
  try {
    const result = await network.save(organization.value, binding);
    if (result.ok) {
      const account = accounts.find((item) => item.id === organization.value);
      if (account) account.network = binding;
      status.textContent =
        "Saved on this Mac. Applies when you next select this organization.";
    } else
      status.textContent =
        result.error || "Couldn't save this network setting.";
  } catch {
    status.textContent = "Couldn't save this network setting.";
  } finally {
    save.disabled = false;
    organization.disabled = false;
    profile.disabled = false;
    mode.disabled = !profile.value;
    refresh.disabled = false;
  }
});
document
  .getElementById("open")
  .addEventListener("click", () => network.openTailscale());
document
  .getElementById("close")
  .addEventListener("click", () => network.close());
window.addEventListener("keydown", (event) => {
  if (event.key === "Escape") network.close();
});
network.onState(render);
void load();
