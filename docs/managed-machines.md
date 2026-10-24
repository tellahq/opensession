# Managed machines

A managed machine is a computer Open Session can turn on, turn off, watch and
run commands on, with no Open Session software installed on it. An operator
describes it with a few commands that the Open Session server runs:

| Command  | Required | What it does                                                         |
| -------- | -------- | -------------------------------------------------------------------- |
| `start`  | yes      | Turns the machine on. Exit 0 means the request was accepted.         |
| `stop`   | yes      | Turns it off. Exit 0 means the request was accepted.                 |
| `status` | yes      | Polled every `pollSeconds`. Prints one JSON object (below).          |
| `exec`   | no       | A prefix; an agent's command is appended to it as one last argument. |

Anything that can be driven from a command line works: a CI workflow
dispatch, `aws ec2 start-instances`, `kubectl scale`, `gcloud compute
instances start`, a `curl` to a webhook, `ssh`, `docker exec`.

Managed machines appear in **Settings → Runners** above the Runner inventory,
with their state, when they were last checked, CPU/GPU, when they will stop,
and a Start or Stop button. Agents use the same `opensession-runners` tools as
for Runners: `list_runners`, `runner_status`, `start_runner` (starts and waits
until the machine is on), `stop_runner`, `reserve_runner`,
`release_runner_reservation` and, when `exec` is configured, `run_on_runner`.

A managed machine is not a Runner: it has no Runner channel, workspace
management, Portals or Runner-hosted sessions. A machine that also runs the
Runner client still shows up as a separate Runner today.

## Configuration

Managed machines live in the protected instance configuration,
`~/.opensession/config.json`. Workspace settings and agents cannot add or
change them.

```json
{
  "managedMachines": [
    {
      "id": "gpu-ana",
      "label": "Ana's GPU box",
      "description": "1x L4, 32 GB",
      "start": ["/opt/opensession/machines/power.sh", "on", "ana"],
      "stop": ["/opt/opensession/machines/power.sh", "off", "ana"],
      "status": ["/opt/opensession/machines/status.sh", "ana"],
      "exec": [
        "kubectl",
        "--context",
        "acme-dev",
        "exec",
        "-i",
        "-n",
        "devboxes",
        "ana-devbox-0",
        "--",
        "bash",
        "-lc"
      ],
      "env": { "KUBECONFIG": "/home/opensession/.kube/devboxes" },
      "pollSeconds": 60,
      "commandTimeoutSeconds": 120,
      "idleStopMinutes": 60,
      "idleCpuBelow": 0.1,
      "idleGpuBelow": 0.05,
      "startTimeoutMinutes": 20,
      "allowedUsers": ["ana"]
    }
  ]
}
```

- Every command is an **argv array**, run without a shell. A shell string is
  rejected and the machine is left out, with a warning in the server log.
  Wrap shell logic in a script and call the script.
- Commands get `PATH` and `HOME` from the server, `OPENSESSION_MACHINE_ID`,
  and the `env` you set. Nothing else from the server's environment is
  passed on.
- `pollSeconds` (default 60, minimum 15) and `commandTimeoutSeconds`
  (default 120) bound the status poll and every start, stop and status call.
- `idleStopMinutes` turns on idle stops (see below). It needs `idleCpuBelow`,
  `idleGpuBelow` or both, so a machine is never stopped on time alone.
- `allowedUsers` limits who can start, stop, reserve and run commands. Empty
  means every signed-in teammate. Only interactive sessions get the
  `opensession-runners` tools; automations never do.

## The status contract

`status` prints one JSON object on its last line of stdout and exits 0:

```json
{ "state": "on", "cpu": 0.42, "gpu": 0.0, "detail": "1x L4" }
```

- `state` is one of `off`, `starting`, `on`, `stopping`.
- `cpu` and `gpu` are utilization fractions (0 to 1; `cpu` may exceed 1 when
  you report cores). Leave a value out when you could not measure it. Never
  print 0 for "unknown": a missing value keeps the machine on, a 0 lets it
  stop.
- `detail` is optional free text shown in the UI.

A non-zero exit, a timeout, or output that is not such an object counts as a
failed check.

### Example: a Kubernetes pod

This script reports a single-pod StatefulSet. It uses only `kubectl`, run with
whatever credentials the Open Session host already has.

