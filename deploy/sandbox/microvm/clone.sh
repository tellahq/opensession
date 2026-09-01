#!/bin/bash
# Create/destroy a restored preview-VM clone in its own network namespace.
# Every clone wakes from the golden snapshot believing it is 172.16.100.2
# behind tap bkstap0 — a private netns per clone makes that true for all of
# them at once. Host reaches the guest via the veth: 10.200.<idx>.2 with
# ports DNAT'd into the guest (3300 dev, 8080 agent, 8081 root agent).
#
#   clone.sh create <idx> <pool-dir> <template-key> <vcpus> <memory-mib> <disk-gib>
#   clone.sh pause <idx> <pool-dir>    # stop compute/network, preserve COW disk
#   clone.sh resume <idx> <pool-dir>   # cold-boot the preserved COW disk
#   clone.sh publish-template <idx> <pool-dir> <template-key>
#   clone.sh destroy <idx> <pool-dir>  # remove compute/network/disk
#
# Layout per clone (under <pool-dir>): clone<idx>.ext4 (COW/sparse copy of
# golden.ext4), fc-clone<idx>.sock|log. The firecracker process runs inside
# netns bksns<idx> + a private mount ns binding the clone disk over the
# golden path (the vmstate references the golden's absolute path).
# Run as root.
set -euo pipefail
CMD="$1"; IDX="$2"; POOL="${3:-/opt/firecracker/store}"
TEMPLATE_KEY="${4:-}"
if [ "$CMD" = "restrict-egress" ]; then
  # Arguments 4+ are resolved network targets, not machine sizing.
  VCPUS=4
  MEMORY_MIB=12288
  DISK_GIB=25
else
  VCPUS="${5:-4}"
  MEMORY_MIB="${6:-12288}"
  DISK_GIB="${7:-25}"
  case "$VCPUS:$MEMORY_MIB:$DISK_GIB" in
    2:4096:25|4:8192:25|4:12288:25|4:12288:50|8:24576:100) ;;
    *) echo "unsupported microvm size $VCPUS vCPU / $MEMORY_MIB MiB / $DISK_GIB GiB" >&2; exit 2 ;;
  esac
