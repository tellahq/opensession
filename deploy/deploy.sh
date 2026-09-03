#!/usr/bin/env bash
#
# Drain-aware immutable-release deploy for Open Session, run ON the EC2 box by a CI
# deploy job (this repo ships no such workflow — wire up your own) via AWS SSM
# Run Command (AWS-RunShellScript). No inbound ingress, no SSH — CI
# authenticates to AWS with OIDC and calls ssm:SendCommand; the SSM agent on
# the box runs this.
#
# SSM runs commands as root. The checkout and the systemd service are owned by
# `ubuntu`, so git/bun run as ubuntu and only systemctl runs as root.
#
# Usage: deploy.sh <git-sha>   (defaults to origin/main)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_DIR="${OPENSESSION_DEPLOY_CHECKOUT:-${OPENSESSION_REPO_DIR:-$(dirname "$SCRIPT_DIR")}}"
HEALTH_URL="${OPENSESSION_HEALTH_URL:-http://127.0.0.1:3850/ready}"
DRAIN_URL="${OPENSESSION_DRAIN_URL:-http://127.0.0.1:3850/api/health}"
SERVICE_USER="${OPENSESSION_SERVICE_USER:-$(stat -c '%U' "$SOURCE_DIR")}"
SERVICE_UID="${OPENSESSION_SERVICE_UID:-$(id -u "$SERVICE_USER")}"
SERVICE_GROUP="${OPENSESSION_SERVICE_GROUP:-$(id -gn "$SERVICE_USER")}"
SERVICE_HOME_DIR="${OPENSESSION_SERVICE_HOME_DIR:-$(getent passwd "$SERVICE_USER" | cut -d: -f6)}"
TARGET_SHA="${1:-origin/main}"
MAX_DRAIN_WAIT="${MAX_DRAIN_WAIT:-0}"     # optional pre-drain; graceful service shutdown owns the default 10s drain
DEPLOY_LOCK_WAIT_SECS="${OPENSESSION_DEPLOY_LOCK_WAIT_SECS:-900}"
case "$DEPLOY_LOCK_WAIT_SECS" in (''|*[!0-9]*) DEPLOY_LOCK_WAIT_SECS=900 ;; esac

case "$SERVICE_HOME_DIR" in
  ""|"/")
    echo "[deploy] ERROR: unsafe home directory for service user $SERVICE_USER: '$SERVICE_HOME_DIR'" >&2
    exit 1
    ;;
esac

run_as_service_user() { runuser -u "$SERVICE_USER" -- "$@"; }
SERVICE_BUN="${OPENSESSION_BUN_BIN:-$(sed -n 's/^ExecStart=\([^ ]*\) run .*/\1/p' "$SOURCE_DIR/opensession-executor.service" | head -n 1)}"
[ -n "$SERVICE_BUN" ] && [ -x "$SERVICE_BUN" ] || {
  echo "[deploy] ERROR: Bun is not available for service user $SERVICE_USER" >&2
  exit 1
}

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

default_state_path() {
  local base="$1" current="$SERVICE_HOME_DIR/.opensession/$1" legacy="$SERVICE_HOME_DIR/.opensession-$1"
  if [ -e "$current" ] || [ ! -e "$legacy" ]; then
    printf '%s' "$current"
  else
    printf '%s' "$legacy"
  fi
}

if [ -n "${OPENSESSION_DEPLOY_STATE:-}" ]; then
  DEPLOY_STATE="$OPENSESSION_DEPLOY_STATE"
elif [ -e "$SERVICE_HOME_DIR/.opensession/deploy" ] || [ ! -e "$SERVICE_HOME_DIR/.opensession-deploy" ]; then
  DEPLOY_STATE="$SERVICE_HOME_DIR/.opensession/deploy"
else
  DEPLOY_STATE="$SERVICE_HOME_DIR/.opensession-deploy"
fi
CURRENT_LINK="$DEPLOY_STATE/current"
RELEASE_TOOL="$SCRIPT_DIR/release-checkout.sh"

run_release() {
  run_as_service_user env \
    OPENSESSION_DEPLOY_CHECKOUT="$SOURCE_DIR" \
    OPENSESSION_DEPLOY_STATE="$DEPLOY_STATE" \
    OPENSESSION_BUN_BIN="$SERVICE_BUN" \
    /bin/bash "$RELEASE_TOOL" "$@"
}

executor_ready() {
  local ready main_pid generation
  ready="$(cat /run/opensession-executor/ready 2>/dev/null || true)"
  main_pid="$(systemctl show -p MainPID --value opensession-executor.service 2>/dev/null || true)"
  generation="$(cat "$CURRENT_LINK/.opensession-release" 2>/dev/null || true)"
  [ -n "$main_pid" ] \
    && printf '%s' "$ready" | grep -Fq "\"pid\":$main_pid" \
    && printf '%s' "$ready" | grep -Fq "\"generation\":\"$generation\""
}

service_generation() {
  local service="$1" pid
  pid="$(systemctl show -p MainPID --value "$service" 2>/dev/null || true)"
  [ -n "$pid" ] && [ "$pid" != "0" ] || return 1
  cat "/proc/$pid/cwd/.opensession-release" 2>/dev/null
}

supervisor_generation() {
  service_generation opensession.service
}

ingress_generation() {
  service_generation opensession-ingress.service
}

