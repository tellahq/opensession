# A clean EC2 box for Open Session

You do not need AWS to run Open Session — any Linux box works. This page exists
because "spin up a fresh VM" is the most common way people try it, and a couple
of traps along the way cost an afternoon each.

## Sizing

Open Session runs agent turns, builds frontends and cuts git worktrees, so it
wants memory and disk more than cores.

| Use                             | Instance                           | Disk       | IOPS / throughput    |
| ------------------------------- | ---------------------------------- | ---------- | -------------------- |
| Trying it out                   | `t3.large` (2 vCPU, 8 GB)          | 50 GB gp3  | default (3000 / 125) |
| A small team                    | `m7i-flex.2xlarge` (8 vCPU, 32 GB) | 500 GB gp3 | 6000 / 500           |
| Heavy use, sandboxes, big repos | `r8i.2xlarge` (8 vCPU, 64 GB)+     | 1 TB gp3   | 12000 / 1000         |

For reference: Tella runs its whole team on one `r8i.4xlarge` (16 vCPU,
128 GB) with a 2 TB gp3 volume. Concurrent agent sessions are memory-hungry:
every engine run, dev server and preview adds up, and a swap-less box that
runs out of memory can freeze. When in doubt, err large on RAM. That is why the
heavy-use row uses the memory-optimized `r` family.

Worktrees and engine state grow steadily; disk is the resource that bites first.

**Set IOPS and throughput explicitly.** This is the non-obvious part of gp3: it
does _not_ scale with capacity the way gp2 did. A 1 TB gp3 gets exactly the same
3,000 IOPS and 125 MB/s as an 8 GB one unless you ask for more. Cloning repos,
cutting worktrees, installing dependencies and building frontends are all
I/O-heavy, so both baseline IOPS and throughput can bottleneck the box.

The ceiling is 16,000 IOPS and 1,000 MB/s. You pay only for what you provision
above the baseline. At current us-east-1 rates, the "small team" row costs
roughly $30/month more than default.

## Launch

These commands need the AWS CLI authenticated with a default region, a default
VPC, and `~/.ssh/id_ed25519.pub`. They use the account and region selected by
your AWS CLI configuration. If your account has no default VPC, choose an
internet-routed VPC and subnet explicitly instead of using this block.

Four steps print what they resolved before the next one uses it. Step 2 is safe
to re-run and step 3 refuses to launch on missing input.

None of these blocks contain `#` comments — zsh without `interactivecomments`
parses a pasted trailing `# comment` as a command and silently leaves the
variable empty.

**1. Resolve and check.**

```bash
KEY="$(cat ~/.ssh/id_ed25519.pub)"
MY_IP="$(curl -fsS https://checkip.amazonaws.com | tr -d '\n')/32"
REGION=$(aws ec2 describe-availability-zones \
  --query 'AvailabilityZones[0].RegionName' --output text)

AMI=$(aws ssm get-parameters \
  --names /aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id \
  --query 'Parameters[0].Value' --output text)
VPC=$(aws ec2 describe-vpcs --filters Name=isDefault,Values=true \
  --query 'Vpcs[0].VpcId' --output text)
SUBNET=None
if [ -n "$VPC" ] && [ "$VPC" != None ]; then
  SUBNET=$(aws ec2 describe-subnets --filters \
    Name=vpc-id,Values="$VPC" Name=default-for-az,Values=true \
    --query 'Subnets[0].SubnetId' --output text)
fi

echo "account=$(aws sts get-caller-identity --query Account --output text)"
echo "region=$REGION"
echo "vpc=$VPC  subnet=$SUBNET  ami=$AMI"
echo "from=$MY_IP  key=${KEY%% *} ${#KEY} chars"
```

Read that output before continuing. Wrong account or region is the expensive
mistake; an empty `key=` is the annoying one.

**2. Security group, safe to re-run.**

```bash
SG=None
if [ -n "$VPC" ] && [ "$VPC" != None ] && \
   [ -n "$MY_IP" ] && [ "$MY_IP" != /32 ]; then
  SG=$(aws ec2 describe-security-groups --filters \
    Name=group-name,Values=opensession Name=vpc-id,Values="$VPC" \
    --query 'SecurityGroups[0].GroupId' --output text)

  if [ -z "$SG" ] || [ "$SG" = None ]; then
    SG=$(aws ec2 create-security-group --group-name opensession \
      --description "Open Session" --vpc-id "$VPC" --query GroupId --output text)
  fi

  HAS_RULE=$(aws ec2 describe-security-groups --group-ids "$SG" \
    --query "contains(SecurityGroups[0].IpPermissions[?IpProtocol=='tcp' && FromPort==\`22\` && ToPort==\`22\`][].IpRanges[].CidrIp, '$MY_IP')" \
    --output text)

  if [ "$HAS_RULE" != True ]; then
    aws ec2 authorize-security-group-ingress --group-id "$SG" \
      --protocol tcp --port 22 --cidr "$MY_IP"
  fi
fi

echo "sg=$SG"
```

