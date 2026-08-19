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
#   --no-engine           NO_ENGINE=1          do not install the OpenCode engine
#                                              or the claude model CLI
#   --codex               WITH_CODEX=1         also install the codex CLI (ChatGPT
#                                              sign-in); off by default
#   --tailscale           WITH_TAILSCALE=1     also install Tailscale (off by
#                                              default; --no-tailscale still accepted)
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
NO_MODIFY_PATH="${NO_MODIFY_PATH:-0}"
NO_ONBOARD="${NO_ONBOARD:-0}"
NO_ENGINE="${NO_ENGINE:-0}"
IS_BINARY=0
WITH_CODEX="${WITH_CODEX:-0}"
WITH_TAILSCALE="${WITH_TAILSCALE:-0}"
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
    --source) FROM_SOURCE=1; shift ;;
    --no-modify-path) NO_MODIFY_PATH=1; shift ;;
    --no-onboard) NO_ONBOARD=1; shift ;;
    --no-engine) NO_ENGINE=1; shift ;;
    --codex) WITH_CODEX=1; shift ;;
    --tailscale) WITH_TAILSCALE=1; shift ;;
    --no-tailscale) WITH_TAILSCALE=0; shift ;;
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
  B=$'\033[1m'; D=$'\033[2m'; G=$'\033[32m'; Y=$'\033[33m'; R=$'\033[31m'; N=$'\033[0m'
else
  B=""; D=""; G=""; Y=""; R=""; N=""
fi

