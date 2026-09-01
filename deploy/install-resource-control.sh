#!/bin/sh
set -eu
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH

[ "$(id -u)" -eq 0 ] || {
  echo "install-resource-control.sh must run as root" >&2
  exit 1
}

script_dir="$(CDPATH= cd -- "$(dirname "$0")" && pwd)"
unit_dir="/etc/systemd/system"

safe_regular_destination() {
  [ ! -e "$1" ] || { [ -f "$1" ] && [ "$(stat -c %h "$1")" = "1" ]; }
}

[ ! -L "$unit_dir" ] || {
  echo "systemd unit directory cannot be a symlink" >&2
  exit 2
}

for name in opensession-control.slice opensession-workloads.slice; do
  source="$script_dir/systemd/$name"
  destination="$unit_dir/$name"
  [ -f "$source" ] || {
    echo "missing resource-control unit $source" >&2
    exit 2
  }
  [ ! -L "$destination" ] || {
    echo "resource-control unit cannot be a symlink: $destination" >&2
    exit 2
  }
  safe_regular_destination "$destination" || {
    echo "unsafe resource-control destination: $destination" >&2
    exit 2
  }
  install -o root -g root -m 0644 "$source" "$destination"
done

systemctl daemon-reload
systemctl start opensession-control.slice opensession-workloads.slice
