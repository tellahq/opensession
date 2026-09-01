# Runners

A Runner is a persistent computer your workspace explicitly trusts for work
that needs a particular platform, toolchain, or GPU. It is not an isolated
Sandbox.

Workspace administrators pair a Runner from **Settings → Runners**. The
pairing code is one-time and expires after ten minutes. On a new macOS or Linux
Runner, install the command without onboarding a server or model engine:

```sh
curl -fsSL https://raw.githubusercontent.com/tellahq/opensession/main/install.sh | bash -s -- --no-onboard --no-engine
```

Follow any PATH refresh instruction from the installer, then pair the machine:

```sh
opensession runner connect --server https://your-opensession-host --code CODE
```

Connect installs a per-user LaunchAgent, systemd user service or Windows
scheduled task when one is available. The service recovers from process
failures, and the Runner reconnects after connection failures. After a machine
reboot, macOS starts the LaunchAgent when that user logs into a GUI session.
Linux starts the user service at login unless lingering is enabled separately
with `sudo loginctl enable-linger "$USER"`. Windows starts the task at sign-in. If
Connect cannot install a service, it says why;
`opensession runner service install` retries after the cause is fixed.
The Runner connects outbound over the tailnet. Open Session never dials into
the machine.

## Windows Runners

Windows machines are supported as Runners. The Open Session server itself
still runs on Linux or macOS; the Windows install is the Runner client only.
On the Windows machine, from PowerShell:

```powershell
irm https://raw.githubusercontent.com/tellahq/opensession/main/install.ps1 | iex
opensession runner connect --server https://your-opensession-host --code CODE
```

Connect registers a per-user scheduled task named `OpenSessionRunner` that
starts the Runner at sign-in, restarts it if the process dies, and needs no
administrator rights. Delegated commands run under PowerShell (`-NoProfile
-NonInteractive`), so write PowerShell rather than bash when targeting a
Windows Runner; the `run_on_runner` tool description says the same to agents.
Pairing is tailnet-gated on every platform, so install Tailscale for Windows
first.

PowerShell and `schtasks.exe` are resolved at their known location under
`%SystemRoot%\System32` rather than through PATH, because a damaged PATH would
otherwise break every delegated command and leave the sign-in task launching
nothing.

## Operating a Windows Runner

The scheduled task is the service. Inspect and drive it directly:

```powershell
schtasks /Query /TN OpenSessionRunner /FO LIST /V
schtasks /Run /TN OpenSessionRunner
schtasks /Delete /TN OpenSessionRunner /F
```

The Runner writes everything it prints to `%USERPROFILE%\.opensession\runner.log`.
Read that first when a Runner shows offline.

If `connect` cannot install the task, it says why and
`opensession runner service install` runs the same installation on its own.
There is nothing to configure first on Windows, and the task itself needs no
administrator rights: it is per-user and installs from an ordinary PowerShell
window. Machine-wide setup does need elevation, which is its own subject below.

The Runner resolves PowerShell and `schtasks.exe` from
`%SystemRoot%\System32` and restores the core System32, Windows PowerShell, and
WMI directories in each delegated command's PATH. This repairs Windows inbox
tools such as `where.exe` and PowerShell/WMI components without changing the
machine PATH. Third-party tools such as Git must still be installed and present
on the inherited PATH.

Two behaviours of the task decide how an always-on box has to be set up:

- The trigger is a **LogonTrigger** running with an `InteractiveToken`. The
  Runner starts when the user signs in, not at boot. A headless machine needs
  autologon to come back on its own after a reboot.
- `MultipleInstancesPolicy` is `IgnoreNew`. If `opensession runner run` is
  already going in a console window, the task's launch is ignored without
  comment. Close the foreground one first.

### Elevation, and running exactly one instance

A delegated command runs with a UAC-filtered token. `whoami /groups` reports
`BUILTIN\Administrators` as _"Group used for deny only"_ even when the account
is an administrator, and

```powershell
([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
```

returns `False`. The boundary does not fall where the command names suggest:

| Works unelevated                           | Needs elevation                               |
| ------------------------------------------ | --------------------------------------------- |
| `powercfg /change standby-timeout-ac 0`    | `powercfg /hibernate off`                     |
| installing and querying the scheduled task | `New-NetFirewallRule`, `Set-NetFirewallRule`  |
| writes under `HKCU`                        | writes under `HKLM`                           |
|                                            | `Get-NetAdapterPowerManagement`, even to read |
|                                            | installing a service, such as a VNC server    |

So the awake settings, the firewall rules and a VNC server all have to be
driven from a Runner that was started elevated. Start one from an
**Administrator** PowerShell window, stopping the task first so only one
instance holds the channel:

