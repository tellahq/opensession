#!/usr/bin/env bash
#
# Agent-callable release deploy for Open Session, with a last-known-good pin,
# a post-restart health gate, and automatic pointer-swap rollback.
#
# Modes:
#   self-deploy.sh [--sha <target>]   deploy immutable <target> (default
#                  [--pin <sha>]      origin/main) + restart + health gate;
#                                     --pin overrides the last-known-good pin
#                                     (for callers that pre-merged, e.g.
#                                     `opensession update`)
#   self-deploy.sh --rollback-only    restart onto the last-known-good pin
#                                     (used by the watchdog after a bad deploy)
#   self-deploy.sh --watchdog-probe   one conservative health probe (run every
#                                     60s by opensession-watchdog.timer)
#
# Runs as the service user; systemctl goes through `sudo -n` (plain systemctl
# when already root), so a missing sudo grant fails fast instead of prompting.
# The opensession-self-deploy MCP tool launches this as a transient SYSTEM unit
# (sudo -n systemd-run) so the deploy/health-gate/rollback sequence survives
# the service restart it triggers — but the script is equally runnable
# standalone by a human.
#
# The shared checkout is a git object source only. Deploying never merges,
# checks out, resets, installs dependencies in, or otherwise mutates that WIP
# tree. `deploy/release-checkout.sh` prepares a detached worktree for the exact
# commit and atomically moves the runtime `current` symlink. The previous
# release remains intact, so rollback is the same pointer swap in reverse.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="${OPENSESSION_DEPLOY_CHECKOUT:-$(dirname "$SCRIPT_DIR")}"
RELEASE_TEMPLATE_DIR="$(dirname "$SCRIPT_DIR")"

read_env_value() {
  local name="$1" file="$2" value
  [ -r "$file" ] || return 0
  value="$(sed -n "s/^${name}=//p" "$file" | tail -n 1)"
  case "$value" in
    \"*\") value="${value#\"}"; value="${value%\"}" ;;
    \'*\') value="${value#\'}"; value="${value%\'}" ;;
  esac
  printf '%s' "$value"
}

GATEWAY_ENV_FILE="$(sed -n 's/^EnvironmentFile=//p' "$RELEASE_TEMPLATE_DIR/opensession.service" | tail -n 1)"
MIGRATION_STATE_DIR="${OPENSESSION_STATE_DIR:-$(read_env_value OPENSESSION_STATE_DIR "$GATEWAY_ENV_FILE")}"
MIGRATION_SESSIONS_DIR="${OPENSESSION_SESSIONS_DIR:-$(read_env_value OPENSESSION_SESSIONS_DIR "$GATEWAY_ENV_FILE")}"
if [ -n "${OPENSESSION_DEPLOY_STATE:-}" ]; then
  STATE_DIR="$OPENSESSION_DEPLOY_STATE"
elif [ -e "$HOME/.opensession/deploy" ] || [ ! -e "$HOME/.opensession-deploy" ]; then
  STATE_DIR="$HOME/.opensession/deploy"
else
  STATE_DIR="$HOME/.opensession-deploy"
fi
HEALTH_URL="${OPENSESSION_HEALTH_URL:-http://127.0.0.1:3850/ready}"
LEGACY_HEALTH_URL="${OPENSESSION_LEGACY_HEALTH_URL:-http://127.0.0.1:3850/api/health}"
SERVICE_NAME="${OPENSESSION_SERVICE_NAME:-opensession.service}"
EXECUTOR_SERVICE_NAME="opensession-executor.service"
SESSION_KERNEL_SERVICE_NAME="opensession-session-kernel.service"
SESSION_KERNEL_READY_URL="http://127.0.0.1:3849/ready"
EXECUTOR_READY_FILE="/run/opensession-executor/ready"
RUN_HOST_HELPER_VERSION=2
BUN_BIN="${OPENSESSION_BUN_BIN:-$(command -v bun || true)}"
[ -n "$BUN_BIN" ] && [ -x "$BUN_BIN" ] || {
  echo "Open Session deploy requires Bun" >&2
  exit 1
}

# Health gate: 30 x 2s = 60s budget, matching deploy.sh's post-restart gate.
HEALTH_TRIES=30
HEALTH_SLEEP=2

# Watchdog conservatism: only act while a self-deploy is fresh, and only after
# several consecutive failures (transient blips must not trigger a rollback).
WATCHDOG_WINDOW_SECS=900   # 15 min after the last self-deploy restart
WATCHDOG_FAIL_THRESHOLD=3
DEPLOY_LOCK_WAIT_SECS="${OPENSESSION_DEPLOY_LOCK_WAIT_SECS:-900}"
DEPLOY_COALESCE_SECS="${OPENSESSION_DEPLOY_COALESCE_SECS:-15}"
DEPLOY_COALESCE_MAX_SECS="${OPENSESSION_DEPLOY_COALESCE_MAX_SECS:-60}"
case "$DEPLOY_LOCK_WAIT_SECS" in (''|*[!0-9]*) DEPLOY_LOCK_WAIT_SECS=900 ;; esac
case "$DEPLOY_COALESCE_SECS" in (''|*[!0-9]*) DEPLOY_COALESCE_SECS=15 ;; esac
case "$DEPLOY_COALESCE_MAX_SECS" in (''|*[!0-9]*) DEPLOY_COALESCE_MAX_SECS=60 ;; esac

PIN_FILE="$STATE_DIR/last-known-good"
MARKER_FILE="$STATE_DIR/last-deploy-marker"
RESULT_FILE="$STATE_DIR/last-result.json"
RESULTS_DIR="$STATE_DIR/results"
REQUESTS_DIR="$STATE_DIR/requests"
FAIL_COUNT_FILE="$STATE_DIR/watchdog-fail-count"
LOG_FILE="$STATE_DIR/self-deploy.log"
WATCHDOG_LOG="$STATE_DIR/watchdog.log"
KERNEL_SCHEMA_REL="packages/core/opensession-server/src/server/session-kernel/schema-version"
KERNEL_SCHEMA_FLOOR_FILE="$STATE_DIR/minimum-kernel-schema"
RELEASE_TOOL="$SCRIPT_DIR/release-checkout.sh"
CURRENT_LINK="$STATE_DIR/current"

STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
STARTED_EPOCH="$(date +%s)"

usage() {
  sed -n '2,23p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

MODE=deploy
TARGET="origin/main"
PIN_OVERRIDE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --sha) TARGET="${2:?--sha needs a value}"; shift 2 ;;
    # Record this sha as last-known-good instead of the pre-merge HEAD. For
    # callers that already moved the tree before invoking the deploy (e.g.
    # `opensession update` merges upstream first, then deploys --sha HEAD):
    # without the override the pin would equal the just-merged commit and a
    # rollback would "restore" the very code that failed.
    --pin) PIN_OVERRIDE="${2:?--pin needs a value}"; shift 2 ;;
    --rollback-only) MODE=rollback; shift ;;
    --watchdog-probe) MODE=probe; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "[self-deploy] unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

