#!/bin/sh
# Prepare an Apple silicon Mac to host Mac VM Sandboxes: a Mac mini on a desk
# or an EC2 Mac instance. Run it on the Mac as the user who will stay logged
# in to the desktop (the Runner's LaunchAgent and the VMs run in that user's
# session). Every step is idempotent; re-run after fixing whatever it reports.
#
#   sh prepare.sh --server https://opensession.example.test --code PAIRING_CODE \
#       [--autologin-password PW] [--tailscale-authkey tskey-...]
#
# What it does, in order:
#   1. Refuses anything but Apple silicon (Virtualization.framework guests).
#   2. On EC2, grows the APFS container to the EBS volume (AWS ships the
#      AMI on a small root volume; the rest of the disk is unused until then).
#   3. Keeps the machine awake: sleep, disk sleep, and display sleep off.
#   4. Optionally sets the current user to log in automatically at boot, so
#      a reboot comes back with a desktop session and the Runner running.
#   5. Turns Screen Sharing on, for the one prompt only a person can accept:
#      macOS 15+ asks whether the Runner may use the local network.
#   6. Joins the tailnet when an auth key is given (pairing is tailnet-gated).
#   7. Installs the Open Session command and pairs the machine as a Runner.
#
# It does not install Tart or pull the macOS image: the Mac VM connection's
# qualification does that over the Runner channel once the Mac is added as a
# host under Workspace > Sandboxes > Mac VM > Configure.
#
# See docs/mac-vm-hosts.md.

set -eu

SERVER=""
CODE=""
AUTOLOGIN_PASSWORD=""
TS_AUTHKEY="${TS_AUTHKEY:-}"
INSTALL_URL="${OPENSESSION_INSTALL_URL:-https://raw.githubusercontent.com/tellahq/opensession/main/install.sh}"

usage() {
  sed -n '2,25p' "$0" | sed 's/^# \{0,1\}//'
  exit "${1:-0}"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --server) SERVER="$2"; shift 2 ;;
    --code) CODE="$2"; shift 2 ;;
    --autologin-password) AUTOLOGIN_PASSWORD="$2"; shift 2 ;;
    --tailscale-authkey) TS_AUTHKEY="$2"; shift 2 ;;
    -h|--help) usage 0 ;;
    *) echo "unknown option: $1" >&2; usage 2 ;;
  esac
done

say() { printf '\n==> %s\n' "$*"; }
fail() { printf 'prepare.sh: %s\n' "$*" >&2; exit 1; }

[ "$(uname -s)" = Darwin ] || fail "this script prepares a Mac"
[ "$(uname -m)" = arm64 ] || fail "Mac VM hosts need Apple silicon (Virtualization.framework guests); this Mac is $(uname -m)"
[ "$(id -u)" -ne 0 ] || fail "run as the desktop user, not root; the script uses sudo where it must"

ON_EC2=0
if curl -fsS -m 2 http://169.254.169.254/latest/meta-data/instance-id >/dev/null 2>&1; then
  ON_EC2=1
fi

say "Host: $(sysctl -n hw.model), macOS $(sw_vers -productVersion), user $(id -un)$([ $ON_EC2 = 1 ] && echo ', EC2 instance')"

if [ $ON_EC2 = 1 ]; then
  # AWS's documented recipe: the root EBS volume is larger than the APFS
  # container the AMI shipped with; repair the disk and grow the container.
  say "Growing the APFS container to the EBS volume"
  PDISK=$(diskutil list physical external | awk '/GUID_partition_scheme/ {print $NF}')
  APFSCONT=$(diskutil list physical external | awk '/Apple_APFS/ {print $NF}')
  if [ -n "$PDISK" ] && [ -n "$APFSCONT" ]; then
    yes | sudo diskutil repairDisk "$PDISK" >/dev/null 2>&1 || true
    sudo diskutil apfs resizeContainer "$APFSCONT" 0 >/dev/null 2>&1 || echo "  (container already fills the volume)"
  else
    echo "  could not find the external physical disk; skipping"
  fi
