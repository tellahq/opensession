const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { setTimeout: delay } = require("node:timers/promises");

const exec = promisify(execFile);
const BINARIES = [
  "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
  "/opt/homebrew/bin/tailscale",
  "/usr/local/bin/tailscale",
];

function readNetworkBinding(value) {
  if (
    !value ||
    typeof value.profileId !== "string" ||
    !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value.profileId) ||
    !["ask", "automatic"].includes(value.mode)
  )
    return null;
  return { profileId: value.profileId, mode: value.mode };
}

function parseProfiles(stdout) {
  const profiles = JSON.parse(stdout);
  if (
    !Array.isArray(profiles) ||
    !profiles.every(
      (profile) =>
        profile &&
        typeof profile.id === "string" &&
        /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(profile.id) &&
        typeof profile.account === "string" &&
        typeof profile.tailnet === "string" &&
        typeof profile.selected === "boolean",
    )
  )
    throw new Error(
      "Tailscale returned an unsupported account list. Update Tailscale and try again.",
    );
  return profiles.map(({ id, account, tailnet, selected }) => ({
    id,
    account,
    tailnet,
    selected,
  }));
}

function createTailscaleClient({
  run = exec,
  wait = delay,
  platform = process.platform,
} = {}) {
  let binary;
  async function command(args, timeout = 6000) {
    if (platform !== "darwin")
      throw new Error("Network switching is available on macOS only.");
    for (const candidate of binary ? [binary] : BINARIES) {
      try {
        const result = await run(candidate, args, {
          timeout,
          maxBuffer: 1024 * 1024,
          windowsHide: true,
        });
        binary = candidate;
        return result.stdout;
      } catch (error) {
        if (error.code === "ENOENT" && !binary) continue;
        // Do not forward CLI stderr to remotely served pages or shell HTML.
        throw new Error(
          "Couldn't control Tailscale. Open Tailscale, check that it is running, and try again.",
        );
      }
    }
    throw new Error(
      "Install Tailscale in Applications and sign in to the account you want to use.",
    );
  }
  const list = async () =>
    parseProfiles(await command(["switch", "--list", "--json"]));
  return {
    list,
    async switch(profileId, isCurrent = () => true) {
      // Only exact saved IDs can reach argv. Never accept a CLI flag or a
      // tailnet/account name, which may match more than one saved profile.
      if (!(await list()).some((profile) => profile.id === profileId)) {
        throw new Error(
          "That Tailscale account is no longer saved. Choose another in Network on this Mac.",
        );
      }
      if (isCurrent()) await command(["switch", profileId], 20000);
    },
    async ready(profileId, isCurrent) {
      for (let attempt = 0; attempt < 12 && isCurrent(); attempt++) {
        const profiles = await list();
        if (profiles.find((profile) => profile.id === profileId)?.selected) {
          const status = JSON.parse(await command(["status", "--json"]));
          if (status?.BackendState === "Running") return;
        }
        await wait(350);
      }
      if (isCurrent())
        throw new Error(
          "Tailscale isn't connected to the selected account. Connect it in Tailscale, then retry.",
        );
    },
  };
}

async function connectOrganizationNetwork({
  account,
  client,
  confirm,
  probe,
  isCurrent,
  status,
}) {
  const binding = readNetworkBinding(account.network);
  if (!binding || !isCurrent()) return;
  status("Checking Tailscale…");
  const profiles = await client.list();
  if (!isCurrent()) return;
  const profile = profiles.find(
    (candidate) => candidate.id === binding.profileId,
  );
  if (!profile)
    throw new Error(
      "That Tailscale account is no longer saved. Choose another in Network on this Mac.",
    );
  if (!profile.selected) {
    if (binding.mode === "ask" && !(await confirm(profile))) return false;
    if (!isCurrent()) return;
    status(`Connecting to ${profile.tailnet}…`);
    await client.switch(profile.id, isCurrent);
  }
  if (!isCurrent()) return;
  await client.ready(profile.id, isCurrent);
  if (!isCurrent()) return;
  status(`Connecting to ${account.label}…`);
  const reached = await probe(account.url);
  if (!isCurrent()) return;
  if (!reached.ok)
    throw new Error(
      "Tailscale is connected, but this Open Session server isn't reachable. Check the server address and network access, then retry.",
    );
  return true;
}

// One device has one active Tailscale profile. Serialize across all windows;
// skip superseded selections and never navigate after a stale async result.
function createLatestSwitchQueue() {
  let revision = 0;
  let controller;
  let pending = Promise.resolve();
  return (run) => {
    const mine = ++revision;
    controller?.abort();
    controller = new AbortController();
    const { signal } = controller;
    const isCurrent = () => mine === revision;
    const result = pending.then(() =>
      isCurrent() ? run(isCurrent, signal) : undefined,
    );
    pending = result.catch(() => {});
    return result;
  };
}

module.exports = {
  readNetworkBinding,
  parseProfiles,
  createTailscaleClient,
  connectOrganizationNetwork,
  createLatestSwitchQueue,
};