Reuses the group if it exists and adds your current IP only when the exact SSH
rule is absent. Run it again from a new network to add a second rule.

**3. Launch, guarded.**

```bash
ID=""
if [ -z "$KEY" ] || [ -z "$MY_IP" ] || [ "$MY_IP" = /32 ] || \
   [ -z "$AMI" ] || [ "$AMI" = None ] || \
   [ -z "$SG" ] || [ "$SG" = None ] || \
   [ -z "$SUBNET" ] || [ "$SUBNET" = None ]; then
  echo "refusing to launch: KEY, MY_IP, AMI, SG, or SUBNET is unset"
else
  ID=$(aws ec2 run-instances \
    --image-id "$AMI" --instance-type m7i-flex.2xlarge \
    --subnet-id "$SUBNET" --security-group-ids "$SG" \
    --associate-public-ip-address \
    --metadata-options "HttpTokens=required" \
    --block-device-mappings '[{"DeviceName":"/dev/sda1","Ebs":{"VolumeSize":500,"VolumeType":"gp3","Iops":6000,"Throughput":500,"DeleteOnTermination":true,"Encrypted":true}}]' \
    --tag-specifications 'ResourceType=instance,Tags=[{Key=Name,Value=opensession}]' \
    --user-data "#cloud-config
ssh_authorized_keys:
  - $KEY" \
    --query 'Instances[0].InstanceId' --output text)
  echo "instance=$ID"
fi
```

The guard is the whole point: user-data runs once, at first boot. Without a
separate recovery path, an instance launched with an empty key must be replaced.

**4. Wait for it.**

```bash
aws ec2 wait instance-running --instance-ids "$ID"
IP=$(aws ec2 describe-instances --instance-ids "$ID" \
  --query 'Reservations[0].Instances[0].PublicIpAddress' --output text)
echo "ip=$IP"

for i in 1 2 3 4 5 6 7 8 9 10; do
  ssh -o ConnectTimeout=5 -o StrictHostKeyChecking=accept-new \
    ubuntu@"$IP" true 2>/dev/null && break
  sleep 10
done
ssh ubuntu@"$IP" true && echo "ssh ok" || echo "ssh still failing"
```

`instance-running` fires well before cloud-init has installed your key, so the
first few attempts failing is normal. If it is still failing after the loop,
the key never landed — check that `$KEY` was actually non-empty when you
launched.

## Install

The default user service refuses to install while EC2 instance metadata is
reachable: agent code running as that user must not be able to obtain instance
role credentials. This launch attaches no IAM instance profile. After
cloud-init has finished, disable the metadata endpoint from your laptop and
wait for the change:

```bash
ssh ubuntu@"$IP" cloud-init status --wait
aws ec2 modify-instance-metadata-options --instance-id "$ID" \
  --http-endpoint disabled

STATE=""
for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
  STATE=$(aws ec2 describe-instances --instance-ids "$ID" \
    --query 'Reservations[0].Instances[0].MetadataOptions.State' \
    --output text)
  [ "$STATE" = applied ] && break
  sleep 2
done
echo "metadata-options=$STATE"
```

Continue only when that prints `metadata-options=applied`. Then install on the
box:

```bash
ssh ubuntu@"$IP"
curl -fsSL https://raw.githubusercontent.com/tellahq/opensession/main/install.sh | bash
```