drain_gateway_for_supervisor_restart() {
  [ -S /run/opensession-gateway/control.sock ] || return 1
  "$SERVICE_BUN" \
    "$CURRENT_LINK/packages/core/opensession-server/src/server/gateway-supervisor.ts" \
    drain-supervisor
}

session_kernel_ready() {
  local generation body
  generation="$(cat "$CURRENT_LINK/.opensession-release" 2>/dev/null || true)"
  body="$(curl -fs --max-time 2 http://127.0.0.1:3849/ready 2>/dev/null || true)"
  [ -n "$generation" ] && printf '%s' "$body" | grep -Fq "\"generation\":\"$generation\""
}

run_as_service_user mkdir -p "$DEPLOY_STATE"
run_as_service_user touch "$DEPLOY_STATE/.lock"
exec 9<>"$DEPLOY_STATE/.lock"
if ! flock -w "$DEPLOY_LOCK_WAIT_SECS" 9; then
  echo "[deploy] ERROR: timed out after ${DEPLOY_LOCK_WAIT_SECS}s waiting for another deploy or rollback" >&2
  exit 1
fi

echo "[deploy] fetching ${TARGET_SHA}; the WIP checkout will not be changed"
run_as_service_user git -C "$SOURCE_DIR" fetch --prune origin
TARGET_COMMIT="$(run_as_service_user git -C "$SOURCE_DIR" rev-parse "${TARGET_SHA}^{commit}")"
REMOTE_HEAD="$(run_as_service_user git -C "$SOURCE_DIR" rev-parse 'origin/main^{commit}')"
PREVIOUS_HEAD="$(run_release current-sha 2>/dev/null || true)"
if [ -n "$PREVIOUS_HEAD" ] && [ "${OPENSESSION_ROOT_DEPLOY_OVERRIDE:-0}" != "1" ]; then
  if [ "$TARGET_COMMIT" = "$PREVIOUS_HEAD" ]; then
    echo "[deploy] ERROR: ${TARGET_COMMIT:0:10} is already current; refusing a duplicate root rollout" >&2
    exit 1
  fi
  if [ "$TARGET_COMMIT" != "$REMOTE_HEAD" ]; then
    echo "[deploy] ERROR: root deploy target ${TARGET_COMMIT:0:10} is not latest origin/main ${REMOTE_HEAD:0:10}" >&2
    echo "[deploy] Use deploy_self for ordinary releases. Set OPENSESSION_ROOT_DEPLOY_OVERRIDE=1 only for explicit recovery." >&2
    exit 1
  fi
  ROOT_IMPACT="$(run_as_service_user git -C "$SOURCE_DIR" diff --no-renames --name-only "$PREVIOUS_HEAD" "$TARGET_COMMIT" -- \
    | grep -E '^(deploy/(deploy|self-deploy|release-checkout|install-executor-credential|install-session-kernel-credential|install-run-host-helper|install-resource-control)\.sh|deploy/opensession-run-host|deploy/systemd/|packages/core/opensession-server/src/server/(gateway-ingress|gateway-routing|gateway-tcp-proxy|stable-frontend)\.ts|opensession(\.socket|-ingress\.service|-executor\.service|-session-kernel\.service|\.service)$)' \
    || true)"
  if [ -z "$ROOT_IMPACT" ]; then
    echo "[deploy] ERROR: ${TARGET_COMMIT:0:10} changes no root-owned deployment artifacts" >&2
    echo "[deploy] Refusing a disruptive root rollout; use deploy_self so frontend and component impact classification applies." >&2
    exit 1
  fi
fi
if [ -n "$PREVIOUS_HEAD" ] && [ "$TARGET_COMMIT" != "$PREVIOUS_HEAD" ] \
  && ! run_as_service_user git -C "$SOURCE_DIR" merge-base --is-ancestor "$PREVIOUS_HEAD" "$TARGET_COMMIT"; then
  if [ "${OPENSESSION_DEPLOY_ALLOW_DIVERGED:-0}" != "1" ]; then
    echo "[deploy] ERROR: target ${TARGET_COMMIT:0:10} does not advance current ${PREVIOUS_HEAD:0:10}" >&2
    echo "[deploy] Refusing a stale/parallel release. Roll back explicitly, or set OPENSESSION_DEPLOY_ALLOW_DIVERGED=1 for a deliberate operator-selected history change." >&2
    exit 1
  fi
  echo "[deploy] WARNING: operator override permits history change ${PREVIOUS_HEAD:0:10} -> ${TARGET_COMMIT:0:10}"
fi
RELEASE_DIR="$(run_release prepare-frontend "$TARGET_COMMIT")"
# From here on, every source artifact comes from the exact prepared commit.
# SOURCE_DIR remains only the git object source and the place agents do WIP.
REPO_DIR="$RELEASE_DIR"
CANARY_DIR="$DEPLOY_STATE/results"
CANARY_FILE="$CANARY_DIR/$(date -u +%Y%m%dT%H%M%SZ)-root-canary-${TARGET_COMMIT:0:10}.json"
install -d -o "$SERVICE_USER" -g "$SERVICE_GROUP" -m 0700 "$CANARY_DIR"
setsid runuser -u "$SERVICE_USER" -- \
  "$SERVICE_BUN" "$REPO_DIR/scripts/deploy-canary.ts" \
  "${HEALTH_URL%/ready}/live" "$CANARY_FILE" &