mkdir -p "$STATE_DIR" "$RESULTS_DIR" "$REQUESTS_DIR"

# Publish an exact-SHA deploy intent before waiting on the lifecycle lock. The
# lock holder can then collapse a burst of real requests without guessing that
# every new commit on origin/main was intended for this instance. Manual refs
# such as origin/main still work; the server-side helper always supplies a SHA.
if [ "$MODE" = "deploy" ] && printf '%s\n' "$TARGET" | grep -Eq '^[0-9a-f]{40,64}$'; then
  request_tmp="$REQUESTS_DIR/.${TARGET}.$$"
  printf '%s\n' "$STARTED_EPOCH" > "$request_tmp"
  mv "$request_tmp" "$REQUESTS_DIR/$TARGET"
fi

# One lifecycle change at a time: concurrent deploys race the pin (the second
# call would pin the first call's UNVERIFIED target as last-known-good). Deploy
# requests queue because callers commonly land a burst of commits together;
# once admitted, a queued request becomes a no-op when the active deploy already
# covered it. Probes and explicit rollbacks stay non-blocking: the active
# deploy's health gate owns that window and a delayed rollback would be unsafe.
exec 9>"$STATE_DIR/.lock"
case "$MODE" in
  deploy)
    if ! flock -w "$DEPLOY_LOCK_WAIT_SECS" 9; then
      echo "[self-deploy] timed out after ${DEPLOY_LOCK_WAIT_SECS}s waiting for the active deploy" >&2
      exit 1
    fi
    ;;
  probe)
    flock -n 9 || exit 0
    ;;
  *)
    if ! flock -n 9; then
      echo "[self-deploy] another deploy/rollback is in flight (lock at $STATE_DIR/.lock) — refusing delayed rollback" >&2
      exit 1
    fi
    ;;
esac

log() { echo "[self-deploy] $(date -u +%H:%M:%S) $*"; }

# A set -e abort after the tree moved but before any write_result leaves the
# agent blind (stale result + open marker). Record an honest failure result for
# THIS run; deliberate exit-after-write paths are untouched (plain `exit`
# never trips ERR).
on_err() {
  local rc=$?
  set +e
  if ! grep -q "\"startedAt\":\"$STARTED_AT\"" "$RESULT_FILE" 2>/dev/null; then
    write_result false "$MODE" "$(release_cmd current-sha 2>/dev/null || echo unknown)" "" \
      "aborted by error (exit $rc) — see $LOG_FILE"
  fi
  exit "$rc"
}
trap on_err ERR

run_systemctl() {
  if [ "$(id -u)" = "0" ]; then systemctl "$@"; else sudo -n systemctl "$@"; fi
}

release_cmd() {
  env \
    OPENSESSION_DEPLOY_CHECKOUT="$REPO_DIR" \
    OPENSESSION_DEPLOY_STATE="$STATE_DIR" \
    OPENSESSION_BUN_BIN="$BUN_BIN" \
    /bin/bash "$RELEASE_TOOL" "$@"
}

# Once this script stops the gateway, every exit path owns bringing it back.
# A failed actor migration/readiness check must degrade the deploy, not leave
# an explicitly stopped unit that Restart=always will never recover.
GATEWAY_STOPPED_BY_DEPLOY=0
CANARY_PID=""
CANARY_FILE=""
restore_gateway_on_exit() {
  local rc=$?
  if [ -n "$CANARY_PID" ]; then
    kill -TERM "$CANARY_PID" 2>/dev/null || true
    wait "$CANARY_PID" 2>/dev/null || true
    CANARY_PID=""
    if [ -s "$CANARY_FILE" ]; then
      log "deploy canary: $(tr '\n' ' ' < "$CANARY_FILE")"
    fi
  fi
  if [ "$GATEWAY_STOPPED_BY_DEPLOY" = "1" ]; then
    log "deploy exiting with gateway stopped — starting ${SERVICE_NAME}"
    run_systemctl start "$SERVICE_NAME" || true
  fi
  return "$rc"
}
trap restore_gateway_on_exit EXIT

stop_gateway() {
  # Set the guard before invoking systemctl: a partial/ambiguous stop still
  # requires a best-effort start when the script exits.
  GATEWAY_STOPPED_BY_DEPLOY=1
  run_systemctl stop "$SERVICE_NAME"
}

