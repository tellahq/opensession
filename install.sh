#!/usr/bin/env bash
#
# Open Session installer.
#
#   curl -fsSL https://raw.githubusercontent.com/tellahq/opensession/main/install.sh | bash
#
# Gets a bare box to a working `opensession` command: installs Bun if needed,
# clones the source, installs dependencies, puts a shim on PATH, and hands off
# to `opensession onboard`.
#
# Safe to re-run — an existing install is fast-forwarded, never clobbered.
#
# Flags (also settable as environment variables):
#   --dir <path>          OPENSESSION_DIR      install location
#   --channel <ref>       OPENSESSION_CHANNEL  branch or tag to track
#   --repo <url>          OPENSESSION_REPO     source repository
#   --artifact <path|url> OPENSESSION_ARTIFACT install this prebuilt release instead
#                                              of the latest published one
#   --source                                   install from a git checkout (the
#                                              contributor path; --repo/--channel imply it)
#                                              tarball (scripts/build-release.ts)
#                                              instead of cloning source: no
#                                              Bun install, no bun install
#   --no-modify-path      NO_MODIFY_PATH=1     do not touch shell profiles
#   --no-onboard          NO_ONBOARD=1         install only, skip the wizard
#   --no-engine           NO_ENGINE=1          do not install the model CLIs
#   --no-codex            WITH_CODEX=0         do not install the codex CLI
#   --codex               WITH_CODEX=1         install the codex CLI (the default;
#                                              retained for compatibility)
#   --tailscale           WITH_TAILSCALE=1     also install Tailscale (off by
#                                              default; --no-tailscale still accepted)
#   --caddy               WITH_CADDY=1         install Caddy and lego for managed
#                                              private or public custom domains
#   --cloudflare          WITH_CLOUDFLARE=1    install cloudflared for Tunnel
#                                              public ingress
#   --org <name>          OPENSESSION_ORG      set this instance up for a GitHub
#                                              org: an org-owned GitHub App plus
#                                              per-user sign-in, turned on when
#                                              the first admin connects. Omit for
#                                              a single-user install.
#   --advanced                                 interactive onboarding (all the
#                                              questions); default writes defaults
#                                              and asks nothing
#   --yes                 NO_PROMPT=1          accept defaults, never prompt
#   --uninstall                                stop the service and remove everything
#                                              the install owns (with --yes: no
#                                              confirmation). Repositories registered
#                                              from elsewhere are untouched.
#
# OPENSESSION_CLAUDE_TOKEN  a `claude setup-token` value; staged for the server
#                           to import into its account pool at first start
# OPENSESSION_ARTIFACT_SHA256 expected SHA-256 for a local/custom artifact;
#                           otherwise <artifact>.sha256 is required
#
# With --tailscale the client is installed but not joined to a network, since
# joining needs your account. Set TS_AUTHKEY to have the installer do that too.
#
set -euo pipefail

OPENSESSION_HOME="${OPENSESSION_HOME:-$HOME/.opensession}"
DIR="${OPENSESSION_DIR:-$OPENSESSION_HOME/src}"
BIN_DIR="$OPENSESSION_HOME/bin"
REPO="${OPENSESSION_REPO:-https://github.com/tellahq/opensession.git}"
ARTIFACT="${OPENSESSION_ARTIFACT:-}"
# Where published releases live; the default install downloads
# opensession-<os>-<arch>.tar.gz from here (the stable alias each release
# carries beside its versioned tarball; .github/workflows/release.yml).
RELEASE_BASE="${OPENSESSION_RELEASE_BASE:-https://github.com/tellahq/opensession/releases/latest/download}"
# Naming a repo or channel means a checkout is wanted, flag or env alike.
FROM_SOURCE=0
[ -n "${OPENSESSION_REPO:-}${OPENSESSION_CHANNEL:-}" ] && FROM_SOURCE=1
CHANNEL="${OPENSESSION_CHANNEL:-}"
# The GitHub org this instance is for. Set = onboarding writes an org App owner
# and the intent to turn on per-user sign-in at first connect; unset = today's
# single-user install.
ORG="${OPENSESSION_ORG:-}"
NO_MODIFY_PATH="${NO_MODIFY_PATH:-0}"
NO_ONBOARD="${NO_ONBOARD:-0}"
NO_ENGINE="${NO_ENGINE:-0}"
IS_BINARY=0
WITH_CODEX="${WITH_CODEX:-1}"
WITH_TAILSCALE="${WITH_TAILSCALE:-0}"
WITH_CADDY="${WITH_CADDY:-0}"
WITH_CLOUDFLARE="${WITH_CLOUDFLARE:-0}"
ADVANCED=0
NO_PROMPT="${NO_PROMPT:-0}"
DO_UNINSTALL=0
OS="$(uname -s)"

while [ $# -gt 0 ]; do
  case "$1" in
    --dir) DIR="$2"; shift 2 ;;
    --channel) CHANNEL="$2"; FROM_SOURCE=1; shift 2 ;;
    --repo) REPO="$2"; FROM_SOURCE=1; shift 2 ;;
    --artifact) ARTIFACT="$2"; shift 2 ;;
    --org) ORG="$2"; shift 2 ;;
    --source) FROM_SOURCE=1; shift ;;
    --no-modify-path) NO_MODIFY_PATH=1; shift ;;
    --no-onboard) NO_ONBOARD=1; shift ;;
    --no-engine) NO_ENGINE=1; shift ;;
    --no-codex) WITH_CODEX=0; shift ;;
    --codex) WITH_CODEX=1; shift ;;
    --tailscale) WITH_TAILSCALE=1; shift ;;
    --no-tailscale) WITH_TAILSCALE=0; shift ;;
    --caddy) WITH_CADDY=1; shift ;;
    --cloudflare) WITH_CLOUDFLARE=1; shift ;;
    --advanced) ADVANCED=1; shift ;;
    --yes|-y) NO_PROMPT=1; shift ;;
    --uninstall) DO_UNINSTALL=1; shift ;;
    # Print the header comment, stopping at the first line that is not one, so
    # this does not need re-pointing every time the header grows.
    -h|--help) awk 'NR>1 && /^#/ {sub(/^# ?/, ""); print; next} NR>1 {exit}' "$0"; exit 0 ;;
    *) echo "unknown flag: $1" >&2; exit 1 ;;
  esac
done

# ── output ──────────────────────────────────────────────────────────────────

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  B=$'\033[1m'; D=$'\033[2m'; G=$'\033[32m'; Y=$'\033[33m'; R=$'\033[31m'; C=$'\033[36m'; N=$'\033[0m'
else
  B=""; D=""; G=""; Y=""; R=""; C=""; N=""
fi