fi
[[ "$IDX" =~ ^[0-9]+$ ]] && [ "$IDX" -ge 1 ] && [ "$IDX" -le 254 ] || {
  echo "clone index must be an integer in 1..254" >&2; exit 2;
}
[[ "$POOL" = /* ]] && [ "$POOL" != "/" ] && [ -d "$POOL" ] || {
  echo "pool must be an existing absolute directory other than /" >&2; exit 2;
}
NS="bksns$IDX"
VETH_H="bksveth${IDX}h"; VETH_N="bksveth${IDX}n"
HOST_IP="10.200.$IDX.1"; NS_IP="10.200.$IDX.2"
GUEST_IP="172.16.100.2"; TAP_HOST_IP="172.16.100.1"
JAIL="$POOL/jail$IDX"
API="$POOL/fc-clone$IDX.sock"; JAIL_API="$JAIL/run/firecracker.sock"
DISK="$POOL/clone$IDX.ext4"; LOG="$POOL/fc-clone$IDX.log"
FC=/opt/firecracker/firecracker
VMM_UID="${SUDO_UID:-$(id -u ubuntu)}"
[ "$VMM_UID" -gt 0 ] || VMM_UID="$(id -u ubuntu)"
VMM_GID="$(stat -c %g /dev/kvm)"

stop_runtime() {
  # The scope is the process handle — no pkill patterns (a -f pattern once
  # matched the INVOKER's own command text and killed the calling shell).
  systemctl stop "os-fc-clone$IDX" 2>/dev/null || true
  sleep 0.3
  ip netns del "$NS" 2>/dev/null || true
  ip link del "$VETH_H" 2>/dev/null || true
  rm -f "$API" "$JAIL_API"
}

destroy() {
  stop_runtime
  rm -f "$DISK" "$LOG" "$POOL/clone$IDX.paused"
  # JAIL is a validated child of a validated pool and every private mount
  # vanished with the stopped unshare process. Remove only this clone's empty
  # jail tree; never recurse through a live mount namespace.
  rm -rf --one-file-system "$JAIL"
}

restrict_egress() {
  systemctl is-active --quiet "os-fc-clone$IDX" || {
    echo "clone $IDX is not running" >&2; exit 4;
  }
  local chain="OS_EGRESS_$IDX" target address port
  ip netns exec "$NS" iptables -N "$chain" 2>/dev/null || true
  ip netns exec "$NS" iptables -F "$chain"
  # Install the deny before any allow rules: a malformed target or interrupted
  # policy update leaves the clone closed, never temporarily unrestricted.
  ip netns exec "$NS" iptables -A "$chain" -j REJECT --reject-with icmp-admin-prohibited
  # DNS is the sole infrastructure exception. Destination traffic is still
  # limited to the IPs resolved by the host when this policy is installed, so
  # a DNS answer cannot widen the firewall.
  # Return traffic for host→guest control/preview flows traverses FORWARD in
  # this namespace too; admit only conntrack-established packets, never new
  # guest-initiated connections to arbitrary destinations.
  ip netns exec "$NS" iptables -I "$chain" 1 -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
  ip netns exec "$NS" iptables -I "$chain" 1 -p udp --dport 53 -j ACCEPT
  ip netns exec "$NS" iptables -I "$chain" 1 -p tcp --dport 53 -j ACCEPT
  for target in "${@:4}"; do
    [[ "$target" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}(/([0-9]|[12][0-9]|3[0-2]))?(:[0-9]{1,5})?$ ]] || {
      echo "invalid resolved egress target: $target" >&2; exit 2;
    }
    address="${target%:*}"
    if [ "$address" = "$target" ]; then
      ip netns exec "$NS" iptables -I "$chain" 1 -d "$address" -p tcp -j ACCEPT
    else
      port="${target##*:}"
      [ "$port" -ge 1 ] && [ "$port" -le 65535 ] || {
        echo "invalid egress port: $port" >&2; exit 2;
      }
      ip netns exec "$NS" iptables -I "$chain" 1 -d "$address" -p tcp --dport "$port" -j ACCEPT
    fi
  done
  ip netns exec "$NS" iptables -C FORWARD -i bkstap0 -j "$chain" 2>/dev/null || \
    ip netns exec "$NS" iptables -I FORWARD 1 -i bkstap0 -j "$chain"
  echo "restricted clone $IDX egress to $((${#@} - 3)) resolved target(s)"
}

if [ "$CMD" = "destroy" ]; then destroy; echo "destroyed clone $IDX"; exit 0; fi
if [ "$CMD" = "restrict-egress" ]; then restrict_egress "$@"; exit 0; fi
if [ "$CMD" = "pause" ]; then
  [ -f "$DISK" ] || { echo "clone $IDX has no disk to pause" >&2; exit 4; }
  # Firecracker is terminated below, so flush the guest page cache first.
  # The root control lane is separate from user/agent exec and remains usable
  # even while the workspace lane is busy.
  SYNCED=$(curl -s -m 10 -X POST "http://$NS_IP:8081/exec" \
    -H 'Content-Type: application/json' \
    -d '{"command":"sync && echo synced","timeoutMs":8000}' 2>/dev/null || true)
  echo "$SYNCED" | grep -q synced || {
    echo "clone $IDX could not flush its disk; refusing to pause" >&2
    exit 5
  }
  stop_runtime
  touch "$POOL/clone$IDX.paused"
  echo "paused clone $IDX"
  exit 0
fi
[ "$CMD" = "create" ] || [ "$CMD" = "resume" ] || [ "$CMD" = "publish-template" ] || {
  echo "usage: clone.sh create|pause|resume|destroy|publish-template|restrict-egress <idx> [pool-dir] [args…]" >&2
  exit 2
}

# A golden refresh temporarily swaps the canonical disk before producing its
# matching memory/vmstate. Never let a clone observe a mixed generation.
exec 9>"$POOL/.refresh.lock"
flock -s 9

if [ "$CMD" = "publish-template" ]; then
  [[ "$TEMPLATE_KEY" =~ ^[A-Za-z0-9_.-]+$ ]] || {
    echo "invalid repo template key" >&2; exit 2;
  }
  [ -f "$DISK" ] && [ -f "$POOL/clone$IDX.paused" ] || {
    echo "clone $IDX must be paused before publishing a repo template" >&2; exit 4;
  }
  mkdir -p "$POOL/repo-templates"
  NEXT="$POOL/repo-templates/$TEMPLATE_KEY.next.ext4"
  TARGET="$POOL/repo-templates/$TEMPLATE_KEY.ext4"
  rm -f "$NEXT"
  cp --reflink=auto --sparse=always "$DISK" "$NEXT"
  mv -f "$NEXT" "$TARGET"
  find "$POOL/repo-templates" -maxdepth 1 -type f -name '*.ext4' -mmin +1440 -delete
  echo "published repo template $TEMPLATE_KEY"
  exit 0
fi

# Never destroy-first: a concurrent caller re-using a live index must FAIL,
# not silently kill the running VM (a claim's VM died mid-converge to a
# racing sweep spawn before this guard).
if systemctl is-active --quiet "os-fc-clone$IDX" 2>/dev/null; then
  echo "index $IDX already has a live VM — pick another" >&2
  exit 3
fi
if [ "$CMD" = "create" ]; then
  destroy 2>/dev/null || true
  SOURCE="$POOL/golden.ext4"
  LOAD_MEMORY_SNAPSHOT=1
  if [[ "$TEMPLATE_KEY" =~ ^[A-Za-z0-9_.-]+$ ]] && \
     [ -f "$POOL/repo-templates/$TEMPLATE_KEY.ext4" ] && \
     find "$POOL/repo-templates/$TEMPLATE_KEY.ext4" -mmin -1440 -print -quit | grep -q .; then
    SOURCE="$POOL/repo-templates/$TEMPLATE_KEY.ext4"
    LOAD_MEMORY_SNAPSHOT=0
  fi
  # COW disk: reflink when the store supports it (XFS), sparse copy otherwise.
  cp --reflink=auto --sparse=always "$SOURCE" "$DISK"
  TARGET_BYTES=$((DISK_GIB * 1024 * 1024 * 1024))
  CURRENT_BYTES=$(stat -c %s "$DISK")
  if [ "$TARGET_BYTES" -gt "$CURRENT_BYTES" ]; then
    truncate -s "$TARGET_BYTES" "$DISK"
    set +e
    e2fsck -pf "$DISK" >/dev/null
    CHECK_CODE=$?
    set -e
    [ "$CHECK_CODE" -le 1 ] || { echo "could not check expanded clone disk" >&2; exit 5; }
    resize2fs "$DISK" >/dev/null
  fi
else
  [ -f "$DISK" ] || { echo "clone $IDX has no preserved disk to resume" >&2; exit 4; }
  stop_runtime 2>/dev/null || true
fi

# The VMM must never run as host root or see the host filesystem. Build an
# empty per-clone chroot and bind in exactly the files/devices Firecracker
# needs. Mounts are created inside the private mount namespace below and
# disappear with the unit. The writable clone disk is owned by the guest VMM
# uid; golden/template sources remain root-owned and outside the jail.
install -d -m 0755 \
  "$JAIL/opt/firecracker" "$JAIL$POOL" "$JAIL/dev/net" "$JAIL/run" "$JAIL/proc"
touch "$JAIL$FC" "$JAIL/opt/firecracker/vmlinux" \
  "$JAIL$POOL/golden.ext4" "$JAIL$POOL/golden.mem" "$JAIL$POOL/golden.vmstate" \
  "$JAIL/dev/kvm" "$JAIL/dev/net/tun" "$JAIL/dev/null" "$JAIL/dev/zero" \
  "$JAIL/dev/random" "$JAIL/dev/urandom"
chown "$VMM_UID:$VMM_GID" "$DISK" "$JAIL/run"
chmod 0660 "$DISK"
rm -f "$API"
ln -s "$JAIL_API" "$API"

# netns + veth + in-ns tap with the exact name/subnet the snapshot expects.
ip netns add "$NS"
ip link add "$VETH_H" type veth peer name "$VETH_N"
ip link set "$VETH_N" netns "$NS"
ip addr replace "$HOST_IP/30" dev "$VETH_H"; ip link set "$VETH_H" up
ip netns exec "$NS" ip addr add "$NS_IP/30" dev "$VETH_N"
ip netns exec "$NS" ip link set "$VETH_N" up
ip netns exec "$NS" ip link set lo up
ip netns exec "$NS" ip tuntap add dev bkstap0 mode tap
ip netns exec "$NS" ip addr add "$TAP_HOST_IP/30" dev bkstap0
ip netns exec "$NS" ip link set bkstap0 up
ip netns exec "$NS" ip route add default via "$HOST_IP"
# in-ns NAT: host->veth traffic lands on the guest; guest egress masquerades.
ip netns exec "$NS" sysctl -qw net.ipv4.ip_forward=1
for p in 3300 8080 8081; do
  ip netns exec "$NS" iptables -t nat -A PREROUTING -d "$NS_IP" -p tcp --dport $p -j DNAT --to-destination "$GUEST_IP:$p"
done
ip netns exec "$NS" iptables -t nat -A POSTROUTING -o "$VETH_N" -j MASQUERADE
ip netns exec "$NS" iptables -t nat -A POSTROUTING -o bkstap0 -j MASQUERADE
# host side: let the clone subnet egress (IMDS stays blocked by setup-net's rule)
sysctl -qw net.ipv4.ip_forward=1
OUT_IF=$(ip route show default | awk '{print $5; exit}')
iptables -t nat -C POSTROUTING -s "10.200.$IDX.0/30" -o "$OUT_IF" -j MASQUERADE 2>/dev/null \
  || iptables -t nat -A POSTROUTING -s "10.200.$IDX.0/30" -o "$OUT_IF" -j MASQUERADE
iptables -C FORWARD -s "10.200.$IDX.0/30" -d 169.254.169.254 -j DROP 2>/dev/null \
  || iptables -I FORWARD 1 -s "10.200.$IDX.0/30" -d 169.254.169.254 -j DROP
iptables -C FORWARD -s "10.200.$IDX.0/30" -j ACCEPT 2>/dev/null || iptables -A FORWARD -s "10.200.$IDX.0/30" -j ACCEPT
iptables -C FORWARD -d "10.200.$IDX.0/30" -m state --state RELATED,ESTABLISHED -j ACCEPT 2>/dev/null \
  || iptables -A FORWARD -d "10.200.$IDX.0/30" -m state --state RELATED,ESTABLISHED -j ACCEPT

# Pre-fault the memory file only for the profile that can restore the golden
# snapshot. Alternate machine sizes cold boot and should not read 12 GiB they
# will never use.
if [ "$CMD" = "create" ] && [ "$LOAD_MEMORY_SNAPSHOT" = "1" ] && \
   [ "$VCPUS" = "4" ] && [ "$MEMORY_MIB" = "12288" ] && [ "$DISK_GIB" = "25" ]; then
  cat "$POOL/golden.mem" > /dev/null 2>&1 || true
fi

# firecracker inside netns + private mountns (clone disk over the golden
# path), detached into its own transient systemd scope — clone VMs must
# OUTLIVE whoever spawned them (previews died on every opensession restart
# while FCs were children of the service cgroup; same fix as the detached
# engine servers).
systemd-run --collect --unit "os-fc-clone$IDX" \
  --property=NoNewPrivileges=yes \
  --property=PrivateTmp=yes \
  --property=ProtectControlGroups=yes \
  --property=ProtectKernelModules=yes \
  --property=ProtectKernelTunables=yes \
  --property=RestrictSUIDSGID=yes \
  --property=LockPersonality=yes \
  --property=SystemCallArchitectures=native \
  --property=DevicePolicy=closed \
  --property='DeviceAllow=/dev/kvm rw' \
  --property='DeviceAllow=/dev/net/tun rw' \
  --property='DeviceAllow=/dev/null rw' \
  --property='DeviceAllow=/dev/zero rw' \
  --property='DeviceAllow=/dev/random rw' \
  --property='DeviceAllow=/dev/urandom rw' \
  bash -c "exec ip netns exec '$NS' unshare -m bash -c \"
    mount --make-rprivate / &&
    mount --bind '$FC' '$JAIL$FC' &&
    mount --bind '/opt/firecracker/vmlinux' '$JAIL/opt/firecracker/vmlinux' &&
    mount --bind '$DISK' '$JAIL$POOL/golden.ext4' &&
    mount --bind '$POOL/golden.mem' '$JAIL$POOL/golden.mem' &&
    mount --bind '$POOL/golden.vmstate' '$JAIL$POOL/golden.vmstate' &&
    mount --bind /dev/kvm '$JAIL/dev/kvm' &&
    mount --bind /dev/net/tun '$JAIL/dev/net/tun' &&
    mount --bind /dev/null '$JAIL/dev/null' &&
    mount --bind /dev/zero '$JAIL/dev/zero' &&
    mount --bind /dev/random '$JAIL/dev/random' &&
    mount --bind /dev/urandom '$JAIL/dev/urandom' &&
    mount -t proc -o nosuid,nodev,noexec proc '$JAIL/proc' &&
    exec chroot --userspec='$VMM_UID:$VMM_GID' '$JAIL' '$FC' --api-sock /run/firecracker.sock
  \" > '$LOG' 2>&1"
for i in $(seq 1 80); do [ -S "$API" ] && break; sleep 0.1; done
[ -S "$API" ] || { echo "firecracker api socket never appeared" >&2; destroy; exit 1; }

fc() {
  curl -s --unix-socket "$API" -X "$1" "http://x$2" \
    -H 'Content-Type: application/json' -d "$3"
}
if [ "$CMD" = "create" ] && [ "$LOAD_MEMORY_SNAPSHOT" = "1" ] && \
   [ "$VCPUS" = "4" ] && [ "$MEMORY_MIB" = "12288" ] && [ "$DISK_GIB" = "25" ]; then
  LOAD=$(fc PUT /snapshot/load \
    "{\"snapshot_path\":\"$POOL/golden.vmstate\",\"mem_backend\":{\"backend_type\":\"File\",\"backend_path\":\"$POOL/golden.mem\"},\"resume_vm\":true}")
  if echo "$LOAD" | grep -q fault_message; then
    echo "SNAPSHOT LOAD FAILED: $LOAD" >&2
    destroy
    exit 1
  fi
else
  # A paused session keeps its COW root disk, not a 12GB RAM image. Cold boot
  # that disk with the same kernel/network contract; repo state survives and
  # `.agents/resume` repairs processes that intentionally do not.
  fc PUT /boot-source \
    "{\"kernel_image_path\":\"/opt/firecracker/vmlinux\",\"boot_args\":\"console=ttyS0 reboot=k panic=1 pci=off init=/sbin/bks-init ip=$GUEST_IP::$TAP_HOST_IP:255.255.255.252::eth0:off\"}" >/dev/null
  fc PUT /drives/rootfs \
    "{\"drive_id\":\"rootfs\",\"path_on_host\":\"$POOL/golden.ext4\",\"is_root_device\":true,\"is_read_only\":false}" >/dev/null
  fc PUT /network-interfaces/eth0 \
    '{"iface_id":"eth0","guest_mac":"06:00:AC:10:64:02","host_dev_name":"bkstap0"}' >/dev/null
  fc PUT /machine-config "{\"vcpu_count\":$VCPUS,\"mem_size_mib\":$MEMORY_MIB}" >/dev/null
  START=$(fc PUT /actions '{"action_type":"InstanceStart"}')
  if echo "$START" | grep -q fault_message; then
    echo "COLD BOOT FAILED: $START" >&2
    if [ "$CMD" = "create" ]; then destroy; else stop_runtime; fi
    exit 1
  fi
fi

# clock resync + boot-log truncate via the root agent (SigV4 needs <5min skew)
NOW=$(date -u +%s)
for i in $(seq 1 30); do
  R=$(curl -s -m 3 -X POST "http://$NS_IP:8081/exec" -H 'Content-Type: application/json' \
    -d "{\"command\":\"date -u -s @$NOW && echo resynced\",\"timeoutMs\":5000}" 2>/dev/null | grep -c resynced || true)
  [ "$R" = "1" ] && break; sleep 0.5
done

echo "CLONE_IDX=$IDX"
echo "CLONE_IP=$NS_IP"
echo "CLONE_API=$API"
echo "CLONE_BOOT=$CMD"
rm -f "$POOL/clone$IDX.paused"