session_kernel_unit_available() {
  local load_state
  load_state="$(run_systemctl show --property=LoadState --value \
    "$SESSION_KERNEL_SERVICE_NAME" 2>/dev/null || true)"
  if [ "$load_state" != "loaded" ]; then
    log "ERROR: installed session kernel unit is unavailable; run the root deploy before this revision"
    return 1
  fi
}

current_release_sha() {
  release_cmd current-sha 2>/dev/null || true
}

session_kernel_ready_any_generation() {
  local body
  body="$(curl -fs --max-time 2 "$SESSION_KERNEL_READY_URL" 2>/dev/null || true)"
  printf '%s' "$body" | grep -Fq '"ready":true'
}

session_kernel_ready_for_current() {
  local expected body
  expected="$(current_release_sha)"
  body="$(curl -fs --max-time 2 "$SESSION_KERNEL_READY_URL" 2>/dev/null || true)"
  [ -n "$expected" ] && printf '%s' "$body" | grep -Fq "\"generation\":\"$expected\""
}

executor_ready_for_current() {
  local expected pid body
  expected="$(current_release_sha)"
  pid="$(run_systemctl show -p MainPID --value "$EXECUTOR_SERVICE_NAME" 2>/dev/null || true)"
  body="$(cat "$EXECUTOR_READY_FILE" 2>/dev/null || true)"
  [ -n "$expected" ] \
    && printf '%s' "$body" | grep -Fq "\"pid\":$pid" \
    && printf '%s' "$body" | grep -Fq "\"generation\":\"$expected\""
}

preflight_session_kernel() {
  session_kernel_unit_available || return 1
  if ! run_systemctl is-active --quiet "$SESSION_KERNEL_SERVICE_NAME" \
    || ! session_kernel_ready_any_generation; then
    log "ERROR: installed session kernel is not healthy; refusing to stop the gateway"
    return 1
  fi
  # Do not stat /etc/opensession/session-kernel-token here. It is deliberately
  # root-only and self-deploy runs as the service user. systemd LoadCredential
  # validates and exposes it only to the kernel service when that unit starts.
}

refresh_executor() {
  # Privileged artifacts are installed only by `opensession service install`
  # or the root-run deploy script. Self-deploy may restart those fixed units,
  # but never copies executable code from the user-writable checkout as root.
  if [ ! -f "$CURRENT_LINK/packages/core/opensession-server/src/executor/main.ts" ]; then
    return
  fi
  if [ ! -f "/etc/systemd/system/$EXECUTOR_SERVICE_NAME" ] \
    || [ ! -x /usr/local/libexec/opensession-run-host ]; then
    log "ERROR: executor system artifacts are missing; run opensession service install or the root deploy before this revision"
    return 1
  fi
  if [ "$(id -u)" = "0" ]; then
    /usr/local/libexec/opensession-run-host check-version "$RUN_HOST_HELPER_VERSION"
  else
    sudo -n /usr/local/libexec/opensession-run-host check-version "$RUN_HOST_HELPER_VERSION"
  fi
  run_systemctl restart "$EXECUTOR_SERVICE_NAME"
  local i
  for i in $(seq 1 30); do
    if run_systemctl is-active --quiet "$EXECUTOR_SERVICE_NAME" \
      && [ -s "$EXECUTOR_READY_FILE" ] \
      && executor_ready_for_current; then
      return
    fi
    sleep 1
  done
  log "ERROR: installed executor launcher did not become healthy"
  return 1
}

refresh_session_kernel() {
  local allow_unhealthy="${1:-0}"
  # Like the executor, this privileged unit is installed only through the root
  # deploy path. Self-deploy restarts the fixed unit but never copies a unit or
  # credential out of the user-writable checkout.
  if [ "$allow_unhealthy" = "1" ]; then
    session_kernel_unit_available || return 1
  else
    preflight_session_kernel || return 1
  fi
  run_systemctl stop "$SESSION_KERNEL_SERVICE_NAME"
  log "migrating legacy session-kernel rows offline"
  local -a migration_env
  migration_env=("HOME=$HOME")
  if [ -n "$MIGRATION_STATE_DIR" ]; then
    migration_env+=("OPENSESSION_STATE_DIR=$MIGRATION_STATE_DIR")
  fi
  if [ -n "$MIGRATION_SESSIONS_DIR" ]; then
    migration_env+=("OPENSESSION_SESSIONS_DIR=$MIGRATION_SESSIONS_DIR")
  fi
  env "${migration_env[@]}" \
    "$BUN_BIN" "$CURRENT_LINK/scripts/migrate-session-kernel-storage.ts"
  run_systemctl start "$SESSION_KERNEL_SERVICE_NAME"
  local i
  for i in $(seq 1 30); do
    if run_systemctl is-active --quiet "$SESSION_KERNEL_SERVICE_NAME" \
      && session_kernel_ready_for_current; then
      return
    fi
    sleep 1
  done
  log "ERROR: installed session kernel service did not become healthy"
  return 1
}

refresh_protocol_peers() {
  local refresh_executor_peer="${1:-1}" refresh_kernel_peer="${2:-1}"
  local allow_unhealthy_kernel="${3:-0}" executor_pid="" kernel_pid="" failed=0
  if [ "$refresh_executor_peer" = "1" ]; then
    refresh_executor &
    executor_pid=$!
  fi
  if [ "$refresh_kernel_peer" = "1" ]; then
    refresh_session_kernel "$allow_unhealthy_kernel" &
    kernel_pid=$!
  fi
  if [ -n "$executor_pid" ] && ! wait "$executor_pid"; then failed=1; fi
  if [ -n "$kernel_pid" ] && ! wait "$kernel_pid"; then failed=1; fi
  return "$failed"
}