step() { printf '%s\n' "${B}$1${N}"; }
success() { printf '%s\n' "${B}${G}$1${N}"; }
# Strip credentials out of a URL before printing it. A tokenised clone URL in
# terminal scrollback or CI logs is a leaked credential.
redact() { printf '%s' "$1" | sed -E 's#(://)[^/@]*@#\1***@#'; }
info() { printf '  %s\n' "$1"; }
muted() { printf '  %s%s%s\n' "$D" "$1" "$N"; }
good() { printf '  %sok%s      %s\n' "$G" "$N" "$1"; }
warn() { printf '  %swarn%s    %s\n' "$Y" "$N" "$1"; }
die() { printf '  %serror%s   %s\n' "$R" "$N" "$1" >&2; exit 1; }

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    die "SHA-256 verification requires sha256sum or shasum"
  fi
}

verify_release_archive() {
  archive="$1" checksum_file="${2:-}" checksum_label="${3:-checksum}"
  expected="${OPENSESSION_ARTIFACT_SHA256:-}"
  if [ -z "$expected" ]; then
    [ -n "$checksum_file" ] && [ -s "$checksum_file" ] ||
      die "missing SHA-256 checksum for $archive ($checksum_label)"
    expected="$(awk 'NF {print $1; exit}' "$checksum_file")"
  fi
  if [ "${#expected}" -ne 64 ]; then
    die "invalid SHA-256 checksum from $checksum_label (expected 64 hex characters)"
  fi
  case "$expected" in *[!0-9a-fA-F]*) die "invalid SHA-256 checksum from $checksum_label" ;; esac
  actual="$(sha256_file "$archive")"
  [ "$(printf '%s' "$actual" | tr 'A-F' 'a-f')" = "$(printf '%s' "$expected" | tr 'A-F' 'a-f')" ] ||
    die "SHA-256 mismatch for $archive (expected $expected, got $actual)"
  good "verified SHA-256 for $(basename "$archive")"
}

# ── uninstall ───────────────────────────────────────────────────────────────