```bash
#!/usr/bin/env bash
# status.sh <owner>: report <owner>-devbox-0 as a managed machine.
set -euo pipefail
ctx=acme-dev ns=devboxes pod="$1-devbox-0" container=devbox
k() { kubectl --context "$ctx" -n "$ns" "$@"; }

if ! out=$(k get pod "$pod" -o jsonpath='{.metadata.deletionTimestamp}|{.status.phase}|{.status.containerStatuses[0].ready}' 2>&1); then
  # NotFound means off. Any other error must fail the check, not read as off.
  grep -q NotFound <<<"$out" && { echo '{"state":"off"}'; exit 0; }
  echo "$out" >&2; exit 1
fi
IFS='|' read -r deleting phase ready <<<"$out"
[ -n "$deleting" ] && { echo '{"state":"stopping"}'; exit 0; }
[ "$phase" = Running ] && [ "$ready" = true ] || { echo '{"state":"starting"}'; exit 0; }

# CPU in cores from metrics-server, against the pod's CPU request.
cores=$(k top pod "$pod" --containers --no-headers | awk -v c="$container" '$2==c {sub("m","",$3); print $3/1000}')
request=$(k get pod "$pod" -o jsonpath="{.spec.containers[?(@.name=='$container')].resources.requests.cpu}")
# Peak utilization across the pod's GPUs.
gpu=$(k exec "$pod" -c "$container" -- nvidia-smi --query-gpu=utilization.gpu --format=csv,noheader,nounits | sort -n | tail -1)

jq -cn --arg cores "$cores" --arg request "${request:-1}" --arg gpu "$gpu" '
  def n: tonumber? // null;
  def req: if ($request | endswith("m")) then ($request[:-1] | n) / 1000 else ($request | n) end;
  {state: "on"}
  + (if ($cores | n) != null and (req // 0) > 0 then {cpu: (($cores | n) / req)} else {} end)
  + (if ($gpu | n) != null then {gpu: (($gpu | n) / 100)} else {} end)'
```

When `kubectl top` or `nvidia-smi` fails, the script leaves that value out,
and the machine stays on. Note that `kubectl top` reports a short-window
average: a job that is busy only between polls can look idle at every poll.
If yours behave like that, report a peak over the poll interval instead (for
example from a metrics store, or `max_over_time` in Prometheus).

## Running commands: `exec`

`exec` is an argv prefix. The agent's command is appended as **one** extra
argument, never spliced into a string, so the prefix decides how it is
interpreted. End it with something that runs a single argument as a script:

| Target         | `exec`                                                                            |
| -------------- | --------------------------------------------------------------------------------- |
| Kubernetes pod | `["kubectl", "exec", "-i", "-n", "ns", "pod", "-c", "main", "--", "bash", "-lc"]` |
| SSH host       | `["ssh", "-o", "BatchMode=yes", "build@host", "--"]`                              |
| Docker         | `["docker", "exec", "-i", "box", "bash", "-lc"]`                                  |

`ssh` passes its remaining arguments to the remote login shell, so the
command is interpreted there. To start every command in a directory or with
a variable set, put a small wrapper on the machine and end the prefix with
it, for example `["ssh", "host", "--", "/usr/local/bin/in-work-dir"]`, or use
`bash -lc` with a login profile that sets them. There is no template
language.

`run_on_runner` on a managed machine behaves like it does on a Runner: the
same default and maximum timeout (10 and 60 minutes), output capped at 200 KB
per stream, the exit code, and a cancelled tool call kills the local command
process. It also accepts `stdin`; keep `-i` on `kubectl exec` and `docker
exec` so stdin reaches the command. It refuses to run unless the last status
check succeeded, said `on`, and is recent.

The access a command gets is whatever the Open Session host's own
credentials for that prefix grant: its kubeconfig, SSH key or Docker socket.
Scope them to the machines you configure (for Kubernetes, a Role in the
machines' namespace allowing `get` on `pods`, `create` on `pods/exec`, and
`get` on `pods.metrics.k8s.io` for `kubectl top`, nothing cluster-wide).

## Idle stops

With `idleStopMinutes` set, Open Session stops a machine only when, for the
whole period:

- every status check succeeded, reported `state: "on"`, reported every metric
  the policy uses, and those metrics were below `idleCpuBelow` and
  `idleGpuBelow`;
- checks kept arriving, with no gap longer than three poll intervals;
- no command ran through `exec`, and no start or stop was running;
- nobody held a reservation.

Any failed, missing, unparseable or late check, any activity, any `exec` and
any reservation restarts the period. A server restart also restarts it. The
reason the machine is not idle is shown under it in Settings and in
`runner_status`.

When the idle stop fails, the error is shown on the machine and the stop is
retried after another full idle period (at least ten minutes later). A
machine whose checks keep failing, whose stop failed, or that is still
running ten minutes after a successful stop is flagged in red: it may be
costing money and Open Session will not stop it on its own.

Reservations (`reserve_runner`, or the API) are kept across server restarts.
People running long jobs outside Open Session are covered by the CPU and GPU
thresholds; for a quiet job (waiting on a remote service, say), reserve the
machine.

## API

All routes need a signed-in user.

- `GET /api/managed-machines` lists machines with their current view.
- `POST /api/managed-machines/<id>/start`, `/stop` (`{"force": true}` stops
  even while in use), `/reserve` (`{"reason", "durationMinutes"}`) and
  `/release`.
