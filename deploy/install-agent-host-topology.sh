#!/usr/bin/env bash
# Install the production-unactivated detached Agent Host identity and unit foundation.
set -euo pipefail

[ "$(id -u)" = 0 ] || { echo "[agent-host-install] ERROR: root is required" >&2; exit 1; }
[ "$#" = 2 ] || { echo "usage: $0 <stable-release-directory> <bun-binary>" >&2; exit 2; }
WORKDIR="$1"
BUN="$2"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"

case "$WORKDIR" in /*) ;; *) echo "[agent-host-install] ERROR: release directory must be absolute" >&2; exit 1;; esac
case "$BUN" in /*) ;; *) echo "[agent-host-install] ERROR: Bun path must be absolute" >&2; exit 1;; esac
[ -d "$WORKDIR" ] || { echo "[agent-host-install] ERROR: release directory is absent" >&2; exit 1; }
[ -x "$BUN" ] || { echo "[agent-host-install] ERROR: Bun is not executable" >&2; exit 1; }

identities=(opensession-gateway opensession-session-kernel opensession-agent-host opensession-executor)
for identity in "${identities[@]}"; do
  if getent passwd "$identity" >/dev/null; then
    [ "$(getent passwd "$identity" | cut -d: -f7)" = /usr/sbin/nologin ] || {
      echo "[agent-host-install] ERROR: existing $identity account is not a nologin service account" >&2; exit 1;
    }
  else
    getent group "$identity" >/dev/null || groupadd --system "$identity"
    useradd --system --gid "$identity" --home-dir /nonexistent --no-create-home --shell /usr/sbin/nologin "$identity"
  fi
done

uids=()
for identity in "${identities[@]}"; do uids+=("$(id -u "$identity")"); done
[ "$(printf '%s\n' "${uids[@]}" | sort -u | wc -l)" = "${#identities[@]}" ] || {
  echo "[agent-host-install] ERROR: Open Session service identities must have distinct UIDs" >&2; exit 1;
}
GATEWAY_UID="$(id -u opensession-gateway)"
HOST_UID="$(id -u opensession-agent-host)"

install -d -o root -g root -m 0755 /run/opensession /var/lib/opensession
install -d -o root -g root -m 0755 /etc/opensession /etc/opensession/credentials
install -d -o root -g opensession-agent-host -m 0710 \
  /var/lib/opensession/agent-host /etc/opensession/credentials/agent-host
for identity in gateway session-kernel executor; do
  account="opensession-$identity"
  install -d -o "$account" -g "$account" -m 0700 "/var/lib/opensession/$identity"
done

escape_sed() { printf '%s' "$1" | sed 's/[&|]/\\&/g'; }
workdir_escaped="$(escape_sed "$WORKDIR")"
bun_escaped="$(escape_sed "$BUN")"
rendered="$(mktemp)"
trap 'rm -f "$rendered"' EXIT
sed \
  -e "s|@@WORKING_DIRECTORY@@|$workdir_escaped|g" \
  -e "s|@@BUN@@|$bun_escaped|g" \
  -e "s|@@GATEWAY_UID@@|$GATEWAY_UID|g" \
  -e "s|@@HOST_UID@@|$HOST_UID|g" \
  "$REPO_DIR/opensession-agent-host@.service" > "$rendered"
install -o root -g root -m 0644 "$rendered" /etc/systemd/system/opensession-agent-host@.service
install -o root -g root -m 0644 "$REPO_DIR/opensession-agent-host@.socket" /etc/systemd/system/opensession-agent-host@.socket
systemctl daemon-reload

# Installation must not activate the production-unwired boundary.
if systemctl list-unit-files 'opensession-agent-host@*.socket' --state=enabled --no-legend 2>/dev/null | grep -q .; then
  echo "[agent-host-install] ERROR: Agent Host socket instance is unexpectedly enabled" >&2
  exit 1
fi
if systemctl list-units 'opensession-agent-host@*.service' 'opensession-agent-host@*.socket' --state=active --no-legend 2>/dev/null | grep -q .; then
  echo "[agent-host-install] ERROR: Agent Host topology is unexpectedly active" >&2
  exit 1
fi

echo "[agent-host-install] installed disabled Agent Host topology"