if [ "$DO_UNINSTALL" = "1" ]; then
  step "Uninstalling Open Session"
  if [ "$OS" = "Darwin" ]; then
    plist="$HOME/Library/LaunchAgents/dev.opensession.server.plist"
    if [ -f "$plist" ]; then
      launchctl bootout "gui/$(id -u)/dev.opensession.server" 2>/dev/null || true
      rm -f "$plist"
      good "LaunchAgent removed"
    fi
  else
    user_unit="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/opensession.service"
    if [ -f "$user_unit" ]; then
      export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
      systemctl --user disable --now opensession 2>/dev/null || true
      rm -f "$user_unit"
      systemctl --user daemon-reload 2>/dev/null || true
      good "user service removed"
    fi
    if [ -e /etc/systemd/system/opensession.service ] \
      || [ -e /etc/systemd/system/opensession-executor.service ] \
      || [ -e /etc/systemd/system/opensession.service.d/executor-credential.conf ] \
      || [ -e /etc/opensession/executor-token ] \
      || [ -e /etc/opensession/run-host.conf ] \
      || [ -e /etc/sudoers.d/opensession-run-host ] \
      || [ -e /usr/local/libexec/opensession-run-host ]; then
      sudo systemctl disable --now opensession 2>/dev/null || true
      sudo systemctl disable --now opensession-executor 2>/dev/null || true
      sudo rm -f /etc/systemd/system/opensession.service
      sudo rm -f /etc/systemd/system/opensession-executor.service
      sudo rm -f /etc/systemd/system/opensession.service.d/executor-credential.conf
      sudo rm -f /etc/opensession/executor-token
      sudo rm -f /etc/opensession/run-host.conf
      sudo rm -f /etc/sudoers.d/opensession-run-host
      sudo rm -f /usr/local/libexec/opensession-run-host
      sudo rmdir /etc/systemd/system/opensession.service.d /etc/opensession 2>/dev/null || true
      sudo systemctl daemon-reload 2>/dev/null || true
      good "system services and executor policy removed"
    fi
  fi
  rm -rf "$BIN_DIR"
  good "shim removed from $BIN_DIR"

  # The PATH block this installer appended (a "# opensession" marker line and
  # the export/fish_add_path line after it), in every profile it may have
  # touched. Only that block; nothing else in the file moves.
  for profile in "$HOME/.bashrc" "$HOME/.profile" "${ZDOTDIR:-$HOME}/.zshrc" "${ZDOTDIR:-$HOME}/.zshenv" "$HOME/.config/fish/config.fish"; do
    [ -f "$profile" ] && grep -q '^# opensession$' "$profile" || continue
    tmp="$(mktemp)"
    awk -v bin="$BIN_DIR" '
      $0 == "# opensession" { skip = 1; next }
      skip == 1 { skip = 0; if (index($0, bin) > 0) next }
      { print }
    ' "$profile" > "$tmp" && cat "$tmp" > "$profile"
    rm -f "$tmp"
    good "PATH line removed from $profile"
  done

  # Everything else the install owns: the release or checkout, config, logs,
  # the secrets file, and the app state (session store, audit log, model
  # accounts). Session worktrees with unsaved work and scratch workspace files
  # are preserved below; repositories registered from elsewhere are never
  # under any of these. Ask when there is someone to ask, since this is data;
  # --yes is the answer for scripts. Without a terminal and without --yes, keep.
  remove_data=1
  if [ "$NO_PROMPT" != "1" ]; then
    remove_data=0
    if [ -r /dev/tty ] && { : </dev/tty; } 2>/dev/null; then
      printf '  remove %s, secrets and app state (session store, accounts, audit)? [y/N] ' "$OPENSESSION_HOME"
      read -r answer </dev/tty || answer=""
      case "$answer" in y*|Y*) remove_data=1 ;; esac
    fi
  fi
  # Removal classifies what it touches; it never blanket-globs, because two
  # kinds of user work live under the ~/.opensession* names:
  #
  #  - session worktrees, at the configured worktrees dir (env >
  #    config `paths.worktreesDir` > $OPENSESSION_HOME/worktrees) — which can
  #    sit at a `~/.opensession-*` path, so a `~/.opensession-*` glob would
  #    delete it and the scan would miss it;
  #  - scratch workspace directories under ~/.opensession/scratch/<id> (or the
  #    legacy ~/.opensession-scratch/<id>) — plain
  #    (non-git) working dirs holding downloaded and edited files.
  #
  # So: resolve the real worktrees dir and scan it for unsaved git work,
  # preserve a non-empty scratch dir, and remove only an explicit list of app
  # state and credentials. Anything unrecognised is left, not guessed at.

  worktrees_dir="${OPENSESSION_WORKTREES_DIR:-}"
  if [ -z "$worktrees_dir" ] && [ -f "$OPENSESSION_HOME/config.json" ]; then
    worktrees_dir="$(sed -n 's/.*"worktreesDir": *"\([^"]*\)".*/\1/p' "$OPENSESSION_HOME/config.json" | head -1)"
  fi
  [ -z "$worktrees_dir" ] && worktrees_dir="$OPENSESSION_HOME/worktrees"

  # Scan the worktrees dir for unsaved work: uncommitted changes, or commits
  # reachable from a worktree's HEAD that are on no remote and not on the
  # repo's main/master (deleting the worktree would be their only copy; a
  # no-remote repo like scratch is judged the same way — work an agent added
  # on top of the base counts, a freshly branched clean worktree does not).
  dirty_worktrees=""
  if [ "$remove_data" = "1" ] && command -v git >/dev/null 2>&1 && [ -d "$worktrees_dir" ]; then
    while IFS= read -r gitpath; do
      wt="$(dirname "$gitpath")"
      if [ -n "$(git -C "$wt" status --porcelain 2>/dev/null)" ]; then
        dirty_worktrees="$dirty_worktrees  $wt (uncommitted)"$'\n'; continue
      fi
      base="$(git -C "$wt" rev-parse --verify -q main 2>/dev/null || git -C "$wt" rev-parse --verify -q master 2>/dev/null || true)"
      if [ -n "$(git -C "$wt" log --oneline HEAD --not --remotes ${base:+"$base"} 2>/dev/null)" ]; then
        dirty_worktrees="$dirty_worktrees  $wt (unpushed commits)"$'\n'
      fi
    done <<EOT
$(find "$worktrees_dir" -maxdepth 4 -name .git 2>/dev/null)
EOT
  fi

  # A non-empty scratch dir holds workspace files, not app state.
  if [ -d "$OPENSESSION_HOME/scratch" ]; then
    scratch_state="$OPENSESSION_HOME/scratch"
  else
    scratch_state="$HOME/.opensession-scratch"
  fi
  scratch_has_data=0
  [ -d "$scratch_state" ] && [ -n "$(ls -A "$scratch_state" 2>/dev/null)" ] && scratch_has_data=1

  if [ "$remove_data" = "1" ]; then
    kept_any=0
    # The install home holds the default worktrees dir and the scratch git repo
    # its worktrees branch from; keep the whole thing if any of its worktrees is
    # unsaved. A worktrees dir configured OUTSIDE the home is preserved on its
    # own in the state sweep below.
    if { [ -n "$dirty_worktrees" ] && case "$worktrees_dir" in "$OPENSESSION_HOME"/*) true ;; *) false ;; esac; } || \
       { [ "$scratch_has_data" = "1" ] && case "$scratch_state" in "$OPENSESSION_HOME"/*) true ;; *) false ;; esac; }; then
      warn "keeping $OPENSESSION_HOME: session worktrees or scratch files have unsaved work"
      [ -n "$dirty_worktrees" ] && printf '%s' "$dirty_worktrees" | sed '/^$/d'
      kept_any=1
    else
      rm -rf "$OPENSESSION_HOME"
      good "removed $OPENSESSION_HOME"
    fi
    rm -f "$HOME/.opensession.env"

    # Legacy state lives across a growing set of ~/.opensession-* names
    # (sessions, audit, accounts, automations, github, …). New state was removed
    # with $OPENSESSION_HOME above. Remove legacy entries too, EXCEPT the two
    # that can hold user work: a non-empty scratch workspace dir, and a
    # worktrees dir configured at a ~/.opensession-* path that has unsaved work.
    # Classifying by what to KEEP (not an ever-growing list of what to delete)
    # is what keeps a new state dir from being left behind or user work from
    # being destroyed.
    for p in "$HOME"/.opensession-*; do
      [ -e "$p" ] || continue
      if [ "$p" = "$scratch_state" ] && [ "$scratch_has_data" = "1" ]; then
        muted "kept $scratch_state (workspace files)"; kept_any=1; continue
      fi
      if [ "$p" = "$worktrees_dir" ] && [ -n "$dirty_worktrees" ]; then
        warn "keeping $worktrees_dir: session worktrees have unsaved work"
        printf '%s' "$dirty_worktrees" | sed '/^$/d'; kept_any=1; continue
      fi
      rm -rf "$p"
    done
    good "removed session store, audit log, model accounts and secrets"
    [ "$kept_any" = "1" ] && muted "commit/push or copy out anything you want, then delete the kept paths by hand"
  else
    muted "kept $OPENSESSION_HOME, $HOME/.opensession.env and app state (re-run with --yes to remove)"
  fi
  # Tailscale is a system daemon that may now be carrying your SSH access.
  # Removing it as a side effect of uninstalling Open Session would be hostile.
  if command -v tailscale >/dev/null 2>&1; then
    muted "  tailscale              still installed ('sudo tailscale down' to leave)"
  fi
  exit 0
fi

# ── prompting ───────────────────────────────────────────────────────────────
#
# Under `curl | bash` stdin is the script itself, so anything interactive must
# be re-attached to the terminal. Test stdin (-t 0), never stdout: redirecting
# output would otherwise silently turn an interactive install into a
# defaults-only one.

STDIN_PATH=""
if [ "$NO_PROMPT" = "1" ]; then
  STDIN_PATH=/dev/null
elif [ ! -t 0 ]; then
  if [ -r /dev/tty ] && { : </dev/tty; } 2>/dev/null; then
    STDIN_PATH=/dev/tty
  else
    STDIN_PATH=/dev/null
  fi
fi

# Run a command with stdin pointed somewhere it can actually prompt from.
run_interactive() {
  if [ -n "$STDIN_PATH" ]; then "$@" <"$STDIN_PATH"; else "$@"; fi
}

# ── plan ────────────────────────────────────────────────────────────────────

printf '\n'
step "Open Session"
muted "source      $(redact "$REPO")${CHANNEL:+ ($CHANNEL)}"
muted "install to  $DIR"
muted "command     $BIN_DIR/opensession"
printf '\n'

# ── prerequisites ───────────────────────────────────────────────────────────

step "Prerequisites"

# Install a missing system package. Minimal cloud images (the Ubuntu EC2 AMI
# among them) ship without unzip, which Bun's own installer requires — so
# without this the very first install on a fresh box fails.
install_package() {
  pkg="$1"
  # Homebrew installs as the invoking user — no sudo, and asking for it is
  # actively wrong on macOS.
  if [ "$OS" = "Darwin" ]; then
    if ! command -v brew >/dev/null 2>&1; then
      warn "Homebrew is required to install $pkg automatically on macOS"
      muted "install Homebrew from https://brew.sh, then re-run the installer"
      return 1
    fi
    brew install --quiet "$pkg" >/dev/null 2>&1
    return $?
  fi
  if ! sudo -n true 2>/dev/null; then
    return 1
  fi
  if command -v apt-get >/dev/null 2>&1; then
    sudo -n apt-get update -qq >/dev/null 2>&1
    sudo -n apt-get install -y -qq "$pkg" >/dev/null 2>&1
  elif command -v dnf >/dev/null 2>&1; then
    sudo -n dnf install -y -q "$pkg" >/dev/null 2>&1
  elif command -v apk >/dev/null 2>&1; then
    sudo -n apk add --quiet "$pkg" >/dev/null 2>&1
  else
    return 1
  fi
}

# cmd -> package name, when they differ
require_tool() {
  cmd="$1"; pkg="${2:-$1}"; why="$3"
  command -v "$cmd" >/dev/null 2>&1 && return 0
  muted "installing $pkg ($why) ..."
  if install_package "$pkg" && command -v "$cmd" >/dev/null 2>&1; then
    good "$pkg installed"
  else
    die "$cmd is required ($why). Install $pkg and re-run."
  fi
}

require_tool curl curl "downloading Bun"
require_tool git git "cloning the source"
good "git $(git --version | awk '{print $3}')"

# Bun's own installer shells out to unzip. On a box with neither unzip nor
# passwordless sudo (minimal containers, locked-down hosts, an EC2 image whose
# default user was overridden) that is a dead end — so fall back to Python's
# zipfile module, which is present on essentially every Linux image.
install_bun_via_python() {
  command -v python3 >/dev/null 2>&1 || return 1
  case "$OS" in
    Darwin) plat="darwin" ;;
    Linux)  plat="linux" ;;
    *) return 1 ;;
  esac
  case "$(uname -m)" in
    x86_64|amd64) target="bun-${plat}-x64" ;;
    aarch64|arm64) target="bun-${plat}-aarch64" ;;
    *) return 1 ;;
  esac

  tmp="$(mktemp -d)"
  url="https://github.com/oven-sh/bun/releases/latest/download/${target}.zip"
  curl -fsSL "$url" -o "$tmp/bun.zip" 2>/dev/null || { rm -rf "$tmp"; return 1; }
  python3 -m zipfile -e "$tmp/bun.zip" "$tmp" >/dev/null 2>&1 || { rm -rf "$tmp"; return 1; }
  mkdir -p "$HOME/.bun/bin"
  mv "$tmp/$target/bun" "$HOME/.bun/bin/bun" 2>/dev/null || { rm -rf "$tmp"; return 1; }
  chmod +x "$HOME/.bun/bin/bun"
  rm -rf "$tmp"

  # Pre-AVX2 CPUs need the baseline build; the normal one dies with SIGILL.
  # Only x64 has a baseline variant.
  if ! "$HOME/.bun/bin/bun" --version >/dev/null 2>&1 && [ "${target%-x64}" != "$target" ]; then
    tmp="$(mktemp -d)"
    curl -fsSL "https://github.com/oven-sh/bun/releases/latest/download/${target}-baseline.zip" \
      -o "$tmp/bun.zip" 2>/dev/null || { rm -rf "$tmp"; return 1; }
    python3 -m zipfile -e "$tmp/bun.zip" "$tmp" >/dev/null 2>&1 || { rm -rf "$tmp"; return 1; }
    mv "$tmp/${target}-baseline/bun" "$HOME/.bun/bin/bun" 2>/dev/null || { rm -rf "$tmp"; return 1; }
    chmod +x "$HOME/.bun/bin/bun"
    rm -rf "$tmp"
  fi
  "$HOME/.bun/bin/bun" --version >/dev/null 2>&1
}

# ── release artefact ────────────────────────────────────────────────────────
#
# The default install is a prebuilt release: a tarball that carries its own
# Bun and dependencies, unpacked under releases/ with $DIR (the checkout path
# everything else expects) pointing at it, so onboarding, the shim and the CLI
# work unchanged. Without --artifact, the latest published release for this
# OS/arch is downloaded; a box with an existing source checkout at $DIR, or
# --source/--repo/--channel, takes the git path instead. If no release exists
# for this platform yet, say so and fall back to source rather than stop.
if [ "$FROM_SOURCE" != "1" ] && [ -z "$ARTIFACT" ] && ! { [ -e "$DIR/.git" ] && [ ! -L "$DIR" ]; }; then
  case "$OS" in Linux) rel_os=linux ;; Darwin) rel_os=darwin ;; *) rel_os="" ;; esac
  case "$(uname -m)" in aarch64|arm64) rel_arch=arm64 ;; x86_64|amd64) rel_arch=x64 ;; *) rel_arch="" ;; esac
  if [ -n "$rel_os" ] && [ -n "$rel_arch" ]; then
    rel_url="$RELEASE_BASE/opensession-$rel_os-$rel_arch.tar.gz"
    step "Release"
    muted "downloading $rel_url ..."
    art_tmp="$(mktemp -d)"
    if curl -fsSL --retry 3 "$rel_url" -o "$art_tmp/release.tar.gz" 2>/dev/null; then
      checksum_url="$rel_url.sha256"
      curl -fsSL --retry 3 "$checksum_url" -o "$art_tmp/release.tar.gz.sha256" 2>/dev/null ||
        die "release downloaded but its checksum is unavailable at $checksum_url"
      ARTIFACT="$art_tmp/release.tar.gz"
      art_checksum="$art_tmp/release.tar.gz.sha256"
      art_checksum_label="$checksum_url"
    else
      rm -rf "$art_tmp"
      warn "no published release for $rel_os/$rel_arch at $rel_url"
      muted "installing from source instead (a checkout, Bun and a dependency install)"
    fi
  fi
fi
if [ -n "$ARTIFACT" ]; then
  [ -n "${rel_url:-}" ] || step "Release"
  RELEASES="$OPENSESSION_HOME/releases"
  mkdir -p "$RELEASES"
  case "$ARTIFACT" in
    http://*|https://*)
      artifact_url="$ARTIFACT"
      art_tmp="$(mktemp -d)"
      curl -fsSL --retry 3 "$artifact_url" -o "$art_tmp/release.tar.gz" || die "could not download $artifact_url"
      art_file="$art_tmp/release.tar.gz"
      art_checksum="$art_tmp/release.tar.gz.sha256"
      art_checksum_label="$artifact_url.sha256"
      if [ -z "${OPENSESSION_ARTIFACT_SHA256:-}" ]; then
        curl -fsSL --retry 3 "$artifact_url.sha256" -o "$art_checksum" ||
          die "artifact downloaded but its checksum is unavailable at $artifact_url.sha256"
      fi ;;
    *)
      art_file="$ARTIFACT"; [ -f "$art_file" ] || die "no such file: $art_file"
      art_checksum="$art_file.sha256"
      art_checksum_label="$art_checksum" ;;
  esac
  verify_release_archive "$art_file" "${art_checksum:-}" "${art_checksum_label:-provided checksum}"
  # awk reads the whole listing so tar never sees a closed pipe (pipefail).
  rel_name="$(tar -tzf "$art_file" 2>/dev/null | awk -F/ 'NR==1{print $1}')"
  [ -n "$rel_name" ] || die "could not read the release tarball"
  if [ ! -d "$RELEASES/$rel_name" ]; then
    tar -xzf "$art_file" -C "$RELEASES" 2>/dev/null || die "could not unpack $art_file"
    good "unpacked $rel_name"
  else
    good "$rel_name already unpacked"
  fi
  if [ -e "$DIR" ] && [ ! -L "$DIR" ]; then
    die "$DIR is a source checkout — remove it or pass --dir to install a release beside it"
  fi
  ln -sfn "$RELEASES/$rel_name" "$DIR"
  good "$DIR -> releases/$rel_name"
  export PATH="$DIR/bin:$PATH"
  [ -n "${art_tmp:-}" ] && rm -rf "$art_tmp"
  # A compiled-binary artefact ships a top-level `opensession` executable and no
  # scripts/ tree; a source-tarball artefact ships bin/bun + scripts/.
  if [ -x "$DIR/opensession" ] && [ ! -d "$DIR/scripts" ]; then IS_BINARY=1; fi
fi

if [ "$IS_BINARY" = "1" ]; then
  : # the compiled binary embeds its runtime; no Bun on the box
elif [ -n "$ARTIFACT" ] && [ -x "$DIR/bin/bun" ]; then
  : # the release brings its own Bun
elif ! command -v bun >/dev/null 2>&1; then
  muted "installing Bun ..."
  export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"

  if command -v unzip >/dev/null 2>&1 || install_package unzip; then
    bun_log="$(mktemp)"
    if ! curl -fsSL https://bun.sh/install | bash >"$bun_log" 2>&1; then
      # Never swallow this: a hidden installer error is undiagnosable.
      warn "Bun's installer failed:"
      sed 's/^/    /' "$bun_log" | tail -20
      rm -f "$bun_log"
      die "could not install Bun — see https://bun.sh"
    fi
    rm -f "$bun_log"
  elif install_bun_via_python; then
    muted "(unzip unavailable — extracted with python3)"
  else
    die "could not install Bun — install unzip and re-run, or see https://bun.sh"
  fi

  # Bun's installer appends to a shell profile this non-interactive shell has
  # not sourced, so put it on PATH for the rest of this run explicitly.
  export PATH="$BUN_INSTALL/bin:$PATH"
  command -v bun >/dev/null 2>&1 || die "Bun installed but not on PATH — open a new shell and re-run"
fi
if [ "$IS_BINARY" = "1" ]; then good "single-executable release (no Bun needed)"; else good "bun $(bun --version)"; fi

# ── source ──────────────────────────────────────────────────────────────────

step "Source"
if [ -n "$ARTIFACT" ]; then
  good "release $(sed -n 's/.*"version": "\([^"]*\)".*/\1/p' "$DIR/release.json" 2>/dev/null || echo "$rel_name") (no checkout)"
elif [ -d "$DIR/.git" ]; then
  git -C "$DIR" fetch --quiet origin
  target="${CHANNEL:-$(git -C "$DIR" rev-parse --abbrev-ref HEAD)}"
  if [ -n "$(git -C "$DIR" status --porcelain)" ]; then
    warn "local changes present — leaving the checkout alone"
  elif git -C "$DIR" merge --ff-only --quiet "origin/$target" 2>/dev/null; then
    good "updated to $(git -C "$DIR" rev-parse --short HEAD)"
  else
    warn "could not fast-forward — leaving the checkout alone"
  fi
else
  [ -e "$DIR" ] && die "$DIR exists but is not a git checkout — move it or pass --dir"
  mkdir -p "$(dirname "$DIR")"
  clone_log="$(mktemp)"
  clone_args="--quiet"
  [ -n "$CHANNEL" ] && clone_args="$clone_args --branch $CHANNEL"
  # shellcheck disable=SC2086
  if ! git clone $clone_args "$REPO" "$DIR" >"$clone_log" 2>&1; then
    warn "clone failed:"
    # git echoes the remote URL on failure, which may carry a token.
    redact "$(sed 's/^/    /' "$clone_log" | tail -10)"; printf '\n'
    rm -f "$clone_log"
    die "could not clone $(redact "$REPO")"
  fi
  rm -f "$clone_log"
  good "cloned to $DIR"
fi

# Cloning a private fork with a tokenised URL leaves that token in
# .git/config, which is a file people paste into bug reports and which
# `opensession update` would keep using forever. Move it into git's own
# credential store (0600) and point the remote at the clean URL.
if git -C "$DIR" remote get-url origin 2>/dev/null | grep -q '://[^/@]*@'; then
  full_url="$(git -C "$DIR" remote get-url origin)"
  clean_url="$(printf '%s' "$full_url" | sed -E 's#(://)[^/@]*@#\1#')"
  cred_file="$HOME/.git-credentials"
  touch "$cred_file"; chmod 600 "$cred_file"
  grep -qxF "$full_url" "$cred_file" 2>/dev/null || printf '%s\n' "$full_url" >>"$cred_file"
  git -C "$DIR" remote set-url origin "$clean_url"
  git -C "$DIR" config credential.helper store
  good "clone credentials moved to ~/.git-credentials (0600)"
fi

step "Dependencies"
if [ -n "$ARTIFACT" ]; then
  good "bundled with the release"
else
  (cd "$DIR" && bun install --silent) || die "bun install failed"
  good "installed"
fi

# ── engine ──────────────────────────────────────────────────────────────────
#
# Pi is bundled with Open Session, while the subscription-backed provider paths
# also use two external CLIs:
#
#   claude    the bundled Anthropic bridge execs it, and `claude setup-token`
#             is how you mint an account token.
#   codex     `codex login --device-auth` backs the ChatGPT sign-in in the UI
#             (codex-device-login.ts).
#
# Both are installed by default so either subscription path works out of the
# box. Each is skipped when already present, so re-runs are free. `--no-engine`
# skips both, while `--no-codex` skips only Codex.

# First line of `<bin> --version`, or $2 when it prints nothing usable. Kept
# separate so the `||` fallback isn't swallowed by a pipeline's exit status.
cli_version() {
  cli_v="$("$1" --version 2>/dev/null | head -1)" || cli_v=""
  printf '%s' "${cli_v:-$2}"
}

# $1 binary, $2 label, $3 install command, $4 PATH dir to add on success.
install_cli() {
  cli_bin="$1"; cli_label="$2"; cli_cmd="$3"; cli_path="${4:-}"; cli_want="${5:-}"
  if command -v "$cli_bin" >/dev/null 2>&1; then
    cli_have="$(cli_version "$cli_bin" "")"
    # A concrete pin must match: an older binary paired with a newer server can
    # break turns. "latest" or no pin: any is ok.
    if [ -z "$cli_want" ] || [ "$cli_want" = "latest" ] || [ "$cli_have" = "$cli_want" ]; then
      good "$cli_label $cli_have"
      return 0
    fi
    muted "$cli_label $cli_have installed, pinned to $cli_want — reinstalling ..."
  else
    muted "installing $cli_label ..."
  fi
  cli_log="$(mktemp)"
  if sh -c "$cli_cmd" >"$cli_log" 2>&1; then
    # A plain `[ -n "$x" ] && export …` here would make the function return
    # non-zero when no PATH dir is passed, which `set -e` turns into an exit.
    if [ -n "$cli_path" ]; then export PATH="$cli_path:$PATH"; fi
    good "$cli_label $(cli_version "$cli_bin" installed)"
  else
    # Never fatal: a box with the server and no CLI is recoverable, and
    # `opensession doctor` names whichever one is missing.
    warn "could not install $cli_label automatically:"
    sed 's/^/    /' "$cli_log" | tail -10
    muted "install it later: $cli_cmd"
  fi
  rm -f "$cli_log"
}

step "Engine"
if [ "$NO_ENGINE" = "1" ]; then
  muted "skipped (--no-engine)"
else
  install_cli claude "Claude Code" \
    "curl -fsSL https://claude.ai/install.sh | bash" "$HOME/.local/bin"
  if [ "$WITH_CODEX" = "1" ]; then
    install_cli codex "Codex" \
      "curl -fsSL https://chatgpt.com/codex/install.sh | CODEX_NON_INTERACTIVE=1 sh" "$HOME/.local/bin"
  fi

fi

# ── network ─────────────────────────────────────────────────────────────────
#
# Open Session has no authentication and trusts everyone who can reach the
# address it binds to, so a private network is not a nice-to-have — it is the
# access control. The default install binds 127.0.0.1 and needs no network
# software; Tailscale is off the critical path (adrs/simple-mode.md R1.2) and
# comes in with --tailscale, or later when sharing is set up. Installed here,
# `opensession onboard` can offer the tailnet address as the bind default
# instead of the usual outcome: 127.0.0.1, discovering later that nobody
# else can reach it, and reaching for HOST=0.0.0.0.
#
# Installing the client is not joining a network. `tailscale up` needs your
# account, and under `curl | bash` there is often no terminal to authenticate
# from — so joining happens only with an auth key, or later by hand.

step "Network"
tailnet_ip() { command -v tailscale >/dev/null 2>&1 && tailscale ip -4 2>/dev/null | head -1; }

if [ "$WITH_TAILSCALE" != "1" ] && ! command -v tailscale >/dev/null 2>&1; then
  muted "Tailscale not installed (--tailscale to add it; sharing the UI needs a private network)"
elif [ -n "$(tailnet_ip)" ]; then
  good "tailscale $(tailnet_ip)"
else
  if ! command -v tailscale >/dev/null 2>&1; then
    if [ "$OS" = "Darwin" ]; then
      muted "install Tailscale from https://tailscale.com/download/mac"
    elif ! sudo -n true 2>/dev/null; then
      muted "skipped (needs sudo) — curl -fsSL https://tailscale.com/install.sh | sh"
    else
      muted "installing Tailscale ..."
      ts_log="$(mktemp)"
      # Redirect the whole pipeline, not the sudo: the log belongs to us, and
      # a redirect on `sudo` is applied by this shell anyway (shellcheck SC2024).
      if { curl -fsSL https://tailscale.com/install.sh | sudo -n sh; } >"$ts_log" 2>&1; then
        good "tailscale $(tailscale version 2>/dev/null | head -1 || echo installed)"
      else
        warn "could not install Tailscale automatically:"
        sed 's/^/    /' "$ts_log" | tail -10
        muted "install it later: curl -fsSL https://tailscale.com/install.sh | sh"
      fi
      rm -f "$ts_log"
    fi
  fi

  if command -v tailscale >/dev/null 2>&1 && [ -z "$(tailnet_ip)" ]; then
    if [ -n "${TS_AUTHKEY:-}" ]; then
      muted "joining the tailnet ..."
      if sudo -n tailscale up --authkey="$TS_AUTHKEY" >/dev/null 2>&1; then
        good "joined as $(tailnet_ip)"
      else
        warn "tailscale up failed — check TS_AUTHKEY has not expired"
      fi
    else
      muted "To share Open Session, connect this box to your tailnet:"
      info "1. ${C}sudo tailscale up${N}"
      info "2. ${C}opensession bind${N}"
    fi
  fi
fi

# Public ingress is configured in /welcome or Settings after the service is
# running. These flags only put the selected connector on the box so that flow
# can complete without sending the operator back to package-manager docs.
if [ "$WITH_CADDY" = "1" ] || [ "$WITH_CLOUDFLARE" = "1" ]; then
  step "Public ingress tools"
fi

if [ "$WITH_CADDY" = "1" ]; then
  if command -v caddy >/dev/null 2>&1; then
    good "caddy $(caddy version 2>/dev/null | head -1 || echo installed)"
  elif install_package caddy && command -v caddy >/dev/null 2>&1; then
    good "caddy $(caddy version 2>/dev/null | head -1 || echo installed)"
  else
    warn "could not install Caddy automatically"
    muted "install it from https://caddyserver.com/docs/install and reload /welcome"
  fi

  # Private custom domains cannot use HTTP-01 because they terminate on a
  # Tailscale address. lego handles Let's Encrypt DNS-01 and renewal while
  # stock Caddy continues to serve the resulting certificate. Use the official
  # pinned v4 build on both platforms: distro builds may omit DNS providers,
  # and lego 5 has an incompatible CLI.
  case "$OS" in
    Darwin) lego_os="darwin" ;;
    *) lego_os="linux" ;;
  esac
  case "$(uname -m)" in
    x86_64|amd64) lego_arch="amd64" ;;
    aarch64|arm64) lego_arch="arm64" ;;
    *) lego_arch="" ;;
  esac
  lego_version="${LEGO_VERSION:-4.26.0}"
  case "$lego_version" in
    4.*)
      lego_tmp="$(mktemp -d)"
      mkdir -p "$HOME/.local/bin"
      if [ -n "$lego_arch" ] \
        && curl -fsSL "https://github.com/go-acme/lego/releases/download/v${lego_version}/lego_v${lego_version}_${lego_os}_${lego_arch}.tar.gz" -o "$lego_tmp/lego.tar.gz" \
        && tar -xzf "$lego_tmp/lego.tar.gz" -C "$lego_tmp" lego \
        && install -m 0755 "$lego_tmp/lego" "$HOME/.local/bin/lego"; then
        export PATH="$HOME/.local/bin:$PATH"
        good "lego $(lego --version 2>/dev/null | head -1 || echo installed)"
      else
        warn "could not install the official lego build automatically"
        muted "install lego 4.x from https://go-acme.github.io/lego/installation/"
      fi
      rm -rf "$lego_tmp"
      ;;
    *) warn "LEGO_VERSION must select lego 4.x; automatic setup does not support lego 5" ;;
  esac
  if [ "$OS" = "Darwin" ]; then
    muted "Automatic private-domain setup requires Linux with systemd; on macOS, manage the certificate and reverse proxy externally."
  fi