CANARY_PID=$!
stop_canary() {
  if [ -n "${CANARY_PID:-}" ]; then
    kill -TERM -- "-$CANARY_PID" 2>/dev/null || true
    wait "$CANARY_PID" 2>/dev/null || true
    CANARY_PID=""
    if [ -s "$CANARY_FILE" ]; then
      echo "[deploy] canary: $(tr '\n' ' ' < "$CANARY_FILE")"
    fi
  fi
}
start_canary() {
  [ -z "${CANARY_PID:-}" ] || return 0
  setsid runuser -u "$SERVICE_USER" -- \
    "$SERVICE_BUN" "$REPO_DIR/scripts/deploy-canary.ts" \
    "${HEALTH_URL%/ready}/live" "$CANARY_FILE" &
  CANARY_PID=$!
}
trap stop_canary EXIT

if [ -z "$PREVIOUS_HEAD" ]; then
  # Bootstrap the stable path before installing helpers that validate it. No
  # running service points here yet, so this is not the lifecycle cut-over.
  run_release switch "$TARGET_COMMIT"
fi

# (Re)install the shared-checkout tripwire hook: warns loudly if this live
# checkout ever gets switched off main (branch work must use a worktree).
if [ -f "$REPO_DIR/deploy/git-hooks/post-checkout" ]; then
  run_as_service_user install -m 755 "$REPO_DIR/deploy/git-hooks/post-checkout" "$SOURCE_DIR/.git/hooks/post-checkout"
fi

# Install the cgroup hierarchy before rendering services or launching hosts
# that reference it. Existing hosts continue in their current cgroups; new
# hosts enter the workload slice without interrupting active turns.
"$REPO_DIR/deploy/install-resource-control.sh"

# A privileged rollout refreshes all runtime generations. Ordinary releases use
# self-deploy's generated component impact and avoid this broad compatibility
# path entirely.
RESTART_EXECUTOR=1
RESTART_KERNEL=1
RESTART_GATEWAY=1
RESTART_INGRESS=0

# The ingress deliberately keeps its original immutable cwd through ordinary
# runtime rollouts. A privileged rollout must still replace it when its own
# source closure changed. Compare against the release the live process actually
# loaded, not PREVIOUS_HEAD: a root deploy interrupted after pointer cut-over
# can be resumed with current already naming the target.
INGRESS_GENERATION="$(ingress_generation || true)"
if [ -z "$INGRESS_GENERATION" ] \
  || ! run_as_service_user git -C "$SOURCE_DIR" cat-file -e "${INGRESS_GENERATION}^{commit}" 2>/dev/null \
  || ! run_as_service_user git -C "$SOURCE_DIR" diff --quiet \
    "$INGRESS_GENERATION" "$TARGET_COMMIT" -- \
    packages/core/opensession-server/src/server/gateway-ingress.ts \
    packages/core/opensession-server/src/server/gateway-routing.ts \
    packages/core/opensession-server/src/server/gateway-tcp-proxy.ts \
    packages/core/opensession-server/src/server/stable-frontend.ts; then
  RESTART_INGRESS=1
fi

# Render every service against the stable current pointer, never the WIP tree
# or a versioned release path. The pointer changes atomically at cut-over.
GATEWAY_UNIT_RENDERED="$(mktemp)"
awk -v workdir="$CURRENT_LINK" '
  /^WorkingDirectory=/ { print "WorkingDirectory=" workdir; next }
  { print }
' "$REPO_DIR/opensession.service" > "$GATEWAY_UNIT_RENDERED"
GATEWAY_UNIT_NEEDS_SYNC=0
if ! cmp -s "$GATEWAY_UNIT_RENDERED" /etc/systemd/system/opensession.service; then
  GATEWAY_UNIT_NEEDS_SYNC=1
  RESTART_GATEWAY=1
fi

INGRESS_UNIT_RENDERED="$(mktemp)"
awk -v workdir="$CURRENT_LINK" -v user="$SERVICE_USER" -v home="$SERVICE_HOME_DIR" -v bun="$SERVICE_BUN" '
  /^WorkingDirectory=/ { print "WorkingDirectory=" workdir; next }
  /^User=/ { print "User=" user; next }
  /^Environment="HOME=/ { print "Environment=\"HOME=" home "\""; next }
  /^ExecStart=/ { print "ExecStart=" bun " run packages/core/opensession-server/src/server/gateway-ingress.ts"; next }
  { print }
' "$REPO_DIR/opensession-ingress.service" > "$INGRESS_UNIT_RENDERED"
INGRESS_UNIT_PATH="/etc/systemd/system/opensession-ingress.service"
if ! cmp -s "$INGRESS_UNIT_RENDERED" "$INGRESS_UNIT_PATH"; then
  install -o root -g root -m 0644 "$INGRESS_UNIT_RENDERED" "$INGRESS_UNIT_PATH"
  RESTART_INGRESS=1
fi
rm -f "$INGRESS_UNIT_RENDERED"

# Install the socket unit before cut-over. On the bootstrap release it can only
# be started after the legacy supervisor releases port 3850; afterwards PID 1
# retains this listener across every service restart.
SOCKET_UNIT_SOURCE="$REPO_DIR/opensession.socket"
SOCKET_UNIT_PATH="/etc/systemd/system/opensession.socket"
if ! cmp -s "$SOCKET_UNIT_SOURCE" "$SOCKET_UNIT_PATH"; then
  install -o root -g root -m 0644 "$SOCKET_UNIT_SOURCE" "$SOCKET_UNIT_PATH"
  RESTART_INGRESS=1
