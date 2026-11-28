import { useEffect, useState } from "react";
import {
  fetchSandboxLifecycle,
  saveSandboxIdlePolicy,
  saveWorkspaceResumeScript,
  type SandboxLifecycleSettings,
} from "../../lib/api/sandboxes";
import { errorMessage } from "../../lib/error-message";
import { sandboxProviderLabel } from "../../lib/ready-sandbox-providers";
import { Button } from "../../ui/button";
import {
  SettingCard,
  SettingsGroupLabel,
  SettingsHint,
} from "../../ui/settings";
import { toast } from "../../ui/toast";
import { SandboxScriptDialog } from "./SandboxScriptDialog";
import { Select, SettingRow } from "./shared";

const AGENT_IDLE_PRESETS = [2, 5, 10, 15, 30, 60];
const HUMAN_IDLE_PRESETS = [5, 10, 20, 30, 60, 120];

function idleMinuteOptions(presets: readonly number[], current: number) {
  const values = presets.includes(current)
    ? [...presets]
    : [...presets, current].sort((a, b) => a - b);
  return values.map((minutes) => ({
    value: String(minutes),
    label: `${minutes} min`,
  }));
}

/** Workspace → Sandboxes: when Sandboxes sleep, the workspace resume
 *  script, and which providers run the Sandbox agent. */
export function SandboxSleepSettings() {
  const [settings, setSettings] = useState<SandboxLifecycleSettings | null>(
    null,
  );
  const [editing, setEditing] = useState(false);
  const [savingIdle, setSavingIdle] = useState(false);
  useEffect(() => {
    fetchSandboxLifecycle()
      .then(setSettings)
      .catch(() => {});
  }, []);
  if (!settings) return null;
  const { agentMinutes, humanMinutes } = settings.idle;
  const agentProviders = settings.agentProviders.map(sandboxProviderLabel);

  function saveIdle(next: { agentMinutes: number; humanMinutes: number }) {
    setSavingIdle(true);
    void saveSandboxIdlePolicy(next)
      .then(setSettings)
      .catch((error) => {
        toast(
          errorMessage(error, "Failed to save Sandbox idle sleep settings"),
          { variant: "error" },
        );
      })
      .finally(() => {
        setSavingIdle(false);
      });
  }

  return (
    <>
      <SettingsGroupLabel>Sleep and wake</SettingsGroupLabel>
      <SettingCard>
        <SettingRow
          title="Agent idle sleep"
          desc="After the agent finishes."
          control={
            <div
              className={
                savingIdle ? "pointer-events-none opacity-60" : undefined
              }
            >
              <Select
                label="Agent idle timeout"
                value={String(agentMinutes)}
                options={idleMinuteOptions(AGENT_IDLE_PRESETS, agentMinutes)}
                onChange={(value) => {
                  const parsed = Number(value);
                  if (Number.isFinite(parsed)) {
                    saveIdle({ agentMinutes: parsed, humanMinutes });
                  }
                }}
              />
            </div>
          }
        />
        <SettingRow
          title="Human idle sleep"
          desc="After your last prompt, Portal, Terminal or Desktop use."
          control={
            <div
              className={
                savingIdle ? "pointer-events-none opacity-60" : undefined
              }
            >
              <Select
                label="Human idle timeout"
                value={String(humanMinutes)}
                options={idleMinuteOptions(HUMAN_IDLE_PRESETS, humanMinutes)}
                onChange={(value) => {
                  const parsed = Number(value);
                  if (Number.isFinite(parsed)) {
                    saveIdle({ agentMinutes, humanMinutes: parsed });
                  }
                }}
              />
            </div>
          }
        />
        <SettingRow
          title="Resume script"
          desc={
            settings.workspaceResumeScript
              ? "Runs in every Linux Sandbox on start and wake."
              : "Optional. Runs in every Linux Sandbox on start and wake."
          }
          control={
            <Button size="sm" onClick={() => setEditing(true)}>
              {settings.workspaceResumeScript ? "Edit" : "Add"}
            </Button>
          }
        />
        <SettingRow
          title="Sandbox agent"
          desc="Runs commands without the provider's API."
          control={
            <span className="text-supporting text-faint">
              {agentProviders.length ? agentProviders.join(", ") : "Off"}
            </span>
          }
        />
      </SettingCard>
      <SettingsHint>
        Asleep, a Sandbox keeps its files but stops its processes.
      </SettingsHint>
      <SandboxScriptDialog
        open={editing}
        onOpenChange={setEditing}
        title="Workspace resume script"
        description="Runs before .agents/resume in every Linux Sandbox. Keep it fast."
        value={settings.workspaceResumeScript}
        placeholder={"#!/usr/bin/env bash\nset -euo pipefail"}
        onSave={async (script) => {
          setSettings(await saveWorkspaceResumeScript(script));
        }}
      />
    </>
  );
}
