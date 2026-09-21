# Mac VM hosts

A Mac VM Sandbox connection (provider `tart`,
[self-hosting-sandboxes.md](self-hosting-sandboxes.md#mac-vm-tart-on-a-mac-runner))
runs on a list of **hosts**: Apple silicon Macs you paired as Runners, each
with its own VM budget. Sessions are placed on whichever host has a free
slot, so capacity grows by adding a Mac, not by changing anything else. Two
kinds of Mac fit:

- a **Mac mini** (or any Apple silicon Mac) on a desk, and
- an **EC2 Mac instance**, which is the same Mac mini hardware in an AWS
  data center.

Both end up as a paired macOS Runner with a logged-in desktop session, on the
tailnet, with the Local Network permission granted to the Runner. The
machine-side steps are scripted in
[`deploy/mac-host/prepare.sh`](../deploy/mac-host/prepare.sh); the rest is
one Screen Sharing visit and a few clicks in Open Session.

## What every host needs

| Need                     | Why                                                                                                                                  |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| Apple silicon            | Guests are Virtualization.framework macOS VMs; Intel Macs cannot run them.                                                           |
| Logged-in desktop user   | The Runner is a per-user LaunchAgent and each VM is a launchd job in that user's GUI session; Tart's VNC display needs it too.       |
| Machine stays awake      | A sleeping host stops every guest.                                                                                                   |
| Tailnet membership       | Runner pairing is tailnet-gated. The Runner dials out; nothing dials into the Mac.                                                   |
| Local Network permission | macOS 15+ gates the vmnet bridge behind a per-app prompt. The Runner (`bun`) needs it once per binary path; only a person can grant. |
| Disk                     | The default image is about 70 GB; plan 150 GB free with room for clones (a few GB each as they diverge from the base).               |
| Two guests per host      | Apple's limit. The base VM only runs during preparation, so `Max VMs` of 2 means two session VMs at once.                            |

## Mac mini

1. Sign the machine in to a desktop session as the user who will run the
   Runner, and keep it signed in. Turn off the screen lock under
   System Settings → Lock Screen.
2. Install Tailscale and join the tailnet.
3. In Open Session, **Settings → Runners → Pair** to get a code, then on the
   Mac:

   ```sh
   curl -fsSL https://raw.githubusercontent.com/tellahq/opensession/main/deploy/mac-host/prepare.sh -o prepare.sh
   sh prepare.sh --server https://your-opensession-host --code CODE
   ```

   The script keeps the Mac awake, turns Screen Sharing on, installs the
   `opensession` command, and pairs the Runner. Add `--autologin-password`
   to make the user log in on its own after a reboot.

4. Grant the Local Network permission: System Settings → Privacy & Security
   → Local Network → turn **bun** on (or accept the prompt when it appears),
   then restart the Runner service so the running process sees it:

   ```sh
   launchctl kickstart -k gui/$(id -u)/dev.tella.opensession.runner
   ```

5. **Workspace → Sandboxes → Mac VM → Configure → Add Mac**, choose the
   Runner, set **Max VMs**, and **Connect and test**. The qualification
   installs Tart, pulls the image, prepares the base VM, and proves a
   disposable VM on that Mac. Every host in the list is proven in turn.

## EC2 Mac

An EC2 Mac is a Mac mini on a Dedicated Host, so the steps are the Mac mini
ones with an AWS front half. Nothing in Open Session knows or cares that
the host is in AWS: it is a paired Runner like any other.

### Allocate and launch

- **Instance family:** `mac2.metal` (M1), `mac2-m2.metal` (M2),
  `mac2-m2pro.metal` (M2 Pro), or `mac2-m1ultra.metal`. Apple silicon only;
  `mac1.metal` is Intel and cannot host macOS guests.
- **Dedicated Host:** EC2 Mac runs on a Dedicated Host allocated for a
  minimum of 24 hours; the host is billed whether or not an instance is on
  it. Allocate one in the region and zone you want, then launch the instance
  onto it.
- **AMI:** the newest AWS-provided macOS AMI, macOS 15 or later (list them
  with `aws ec2 describe-images --owners amazon --filters Name=name,Values='amzn-ec2-macos-*'`).
  The Tart image runs macOS 26; the host may be older.
- **Root volume:** the AMI ships on a small root volume. Launch with a gp3
  root volume of 200 GB or more; the prepare script grows the APFS
  container to fill it.
- **Network:** a VPC subnet with outbound internet (the Runner dials out, Tart
  pulls its image from GHCR). The security group needs inbound SSH (22) from
  your address only; Screen Sharing goes through the SSH tunnel and nothing
  else dials in.
- **Key pair:** for the initial SSH access as `ec2-user`.

### Prepare

1. SSH in: `ssh -i key.pem ec2-user@<public-ip>`.
2. Give `ec2-user` a password (the script needs one for automatic login and
   Screen Sharing needs one to connect):

   ```sh
   sudo passwd ec2-user
   ```

3. Get a pairing code from **Settings → Runners → Pair** and a Tailscale
   auth key, then run the prepare script. On EC2 it also grows the disk and
   installs Tailscale through the preinstalled Homebrew:

   ```sh
   curl -fsSL https://raw.githubusercontent.com/tellahq/opensession/main/deploy/mac-host/prepare.sh -o prepare.sh
   sh prepare.sh --server https://your-opensession-host --code CODE \
     --autologin-password 'the password' --tailscale-authkey tskey-auth-...
   sudo reboot
   ```

   The reboot brings the instance back with `ec2-user` logged in to a desktop
   session and the Runner connected. Open Session lists it online under
   Settings → Runners.

4. Grant the Local Network permission over Screen Sharing:

   ```sh
   ssh -i key.pem -L 5900:localhost:5900 ec2-user@<public-ip>
   ```

   then open `vnc://localhost:5900` (Finder → Go → Connect to Server on a
   Mac), sign in as `ec2-user`, and turn **bun** on under System Settings →
   Privacy & Security → Local Network. Restart the Runner service from the
   SSH session:

   ```sh
   launchctl kickstart -k gui/$(id -u)/dev.tella.opensession.runner
   ```

5. Add the Runner as a host on the Mac VM card and **Connect and test**, as
   for a Mac mini.

### Notes

- **Cost.** The Dedicated Host is the cost, not the instance; an idle host
  still bills. Release the host when the capacity is not needed for a while
  and allocate again later; the connection just sees the Runner go offline
  and skips it for new VMs. Sessions whose VM lived on it wait for the host
  rather than being recreated elsewhere.
- **Reboots.** Automatic login is what makes a reboot come back on its own.
  Without it, an EC2 Mac boots to the login window and nothing runs until
  someone signs in over Screen Sharing.
- **Upgrades.** Homebrew upgrades of `bun` change the Runner binary's path
  and macOS asks for the Local Network permission again. Keep the pinned
  `bun` the installer put in place, or repeat step 4 after an upgrade.
- **Status.** This runbook and the script were prepared ahead of the first
  EC2 host; the Mac mini path is the one exercised so far. Expect to adjust
  AMI names and the resize step as AWS moves them.

## Operating the fleet

- Placement is per session: the host with the most free slots wins, and a
  host that already holds the repo's project snapshot wins a tie. The
  chosen Runner is recorded with the VM, so wake, the Desktop tab, and
  Terminal tabs go back to it.
- Idle VMs are stopped after `idleStopMinutes` on every host; stopped VMs do
  not count against a host's budget.
- Removing a host from the list does not delete its VMs. Sessions on it keep
  working while it stays paired; add it back if one of them needs waking
  after the Runner reconnects.
- Watch disk with `df -h /System/Volumes/Data` on each Mac. Clones are
  copy-on-write, so the base costs its 70 GB once and each session VM grows
  by what it writes.