fi
systemctl daemon-reload
SOCKET_ACTIVE=0
if systemctl is-active --quiet opensession.socket; then SOCKET_ACTIVE=1; fi

EXECUTOR_TOKEN_PATH="/etc/opensession/executor-token"
"$REPO_DIR/deploy/install-executor-credential.sh" "$EXECUTOR_TOKEN_PATH"

EXECUTOR_CREDENTIAL_DROPIN="/etc/systemd/system/opensession.service.d/executor-credential.conf"
[ ! -L "$(dirname "$EXECUTOR_CREDENTIAL_DROPIN")" ] || {
  echo "[deploy] ERROR: gateway drop-in directory cannot be a symlink" >&2
  exit 1
}
install -d -o root -g root -m 0755 "$(dirname "$EXECUTOR_CREDENTIAL_DROPIN")"
[ ! -L "$EXECUTOR_CREDENTIAL_DROPIN" ] || {
  echo "[deploy] ERROR: gateway credential drop-in cannot be a symlink" >&2
  exit 1
}
printf '%s\n' \
  '[Service]' \
  'LoadCredential=executor-token:/etc/opensession/executor-token' \
  > "$EXECUTOR_CREDENTIAL_DROPIN.tmp"
install -o root -g root -m 0644 \
  "$EXECUTOR_CREDENTIAL_DROPIN.tmp" "$EXECUTOR_CREDENTIAL_DROPIN"
rm -f "$EXECUTOR_CREDENTIAL_DROPIN.tmp"
systemctl daemon-reload

RELEASE_ENV_DROPIN="/etc/systemd/system/opensession.service.d/release.conf"
printf '%s\n' \
  '[Service]' \
  "Environment=OPENSESSION_DEPLOY_CHECKOUT=$SOURCE_DIR" \
  "Environment=OPENSESSION_DEPLOY_STATE=$DEPLOY_STATE" \
  'Environment=OPENSESSION_PREBUILT_FRONTEND=0' \
  > "$RELEASE_ENV_DROPIN.tmp"
install -o root -g root -m 0644 "$RELEASE_ENV_DROPIN.tmp" "$RELEASE_ENV_DROPIN"
rm -f "$RELEASE_ENV_DROPIN.tmp"
systemctl daemon-reload

SESSION_KERNEL_TOKEN_PATH="/etc/opensession/session-kernel-token"
"$REPO_DIR/deploy/install-session-kernel-credential.sh" "$SESSION_KERNEL_TOKEN_PATH"
SESSION_KERNEL_CREDENTIAL_DROPIN="/etc/systemd/system/opensession.service.d/session-kernel-credential.conf"
[ ! -L "$SESSION_KERNEL_CREDENTIAL_DROPIN" ] || {
  echo "[deploy] ERROR: session kernel credential drop-in cannot be a symlink" >&2
  exit 1
}
printf '%s\n' \
  '[Service]' \
  'LoadCredential=session-kernel-token:/etc/opensession/session-kernel-token' \
  > "$SESSION_KERNEL_CREDENTIAL_DROPIN.tmp"
install -o root -g root -m 0644 \
  "$SESSION_KERNEL_CREDENTIAL_DROPIN.tmp" "$SESSION_KERNEL_CREDENTIAL_DROPIN"
rm -f "$SESSION_KERNEL_CREDENTIAL_DROPIN.tmp"
systemctl daemon-reload

EXECUTOR_UNIT_SOURCE="$REPO_DIR/opensession-executor.service"
EXECUTOR_BUN="$(sed -n 's/^ExecStart=\([^ ]*\) run .*/\1/p' "$EXECUTOR_UNIT_SOURCE")"
EXECUTOR_PATH="$(sed -n 's/^Environment="PATH=\(.*\)"$/\1/p' "$EXECUTOR_UNIT_SOURCE")"
RUN_HOST_ENV_FILE="$(sed -n 's/^EnvironmentFile=//p' "$REPO_DIR/opensession.service")"
if [ -z "$RUN_HOST_ENV_FILE" ]; then
  echo "[deploy] ERROR: gateway EnvironmentFile is required for run hosts" >&2
  exit 1
fi
# Settings edits this file through a .bak-<n> copy and an atomic .tmp rename,
# both created beside it, so the service user needs the directory, not just
# the file. Root-only /etc/opensession is reset to 0700 below and never works.
RUN_HOST_ENV_DIR="$(dirname "$RUN_HOST_ENV_FILE")"
if ! run_as_service_user test -w "$RUN_HOST_ENV_DIR" || ! run_as_service_user test -x "$RUN_HOST_ENV_DIR"; then
  echo "[deploy] ERROR: env file directory $RUN_HOST_ENV_DIR is not writable by $SERVICE_USER; move $RUN_HOST_ENV_FILE to a directory the service user owns and update EnvironmentFile=" >&2
  exit 1
fi
if [ -e "$RUN_HOST_ENV_FILE" ] && ! run_as_service_user test -w "$RUN_HOST_ENV_FILE"; then
  echo "[deploy] ERROR: env file $RUN_HOST_ENV_FILE is not writable by $SERVICE_USER" >&2
  exit 1
