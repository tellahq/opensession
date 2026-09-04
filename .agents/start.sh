#!/usr/bin/env bash
# Boot a SAFE dev instance of Open Session as this repo's `dev` Portal.
#
# The Portal supervisor runs this script (declared in .agents/portals.json)
# with cwd = this checkout and:
#   PORT         the port the instance must listen on. REQUIRED.
#   PORTAL_URL   the authenticated public origin fronting that port. Optional.
# The older WEBAPP_PORT / PREVIEW_URL names are accepted as aliases so
# `WEBAPP_PORT=4001 ./.agents/start.sh` from a shell keeps working.
#
# A gateway cannot boot without a SessionKernel, so this script starts a
# private kernel on a free loopback port with a scratch token, waits for it,
# then runs the gateway in the foreground. Everything lives under
# ./.dev-state. When the gateway exits, or the supervisor kills the process
# group, the kernel goes with it.
#
# CRITICAL: the inherited environment is the calling server's env. On a
# production box that is the systemd service env (~/.opensession.env) with the
# live PORT/HOST, ENABLE_* agent toggles, gateway lease path and real secrets.
# Nothing here is inherited: both processes start from `env -i` and receive
# only the variables listed below, so the instance is a demo-mode dev server
# (OPENSESSION_DEV=1 OPENSESSION_DEMO=1) with isolated state, its own gateway
# lease and its own kernel. See docs/self-development.md.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

PORT="${PORT:-${WEBAPP_PORT:-}}"
PORTAL_URL="${PORTAL_URL:-${PREVIEW_URL:-}}"
if [ -z "$PORT" ]; then
	echo "ERROR: PORT is not set — refusing to boot (it would fall back to the production default)." >&2
	exit 1
fi
if [ "$PORT" = "3850" ]; then
	echo "ERROR: PORT=3850 is the production Open Session port — refusing to boot." >&2
	exit 1
fi

case ":$PATH:" in
	*":$HOME/.bun/bin:"*) ;;
	*) export PATH="$HOME/.bun/bin:$PATH" ;;
esac
command -v bun >/dev/null 2>&1 || {
	echo "ERROR: bun not found on PATH ($PATH)" >&2
	exit 1
}

STATE_DIR="$PWD/.dev-state"
mkdir -p "$STATE_DIR"

KERNEL_PORT="$(bun -e 'const s = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } }); process.stdout.write(String(s.port)); s.stop(true);')"
KERNEL_URL="http://127.0.0.1:$KERNEL_PORT"
KERNEL_TOKEN="$(bun -e 'process.stdout.write(crypto.randomUUID() + crypto.randomUUID())')"
KERNEL_LOG="$STATE_DIR/session-kernel.log"

env -i \
	PATH="$PATH" \
	HOME="$HOME" \
	USER="${USER:-}" \
	LANG="${LANG:-C.UTF-8}" \
	OPENSESSION_STATE_DIR="$STATE_DIR" \
	OPENSESSION_SESSION_KERNEL_PORT="$KERNEL_PORT" \
	OPENSESSION_SESSION_KERNEL_TOKEN="$KERNEL_TOKEN" \
	OPENSESSION_SESSION_KERNEL_WORKERS=2 \
	NODE_ENV=development \
	bun run packages/core/opensession-server/src/session-kernel-service.ts >"$KERNEL_LOG" 2>&1 &
KERNEL_PID=$!
cleanup() {
	kill "$KERNEL_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

kernel_ready=""
for _ in $(seq 1 300); do
	if ! kill -0 "$KERNEL_PID" 2>/dev/null; then
		echo "ERROR: session kernel exited during launch (see $KERNEL_LOG)" >&2
		tail -n 40 "$KERNEL_LOG" >&2 || true
		exit 1
	fi
	kernel_ready="$(curl -fsS "$KERNEL_URL/ready" 2>/dev/null || true)"
	[ -n "$kernel_ready" ] && break
	sleep 0.1
done
if [ -z "$kernel_ready" ]; then
	echo "ERROR: session kernel did not become ready at $KERNEL_URL (see $KERNEL_LOG)" >&2
	exit 1
fi

# The gateway runs in the foreground so the supervisor's readiness probe and
# process-group kill apply to it; `exec` would drop the kernel cleanup trap.
env -i \
	PATH="$PATH" \
	HOME="$HOME" \
	USER="${USER:-}" \
	LANG="${LANG:-C.UTF-8}" \
	PORT="$PORT" \
	HOST=127.0.0.1 \
	OPENSESSION_DEV=1 \
	OPENSESSION_DEMO=1 \
	OPENSESSION_STATE_DIR="$STATE_DIR" \
	OPENSESSION_DEPLOY_STATE="$STATE_DIR/deploy" \
	OPENSESSION_GATEWAY_LEASE="$STATE_DIR/gateway-active.lock" \
	OPENSESSION_GATEWAY_LEASE_WAIT_SECS=1 \
	OPENSESSION_SESSION_KERNEL_URL="$KERNEL_URL" \
	OPENSESSION_SESSION_KERNEL_TOKEN="$KERNEL_TOKEN" \
	OPENSESSION_ENV_FILE=/dev/null \
	OPENSESSION_EXECUTOR=0 \
	OPENSESSION_PI_DETACH=0 \
	NODE_ENV=development \
	OPENSESSION_UI_BASE="${PORTAL_URL:-http://127.0.0.1:$PORT}" \
	OPENSESSION_GITHUB_AUTH_STORE="$STATE_DIR/github-auth.json" \
	OPENSESSION_WEB_SESSIONS_STORE="$STATE_DIR/web-sessions.json" \
	OPENSESSION_KEYCHAIN_STORE="$STATE_DIR/keychain.json" \
	OPENSESSION_SEARCH_DB="$STATE_DIR/search.db" \
	ENABLE_SLACK_AGENT=false \
	ENABLE_LINEAR_AGENT=false \
	ENABLE_PLAIN_AGENT=false \
	ENABLE_STRIPE_AGENT=false \
	ENABLE_GITHUB_AGENT=false \
	ENABLE_GRAFANA_POLLER=false \
	bun run packages/core/opensession-server/opensession.ts &
GATEWAY_PID=$!
cleanup() {
	kill "$GATEWAY_PID" 2>/dev/null || true
	kill "$KERNEL_PID" 2>/dev/null || true
}
wait "$GATEWAY_PID"