git_repo() { git -C "$REPO_DIR" "$@"; }
runtime_git() { git -C "$CURRENT_LINK" "$@"; }

kernel_schema_at() {
  local ref="$1" value
  value="$(git_repo show "$ref:$KERNEL_SCHEMA_REL" 2>/dev/null || echo 0)"
  case "$value" in
    ''|*[!0-9]*) echo 0 ;;
    *) echo "$value" ;;
  esac
}

record_kernel_schema_floor() {
  local current floor
  current="$(cat "$CURRENT_LINK/$KERNEL_SCHEMA_REL" 2>/dev/null || echo 0)"
  floor="$(cat "$KERNEL_SCHEMA_FLOOR_FILE" 2>/dev/null || echo 0)"
  if [ "$current" -gt "$floor" ]; then
    printf '%s\n' "$current" > "$KERNEL_SCHEMA_FLOOR_FILE"
  fi
}

rollback_schema_compatible() {
  local ref="$1" required target
  required="$(cat "$KERNEL_SCHEMA_FLOOR_FILE" 2>/dev/null || echo 0)"
  target="$(kernel_schema_at "$ref")"
  if [ "$target" -lt "$required" ]; then
    log "REFUSING rollback to ${ref:0:10}: kernel schema $target is below durable floor $required"
    return 1
  fi
}

health_ok() { curl -fs --max-time 4 "$HEALTH_URL" >/dev/null 2>&1; }
legacy_health_ok() { curl -fs --max-time 4 "$LEGACY_HEALTH_URL" >/dev/null 2>&1; }
poll_rollback_health() {
  if grep -q 'path === "/ready"' "$CURRENT_LINK/packages/core/opensession-server/src/server/routes/system.ts" 2>/dev/null; then
    poll_health
    return
  fi
  local target="$HEALTH_URL"
  HEALTH_URL="$LEGACY_HEALTH_URL"
  poll_health
  local result=$?
  HEALTH_URL="$target"
  return "$result"
}