fi
SESSIONS_DIR="$(read_env_value OPENSESSION_SESSIONS_DIR "$RUN_HOST_ENV_FILE")"
STATE_DIR="$(read_env_value OPENSESSION_STATE_DIR "$RUN_HOST_ENV_FILE")"
if [ -z "$SESSIONS_DIR" ]; then
  if [ -n "$STATE_DIR" ]; then
    SESSIONS_DIR="$STATE_DIR/.opensession-sessions"
  else
    SESSIONS_DIR="$(default_state_path sessions)"
  fi
fi
case "$SESSIONS_DIR" in
  /*) ;;
  *) echo "[deploy] ERROR: session state directory must be absolute" >&2; exit 1 ;;
esac
"$REPO_DIR/deploy/install-run-host-helper.sh" \
  "$SERVICE_USER" "$CURRENT_LINK" "$EXECUTOR_BUN" "$SERVICE_HOME_DIR" \
  "$RUN_HOST_ENV_FILE" \
  "$SESSIONS_DIR/run-hosts" "$EXECUTOR_PATH" \
  "$SOURCE_DIR" "$DEPLOY_STATE" \
  0 "$HEALTH_URL" \
  source "$EXECUTOR_BUN"
run_as_service_user sudo -n /usr/local/libexec/opensession-run-host check

EXECUTOR_UNIT_RENDERED="$(mktemp)"
awk -v home="$SERVICE_HOME_DIR" -v state="$STATE_DIR" -v sessions="$SESSIONS_DIR" -v workdir="$CURRENT_LINK" '
  /^WorkingDirectory=/ { print "WorkingDirectory=" workdir; next }
  /^# EXECUTOR_PATH_ENV$/ {
    print "Environment=\"HOME=" home "\""
    if (state != "") print "Environment=\"OPENSESSION_STATE_DIR=" state "\""
    if (sessions != "") print "Environment=\"OPENSESSION_SESSIONS_DIR=" sessions "\""
    next
  }
  { print }
' "$REPO_DIR/opensession-executor.service" > "$EXECUTOR_UNIT_RENDERED"
if ! cmp -s "$EXECUTOR_UNIT_RENDERED" /etc/systemd/system/opensession-executor.service; then
  echo "[deploy] opensession-executor.service changed - syncing unit + daemon-reload"
  cp "$EXECUTOR_UNIT_RENDERED" /etc/systemd/system/opensession-executor.service
  systemctl daemon-reload
  RESTART_EXECUTOR=1
fi
rm -f "$EXECUTOR_UNIT_RENDERED"

SESSION_KERNEL_UNIT_RENDERED="$(mktemp)"
awk -v home="$SERVICE_HOME_DIR" -v state="$STATE_DIR" -v sessions="$SESSIONS_DIR" -v workdir="$CURRENT_LINK" '
  /^WorkingDirectory=/ { print "WorkingDirectory=" workdir; next }
  /^# SESSION_KERNEL_PATH_ENV$/ {
    print "Environment=\"HOME=" home "\""
    if (state != "") print "Environment=\"OPENSESSION_STATE_DIR=" state "\""
    if (sessions != "") print "Environment=\"OPENSESSION_SESSIONS_DIR=" sessions "\""
    next
  }
  { print }
' "$REPO_DIR/opensession-session-kernel.service" > "$SESSION_KERNEL_UNIT_RENDERED"
if ! cmp -s "$SESSION_KERNEL_UNIT_RENDERED" /etc/systemd/system/opensession-session-kernel.service; then
  echo "[deploy] opensession-session-kernel.service changed - syncing unit + daemon-reload"
  cp "$SESSION_KERNEL_UNIT_RENDERED" /etc/systemd/system/opensession-session-kernel.service
  systemctl daemon-reload
  RESTART_KERNEL=1
  RESTART_GATEWAY=1
fi
rm -f "$SESSION_KERNEL_UNIT_RENDERED"

# Keep kernel capacity policy in a dedicated, non-secret drop-in. The actor
# deliberately does not load the gateway's application/secrets environment.
SESSION_KERNEL_CAPACITY_SOURCE="$REPO_DIR/deploy/systemd/opensession-session-kernel.service.d/capacity.conf"
SESSION_KERNEL_CAPACITY_PATH="/etc/systemd/system/opensession-session-kernel.service.d/capacity.conf"
[ ! -L "$(dirname "$SESSION_KERNEL_CAPACITY_PATH")" ] || {
  echo "[deploy] ERROR: session kernel drop-in directory cannot be a symlink" >&2
  exit 1
}
install -d -o root -g root -m 0755 "$(dirname "$SESSION_KERNEL_CAPACITY_PATH")"
[ ! -L "$SESSION_KERNEL_CAPACITY_PATH" ] || {
  echo "[deploy] ERROR: session kernel capacity drop-in cannot be a symlink" >&2
  exit 1
}
if ! cmp -s "$SESSION_KERNEL_CAPACITY_SOURCE" "$SESSION_KERNEL_CAPACITY_PATH"; then
  echo "[deploy] session kernel capacity override changed - syncing drop-in + daemon-reload"
  install -o root -g root -m 0644 \
    "$SESSION_KERNEL_CAPACITY_SOURCE" "$SESSION_KERNEL_CAPACITY_PATH"
  systemctl daemon-reload
  RESTART_KERNEL=1
  RESTART_GATEWAY=1
fi

if [ "$RESTART_GATEWAY" = "1" ] && [ "$MAX_DRAIN_WAIT" -gt 0 ]; then
  # Drain before replacing the executor. The old gateway must not spend the
  # drain window talking to a newer, potentially incompatible launcher.
  echo "[deploy] waiting for idle (max ${MAX_DRAIN_WAIT}s)"
  deadline=$(( $(date +%s) + MAX_DRAIN_WAIT ))
  while :; do
    active=$(curl -s --max-time 4 "$DRAIN_URL" \
      | python3 -c 'import sys,json; print(json.load(sys.stdin).get("activeRuns","?"))' 2>/dev/null || echo "?")
    if [ "$active" = "0" ]; then echo "[deploy] idle - restarting"; break; fi
    if [ "$(date +%s)" -ge "$deadline" ]; then
      echo "[deploy] still ${active} run(s) active after ${MAX_DRAIN_WAIT}s - restarting anyway (journal resumes the rest)"
      break
    fi
    echo "[deploy] ${active} run(s) in flight - waiting"
    sleep 10
  done
fi

if [ -n "$PREVIOUS_HEAD" ]; then
  printf '%s\n' "$PREVIOUS_HEAD" > "$DEPLOY_STATE/last-known-good.tmp"
  chown "$SERVICE_USER:$SERVICE_GROUP" "$DEPLOY_STATE/last-known-good.tmp"
  mv "$DEPLOY_STATE/last-known-good.tmp" "$DEPLOY_STATE/last-known-good"
fi

rollback_release() {
  ROLLBACK_ATTEMPTED=1
  [ -n "$PREVIOUS_HEAD" ] || {
    echo "[deploy] ERROR: initial release failed and no previous release exists" >&2
    return 1
  }
  local required previous_schema
  required="$(cat "$DEPLOY_STATE/minimum-kernel-schema" 2>/dev/null || echo 0)"
  previous_schema="$(run_as_service_user git -C "$SOURCE_DIR" show "$PREVIOUS_HEAD:packages/core/opensession-server/src/server/session-kernel/schema-version" 2>/dev/null || echo 0)"
  if [ "$previous_schema" -lt "$required" ]; then
    echo "[deploy] ERROR: rollback blocked: previous kernel schema $previous_schema is below durable floor $required" >&2
    return 1
  fi
  echo "[deploy] rolling back current pointer to ${PREVIOUS_HEAD:0:10}"
  systemctl stop opensession.service || true
  systemctl stop opensession-session-kernel.service || true
  run_release switch "$PREVIOUS_HEAD"
  if [ ! -f "$CURRENT_LINK/packages/core/opensession-server/src/server/gateway-ingress.ts" ]; then
    echo "[deploy] previous release predates dedicated ingress; restoring supervisor socket ownership"
    systemctl disable --now opensession-ingress.service || true
    systemctl stop opensession.socket || true
    awk -v workdir="$CURRENT_LINK" '
      /^WorkingDirectory=/ { print "WorkingDirectory=" workdir; next }
      { print }
    ' "$CURRENT_LINK/opensession.service" > /etc/systemd/system/opensession.service
    install -o root -g root -m 0644 \
      "$CURRENT_LINK/opensession.socket" /etc/systemd/system/opensession.socket
    systemctl daemon-reload
    systemctl enable --now opensession.socket
  elif ! grep -q "inheritedGatewaySocketFd" \
    "$CURRENT_LINK/packages/core/opensession-server/src/server/gateway-supervisor.ts" 2>/dev/null; then
    echo "[deploy] previous supervisor predates socket activation; restoring its direct-bind unit"
    systemctl disable --now opensession.socket || true
    awk -v workdir="$CURRENT_LINK" '
      /^WorkingDirectory=/ { print "WorkingDirectory=" workdir; next }
      { print }
    ' "$CURRENT_LINK/opensession.service" > /etc/systemd/system/opensession.service
    systemctl daemon-reload
  fi
  systemctl restart opensession-executor.service
  systemctl restart opensession-session-kernel.service
  systemctl restart opensession.service
  for _ in $(seq 1 30); do
    sleep 2
    if curl -fs --max-time 4 "$HEALTH_URL" >/dev/null 2>&1; then
      echo "[deploy] previous release is healthy again"
      return 0
    fi
  done
  echo "[deploy] ERROR: previous release did not recover" >&2
  return 1
}

DEPLOY_SWITCHED=0
ROLLBACK_ATTEMPTED=0
on_runtime_error() {
  local rc=$?
  set +e
  if [ "$DEPLOY_SWITCHED" = "1" ] && [ "$ROLLBACK_ATTEMPTED" = "0" ]; then
    rollback_release || true
  fi
  exit "$rc"
}
trap on_runtime_error ERR

# Cut over only after the candidate, dependencies, credentials, units, helper,
# and drain are ready. Existing processes keep their old cwd until stopped;
# every newly started process resolves this one atomic pointer.
if [ -n "$PREVIOUS_HEAD" ] && [ "$PREVIOUS_HEAD" != "$TARGET_COMMIT" ]; then
  echo "[deploy] release cut-over ${PREVIOUS_HEAD:0:10} -> ${TARGET_COMMIT:0:10}"
else
  echo "[deploy] release cut-over -> ${TARGET_COMMIT:0:10}"
fi
run_release switch "$TARGET_COMMIT"
DEPLOY_SWITCHED=1

KERNEL_SCHEMA_FILE="$CURRENT_LINK/packages/core/opensession-server/src/server/session-kernel/schema-version"
TARGET_SCHEMA="$(cat "$KERNEL_SCHEMA_FILE" 2>/dev/null || echo 0)"
SCHEMA_FLOOR="$(cat "$DEPLOY_STATE/minimum-kernel-schema" 2>/dev/null || echo 0)"
if [ "$TARGET_SCHEMA" -gt "$SCHEMA_FLOOR" ]; then
  printf '%s\n' "$TARGET_SCHEMA" > "$DEPLOY_STATE/minimum-kernel-schema.tmp"
  chown "$SERVICE_USER:$SERVICE_GROUP" "$DEPLOY_STATE/minimum-kernel-schema.tmp"
  mv "$DEPLOY_STATE/minimum-kernel-schema.tmp" "$DEPLOY_STATE/minimum-kernel-schema"
fi

GATEWAY_COORDINATED=0
if [ "$RESTART_KERNEL" = "1" ]; then
  echo "[deploy] preparing gateway before replacing its actor protocol peer"
  if [ "$GATEWAY_UNIT_NEEDS_SYNC" = "0" ] \
    && [ "$SOCKET_ACTIVE" = "1" ] \
    && [ -S /run/opensession-gateway/control.sock ] \
    && "$SERVICE_BUN" \
      "$CURRENT_LINK/packages/core/opensession-server/src/server/gateway-supervisor.ts" \
      prepare-coordinated "$RELEASE_DIR" "$TARGET_COMMIT"; then
    GATEWAY_COORDINATED=1
  else
    if ! drain_gateway_for_supervisor_restart; then
      echo "[deploy] installed supervisor lacks fast service drain; using compatibility stop"
    fi
    # An HTTP canary against the systemd socket would immediately activate a
    # replacement gateway while protocol peers are intentionally offline.
    # Pause it for this rare compatibility path; PID 1 still retains the
    # listener and real clients queue until the selected release starts.
    stop_canary
    systemctl stop opensession.service
  fi
  if [ "$SOCKET_ACTIVE" = "0" ]; then
    echo "[deploy] activating the persistent gateway socket"
    systemctl enable --now opensession.socket
    SOCKET_ACTIVE=1
  fi
  systemctl stop opensession-session-kernel.service
  echo "[deploy] migrating legacy session-kernel rows offline"
  run_as_service_user env \
    HOME="$SERVICE_HOME_DIR" \
    OPENSESSION_STATE_DIR="$STATE_DIR" \
    OPENSESSION_SESSIONS_DIR="$SESSIONS_DIR" \
    "$EXECUTOR_BUN" "$CURRENT_LINK/scripts/migrate-session-kernel-storage.ts"
fi

if [ "$RESTART_EXECUTOR" = "1" ]; then
  echo "[deploy] restarting executor launcher (active run hosts are unaffected)"
  systemctl enable opensession-executor.service
  systemctl restart opensession-executor.service
elif ! systemctl is-active --quiet opensession-executor.service; then
  echo "[deploy] starting executor launcher"
  systemctl enable --now opensession-executor.service
fi

for _ in $(seq 1 30); do
  if systemctl is-active --quiet opensession-executor.service \
    && executor_ready; then
    break
  fi
  sleep 1
done
if ! systemctl is-active --quiet opensession-executor.service \
  || ! executor_ready; then
  echo "[deploy] ERROR: executor launcher did not become healthy" >&2
  rollback_release || true
  exit 1
fi

if [ "$RESTART_KERNEL" = "1" ]; then
  echo "[deploy] restarting session kernel actor service"
  systemctl enable opensession-session-kernel.service
  systemctl restart opensession-session-kernel.service
elif ! systemctl is-active --quiet opensession-session-kernel.service; then
  echo "[deploy] starting session kernel actor service"
  systemctl enable --now opensession-session-kernel.service
fi
for _ in $(seq 1 30); do
  if systemctl is-active --quiet opensession-session-kernel.service \
    && session_kernel_ready; then
    break
  fi
  sleep 1
done
if ! systemctl is-active --quiet opensession-session-kernel.service \
  || ! session_kernel_ready; then
  echo "[deploy] ERROR: session kernel actor service did not become healthy" >&2
  rollback_release || true
  exit 1
fi

if [ "$GATEWAY_UNIT_NEEDS_SYNC" = "1" ]; then
  echo "[deploy] opensession.service changed — syncing after actor readiness"
  cp "$GATEWAY_UNIT_RENDERED" /etc/systemd/system/opensession.service
  systemctl daemon-reload
fi
rm -f "$GATEWAY_UNIT_RENDERED"

# One-time listener migration: older releases handed the systemd descriptor to
# the gateway supervisor itself. Transfer it to the tiny ingress only after the
# old gateway is parked and target peers are ready. Future gateway/supervisor
# replacements leave both this process and port 3850 untouched.
if [ "$RESTART_INGRESS" = "1" ]; then
  echo "[deploy] promoting dedicated stable ingress"
  if [ "$GATEWAY_COORDINATED" = "1" ]; then
    "$SERVICE_BUN" \
      "$CURRENT_LINK/packages/core/opensession-server/src/server/gateway-supervisor.ts" \
      activate-coordinated
    "$SERVICE_BUN" \
      "$CURRENT_LINK/packages/core/opensession-server/src/server/gateway-supervisor.ts" \
      commit-coordinated
    GATEWAY_COORDINATED=0
  fi
  systemctl stop opensession.service || true
  stop_canary
  systemctl restart opensession.socket
  systemctl enable --now opensession-ingress.service
  start_canary
fi

# Host safety fuses: the coordinator gets its own ceiling, while detached
# engine/preview scopes share a bounded user slice. The per-scope limits are
# passed by the application at systemd-run time; this persistent parent catches
# many individually healthy scopes accumulating until the box becomes inert.
OPENSESSION_RESOURCE_SOURCE="$REPO_DIR/deploy/systemd/opensession.service.d/resources.conf"
OPENSESSION_RESOURCE_PATH="/etc/systemd/system/opensession.service.d/resources.conf"
if ! cmp -s "$OPENSESSION_RESOURCE_SOURCE" "$OPENSESSION_RESOURCE_PATH"; then
  echo "[deploy] Open Session resource override changed — syncing drop-in + daemon-reload"
  install -d -m 0755 "$(dirname "$OPENSESSION_RESOURCE_PATH")"
  install -m 0644 "$OPENSESSION_RESOURCE_SOURCE" "$OPENSESSION_RESOURCE_PATH"
  systemctl daemon-reload
fi

OPENSESSION_SLICE_SOURCE="$REPO_DIR/deploy/systemd/user/opensession.slice"
OPENSESSION_SLICE_PATH="$SERVICE_HOME_DIR/.config/systemd/user/opensession.slice"
if ! cmp -s "$OPENSESSION_SLICE_SOURCE" "$OPENSESSION_SLICE_PATH"; then
  echo "[deploy] Open Session user slice changed — syncing aggregate resource budget"
  install -d -m 0755 -o "$SERVICE_USER" -g "$SERVICE_GROUP" "$(dirname "$OPENSESSION_SLICE_PATH")"
  install -m 0644 -o "$SERVICE_USER" -g "$SERVICE_GROUP" \
    "$OPENSESSION_SLICE_SOURCE" "$OPENSESSION_SLICE_PATH"
  run_as_service_user env XDG_RUNTIME_DIR="/run/user/$SERVICE_UID" systemctl --user daemon-reload
  run_as_service_user env XDG_RUNTIME_DIR="/run/user/$SERVICE_UID" systemctl --user start opensession.slice
fi

# When Caddy's listener binds directly to the host's Tailscale IP, at boot
# Caddy can otherwise race tailscaled, fail with EADDRNOTAVAIL, and remain down
# forever because the package unit has no restart policy. Keep the host drop-in
# in source control and recover a currently failed Caddy when it first ships.
CADDY_DROPIN_SOURCE="$REPO_DIR/deploy/systemd/caddy.service.d/opensession.conf"
CADDY_DROPIN_PATH="/etc/systemd/system/caddy.service.d/opensession.conf"
if systemctl cat caddy.service >/dev/null 2>&1 \
  && ! cmp -s "$CADDY_DROPIN_SOURCE" "$CADDY_DROPIN_PATH"; then
  echo "[deploy] Caddy Tailscale boot override changed — syncing drop-in + daemon-reload"
  install -d -m 0755 "$(dirname "$CADDY_DROPIN_PATH")"
  install -m 0644 "$CADDY_DROPIN_SOURCE" "$CADDY_DROPIN_PATH"
  systemctl daemon-reload

  if ! systemctl is-active --quiet caddy.service; then
    echo "[deploy] Caddy is not active — restarting after installing boot override"
    systemctl restart caddy.service
  fi
fi

# The target supervisor is normally socket-activated while peers restart. Keep
# it when both unit and supervisor code already match; replacing it again only
# resets accepted proxy connections. Changed supervisor code or units get one
# fast drain before systemd transfers the inherited listener.
if [ "$GATEWAY_COORDINATED" = "1" ]; then
  "$SERVICE_BUN" \
    "$CURRENT_LINK/packages/core/opensession-server/src/server/gateway-supervisor.ts" \
    activate-coordinated
fi
if [ "$GATEWAY_UNIT_NEEDS_SYNC" = "1" ] \
  || [ "$(supervisor_generation || true)" != "$TARGET_COMMIT" ]; then
  if [ "$GATEWAY_COORDINATED" = "1" ]; then
    "$SERVICE_BUN" \
      "$CURRENT_LINK/packages/core/opensession-server/src/server/gateway-supervisor.ts" \
      commit-coordinated
    GATEWAY_COORDINATED=0
  fi
  if systemctl is-active --quiet opensession.service; then
    drain_gateway_for_supervisor_restart
  fi
  systemctl restart opensession.service
  start_canary
  # The replacement reconciles the durable transaction journal against the
  # selected generation; the old in-memory transaction no longer exists.
  GATEWAY_COORDINATED=0
elif ! systemctl is-active --quiet opensession.service; then
  systemctl start opensession.service
  start_canary
else
  echo "[deploy] target supervisor already active; retaining accepted connections"
fi

# Post-restart health gate — fail the deploy if it doesn't come back.
for _ in $(seq 1 30); do
  sleep 2
  if curl -fs --max-time 4 "$HEALTH_URL" >/dev/null 2>&1; then
    if [ "$GATEWAY_COORDINATED" = "1" ]; then
      "$SERVICE_BUN" \
        "$CURRENT_LINK/packages/core/opensession-server/src/server/gateway-supervisor.ts" \
        commit-coordinated
    fi
    echo "[deploy] healthy after restart"
    exit 0
  fi
done
echo "[deploy] ERROR: service did not return healthy after restart" >&2
rollback_release || true
exit 1