step() { printf '%s\n' "${B}$1${N}"; }
# Strip credentials out of a URL before printing it. A tokenised clone URL in
# terminal scrollback or CI logs is a leaked credential.
redact() { printf '%s' "$1" | sed -E 's#(://)[^/@]*@#\1***@#'; }
info() { printf '  %s\n' "$1"; }
muted() { printf '  %s%s%s\n' "$D" "$1" "$N"; }
good() { printf '  %sok%s      %s\n' "$G" "$N" "$1"; }
warn() { printf '  %swarn%s    %s\n' "$Y" "$N" "$1"; }
die() { printf '  %serror%s   %s\n' "$R" "$N" "$1" >&2; exit 1; }

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
    if [ -f /etc/systemd/system/opensession.service ]; then
      sudo systemctl disable --now opensession 2>/dev/null || true
      sudo rm -f /etc/systemd/system/opensession.service
      sudo systemctl daemon-reload 2>/dev/null || true
      good "system service removed"
    fi
  fi
  rm -rf "$BIN_DIR"
  good "shim removed from $BIN_DIR"

  # The global skill links point into the install; dangling links would be
  # left otherwise. Only links into this install go, never a real directory.
  for skill in "${XDG_CONFIG_HOME:-$HOME/.config}"/opencode/skills/*; do
    [ -L "$skill" ] || continue
    case "$(readlink "$skill")" in "$DIR"/*|"$OPENSESSION_HOME"/*) rm -f "$skill" ;; esac
  done

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
  #  - scratch workspace directories under ~/.opensession-scratch/<id> — plain
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
  scratch_state="$HOME/.opensession-scratch"
  scratch_has_data=0
  [ -d "$scratch_state" ] && [ -n "$(ls -A "$scratch_state" 2>/dev/null)" ] && scratch_has_data=1

  if [ "$remove_data" = "1" ]; then
    kept_any=0
    # The install home holds the default worktrees dir and the scratch git repo
    # its worktrees branch from; keep the whole thing if any of its worktrees is
    # unsaved. A worktrees dir configured OUTSIDE the home is preserved on its
    # own in the state sweep below.
    if [ -n "$dirty_worktrees" ] && case "$worktrees_dir" in "$OPENSESSION_HOME"/*) true ;; *) false ;; esac; then
      warn "keeping $OPENSESSION_HOME: session worktrees have unsaved work"
      printf '%s' "$dirty_worktrees" | sed '/^$/d'
      kept_any=1
    else
      rm -rf "$OPENSESSION_HOME"
      good "removed $OPENSESSION_HOME"
    fi
    rm -f "$HOME/.opensession.env"

    # State lives across a growing set of ~/.opensession-* names (sessions,
    # audit, accounts, automations, github, …). Remove them all EXCEPT the two
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
    command -v brew >/dev/null 2>&1 || return 1
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
      ARTIFACT="$art_tmp/release.tar.gz"
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
      art_tmp="$(mktemp -d)"
      curl -fsSL "$ARTIFACT" -o "$art_tmp/release.tar.gz" || die "could not download $ARTIFACT"
      art_file="$art_tmp/release.tar.gz" ;;
    *) art_file="$ARTIFACT"; [ -f "$art_file" ] || die "no such file: $art_file" ;;
  esac
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
# Two binaries are needed before a session can run a turn, and one is not:
#
#   opencode  the engine that executes agent turns. Without it the server
#             starts, the UI loads, and every session fails.
#   claude    the bundled Anthropic bridge execs it, and `claude setup-token`
#             is how you mint the account token for the default model.
#   codex     `codex login --device-auth` backs the ChatGPT sign-in in the UI
#             (codex-device-login.ts). Off the critical path: only installed
#             with --codex, and the sign-in names the install command when
#             the binary is missing.
#
# The first two are installed by default because leaving them out produces
# the failure this installer exists to prevent: a box that looks installed
# and cannot work. Each is skipped when already present, so re-runs are free.

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
    # A concrete pin must match: an older binary paired with a newer server and
    # SDK breaks turns (the engine version, the seeded plugin and the bundled
    # @opencode-ai/sdk are one compatibility set). "latest" or no pin: any is ok.
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

# The engine version is pinned to the one this checkout was built against
# (package.json `opensession.opencodeVersion`; the same number release.json
# carries), so the plugin runtime seeded below matches what opencode asks
# for. OPENCODE_VERSION=latest (or any version) overrides.
# The pin travels in release.json (`opencode`) for an artefact and in
# package.json (`opensession.opencodeVersion`) for a source checkout. Guard the
# reads: a binary artefact has no package.json, and sed on a missing file would
# abort the installer under `set -e`/pipefail.
pinned_opencode=""
[ -f "$DIR/release.json" ] && pinned_opencode="$(sed -n 's/.*"opencode": *"\([^"]*\)".*/\1/p' "$DIR/release.json" | head -1)"
if [ -z "$pinned_opencode" ] && [ -f "$DIR/package.json" ]; then
  pinned_opencode="$(sed -n 's/.*"opencodeVersion": *"\([^"]*\)".*/\1/p' "$DIR/package.json" | head -1)"
fi
OPENCODE_VERSION="${OPENCODE_VERSION:-${pinned_opencode:-latest}}"
opencode_install="curl -fsSL https://opencode.ai/install | bash"
[ "$OPENCODE_VERSION" != "latest" ] && opencode_install="$opencode_install -s -- --version $OPENCODE_VERSION"

step "Engine"
if [ "$NO_ENGINE" = "1" ]; then
  muted "skipped (--no-engine)"
else
  install_cli opencode "opencode" "$opencode_install" "$HOME/.opencode/bin" "$OPENCODE_VERSION"
  install_cli claude "Claude Code" \
    "curl -fsSL https://claude.ai/install.sh | bash" "$HOME/.local/bin"
  if [ "$WITH_CODEX" = "1" ]; then
    install_cli codex "Codex" \
      "curl -fsSL https://chatgpt.com/codex/install.sh | sh" "$HOME/.local/bin"
  fi

  # opencode's own first run does two slow things before a turn can start:
  # an npm install of @opencode-ai/plugin@<its version> into ~/.config/opencode
  # (~40s cold) and a fetch of the models.dev catalogue into ~/.cache/opencode.
  # A release ships the first prebuilt (engine-seed/, matching the pinned
  # version) and the second is one download; both are skipped by opencode when
  # already there, so doing them now takes them off the first session's clock.
  oc_config="${XDG_CONFIG_HOME:-$HOME/.config}/opencode"
  oc_cache="${XDG_CACHE_HOME:-$HOME/.cache}/opencode"
  # The seed's plugin version, and the one already in ~/.config/opencode.
  seed_src="$DIR/engine-seed/opencode-config"
  # Robust under `set -euo pipefail`: a missing file must yield "" with a zero
  # exit, not abort the installer (sed exits nonzero on ENOENT, and pipefail
  # would propagate it through the pipe into the `x="$(...)"` assignment).
  plugin_ver() {
    [ -f "$1/package.json" ] || return 0
    sed -n 's/.*"@opencode-ai\/plugin": *"\([^"]*\)".*/\1/p' "$1/package.json" | head -1
  }
  if [ -d "$seed_src/node_modules" ]; then
    want_plugin="$(plugin_ver "$seed_src")"
    have_plugin="$(plugin_ver "$oc_config")"
    if [ ! -d "$oc_config/node_modules" ] || [ "$have_plugin" != "$want_plugin" ]; then
      mkdir -p "$oc_config"
      # Replace only the three files the seed owns; user config (opencode.jsonc,
      # AGENTS.md, skills/) stays. A stale tree is removed so no old dep lingers.
      rm -rf "$oc_config/node_modules" "$oc_config/package.json" "$oc_config/package-lock.json"
      cp -R "$seed_src/." "$oc_config/"
      good "engine plugin runtime seeded in $oc_config ($want_plugin)"
    fi
  fi
  mkdir -p "$oc_cache"
  if [ ! -s "$oc_cache/models.json" ]; then
    if curl -fsSL --max-time 60 https://models.dev/api.json -o "$oc_cache/models.json.tmp" 2>/dev/null \
       && [ -s "$oc_cache/models.json.tmp" ]; then
      mv "$oc_cache/models.json.tmp" "$oc_cache/models.json"
      good "engine model catalogue cached"
    else
      rm -f "$oc_cache/models.json.tmp"
      muted "model catalogue not prefetched (the engine fetches it on first use)"
    fi
  fi
fi

# Open Session owns a small set of generic skills that should be available in
# every project. Keep their source in this repository and expose it through
# OpenCode's standard global skill directory; never copy it into ~/.claude.
step "Agent skills"
GLOBAL_SKILLS="$HOME/.config/opencode/skills"
mkdir -p "$GLOBAL_SKILLS"
for skill in simplify pr-autofix audit-codebase; do
  source="$DIR/.agents/skills/$skill"
  target="$GLOBAL_SKILLS/$skill"
  [ -d "$source" ] || continue
  if [ -e "$target" ] && [ ! -L "$target" ]; then
    warn "$target already exists; leaving it unchanged"
    continue
  fi
  ln -sfn "$source" "$target"
  good "$skill -> $source"
done

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
      muted "not joined to a network yet. To finish:"
      muted "  sudo tailscale up"
      muted "then 'opensession bind' to move the server onto the tailnet IP"
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
    muted "gh-stack not installed (needed only to link stacked PRs) — gh extension install github/gh-stack"
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
  good "opensession -> releases/$rel_name/opensession"
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
# lacks bun and opencode — and the server resolves the engine through
# Bun.which(), so it would silently find no engine at all.
export PATH="\$(dirname "\$BUN"):\$HOME/.opencode/bin:\$HOME/.local/bin:\$PATH"
exec "\$BUN" "$DIR/scripts/cli.ts" "\$@"
EOF
  chmod +x "$BIN_DIR/opensession"
  good "opensession -> $DIR/scripts/cli.ts"
fi

# ── PATH ────────────────────────────────────────────────────────────────────

add_to_path() {
  config_file="$1"; line="$2"
  if grep -Fxq "$line" "$config_file" 2>/dev/null; then
    good "PATH already set in $config_file"
  elif [ -w "$config_file" ] || [ ! -e "$config_file" ]; then
    printf '\n# opensession\n%s\n' "$line" >>"$config_file"
    good "added to PATH in $config_file"
  else
    warn "add this to $config_file by hand:"
    muted "  $line"
  fi
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
      line="fish_add_path $BIN_DIR $HOME/.opencode/bin"
      mkdir -p "$HOME/.config/fish"
      ;;
    zsh)
      # .zshenv is read by every zsh invocation; .zshrc only by interactive ones.
      profiles="${ZDOTDIR:-$HOME}/.zshrc ${ZDOTDIR:-$HOME}/.zshenv"
      line="export PATH=\"$BIN_DIR:\$HOME/.opencode/bin:\$PATH\""
      ;;
    *)
      profiles="$HOME/.bashrc $HOME/.profile"
      line="export PATH=\"$BIN_DIR:\$HOME/.opencode/bin:\$PATH\""
      ;;
  esac
  for profile in $profiles; do
    add_to_path "$profile" "$line"
  done
fi
export PATH="$BIN_DIR:$PATH"

# GitHub Actions needs PATH additions written to a file rather than exported.
[ -n "${GITHUB_PATH:-}" ] && echo "$BIN_DIR" >>"$GITHUB_PATH"

# ── onboard ─────────────────────────────────────────────────────────────────

if [ "$NO_ONBOARD" = "1" ]; then
  printf '\n'
  step "Installed"
  info "Next: ${B}opensession onboard${N}"
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

# Default: write defaults, ask nothing, start the service, print the URL.
# --advanced is the operator path with every question.
if [ "$ADVANCED" = "1" ]; then
  run_interactive "$BIN_DIR/opensession" onboard || true
else
  run_interactive "$BIN_DIR/opensession" onboard --defaults || true
fi

# Ensure the service independently of onboarding. On a re-run onboard sees an
# existing config and returns before it would install the service, so a first
# install that wrote config but could not start the service (e.g. the IMDS
# guard refused it until a firewall rule was added) would never recover on a
# plain re-run. `service install` is idempotent and prints its own guidance
# when it still cannot proceed. Skipped for --advanced, where the wizard
# already offered it, and when there is no supervisor.
if [ "$ADVANCED" != "1" ] && [ "$NO_ONBOARD" != "1" ]; then
  if ! "$BIN_DIR/opensession" status 2>/dev/null | grep -qi "active"; then
    "$BIN_DIR/opensession" service install || true
  fi
fi

printf '\n'
step "Done"
info "opensession status    ${D}is the server up?${N}"
info "opensession doctor    ${D}check the install${N}"
info "opensession --help    ${D}everything else${N}"
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) muted "open a new shell (or source your profile) to get 'opensession' on PATH" ;;
esac
# The last line is the URL, when there is a server to open. Read the bind from
# the config the wizard just wrote; a public URL set there wins.
if [ -f "$OPENSESSION_HOME/config.json" ]; then
  url="$(sed -n 's/.*"publicBaseUrl": *"\([^"]*\)".*/\1/p' "$OPENSESSION_HOME/config.json" | head -1)"
  if [ -z "$url" ]; then
    port="$(sed -n 's/.*"port": *\([0-9]*\).*/\1/p' "$OPENSESSION_HOME/config.json" | head -1)"
    url="http://127.0.0.1:${port:-3850}"
  fi
  if curl -fsS --max-time 3 "$url/api/health" >/dev/null 2>&1; then
    printf '\n  %sOpen %s%s\n' "$B" "$url" "$N"
  fi
fi
printf '\n'