```powershell
schtasks /End /TN OpenSessionRunner
$runnerProcesses = Get-CimInstance Win32_Process -Filter "Name='bun.exe'" |
  Where-Object { $_.CommandLine -match '(?i)[\\/]scripts[\\/]cli\.ts"?\s+runner\s+run(?:\s|$)' }
$runnerProcesses | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
opensession runner run
```

When the machine-wide work is finished, close that window and
`schtasks /Run /TN OpenSessionRunner` to hand the channel back to the ordinary
per-user task. A Runner left permanently elevated gives every delegated command
administrator rights it does not need.

**One instance, always.** `MultipleInstancesPolicy: IgnoreNew` only stops the
_task_ from starting a second copy of itself. It does nothing about a
foreground `opensession runner run` started alongside a task that is already
going. Two live Runners share one identity and take turns owning the control
connection, each knocking the other off. The symptom is distinctive rather than
obvious: the Runner reads `online` with a `lastSeenAt` that keeps advancing,
while commands fail immediately with `[Runner disconnected]`, occasionally
interleaved with ones that succeed. Count the Runner processes and expect
exactly one:

```powershell
$runnerProcesses = Get-CimInstance Win32_Process -Filter "Name='bun.exe'" |
  Where-Object { $_.CommandLine -match '(?i)[\\/]scripts[\\/]cli\.ts"?\s+runner\s+run(?:\s|$)' }
@($runnerProcesses).Count
```

Do not stop or count unrelated Bun processes.

### Keeping the machine awake

A sleeping Runner is an offline Runner.

```powershell
powercfg /change standby-timeout-ac 0
powercfg /change disk-timeout-ac 0
powercfg /hibernate off
```

Check `powercfg /a` for Modern Standby ("Standby (S0 Low Power Idle)"). Those
timeouts are ignored on such machines, and staying awake needs the
`PlatformAoAcOverride` registry override under
`HKLM\SYSTEM\CurrentControlSet\Control\Power` followed by a reboot.

Separately, check the network adapter: Device Manager, the adapter's Power
Management tab, and clear "Allow the computer to turn off this device to save
power". With it set the box stays awake while the tailnet connection drops,
which looks exactly like a crashed Runner.

### Remote access for operators

Two options, and they are not interchangeable.

**VNC** shares the physical console session, so it leaves the signed-in
desktop the LogonTrigger depends on exactly as it is. That makes it the right
fit for a machine kept online by autologon. Scope its firewall rule to the
tailnet rather than the LAN:

```powershell
New-NetFirewallRule -DisplayName "VNC over tailnet" -Direction Inbound `
  -Protocol TCP -LocalPort 5900 -RemoteAddress 100.64.0.0/10 -Action Allow
```

**RDP** is built into Windows and the Mac client is free, so it needs no
server installed. Scope it the same way:

```powershell
Set-NetFirewallRule -Name RemoteDesktop-UserMode-In-TCP -RemoteAddress 100.64.0.0/10
```

The conflict to know before picking: an RDP session disconnects the physical
console session. That logs out the interactive desktop the task's LogonTrigger
depends on, so a box built around autologon should use VNC and not also be
reached over RDP.

Administrators configure the Runner's label and tags, user and repository
allowlists for command delegation, command access, and maintenance state.
Revoking a Runner invalidates its credential and closes its control connection
immediately. Runner-backed full sessions, managed workspace roots, terminals,
and Portals are not currently available.

Interactive sessions can use the `opensession-runners` MCP tools for audited
command delegation subject to those allowlists. Delegated commands are time-
and output-bounded, but they are not filesystem-sandboxed or confined to a
managed root. They can access anything available to the Runner's service user.
Automation sessions never receive Runner tools. Only attach machines the
workspace intends to trust.

## Operator-managed migration

The target must already contain a compatible Open Session Runner client.
`runnerCommand` defaults to `/usr/local/bin/opensession`; SSH bootstrap does not
install or upgrade it, and the Kubernetes manifest must provide it in the
selected container.

Workspace administrators can also migrate a named SSH machine or a named
Kubernetes Runner workload from Settings. The SSH and Kubernetes choices are
always shown to workspace administrators, but targets are available only when
the operator has configured `integrations.runnersBootstrap` in the protected
instance configuration. Otherwise the selected path reports that no targets
are configured. SSH entries require both a pinned `SHA256:` host fingerprint
and a dedicated known-hosts file. Kubernetes entries name one context,
namespace, deployment, and optional container, plus a reviewed manifest path
for that dedicated deployment and its persistent workspace volume. Bootstrap
applies the manifest with a fixed field manager, waits for rollout, and returns
bounded pod scheduling diagnostics if it cannot become ready.

The migration performs only the reviewed `opensession runner connect` action,
then the component installs its reconnecting service and dials out normally.
Agents never receive SSH, kubectl, private-key, kubeconfig, or pairing-token
access. Kubernetes credentials must be RBAC-scoped to the configured Runner
namespace and workload.
