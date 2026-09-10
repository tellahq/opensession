#!/usr/bin/env bash
# Manage immutable source releases without ever changing the shared WIP checkout.
#
# The source checkout owns the git object database. Each deployed commit gets a
# detached worktree below the deploy state directory, and `current` is an atomic
# symlink to the release systemd should start. Generated files and node_modules
# may exist in a release; tracked files must continue to match its pinned commit.
set -euo pipefail

SOURCE_DIR="${OPENSESSION_DEPLOY_CHECKOUT:?OPENSESSION_DEPLOY_CHECKOUT is required}"
STATE_DIR="${OPENSESSION_DEPLOY_STATE:?OPENSESSION_DEPLOY_STATE is required}"
BUN_BIN="${OPENSESSION_BUN_BIN:-$(command -v bun || true)}"
RELEASES_DIR="$STATE_DIR/releases"
CURRENT_LINK="$STATE_DIR/current"
RELEASE_RETENTION="${OPENSESSION_DEPLOY_RELEASE_RETENTION:-8}"

log() { printf '[release] %s\n' "$*" >&2; }
git_source() { git -C "$SOURCE_DIR" "$@"; }

resolve_sha() {
  git_source rev-parse "${1}^{commit}"
}

release_path() {
  local sha
  sha="$(resolve_sha "$1")"
  printf '%s/%s\n' "$RELEASES_DIR" "$sha"
}

release_ready() {
  local path="$1" sha="$2" recorded
  [ -d "$path" ] || return 1
  recorded="$(git -C "$path" rev-parse HEAD 2>/dev/null || true)"
  [ "$recorded" = "$sha" ] || return 1
  [ "$(cat "$path/.opensession-release" 2>/dev/null || true)" = "$sha" ]
}

prepare_release() {
  local sha path
  sha="$(resolve_sha "$1")"
  path="$RELEASES_DIR/$sha"
  mkdir -p "$RELEASES_DIR"

  if release_ready "$path" "$sha"; then
    log "release ${sha:0:10} already prepared"
    printf '%s\n' "$path"
    return
  fi

  if [ -e "$path" ]; then
    # A prior interrupted install is safe to resume only when it is the exact
    # detached worktree requested. Never delete an unknown directory here.
    [ "$(git -C "$path" rev-parse HEAD 2>/dev/null || true)" = "$sha" ] || {
      log "ERROR: $path exists but is not release $sha"
      return 1
    }
  else
    log "creating detached release ${sha:0:10}"
    git_source worktree add --detach "$path" "$sha" >&2
  fi

  [ -n "$BUN_BIN" ] && [ -x "$BUN_BIN" ] || {
    log "ERROR: preparing a release requires Bun"
    return 1
  }
  log "installing locked dependencies for ${sha:0:10}"
  (cd "$path" && "$BUN_BIN" install --frozen-lockfile) >&2

  # Refuse to bless a worktree whose tracked source changed during preparation.
  # Generated/untracked frontend output and node_modules are intentionally okay.
  if ! git -C "$path" diff --quiet --ignore-submodules --; then
    log "ERROR: tracked files changed while preparing ${sha:0:10}"
    return 1
  fi
  printf '%s\n' "$sha" > "$path/.opensession-release"
  printf '%s\n' "$path"
}

current_path() {
  [ -L "$CURRENT_LINK" ] || return 1
  readlink -f "$CURRENT_LINK"
}

current_sha() {
  local path
  path="$(current_path)" || return 1
  git -C "$path" rev-parse HEAD
}

prepare_frontend() {
  local path
  path="$(prepare_release "$1")"
  log "building frontend before cut-over for $(basename "$path" | cut -c1-10)"
  (
    cd "$path"
    "$BUN_BIN" run scripts/build-frontend.ts
    "$BUN_BIN" run scripts/validate-frontend-build.ts
  ) >&2
  printf '%s\n' "$path"
}

