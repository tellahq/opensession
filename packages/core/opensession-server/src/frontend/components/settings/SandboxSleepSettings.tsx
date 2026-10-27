import { useEffect, useState } from "react";
import {
  fetchSandboxLifecycle,
  saveWorkspaceResumeScript,
  type SandboxLifecycleSettings,
} from "../../lib/api/sandboxes";
import { sandboxProviderLabel } from "../../lib/ready-sandbox-providers";
import { Button } from "../../ui/button";
import {
  SettingCard,
  SettingsGroupLabel,
  SettingsHint,
} from "../../ui/settings";
import { SandboxScriptDialog } from "./SandboxScriptDialog";
import { SettingRow } from "./shared";

/** Workspace → Sandboxes: when Sandboxes sleep, the workspace resume
 *  script, and which providers run the Sandbox agent. */
export function SandboxSleepSettings() {
  const [settings, setSettings] = useState<SandboxLifecycleSettings | null>(
    null,
  );
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    fetchSandboxLifecycle()
      .then(setSettings)
      .catch(() => {});
  }, []);
  if (!settings) return null;
  const { agentMinutes, humanMinutes } = settings.idle;
  const agentProviders = settings.agentProviders.map(sandboxProviderLabel);

  return (
    <>
      <SettingsGroupLabel>Sleep and wake</SettingsGroupLabel>
      <SettingCard>
        <SettingRow
          title="Idle sleep"
          desc={`A Sandbox sleeps once the agent has done nothing in it for ${agentMinutes} min and nobody has used it for ${humanMinutes} min. Prompts, Portal visits, Terminal and Desktop count as use.`}
          control={
            <span className="text-supporting text-faint">
              {agentMinutes} / {humanMinutes} min
            </span>
          }
        />
        <SettingRow
          title="Resume script"
          desc={
            settings.workspaceResumeScript
              ? "Runs in every Linux Sandbox before .agents/resume, when it starts and each time it wakes."
              : "Optional. A fix every Sandbox needs that repositories cannot deliver."
          }
          control={
            <Button size="sm" onClick={() => setEditing(true)}>
              {settings.workspaceResumeScript ? "Edit" : "Add"}
            </Button>
          }
        />
        <SettingRow
          title="Sandbox agent"
          desc="Sandboxes run a small agent that connects out to this server, so commands skip the provider's API. The provider's own connection takes over whenever the agent is not connected."
          control={
            <span className="text-supporting text-faint">
              {agentProviders.length ? agentProviders.join(", ") : "Off"}
            </span>
          }
        />
      </SettingCard>
      <SettingsHint>
        Asleep, a Sandbox keeps its files but not its running processes, so dev
        servers, Terminal shells and Desktop apps start again when it wakes. A
        wake waits up to 10 seconds for .agents/resume, then lets it finish in
        the background.
      </SettingsHint>
      <SandboxScriptDialog
        open={editing}
        onOpenChange={setEditing}
        title="Workspace resume script"
        description="Runs with Bash as the Sandbox user right before .agents/resume, in every Linux Sandbox of every project. Keep it fast and safe to run again."
        value={settings.workspaceResumeScript}
        placeholder={"#!/usr/bin/env bash\nset -euo pipefail"}
        onSave={async (script) => {
          setSettings(await saveWorkspaceResumeScript(script));
        }}
      />
    </>
  );
}