fi

say "Keeping the machine awake"
sudo pmset -a sleep 0 disksleep 0 displaysleep 0
sudo systemsetup -setcomputersleep Never >/dev/null 2>&1 || true
sudo systemsetup -setrestartfreeze on >/dev/null 2>&1 || true

if [ -n "$AUTOLOGIN_PASSWORD" ]; then
  say "Logging $(id -un) in automatically at boot"
  sudo sysadminctl -autologin set -userName "$(id -un)" -password "$AUTOLOGIN_PASSWORD"
else
  echo
  echo "Skipping automatic login (no --autologin-password). After a reboot someone"
  echo "must log this user in before the Runner and its VMs come back."
fi

say "Turning Screen Sharing on"
sudo defaults write /var/db/launchd.db/com.apple.launchd/overrides.plist com.apple.screensharing -dict Disabled -bool false 2>/dev/null || true
sudo launchctl load -w /System/Library/LaunchDaemons/com.apple.screensharing.plist 2>/dev/null || true

if ! command -v tailscale >/dev/null 2>&1 && [ -x /Applications/Tailscale.app/Contents/MacOS/Tailscale ]; then
  # The App Store / notarized app ships its CLI inside the bundle.
  PATH="/Applications/Tailscale.app/Contents/MacOS:$PATH"
fi
if [ -n "$TS_AUTHKEY" ]; then
  say "Joining the tailnet"
  if ! command -v tailscale >/dev/null 2>&1; then
    command -v brew >/dev/null 2>&1 || fail "Homebrew is needed to install tailscale (or install the Tailscale app first)"
    HOMEBREW_NO_AUTO_UPDATE=1 brew install tailscale >/dev/null
    sudo "$(command -v tailscaled)" install-system-daemon
  fi
  sudo tailscale up --auth-key="$TS_AUTHKEY" --hostname="$(scutil --get LocalHostName | tr '[:upper:]' '[:lower:]')"
elif command -v tailscale >/dev/null 2>&1 && tailscale status >/dev/null 2>&1; then
  say "Tailnet: $(tailscale ip -4 2>/dev/null | head -1)"
else
  echo
  echo "Not on the tailnet yet (no --tailscale-authkey and tailscale is not up)."
  echo "Pairing is tailnet-gated; join before running the pairing step."
fi

say "Installing the Open Session command"
if ! command -v opensession >/dev/null 2>&1; then
  curl -fsSL "$INSTALL_URL" | bash -s -- --no-onboard --no-engine
  # The installer says where it put the command; pick up the usual places.
  PATH="$HOME/.local/bin:$HOME/.bun/bin:/usr/local/bin:/opt/homebrew/bin:$PATH"
fi
command -v opensession >/dev/null 2>&1 || fail "opensession is not on PATH after the install; open a new shell and re-run"

if [ -n "$SERVER" ] && [ -n "$CODE" ]; then
  say "Pairing this Mac as a Runner"
  opensession runner connect --server "$SERVER" --code "$CODE"
else
  echo
  echo "Skipping pairing (give --server and --code from Settings > Runners > Pair)."
fi

cat <<'EOF'

Done on this Mac. What is left needs a person or the server:

  1. Local Network permission (macOS 15+): connect with Screen Sharing (on EC2,
     through an SSH tunnel: ssh -L 5900:localhost:5900 ec2-user@<host>, then
     vnc://localhost:5900), open System Settings > Privacy & Security >
     Local Network, and turn "bun" (the Open Session Runner) on. Then restart
     the Runner service so the running process picks the decision up:
       launchctl kickstart -k gui/$(id -u)/dev.tella.opensession.runner
  2. In Open Session: Workspace > Sandboxes > Mac VM > Configure > Add Mac,
     choose this Runner, set its Max VMs (2 is Apple's ceiling per host), and
     Connect and test. The qualification installs Tart, pulls the image (about
     70 GB; plan an hour), prepares the base VM, and proves a disposable VM.
EOF