fi

if [ "$WITH_CLOUDFLARE" = "1" ]; then
  if command -v cloudflared >/dev/null 2>&1; then
    good "cloudflared $(cloudflared --version 2>/dev/null | head -1 || echo installed)"
  elif [ "$OS" = "Darwin" ]; then
    if install_package cloudflared && command -v cloudflared >/dev/null 2>&1; then
      good "cloudflared $(cloudflared --version 2>/dev/null | head -1 || echo installed)"
    else
      warn "could not install cloudflared automatically"
      muted "install it with: brew install cloudflared"
    fi
  else
    case "$(uname -m)" in
      x86_64|amd64) cf_arch="amd64" ;;
      aarch64|arm64) cf_arch="arm64" ;;
      *) cf_arch="" ;;
    esac
    mkdir -p "$HOME/.local/bin"
    if [ -n "$cf_arch" ] && curl -fsSL "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-$cf_arch" -o "$HOME/.local/bin/cloudflared"; then
      chmod +x "$HOME/.local/bin/cloudflared"
      export PATH="$HOME/.local/bin:$PATH"
      good "cloudflared $(cloudflared --version 2>/dev/null | head -1 || echo installed)"
    else
      warn "could not install cloudflared automatically"
      muted "install it from https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/"
    fi
  fi