switch_release() {
  local sha path next
  sha="$(resolve_sha "$1")"
  path="$RELEASES_DIR/$sha"
  release_ready "$path" "$sha" || {
    log "ERROR: release ${sha:0:10} is not prepared"
    return 1
  }
  next="$STATE_DIR/.current.$$"
  rm -f "$next"
  ln -s "$path" "$next"
  # os.replace is one atomic rename on both Linux and macOS. GNU `mv -T`
  # provides the same semantics but is not available on developer Macs.
  python3 - "$next" "$CURRENT_LINK" <<'PY'
import os
import sys
os.replace(sys.argv[1], sys.argv[2])
PY
  log "current -> ${sha:0:10}"
}

gc_releases() {
  local limit="${1:-4}" protected_file path sha cwd removed=0
  case "$RELEASE_RETENTION" in (''|*[!0-9]*) RELEASE_RETENTION=8 ;; esac
  case "$limit" in (''|*[!0-9]*) limit=4 ;; esac
  [ "$RELEASE_RETENTION" -ge 2 ] || RELEASE_RETENTION=2
  [ "$limit" -ge 1 ] || return 0
  [ -d "$RELEASES_DIR" ] || return 0

  protected_file="$STATE_DIR/.release-gc-protected.$$"
  : > "$protected_file"
  # The active target and rollback pin are never eligible, even when old.
  if path="$(current_path 2>/dev/null)"; then basename "$path" >> "$protected_file"; fi
  if [ -s "$STATE_DIR/last-known-good" ]; then
    head -n 1 "$STATE_DIR/last-known-good" >> "$protected_file"
  fi
  # Keep a small recent window for operator-selected rollback/debugging.
  for path in $(ls -1dt "$RELEASES_DIR"/* 2>/dev/null | head -n "$RELEASE_RETENTION"); do
    [ -d "$path" ] && basename "$path" >> "$protected_file"
  done
  # Detached run hosts can intentionally outlive the gateway generation that
  # spawned them. Preserve every release that is still a process cwd.
  if [ -d /proc ]; then
    for path in /proc/[0-9]*/cwd; do
      cwd="$(readlink -f "$path" 2>/dev/null || true)"
      case "$cwd" in
        "$RELEASES_DIR"/*)
          sha="${cwd#"$RELEASES_DIR"/}"
          printf '%s\n' "${sha%%/*}" >> "$protected_file"
          ;;
      esac
    done
  fi
  sort -u "$protected_file" -o "$protected_file"

  while IFS= read -r path; do
    sha="${path##*/}"
    grep -Fqx "$sha" "$protected_file" && continue
    if git_source worktree remove --force "$path" >&2; then
      removed=$((removed + 1))
    else
      log "WARNING: could not remove old release ${sha:0:10}"
    fi
    [ "$removed" -lt "$limit" ] || break
  done < <(ls -1trd "$RELEASES_DIR"/* 2>/dev/null || true)
  git_source worktree prune --expire now
  rm -f "$protected_file"
  log "garbage-collected $removed old release(s); retention=$RELEASE_RETENTION limit=$limit"
}

case "${1:-}" in
  prepare)
    [ "$#" -eq 2 ] || exit 2
    prepare_release "$2"
    ;;
  prepare-frontend)
    [ "$#" -eq 2 ] || exit 2
    prepare_frontend "$2"
    ;;
  path)
    [ "$#" -eq 2 ] || exit 2
    release_path "$2"
    ;;
  current-path)
    [ "$#" -eq 1 ] || exit 2
    current_path
    ;;
  current-sha)
    [ "$#" -eq 1 ] || exit 2
    current_sha
    ;;
  switch)
    [ "$#" -eq 2 ] || exit 2
    switch_release "$2"
    ;;
  gc)
    [ "$#" -le 2 ] || exit 2
    gc_releases "${2:-4}"
    ;;
  *)
    echo "usage: release-checkout.sh prepare <ref> | prepare-frontend <ref> | path <ref> | current-path | current-sha | switch <ref> | gc [limit]" >&2
    exit 2
    ;;
esac