# Poll the health endpoint until it answers or the budget runs out. A single
# 200 can be a crash-looping instance's brief liveness window, so the gate
# demands HEALTH_CONSECUTIVE straight successes from the SAME process — a
# bootId change between probes means it restarted underneath us and the streak
# starts over.
HEALTH_CONSECUTIVE=3
poll_health() {
  local i ok=0 boot="" b body
  for i in $(seq 1 "$HEALTH_TRIES"); do
    sleep "$HEALTH_SLEEP"
    if body="$(curl -fs --max-time 4 "$HEALTH_URL" 2>/dev/null)"; then
      b="$(printf '%s' "$body" | grep -o '"bootId":"[^"]*"' | head -1 || true)"
      if [ -n "$boot" ] && [ "$b" != "$boot" ]; then ok=0; fi
      boot="$b"
      ok=$((ok + 1))
      if [ "$ok" -ge "$HEALTH_CONSECUTIVE" ]; then return 0; fi
    else
      ok=0
      boot=""
    fi
  done
  return 1
}

# Restart the service. The deploy marker is written ONLY by the deploy path
# (write_marker below), never by rollback restarts — the marker is what opens
# the watchdog's act window, and a rollback must close that window, not renew
# it (otherwise an unhealthy pin would loop restart→probe→rollback forever).
restart_service() {
  log "restarting ${SERVICE_NAME}"
  run_systemctl restart "$SERVICE_NAME"
  GATEWAY_STOPPED_BY_DEPLOY=0
}

# Opening the window also zeroes the consecutive-failure counter: a stale
# nonzero count from a pre-existing outage plus a fresh marker would otherwise
# let the very first failed probe cross the threshold and roll back instantly.
write_marker() {
  date +%s > "$MARKER_FILE"
  echo 0 > "$FAIL_COUNT_FILE"
}

# write_result <ok> <action> <sha> <previous_sha> <message>
# Result JSON is the contract deploy_status (src/server/self-deploy.ts) reads;
# keep the field names in sync with parseDeployResult there.
write_result() {
  local ok="$1" action="$2" sha="$3" previous="$4" message="$5"
  local finished_at duration tmp
  finished_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  duration=$(( $(date +%s) - STARTED_EPOCH ))
  tmp="$RESULT_FILE.tmp.$$"
  printf '{"ok":%s,"action":"%s","sha":"%s","previousSha":"%s","target":"%s","startedAt":"%s","finishedAt":"%s","durationSecs":%s,"message":"%s"}\n' \
    "$ok" "$action" "$sha" "$previous" "$TARGET" "$STARTED_AT" "$finished_at" "$duration" "$message" > "$tmp"
  mv "$tmp" "$RESULT_FILE"
  cp "$RESULT_FILE" "$RESULTS_DIR/$(date -u -d "@$STARTED_EPOCH" +%Y%m%dT%H%M%SZ 2>/dev/null || date -u +%Y%m%dT%H%M%SZ)-$action.json"
}

# Restart onto the last-known-good pin (shared by the failed-deploy path and
# --rollback-only). Sets ROLLBACK_HEALTHY; returns 0 when the service came back
# healthy, 1 otherwise. It never modifies the WIP checkout.
rollback_to_pin() {
  ROLLBACK_HEALTHY=0
  if [ ! -f "$PIN_FILE" ]; then
    log "ERROR: no last-known-good pin at $PIN_FILE — cannot roll back"
    return 1
  fi
  local pin head_now
  pin="$(cat "$PIN_FILE")"
  head_now="$(release_cmd current-sha 2>/dev/null || echo unknown)"
  if ! rollback_schema_compatible "$pin"; then
    write_result false rollback-blocked "$head_now" "$pin" \
      "rollback target cannot read the durable session-kernel schema"
    return 1
  fi
  if [ "$head_now" = "$pin" ]; then
    log "runtime already at pin ${pin:0:10} — restarting without moving it"
  else
    log "rolling back current pointer: ${head_now:0:10} -> ${pin:0:10}"
    release_cmd switch "$pin"
  fi
  if ! refresh_executor; then
    log "ERROR: executor failed readiness after rollback"
    return 1
  fi
  if ! preflight_session_kernel; then
    log "ERROR: session kernel preflight failed after rollback"
    return 1
  fi
  stop_gateway
  if ! refresh_session_kernel; then
    log "ERROR: session kernel failed readiness after rollback"
    return 1
  fi
  restart_service
  if poll_rollback_health; then
    ROLLBACK_HEALTHY=1
    log "healthy after rollback restart"
    return 0
  fi
  log "ERROR: still unhealthy after rollback restart"
  return 1
}

rollback_coordinated_to_pin() {
  local controller="$1" pin head_now
  ROLLBACK_HEALTHY=0
  if [ ! -f "$PIN_FILE" ]; then
    log "ERROR: no last-known-good pin at $PIN_FILE — cannot roll back"
    return 1
  fi
  pin="$(cat "$PIN_FILE")"
  head_now="$(current_release_sha)"
  rollback_schema_compatible "$pin" || return 1

  # The target gateway is already fenced. Restore pointer and protocol peers
  # while the stable proxy parks connections, then admit the previous gateway.
  if [ "$head_now" != "$pin" ]; then
    log "rolling back coordinated pointer: ${head_now:0:10} -> ${pin:0:10}"
    release_cmd switch "$pin"
  fi
  refresh_protocol_peers 1 1 1 || return 1
  if ! "$BUN_BIN" "$controller" abort-coordinated; then
    log "ERROR: supervisor refused previous gateway after peer rollback"
    return 1
  fi
  if poll_rollback_health; then
    ROLLBACK_HEALTHY=1
    log "healthy after fail-closed coordinated rollback"
    return 0
  fi
  log "ERROR: previous generation remained unhealthy after coordinated rollback"
  return 1
}

do_deploy() {
  # Everything below logs to the state dir as well as stdout (standalone runs
  # get a persistent trail; the transient unit's own append log catches any
  # bash error that happens before this line).
  exec > >(tee -a "$LOG_FILE") 2>&1
  log "deploy → $TARGET (repo $REPO_DIR, state $STATE_DIR)"

  log "fetching origin"
  git_repo fetch --prune origin

  local target_sha requested_sha current pin_sha failed_target request candidate
  if ! target_sha="$(git_repo rev-parse "${TARGET}^{commit}" 2>/dev/null)"; then
    log "ERROR: cannot resolve target '$TARGET'"
    exit 1
  fi
  requested_sha="$target_sha"
  if ! current="$(release_cmd current-sha 2>/dev/null)"; then
    log "ERROR: no pinned runtime at $CURRENT_LINK — run the root deploy once to bootstrap releases"
    exit 1
  fi

  # A queued request may have been fully covered by the deploy ahead of it.
  # Treat that as success without moving the pin, marker, or last real result.
  if [ "$target_sha" = "$current" ] \
    || git_repo merge-base --is-ancestor "$target_sha" "$current"; then
    log "request ${target_sha:0:10} already deployed or superseded by ${current:0:10} — coalesced"
    rm -f "$REQUESTS_DIR/$target_sha"
    exit 0
  fi
  if ! git_repo merge-base --is-ancestor "$current" "$target_sha"; then
    log "ERROR: refusing stale/parallel release ${target_sha:0:10}; current ${current:0:10} is not its ancestor"
    write_result false deploy "$current" "$current" \
      "target $target_sha does not advance current release $current; use rollback-only for rollback or the root deploy for an operator-selected line"
    exit 1
  fi

  # Wait for a real quiet window, not a one-shot delay. Every newly requested
  # commit extends the window, up to a hard cap, so a stream of sequential agent
  # pushes becomes one rollout instead of a restart train. Exact-SHA requests
  # still absorb only compatible commits explicitly present in REQUESTS_DIR.
  if [ "$DEPLOY_COALESCE_SECS" -gt 0 ]; then
    local debounce_started debounce_deadline quiet_deadline newest_request seen_request now
    debounce_started="$(date +%s)"
    debounce_deadline=$((debounce_started + DEPLOY_COALESCE_MAX_SECS))
    quiet_deadline=$((debounce_started + DEPLOY_COALESCE_SECS))
    seen_request="$(find "$REQUESTS_DIR" -maxdepth 1 -type f -printf '%T@ %f\n' 2>/dev/null | sort -n | tail -n 1 || true)"
    while :; do
      now="$(date +%s)"
      [ "$now" -lt "$quiet_deadline" ] && [ "$now" -lt "$debounce_deadline" ] || break
      sleep 1
      newest_request="$(find "$REQUESTS_DIR" -maxdepth 1 -type f -printf '%T@ %f\n' 2>/dev/null | sort -n | tail -n 1 || true)"
      if [ "$newest_request" != "$seen_request" ]; then
        seen_request="$newest_request"
        now="$(date +%s)"
        quiet_deadline=$((now + DEPLOY_COALESCE_SECS))
        if [ "$quiet_deadline" -gt "$debounce_deadline" ]; then
          quiet_deadline="$debounce_deadline"
        fi
      fi
    done
  fi
  git_repo fetch --prune origin
  failed_target="$(sed -n 's/.*"ok":false.*"target":"\([^"]*\)".*/\1/p' "$RESULT_FILE" 2>/dev/null | tail -n 1)"
  for request in "$REQUESTS_DIR"/*; do
    [ -f "$request" ] || continue
    candidate="${request##*/}"
    if ! printf '%s\n' "$candidate" | grep -Eq '^[0-9a-f]{40,64}$' \
      || [ "$candidate" = "$failed_target" ] \
      || [ "$(git_repo rev-parse "${candidate}^{commit}" 2>/dev/null || true)" != "$candidate" ] \
      || ! git_repo merge-base --is-ancestor "$current" "$candidate"; then
      continue
    fi
    if git_repo merge-base --is-ancestor "$target_sha" "$candidate"; then
      target_sha="$candidate"
    fi
  done
  if [ "$target_sha" != "$requested_sha" ]; then
    log "coalescing ${requested_sha:0:10} into newest requested target ${target_sha:0:10}"
    TARGET="$target_sha"
  fi
  if [ "$target_sha" = "$failed_target" ] \
    && [ "${OPENSESSION_DEPLOY_RETRY_FAILED:-0}" != "1" ]; then
    log "ERROR: target ${target_sha:0:10} just failed deployment; refusing an automatic queued retry"
    rm -f "$REQUESTS_DIR/$target_sha"
    exit 1
  fi
  # This controller now owns every compatible request up to target_sha. Waiting
  # units retain their original argv and will exit as covered after this deploy.
  for request in "$REQUESTS_DIR"/*; do
    [ -f "$request" ] || continue
    candidate="${request##*/}"
    if printf '%s\n' "$candidate" | grep -Eq '^[0-9a-f]{40,64}$' \
      && git_repo merge-base --is-ancestor "$candidate" "$target_sha" 2>/dev/null; then
      rm -f "$request"
    fi
  done

  # Pin the pre-deploy runtime as last-known-good BEFORE moving anything: this is
  # what --rollback-only and the watchdog restore. --pin overrides it for
  # callers that already selected a release (see the flag comment above).
  if [ -n "$PIN_OVERRIDE" ]; then
    if ! pin_sha="$(git_repo rev-parse "${PIN_OVERRIDE}^{commit}" 2>/dev/null)"; then
      log "ERROR: cannot resolve --pin '$PIN_OVERRIDE'"
      exit 1
    fi
  else
    pin_sha="$current"
  fi
  echo "$pin_sha" > "$PIN_FILE"
  log "pinned last-known-good ${pin_sha:0:10}"

  # Materialize the exact commit before any lifecycle action. A dirty or
  # diverged WIP tree is irrelevant: git worktree reads objects, not its files.
  local release_dir
  if ! release_dir="$(release_cmd prepare-frontend "$target_sha")"; then
    log "ERROR: could not prepare release and frontend ${target_sha:0:10}"
    write_result false deploy "$current" "$current" "release or frontend preparation failed for $target_sha"
    exit 1
  fi

  CANARY_FILE="$RESULTS_DIR/$(date -u +%Y%m%dT%H%M%SZ)-canary-${target_sha:0:10}.json"
  "$BUN_BIN" "$release_dir/scripts/deploy-canary.ts" \
    "${HEALTH_URL%/ready}/live" "$CANARY_FILE" &
  CANARY_PID=$!

  # Validate privileged service installation while the current gateway is
  # still serving. Self-deploy deliberately does not rewrite root artifacts;
  # changes to units/helpers must go through deploy/deploy.sh.
  if ! preflight_session_kernel; then
    log "ERROR: session kernel preflight failed; runtime pointer was not changed"
    write_result false deploy "$current" "$current" "session kernel preflight failed before release switch"
    exit 1
  fi

  # Gateway-only source can use the installed single-active supervisor. The
  # candidate preloads behind IPC, the old process drains while it still owns
  # the listener and OS lease, and activation is sent only after its exit is
  # observed. Peer/protocol/dependency changes stay on the coordinated path.
  local release_impact="coordinated" restart_kernel=1 restart_executor_peer=1
  local impact_manifest="$RESULTS_DIR/$(date -u +%Y%m%dT%H%M%SZ)-impact-${target_sha:0:10}.json"
  if [ -S /run/opensession-gateway/control.sock ]; then
    release_impact="$(
      OPENSESSION_RELEASE_IMPACT_MANIFEST="$impact_manifest" \
      "$BUN_BIN" "$release_dir/scripts/release-impact.ts" \
        "$CURRENT_LINK" "$release_dir" "$REPO_DIR" "$current" "$target_sha" \
        2>/dev/null || echo coordinated
    )"
    log "generated release impact: $release_impact ($impact_manifest)"
    # Coordinated releases refresh both protocol peers. Selective peer versions
    # made an unchanged executor retain an older generation; the next gateway
    # handoff then fenced itself on a mixed generation and caused the 2026-08-28
    # outage. Keep component data for observability, but preserve one release
    # across the live gateway/kernel/executor protocol boundary.
  fi
  if [ "$release_impact" = "root" ]; then
    log "ERROR: release changes root-owned lifecycle artifacts; use deploy/deploy.sh"
    write_result false deploy "$current" "$current" \
      "refused unprivileged deployment of root-owned lifecycle artifacts"
    exit 1
  fi
  if [ "$release_impact" = "gateway-handoff" ] \
    || [ "$release_impact" = "supervisor-restart" ]; then
    write_marker
    log "preloading gateway ${target_sha:0:10} for a single-active handoff"
    if "$BUN_BIN" "$release_dir/packages/core/opensession-server/src/server/gateway-supervisor.ts" \
      handoff "$release_dir" "$target_sha"; then
      if [ "$(release_cmd current-sha 2>/dev/null || true)" != "$target_sha" ]; then
        log "ERROR: gateway supervisor returned without promoting the runtime pointer"
        if rollback_to_pin; then
          write_result false deploy "$(release_cmd current-sha)" "$current" \
            "gateway handoff of $target_sha lost pointer authority; rolled back and healthy again"
        else
          write_result false deploy "$(release_cmd current-sha 2>/dev/null || echo unknown)" "$current" \
            "gateway handoff of $target_sha lost pointer authority; rollback failed"
        fi
        exit 1
      fi
      if [ "$release_impact" = "supervisor-restart" ]; then
        log "fast-draining the promoted child to load target supervisor code"
        if ! "$BUN_BIN" "$release_dir/packages/core/opensession-server/src/server/gateway-supervisor.ts" \
          drain-supervisor; then
          log "ERROR: target supervisor drain protocol failed"
          rollback_to_pin || true
          write_result false deploy "$(current_release_sha)" "$current" \
            "supervisor replacement failed after gateway promotion"
          exit 1
        fi
        run_systemctl restart "$SERVICE_NAME"
      fi
      if poll_health; then
        log "healthy after gateway handoff — deployed ${target_sha:0:10}"
        "$BUN_BIN" "$release_dir/packages/core/opensession-server/src/server/gateway-supervisor.ts" \
          status || true
        write_result true deploy "$target_sha" "$current" "deployed with a single-active gateway handoff"
        echo 0 > "$FAIL_COUNT_FILE"
        exit 0
      fi
      log "ERROR: gateway handoff returned before readiness; attempting coordinated rollback"
      if rollback_to_pin; then
        write_result false deploy "$(release_cmd current-sha)" "$current" \
          "gateway handoff of $target_sha failed post-switch health; rolled back and healthy again"
      else
        write_result false deploy "$(release_cmd current-sha 2>/dev/null || echo unknown)" "$current" \
          "gateway handoff of $target_sha failed post-switch health; rollback failed"
      fi
      exit 1
    fi
    if [ "$(current_release_sha)" = "$current" ] && health_ok; then
      log "ERROR: candidate gateway handoff failed before cut-over; previous gateway remains healthy"
      write_result false deploy "$current" "$current" \
        "gateway handoff of $target_sha failed before cut-over; previous gateway retained"
      exit 1
    fi
    # A supervisor can fail after fencing the old child and then fail its own
    # rollback. Never trust a generic nonzero response to mean the old gateway
    # is still serving: the 2026-08-28 incident left PID 1 crash-looping for
    # minutes because this branch merely recorded failure. Force the pinned
    # generation and all protocol peers back to a health-gated state.
    log "ERROR: gateway handoff failed and the previous gateway is not healthy; forcing rollback"
    if rollback_to_pin; then
      write_result false deploy "$(current_release_sha)" "$current" \
        "gateway handoff of $target_sha failed; forced rollback restored health"
    else
      write_result false deploy "$(current_release_sha 2>/dev/null || echo unknown)" "$current" \
        "gateway handoff of $target_sha failed; forced rollback failed"
    fi
    exit 1
  fi

  # Coordinated peer releases keep the supervisor's public TCP listener alive
  # too. It preloads and parks the target gateway after the old child exits;
  # this deploy unit replaces the executor and SessionKernel, then releases the
  # candidate only after both peers are ready. Older supervisors reject the
  # prepare command without effects and fall through to the cold compatibility
  # path below.
  if [ -S /run/opensession-gateway/control.sock ]; then
    write_marker
    local supervisor_controller="$release_dir/packages/core/opensession-server/src/server/gateway-supervisor.ts"
    local kernel_generation="$target_sha" executor_generation="$target_sha"
    if "$BUN_BIN" "$supervisor_controller" prepare-coordinated \
      "$release_dir" "$target_sha" "$kernel_generation" "$executor_generation"; then
      if [ "$restart_kernel" = "1" ]; then record_kernel_schema_floor; fi
      if refresh_protocol_peers "$restart_executor_peer" "$restart_kernel" \
        && "$BUN_BIN" "$supervisor_controller" activate-coordinated \
        && poll_health \
        && "$BUN_BIN" "$supervisor_controller" commit-coordinated; then
        if [ "$release_impact" = "coordinated-supervisor-restart" ]; then
          log "fast-draining the coordinated target to load its supervisor code"
          "$BUN_BIN" "$supervisor_controller" drain-supervisor
          run_systemctl restart "$SERVICE_NAME"
          if ! poll_health; then
            log "ERROR: target supervisor failed health after coordinated replacement"
            rollback_to_pin || true
            write_result false deploy "$(current_release_sha)" "$current" \
              "coordinated supervisor replacement failed health"
            exit 1
          fi
        fi
        log "healthy after coordinated zero-downtime handoff — deployed ${target_sha:0:10}"
        "$BUN_BIN" "$supervisor_controller" status || true
        write_result true deploy "$target_sha" "$current" \
          "deployed with a generation-checked coordinated handoff"
        echo 0 > "$FAIL_COUNT_FILE"
        exit 0
      fi
      log "ERROR: coordinated handoff failed; parking target before peer rollback"
      "$BUN_BIN" "$supervisor_controller" park-coordinated || true
      if rollback_coordinated_to_pin "$supervisor_controller"; then
        write_result false deploy "$(release_cmd current-sha)" "$current" \
          "coordinated deploy of $target_sha failed; fail-closed rollback is healthy"
      else
        write_result false deploy "$(release_cmd current-sha 2>/dev/null || echo unknown)" "$current" \
          "coordinated deploy of $target_sha failed; fail-closed rollback failed"
      fi
      exit 1
    fi
    log "installed supervisor does not support coordinated handoff; using compatibility restart"
  fi

  # Open the watchdog recovery window before the first destructive lifecycle
  # action. If this transient deploy unit is killed outright, the external
  # watchdog can still recover instead of observing an unmarked stopped unit.
  write_marker
  stop_gateway
  release_cmd switch "$target_sha"
  # The actor service opens and migrates the durable database, so establish the
  # rollback floor from the selected release before replacing it. A failed
  # target must never boot an older protocol against a database it advanced.
  record_kernel_schema_floor

  if ! refresh_executor; then
    log "ERROR: target executor failed readiness; attempting rollback to pin"
    if rollback_to_pin; then
      write_result false deploy "$(release_cmd current-sha)" "$current" \
        "deploy of $target_sha failed executor readiness; rolled back and healthy again"
    else
      write_result false deploy "$(release_cmd current-sha 2>/dev/null || echo unknown)" "$current" \
        "deploy of $target_sha failed executor readiness; rollback failed"
    fi
    exit 1
  fi

  if ! refresh_session_kernel; then
    log "ERROR: target session kernel failed readiness; attempting rollback to pin"
    if rollback_to_pin; then
      write_result false deploy "$(release_cmd current-sha)" "$current" \
        "deploy of $target_sha failed session kernel readiness; rolled back and healthy again"
    else
      write_result false deploy "$(release_cmd current-sha 2>/dev/null || echo unknown)" "$current" \
        "deploy of $target_sha failed session kernel readiness; rollback failed"
    fi
    exit 1
  fi

  restart_service

  if poll_health; then
    log "healthy after restart — deployed ${target_sha:0:10}"
    write_result true deploy "$target_sha" "$current" "deployed and healthy"
    echo 0 > "$FAIL_COUNT_FILE"
    exit 0
  fi

  log "ERROR: not healthy within $((HEALTH_TRIES * HEALTH_SLEEP))s after restart — attempting rollback to pin"
  if rollback_to_pin; then
    write_result false deploy "$(release_cmd current-sha)" "$current" \
      "deploy of $target_sha unhealthy; switched back and healthy again"
  else
    write_result false deploy "$(release_cmd current-sha 2>/dev/null || echo unknown)" "$current" \
      "deploy of $target_sha unhealthy; rollback attempted but service still unhealthy"
  fi
  exit 1
}