fi

# ── shim ────────────────────────────────────────────────────────────────────

# gh is only needed for pull-request operations and needs its own `gh auth
# login` regardless, so this is best-effort and never fatal.
if ! command -v gh >/dev/null 2>&1 && [ "$NO_ENGINE" != "1" ]; then
  if install_package gh >/dev/null 2>&1 && command -v gh >/dev/null 2>&1; then
    good "gh $(gh --version | head -1 | awk '{print $3}')"
  else
    muted "gh not installed (needed only for pull requests) — https://cli.github.com"
  fi
fi

# gh-stack backs the "link into a stack" action on stacked pull requests
# (src/server/pr-stack.ts). Reading a stack needs nothing extra — that's plain
# GraphQL — so this is best-effort too: without the extension the action fails
# with an install hint and every other PR surface is unaffected. Extensions are
# per-user, so a rebuilt box silently loses it; re-running this restores it.
if command -v gh >/dev/null 2>&1 && [ "$NO_ENGINE" != "1" ]; then
  if gh extension list 2>/dev/null | grep -q 'gh-stack'; then
    good "gh-stack present"
  elif gh extension install github/gh-stack >/dev/null 2>&1; then
    good "gh-stack installed"
  else
    muted "gh-stack unavailable (stacked PR linking is optional)"
  fi