If the instance needs metadata, leave it enabled. The installer will require a
host firewall rule before installing the default user service; Open Session's
optional instance-role credential mint needs additional configuration. See
[integrations-misc.md](integrations-misc.md#aws-creds-for-runs-agent_aws_region).
Then follow [install.md](install.md) for model accounts, repositories and
optional integrations.

## Networking

The security group above opens **only** port 22, and only to your current IP.
Nothing else about this box is reachable, which is the correct starting point:
a default Open Session install has no authentication and trusts everyone who
can reach the address it binds to. GitHub sign-in is available but opt-in.

Deciding how to reach the UI — Tailscale, an SSH tunnel, a custom domain — is
the same problem on EC2 as anywhere else, so it lives in one place:
**[networking.md](networking.md)**. Read it before changing `HOST`.

Do not expose the private app on 3850 or the public-ingress listener on 3860
directly in this security group. Public ingress belongs behind one of the
TLS-terminating exposure methods documented on the networking page.

## SSH in to debug

The box stays a normal Linux box — SSH in whenever you want to inspect or
test something. Nothing about the install hides state from you:

```bash
ssh ubuntu@"$IP"
```

| Command               | What                       |
| --------------------- | -------------------------- |
| `opensession status`  | is it running?             |
| `opensession doctor`  | what is wrong              |
| `opensession logs -f` | follow the service journal |
| `opensession version` | which commit is deployed   |

Useful paths:

| Path                         | What                                                             |
| ---------------------------- | ---------------------------------------------------------------- |
| `~/.opensession/src`         | active release symlink, or the checkout for a `--source` install |
| `~/.opensession/releases/`   | downloaded compiled releases                                     |
| `~/.opensession/config.json` | instance config (most changes are re-read live)                  |
| `~/.opensession.env`         | secrets, loaded by the service                                   |
| `~/.opensession/sessions/`   | session store                                                    |
| `~/.opensession/worktrees/`  | per-session git worktrees                                        |

All of these live under the service user's `$HOME`; on Ubuntu's default EC2
user (the setup this guide uses) that resolves to `/home/ubuntu`.

`opensession logs -f` is the safest way to watch the installed service. A
foreground run inherits the current shell and does not load
`~/.opensession.env` for you, so export any required secrets first.

The default install is a compiled release, not an editable checkout. Use the
installer's `--source` flag for self-development; on a source install frontend
edits rebuild live and backend edits need `opensession restart`. See
[../self-development.md](../self-development.md).

## Outgrowing the box

Both of these are things you will want eventually, and they are very different
operations: **disk grows online, instance type does not.**

### More disk, no reboot

EBS resizes live. You grow the volume, then grow the partition, then grow the
filesystem — all with the box running and Open Session serving.

From your laptop:

```bash
VOL=$(aws ec2 describe-instances --instance-ids "$ID" \
  --query 'Reservations[0].Instances[0].BlockDeviceMappings[0].Ebs.VolumeId' \
  --output text)
echo "volume=$VOL"

aws ec2 modify-volume --volume-id "$VOL" --size 1000 --iops 12000 --throughput 1000

aws ec2 describe-volumes-modifications --volume-ids "$VOL" \
  --query 'VolumesModifications[0].{State:ModificationState,Progress:Progress}' \
  --output table
```

Wait for the state to reach `optimizing` — that is enough, you do not need
`completed`. Then on the box:

```bash
lsblk
sudo growpart /dev/nvme0n1 1
sudo resize2fs /dev/nvme0n1p1
df -h /
```

`lsblk` first, always: the root device name is not guaranteed. On Nitro
instances it is `nvme0n1` with root on partition 1, but confirm rather than
assume. Note the space in `growpart /dev/nvme0n1 1` — device and partition
number are separate arguments, unlike `resize2fs`, which takes the partition.

Three things that catch people out:

- **You cannot shrink.** Growing is one-way. Oversizing costs more each month;
  undersizing means another expansion later.
- **Modifications are rate-limited.** Wait until the current modification is
  `completed` and at least six hours have passed before changing it again.
- `--iops` and `--throughput` are optional here, but a bigger volume with the
  old 125 MB/s is a common half-fix. Raise them in the same call.

### A bigger instance, with a stop

Instance type changes require a stop. Set the target explicitly; this example
moves the launch configuration from 32 GB to 64 GB of RAM:

```bash
NEW_TYPE=r8i.2xlarge
aws ec2 stop-instances --instance-ids "$ID"
aws ec2 wait instance-stopped --instance-ids "$ID"

aws ec2 modify-instance-attribute --instance-id "$ID" \
  --instance-type "{\"Value\":\"$NEW_TYPE\"}"

aws ec2 start-instances --instance-ids "$ID"
aws ec2 wait instance-running --instance-ids "$ID"

IP=$(aws ec2 describe-instances --instance-ids "$ID" \
  --query 'Reservations[0].Instances[0].PublicIpAddress' --output text)
echo "ip=$IP"
```

The root volume and everything on it survives untouched. The enabled systemd
service returns on boot. After SSH becomes ready:

```bash
ssh ubuntu@"$IP"
opensession status
```

**The public IP changes.** A stop/start releases the auto-assigned public
address and assigns a new one. Anything pinned to the old address, including
`~/.ssh/config`, DNS, `OPENSESSION_UI_BASE`, `OPENSESSION_INGRESS_BASE`, and
registered webhook URLs, must be updated unless you use stable addressing.

### Stable private and public addresses

**For the private UI, use a private or identity-gated access path.** Tailscale
is the simplest built-in option: its tailnet address survives EC2 stop/start and
is not public. An identity-gated Cloudflare Tunnel can also keep Open Session on
loopback, but a bare Tunnel hostname is public and is not sufficient. If the UI
is all you need, you do not need an Elastic IP. See
[networking.md](networking.md).

**For public callbacks without inbound ports, use Cloudflare Tunnel.** It gives
webhooks and remote Sandbox callbacks a stable HTTPS origin without an Elastic
IP or inbound security-group rule. Configure it in **Settings → Domains and
ingress → Public callbacks** as described in
[networking.md](networking.md#public-ingress-is-separate).

An **Elastic IP** is useful only when you choose the custom-domain/Caddy path
and point public DNS directly at this instance:

```bash
ALLOC=$(aws ec2 allocate-address --domain vpc --query AllocationId --output text)
aws ec2 associate-address --instance-id "$ID" --allocation-id "$ALLOC"

IP=$(aws ec2 describe-addresses --allocation-ids "$ALLOC" \
  --query 'Addresses[0].PublicIp' --output text)
echo "eip=$IP  allocation=$ALLOC"
```

Save `$ALLOC` for teardown. The association changes the public address once;
point DNS at the Elastic IP afterward. Because this guide disabled metadata,
set `OPENSESSION_PUBLIC_IPV4` to this Elastic IP in `~/.opensession.env` and
restart so Settings can suggest and verify DNS. Install Caddy, then allow
inbound TCP 80 and 443 for this setup:

```bash
aws ec2 authorize-security-group-ingress --group-id "$SG" --ip-permissions \
  '[{"IpProtocol":"tcp","FromPort":80,"ToPort":80,"IpRanges":[{"CidrIp":"0.0.0.0/0"}]},{"IpProtocol":"tcp","FromPort":443,"ToPort":443,"IpRanges":[{"CidrIp":"0.0.0.0/0"}]}]'
```

Choose Direct HTTPS with Caddy in **Settings → Domains and ingress → Public
callbacks**. Caddy proxies those public ports to loopback 3860; never open 3850
or 3860 directly. The full requirements
are in [networking.md](networking.md#direct-https-with-caddy).

Public IPv4 addresses currently cost about $0.005/hour (~$3.60/month), attached
or not. An Elastic IP survives instance termination and keeps billing until you
release it. Skip it for Cloudflare Tunnel or a private-only install.

## Updating

```bash
opensession update --check
opensession update
```

For the default compiled install, `update` downloads the latest release,
atomically swaps `~/.opensession/src`, and health-checks the restart with
rollback to the previous release on failure. `--check` reports the current
release and what an update would do, but does not check the remote artifact.

A source install fetches git, reinstalls dependencies and restarts. It refuses
uncommitted changes. An upstream clone is fast-forward only; a correctly
configured fork may merge upstream over local commits and push that merge to
`origin`. See [../self-development.md](../self-development.md).

## Tearing it down

```bash
aws ec2 terminate-instances --instance-ids "$ID"
aws ec2 wait instance-terminated --instance-ids "$ID"
aws ec2 delete-security-group --group-id "$SG"
aws ec2 release-address --allocation-id "$ALLOC"
```

The `wait` matters: the security group cannot be deleted while anything is
still attached to it, and a terminating instance counts. If you reused this
security group for another resource, keep it instead.

Skip the last line if you never allocated an Elastic IP. A terminated instance
stops incurring compute charges, but an Elastic IP keeps billing until released.
The launch command marks the root volume `DeleteOnTermination`, so that volume
is deleted with the instance.

To remove Open Session without destroying the box:

```bash
curl -fsSL https://raw.githubusercontent.com/tellahq/opensession/main/install.sh | bash -s -- --uninstall
```

This always removes the service and installed command. Without `--yes`, it asks
whether to remove `~/.opensession`, secrets and app state; the default answer
keeps them. Pass `--yes` to remove clean owned
state non-interactively. In either mode it preserves external registered
repositories, and it keeps session worktrees or scratch files when they contain
unsaved work.