do_rollback() {
  exec > >(tee -a "$LOG_FILE") 2>&1
  TARGET="last-known-good"
  log "rollback-only (repo $REPO_DIR, state $STATE_DIR)"
  local previous
  previous="$(release_cmd current-sha 2>/dev/null || echo unknown)"
  if rollback_to_pin; then
    write_result true rollback "$(release_cmd current-sha)" "$previous" "restarted onto last-known-good and healthy"
    exit 0
  fi
  if ! grep -q '"action":"rollback-needed"' "$RESULT_FILE" 2>/dev/null; then
    write_result false rollback "$(release_cmd current-sha 2>/dev/null || echo unknown)" "$previous" \
      "rollback restart did not become healthy"
  fi
  exit 1
}

# One watchdog probe. NEVER acts outside a recent self-deploy window: the
# last-deploy-marker (written only by the deploy path, consumed here) must be
# younger than WATCHDOG_WINDOW_SECS, and WATCHDOG_FAIL_THRESHOLD consecutive
# probes must have failed. Outside the window it only counts — a generic
# outage is left to Restart=always and humans, never an automatic rollback.
do_probe() {
  if health_ok; then
    # Reset the consecutive-failure counter; skip the write when already 0 so
    # a healthy box doesn't churn the state dir every minute.
    if [ -s "$FAIL_COUNT_FILE" ] && [ "$(cat "$FAIL_COUNT_FILE")" != "0" ]; then
      echo 0 > "$FAIL_COUNT_FILE"
    fi
    exit 0
  fi
  local count marker now age
  count="$(cat "$FAIL_COUNT_FILE" 2>/dev/null || echo 0)"
  case "$count" in (*[!0-9]*|'') count=0 ;; esac
  count=$((count + 1))
  echo "$count" > "$FAIL_COUNT_FILE"
  echo "[watchdog] $(date -u +%Y-%m-%dT%H:%M:%SZ) health probe failed (consecutive: $count)" >> "$WATCHDOG_LOG"

  marker="$(cat "$MARKER_FILE" 2>/dev/null || echo '')"
  case "$marker" in (*[!0-9]*|'') exit 0 ;; esac   # no (valid) deploy window — count only
  now="$(date +%s)"
  age=$((now - marker))
  if [ "$age" -gt "$WATCHDOG_WINDOW_SECS" ]; then exit 0; fi
  if [ "$count" -lt "$WATCHDOG_FAIL_THRESHOLD" ]; then exit 0; fi

  # Consume the window BEFORE acting: at most one automatic rollback per
  # deploy. If the pin itself is unhealthy we stop here and leave it to humans.
  echo "[watchdog] $(date -u +%Y-%m-%dT%H:%M:%SZ) acting: ${count} consecutive failures within ${age}s of a self-deploy — rollback-only" >> "$WATCHDOG_LOG"
  rm -f "$MARKER_FILE"
  echo 0 > "$FAIL_COUNT_FILE"
  do_rollback
}

case "$MODE" in
  deploy) do_deploy ;;
  rollback) do_rollback ;;
  probe) do_probe ;;
esac