fi

step "Command"
mkdir -p "$BIN_DIR"
if [ "$IS_BINARY" = "1" ]; then
  # The compiled binary IS the CLI/server/runner-host/mcp-proxy behind one
  # argv; point the command straight at it. Its sharp sidecar node_modules
  # sits beside the real binary in the release dir, so sharp resolves at run
  # time via the executable's realpath.
  ln -sfn "$DIR/opensession" "$BIN_DIR/opensession"
  good "installed $BIN_DIR/opensession"
else
  if [ -x "$DIR/bin/bun" ]; then BUN_BIN="$DIR/bin/bun"; else BUN_BIN="$(command -v bun)"; fi
  cat >"$BIN_DIR/opensession" <<EOF
#!/usr/bin/env bash
# Generated by the Open Session installer. Safe to delete; re-run install.sh.
BUN="$BUN_BIN"
[ -x "\$BUN" ] || BUN="\$(command -v bun 2>/dev/null)" || {
  echo "opensession: bun not found — see https://bun.sh" >&2; exit 1; }

# Put the user-local bins on PATH before handing off. Without this, a shim
# invoked from a non-login shell (ssh, cron, systemd) runs with a PATH that
export PATH="\$(dirname "\$BUN"):\$HOME/.local/bin:\$PATH"
exec "\$BUN" "$DIR/scripts/cli.ts" "\$@"
EOF
  chmod +x "$BIN_DIR/opensession"
  good "installed $BIN_DIR/opensession"
