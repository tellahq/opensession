#!/bin/sh
set -eu
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH

[ "$(id -u)" -eq 0 ] || {
  echo "install-run-host-helper.sh must run as root" >&2
  exit 1
}
[ "$#" -eq 13 ] || {
  echo "usage: install-run-host-helper.sh <user> <repo> <bun> <home> <env-file> <hosts-root> <path> <deploy-checkout> <deploy-state> <allow-reset> <health-url> <runner-mode> <runner-bin>" >&2
  exit 2
}

service_user="$1"
repo_dir="$2"
bun_bin="$3"
home_dir="$4"
env_file="$5"
hosts_root="$6"
service_path="$7"
deploy_checkout="$8"
deploy_state="$9"
deploy_allow_reset="${10}"
health_url="${11}"
runner_mode="${12}"
runner_bin="${13}"
script_dir="$(CDPATH= cd -- "$(dirname "$0")" && pwd)"
# Root-side JSON parsing never executes service-owned Bun/JS as root.
[ -x /usr/bin/python3 ] && [ -x /bin/bash ] || { echo "run-host helper requires system Python 3 and Bash" >&2; exit 2; }
command -v timeout >/dev/null && command -v runuser >/dev/null || { echo "run-host capability checks require timeout and runuser" >&2; exit 2; }
helper="/usr/local/libexec/opensession-run-host"
config="/etc/opensession/run-host.conf"
sudoers="/etc/sudoers.d/opensession-run-host"

safe_regular_destination() {
  [ ! -e "$1" ] || { [ -f "$1" ] && [ "$(stat -c %h "$1")" = "1" ]; }
}

printf '%s\n' "$service_user" | grep -Eq '^[A-Za-z0-9_.-]+$' || {
  echo "invalid service user" >&2
  exit 2
}
for value in "$repo_dir" "$bun_bin" "$home_dir" "$env_file" "$hosts_root" "$deploy_checkout" "$deploy_state" "$runner_bin"; do
  case "$value" in
    /*) ;;
    *) echo "run-host paths must be absolute" >&2; exit 2 ;;
  esac
done
for value in "$repo_dir" "$bun_bin" "$home_dir" "$env_file" "$hosts_root" "$service_path" "$deploy_checkout" "$deploy_state" "$health_url" "$runner_mode" "$runner_bin"; do
  case "$value" in
    *'
'*) echo "run-host configuration cannot contain newlines" >&2; exit 2 ;;
  esac
done
[ "$deploy_allow_reset" = "0" ] || [ "$deploy_allow_reset" = "1" ] || {
  echo "allow-reset must be 0 or 1" >&2
  exit 2
}
[ "$runner_mode" = "source" ] || [ "$runner_mode" = "compiled" ] || {
  echo "runner mode must be source or compiled" >&2
  exit 2
}
[ -x "$runner_bin" ] || { echo "runner executable is not executable" >&2; exit 2; }

service_uid="$(id -u "$service_user")"
service_gid="$(id -g "$service_user")"
[ "$service_uid" -ne 0 ] || { echo "service user cannot be root" >&2; exit 2; }
systemd_run="$(command -v systemd-run)"
systemctl_bin="$(command -v systemctl)"

[ ! -L "$(dirname "$helper")" ] || { echo "helper directory cannot be a symlink" >&2; exit 2; }
install -d -o root -g root -m 0755 "$(dirname "$helper")"
[ ! -L "$helper" ] || { echo "helper path cannot be a symlink" >&2; exit 2; }
safe_regular_destination "$helper" || { echo "unsafe helper destination" >&2; exit 2; }
install -o root -g root -m 0755 "$script_dir/opensession-run-host" "$helper"
[ ! -L "$(dirname "$config")" ] || { echo "config directory cannot be a symlink" >&2; exit 2; }
install -d -o root -g root -m 0700 "$(dirname "$config")"
[ ! -L "$config" ] || { echo "config path cannot be a symlink" >&2; exit 2; }
[ ! -L "$sudoers" ] || { echo "sudoers path cannot be a symlink" >&2; exit 2; }
safe_regular_destination "$config" || { echo "unsafe config destination" >&2; exit 2; }
safe_regular_destination "$sudoers" || { echo "unsafe sudoers destination" >&2; exit 2; }
tmp_config="$(mktemp)"
tmp_sudoers="$(mktemp)"
trap 'rm -f "$tmp_config" "$tmp_sudoers"' EXIT
printf '%s\n' \
  "$service_user" "$service_uid" "$service_gid" "$repo_dir" "$bun_bin" \
  "$home_dir" "$env_file" "$hosts_root" "$systemd_run" "$systemctl_bin" \
  "$service_path" \
  "$deploy_checkout" "$deploy_state" "$deploy_allow_reset" "$health_url" \
  "$runner_mode" "$runner_bin" \
  > "$tmp_config"
install -o root -g root -m 0600 "$tmp_config" "$config"

printf '%s ALL=(root) NOPASSWD: %s\n' "$service_user" "$helper" > "$tmp_sudoers"
printf '%s ALL=(root) NOPASSWD: %s restart opensession.service\n' \
  "$service_user" "$systemctl_bin" >> "$tmp_sudoers"
printf '%s ALL=(root) NOPASSWD: %s restart opensession-executor.service\n' \
  "$service_user" "$systemctl_bin" >> "$tmp_sudoers"
printf '%s ALL=(root) NOPASSWD: %s is-active --quiet opensession-executor.service\n' \
  "$service_user" "$systemctl_bin" >> "$tmp_sudoers"
printf '%s ALL=(root) NOPASSWD: %s show -p MainPID --value opensession-executor.service\n' \
  "$service_user" "$systemctl_bin" >> "$tmp_sudoers"
visudo -cf "$tmp_sudoers" >/dev/null
install -o root -g root -m 0440 "$tmp_sudoers" "$sudoers"
