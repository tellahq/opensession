import { useState } from "react";
import type { ManagedMachine } from "../../lib/api/runners";
import {
  runManagedMachineAction,
  useManagedMachines,
} from "../../lib/managed-machines-store";
import {
  markTileClass,
  markTileGradient,
  markTileInk,
  markTileShadow,
} from "../../lib/mark-tile";
import { Button } from "../../ui/button";
import { cn } from "../../ui/cn";
import { SettingCard, SettingsGroupLabel } from "../../ui/settings";
import { toast } from "../../ui/toast";
import { IconBolt } from "../icons";

const stateStyle: Record<ManagedMachine["state"], string> = {
  on: "bg-green-soft text-green",
  starting: "bg-yellow-soft text-yellow",
  stopping: "bg-yellow-soft text-yellow",
  off: "bg-hover text-dim",
  unknown: "bg-red-soft text-red",
};

function ago(at: string, now: number): string {
  const minutes = Math.round((now - Date.parse(at)) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} h ago` : `${Math.round(hours / 24)} d ago`;
}

function until(at: string, now: number): string {
  const minutes = Math.max(0, Math.round((Date.parse(at) - now) / 60_000));
  return minutes < 60 ? `${minutes} min` : `${Math.round(minutes / 6) / 10} h`;
}

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

/** Plain-language idle line: when it stops, or why it will not. */
function idleLine(machine: ManagedMachine, now: number): string | undefined {
  const idle = machine.idle;
  if (!idle)
    return machine.state === "on" ? "Never stops on its own" : undefined;
  if (machine.state !== "on") return `Stops after ${idle.minutes} idle min`;
  if (idle.kind === "idle")
    return `Idle since ${ago(idle.since, now)}, stops in ${until(idle.stopAt, now)}`;
  if (idle.kind === "held") {
    // The reservation has its own line below.
    const reasons = idle.reasons.filter((r) => !r.startsWith("Reserved"));
    return reasons.length
      ? `Kept on: ${reasons.join("; ")}`
      : "Kept on while reserved";
  }
  return `Not idle: ${idle.reason}`;
}

/** Managed machines: turned on and off through operator commands. The
 * section only appears when the server's config defines at least one. */
export function ManagedMachinesSection() {
  const { machines, at: now } = useManagedMachines();
  const [busyId, setBusyId] = useState<string | null>(null);

  const act = async (machine: ManagedMachine, action: "start" | "stop") => {
    setBusyId(machine.id);
    await runManagedMachineAction(machine.id, action)
      .catch((error) =>
        toast(
          error instanceof Error ? error.message : `Could not ${action} it`,
          { variant: "error" },
        ),
      )
      .finally(() => setBusyId(null));
  };

  if (!machines.length) return null;
  return (
    <>
      <SettingsGroupLabel>Managed machines</SettingsGroupLabel>
      <div className="mb-6 grid gap-3">
        {machines.map((machine) => (
          <MachineRow
            key={machine.id}
            machine={machine}
            now={now}
            busy={busyId === machine.id || Boolean(machine.acting)}
            onAct={act}
          />
        ))}
      </div>
    </>
  );
}

function MachineIcon() {
  const size = 40;
  return (
    <span
      className={markTileClass(size)}
      style={{
        width: size,
        height: size,
        backgroundImage: markTileGradient("indigo"),
        color: "#fff",
        boxShadow: markTileShadow(markTileInk("indigo")),
      }}
    >
      <IconBolt size={22} />
    </span>
  );
}

function MachineRow({
  machine,
  now,
  busy,
  onAct,
}: {
  machine: ManagedMachine;
  now: number;
  busy: boolean;
  onAct: (machine: ManagedMachine, action: "start" | "stop") => void;
}) {
  const running = machine.state === "on" || machine.state === "starting";
  const action = running ? "stop" : "start";
  const activity = [
    machine.cpu !== undefined ? `CPU ${percent(machine.cpu)}` : undefined,
    machine.gpu !== undefined ? `GPU ${percent(machine.gpu)}` : undefined,
  ].filter(Boolean);
  const idle = idleLine(machine, now);
  const failed = machine.lastAction?.ok === false;
  return (
    <SettingCard>
      <div className="grid grid-cols-[minmax(0,1fr)_5.75rem] gap-x-4 px-5 py-4 desktop:grid-cols-[minmax(0,1fr)_13rem]">
        <div className="col-start-1 row-start-1 flex min-w-0 items-start gap-3">
          <MachineIcon />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-item-title font-semibold text-fg">
                {machine.label}
              </span>
              <span
                className={cn(
                  "rounded-full px-2 py-0.5 text-meta font-medium capitalize",
                  machine.state === "unknown" && !machine.lastPollError
                    ? stateStyle.off
                    : stateStyle[machine.state],
                )}
              >
                {machine.acting === "start"
                  ? "starting"
                  : machine.acting === "stop"
                    ? "stopping"
                    : machine.state}
              </span>
            </div>
            <div className="mt-1 text-supporting leading-relaxed text-dim">
              {[
                machine.detail ?? machine.description,
                activity.join(" · ") || undefined,
                machine.lastPollAt
                  ? `Checked ${ago(machine.lastPollAt, now)}`
                  : "Not checked yet",
              ]
                .filter(Boolean)
                .join(" · ")}
            </div>
            <div className="mt-2 grid gap-0.5 text-meta text-faint">
              {idle && <div>{idle}</div>}
              {machine.reservation && (
                <div>
                  Reserved
                  {machine.reservation.reservedBy
                    ? ` by ${machine.reservation.reservedBy}`
                    : ""}{" "}
                  for {until(machine.reservation.expiresAt, now)}:{" "}
                  {machine.reservation.reason}
                </div>
              )}
              {machine.lastAction && !failed && (
                <div>
                  Last {machine.lastAction.kind}{" "}
                  {ago(machine.lastAction.at, now)}
                  {machine.lastAction.via === "idle"
                    ? " (idle)"
                    : machine.lastAction.by
                      ? ` by ${machine.lastAction.by}`
                      : ""}
                </div>
              )}
            </div>
            {machine.attention && (
              <div
                role={failed ? "alert" : undefined}
                className="mt-2 rounded-md bg-red-soft px-3 py-2 text-supporting text-red"
              >
                {machine.attention}
              </div>
            )}
          </div>
        </div>
        <div className="col-start-2 row-start-1 flex justify-end self-start">
          {machine.allowed && (
            <Button
              size="sm"
              variant={action === "start" ? "primary" : "default"}
              disabled={busy}
              onClick={() => onAct(machine, action)}
            >
              {busy
                ? machine.acting === "stop" || action === "stop"
                  ? "Stopping"
                  : "Starting"
                : action === "start"
                  ? "Start"
                  : "Stop"}
            </Button>
          )}
        </div>
      </div>
    </SettingCard>
  );
}