fi

# ── PATH ────────────────────────────────────────────────────────────────────

# An installer subprocess cannot update the PATH of the shell that launched it.
# Remember whether the command already works there so the final output can name
# the profile to source when this is a fresh install.
PATH_NEEDS_REFRESH=1
command -v opensession >/dev/null 2>&1 && PATH_NEEDS_REFRESH=0
PATH_REFRESH_PROFILE=""
PATH_CONFIGURED_PROFILES=""

add_to_path() {
  config_file="$1"; line="$2"
  if grep -Fxq "$line" "$config_file" 2>/dev/null; then
    :
  elif [ -w "$config_file" ] || [ ! -e "$config_file" ]; then
    printf '\n# opensession\n%s\n' "$line" >>"$config_file"
  else
    warn "add this to $config_file by hand:"
    muted "  $line"
    return
  fi

  display_profile="$config_file"
  case "$display_profile" in
    "$HOME"/*) printf -v display_profile '%c/%s' '~' "${display_profile#"$HOME"/}" ;;
  esac
  PATH_CONFIGURED_PROFILES="${PATH_CONFIGURED_PROFILES:+$PATH_CONFIGURED_PROFILES, }$display_profile"
}

# Write to more than one file on purpose.
#
# Ubuntu's stock ~/.bashrc begins with an "if not running interactively, return"
# guard, so a line appended to the END of it is invisible to non-interactive
# shells — which is what ssh commands, cron jobs and scripts use. Appending only
# there produces an install where `opensession` works when you type it and
# "command not found" the moment anything automated runs it.
#
# So: the interactive file AND the one login/non-interactive shells read.
if [ "$NO_MODIFY_PATH" != "1" ]; then
  case "$(basename "${SHELL:-bash}")" in
    fish)
      profiles="$HOME/.config/fish/config.fish"
      line="fish_add_path $BIN_DIR"
      mkdir -p "$HOME/.config/fish"
      ;;
    zsh)
      # .zshenv is read by every zsh invocation; .zshrc only by interactive ones.
      profiles="${ZDOTDIR:-$HOME}/.zshrc ${ZDOTDIR:-$HOME}/.zshenv"
      line="export PATH=\"$BIN_DIR:\$PATH\""
      ;;
    *)
      profiles="$HOME/.bashrc $HOME/.profile"
      line="export PATH=\"$BIN_DIR:\$PATH\""
      ;;
  esac
  for profile in $profiles; do
    add_to_path "$profile" "$line"
    if [ -z "$PATH_REFRESH_PROFILE" ] && grep -Fxq "$line" "$profile" 2>/dev/null; then
      PATH_REFRESH_PROFILE="$profile"
    fi
  done
  [ -n "$PATH_CONFIGURED_PROFILES" ] && good "PATH configured in $PATH_CONFIGURED_PROFILES"
fi
export PATH="$BIN_DIR:$PATH"

# GitHub Actions needs PATH additions written to a file rather than exported.
[ -n "${GITHUB_PATH:-}" ] && echo "$BIN_DIR" >>"$GITHUB_PATH"

show_path_refresh_hint() {
  [ "$PATH_NEEDS_REFRESH" = "1" ] || return 0
  if [ -n "$PATH_REFRESH_PROFILE" ]; then
    display_profile="$PATH_REFRESH_PROFILE"
    case "$display_profile" in
      "$HOME"/*) display_profile="$(printf '\176/%s' "${display_profile#"$HOME"/}")" ;;
    esac
    info "To use ${C}opensession${N} in this shell, run:"
    printf '    %ssource %s%s\n' "$C" "$display_profile" "$N"
  elif [ "$NO_MODIFY_PATH" = "1" ]; then
    info "Add ${C}$BIN_DIR${N} to PATH before running ${C}opensession${N}."
  fi
}

# ── onboard ─────────────────────────────────────────────────────────────────

if [ "$NO_ONBOARD" = "1" ]; then
  printf '\n'
  success "Installed"
  info "Next: ${C}opensession onboard${N}"
  show_path_refresh_hint
  exit 0
fi

printf '\n'
if [ "$ADVANCED" = "1" ] && [ "$STDIN_PATH" = "/dev/null" ] && [ "$NO_PROMPT" != "1" ]; then
  warn "no terminal available — onboarding with defaults"
  muted "re-run 'opensession onboard --force' interactively to change them"
fi
# A Claude Max token handed to the installer (unattended installs: cloud-init,
# the VM harness, an agent running this script) is staged in a 0600 file the
# server imports into its account pool at first start, then removes.
if [ -n "${OPENSESSION_CLAUDE_TOKEN:-}" ]; then
  step "Model account"
  ( umask 077; printf '%s\n' "$OPENSESSION_CLAUDE_TOKEN" > "$HOME/.opensession-claude-token" )
  good "Claude token staged in ~/.opensession-claude-token (imported at first start)"
fi

# Default: write defaults, start the service, print the URL.
# --advanced is the operator path with every question.
# The install never asks for a GitHub org — that is configured in the web UI
# after the server is up. --org stays available for scripted installs: it
# records the App owner and per-user sign-in intent (never a live gate flip —
# nobody is signed in yet). Onboard ignores it on a re-run.
onboard_status=0
if [ "$ADVANCED" = "1" ]; then
  run_interactive "$BIN_DIR/opensession" onboard ${ORG:+--org "$ORG"} || onboard_status=$?
else
  run_interactive "$BIN_DIR/opensession" onboard --defaults ${ORG:+--org "$ORG"} || onboard_status=$?
fi

# Ensure the service independently of onboarding. On a re-run onboard sees an
# existing config and returns before it would install the service, so a first
# install that wrote config but could not install the service (e.g. the IMDS
# guard refused it until a firewall rule was added) would never recover on a
# plain re-run. This is also deliberate for --advanced: install.sh installs a
# persistent service; `opensession onboard` remains the standalone path where
# an operator may decline one. `service install` is idempotent and prints its
# own guidance when it still cannot proceed.
service_install_failed=0
[ "$onboard_status" -eq 2 ] && service_install_failed=1
if [ "$service_install_failed" != "1" ] && ! "$BIN_DIR/opensession" status 2>/dev/null | grep -qi "active"; then
  if ! "$BIN_DIR/opensession" service install; then
    service_install_failed=1
  fi
fi

# A requested service failure is not a partly successful installation. In
# particular, do not bury an IMDS refusal beneath generic server/log advice.
if [ "$service_install_failed" = "1" ]; then
  printf '\n'
  step "Installation failed"
  die "Open Session did not install a running service. Follow the instructions above, then rerun the same installation command."
fi

# Resolve both addresses before the summary. The public URL is what the person
# opens; the bind address is the truthful local health probe when a reverse
# proxy or custom domain fronts the server.
url=""
health_url=""
server_ready=0
if [ -f "$OPENSESSION_HOME/config.json" ]; then
  url="$(sed -n 's/.*"publicBaseUrl": *"\([^"]*\)".*/\1/p' "$OPENSESSION_HOME/config.json" | head -1)"
  host="$(sed -n 's/.*"host": *"\([^"]*\)".*/\1/p' "$OPENSESSION_HOME/config.json" | head -1)"
  port="$(sed -n 's/.*"port": *\([0-9]*\).*/\1/p' "$OPENSESSION_HOME/config.json" | head -1)"
  host="${host:-127.0.0.1}"
  port="${port:-3850}"
  case "$host" in 0.0.0.0|::|\[::\]) host="127.0.0.1" ;; esac
  health_url="http://$host:$port"
  [ -n "$url" ] || url="$health_url"
  # Installing a service returning successfully only means the supervisor
  # accepted it. Give the server time to finish booting before declaring the
  # install broken or printing a URL that does not answer yet.
  for _ in $(seq 1 30); do
    if curl -fsS --max-time 3 "$health_url/api/health" >/dev/null 2>&1; then
      server_ready=1
      break
    fi
    sleep 1
  done
fi

printf '\n'
success "Installed"
show_path_refresh_hint

if [ "$server_ready" = "1" ]; then
  printf '\n'
  success "Started"
  info "Open Session is running at ${C}$url${N}"
elif [ "$ADVANCED" != "1" ]; then
  printf '\n'
  step "Needs attention"
  if [ -z "$url" ]; then
    warn "the installer did not create the server configuration"
  else
    warn "the server did not start at $health_url"
    info "Expected URL: ${C}$url${N}"
  fi
  info "Inspect the failure: ${C}$BIN_DIR/opensession logs -n 80${N}"
  info "Retry installation:  ${C}$BIN_DIR/opensession service install${N}"
fi
printf '\n'

# Simple mode promises a running server. Do not report a successful install
# when launchd or systemd accepted a unit that then failed to boot.
if [ "$ADVANCED" != "1" ] && [ "$server_ready" != "1" ]; then
  exit 1
fi
