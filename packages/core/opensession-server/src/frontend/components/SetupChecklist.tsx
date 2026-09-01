import React, { useState } from "react";
import { Button } from "../ui/button";
import {
  SettingCard,
  SettingRow,
  SettingRowDescription,
  SettingRowText,
  SettingRowTitle,
} from "../ui/settings";
import { toast } from "../ui/toast";
import { errorMessage } from "../lib/error-message";
import {
  StateChip,
  integrationState,
  repoLifecycleState,
  setupRequest,
  type ChipTone,
  type SetupEngine,
  type SetupStatus,
  type SetupStepId,
} from "./setup-shared";

// The state of the instance in one card: what runs, what's missing, and — on
// the Setup wizard's last step — a way back to the step that fixes it.

/** One row of the checklist: title, one-liner, state chip. */
function ChecklistRow({
  title,
  description,
  tone,
  label,
  action,
}: {
  title: React.ReactNode;
  description: React.ReactNode;
  tone: ChipTone;
  label: string;
  /** Optional inline fix — only for problems this page can actually solve. */
  action?: React.ReactNode;
}) {
  return (
    <SettingRow>
      <SettingRowText>
        <SettingRowTitle>{title}</SettingRowTitle>
        <SettingRowDescription>{description}</SettingRowDescription>
      </SettingRowText>
      {action}
      <StateChip tone={tone} label={label} />
    </SettingRow>
  );
}

/** Checklist row for model capacity. Without this, no session runs a turn. */
export function EngineRow({
  engine,
  onChanged,
}: {
  engine: SetupEngine;
  onChanged: () => void | Promise<void>;
}) {
  const [enabling, setEnabling] = useState(false);

  async function enable() {
    setEnabling(true);
    await (async () => {
      await setupRequest("/api/settings/pi-engine", {
        method: "PUT",
        json: { enabled: true },
      });
      await onChanged();
      toast("Engine enabled");
    })()
      .catch(async (error) => {
        toast(errorMessage(error, "Couldn't enable the engine"));
      })
      .finally(async () => {
        setEnabling(false);
      });
  }

  const pool =
    engine.claudeAccounts + engine.codexAccounts === 0
      ? "no accounts"
      : [
          engine.claudeAccounts && `${engine.claudeAccounts} Claude`,
          engine.codexAccounts && `${engine.codexAccounts} ChatGPT`,
        ]
          .filter(Boolean)
          .join(", ");

  return (
    <ChecklistRow
      title="Providers"
      description={
        engine.ready
          ? `Ready to run turns on ${engine.defaultModel} (${pool}).`
          : [engine.blocker, engine.fix].filter(Boolean).join(" ") ||
            "The engine is not ready."
      }
      tone={engine.ready ? "on" : "warn"}
      label={engine.ready ? "Ready" : "Can't run turns"}
      action={
        !engine.ready && engine.fixableInApp ? (
          <Button size="sm" onClick={enable} disabled={enabling}>
            {enabling ? "Enabling…" : "Enable"}
          </Button>
        ) : undefined
      }
    />
  );
}

/** Every part of the instance that can be half-configured, as one card of
 *  rows: what it is, what state it's in, and where to go and fix it. */
export function SetupChecklist({
  status,
  onChanged,
  onJump,
}: {
  status: SetupStatus;
  onChanged: () => void | Promise<void>;
  /** Offered on rows that aren't done yet, when a wizard is hosting this. */
  onJump?: (step: SetupStepId) => void;
}) {
  const fix = (step: SetupStepId, tone: ChipTone) =>
    onJump && tone === "warn" ? (
      <Button size="sm" variant="ghost" onClick={() => onJump(step)}>
        Set up
      </Button>
    ) : undefined;

  const github = status.integrations.find(
    (integration) => integration.id === "github",
  );
  const githubState = github
    ? integrationState(github)
    : { tone: "warn" as const, label: "Missing" };
  const githubTone: ChipTone = githubState.tone === "on" ? "on" : "warn";
  const reposTone: ChipTone = status.repos.length > 0 ? "on" : "warn";
  const membersTone: ChipTone = status.team.count > 0 ? "on" : "warn";
  const memberNames = status.team.names.slice(0, 3).join(", ");
  const remainingMembers = status.team.count - 3;
  const bootable = status.repos.filter(
    (r) => repoLifecycleState(r).tone === "on",
  );
  const missing = status.repos.filter(
    (r) => repoLifecycleState(r).tone !== "on",
  );
  const namedMissing = missing
    .slice(0, 3)
    .map((r) => r.label)
    .join(", ");
  const restMissing = missing.length - 3;

  return (
    <SettingCard>
      <ChecklistRow
        title="GitHub"
        description={
          githubState.tone === "on"
            ? "Sessions can access repositories and open pull requests with the workspace account."
            : "Configure the GitHub App used for repositories and pull requests."
        }
        tone={githubTone}
        label={githubState.label}
        action={fix("github", githubTone)}
      />
      <ChecklistRow
        title="Organisation"
        description="The organisation profile and instance identity are configured here."
        tone="on"
        label="Configured"
      />
      <EngineRow engine={status.engine} onChanged={onChanged} />
      <ChecklistRow
        title="Repositories"
        description={
          status.repos.length > 0
            ? status.repos.map((r) => r.label).join(", ")
            : "Register the repos sessions work in, under Workspace → Repositories."
        }
        tone={reposTone}
        label={
          status.repos.length > 0
            ? `${status.repos.length} registered`
            : "None registered"
        }
        action={fix("repos", reposTone)}
      />
      {status.repos.length > 0 && (
        <ChecklistRow
          title="Local dev setup"
          description={
            missing.length === 0
              ? "Every repo commits lifecycle scripts, so sessions provision themselves, previews boot, and agents can check their own UI changes in a browser."
              : `No boot script in ${namedMissing}${restMissing > 0 ? ` and ${restMissing} more` : ""}. The Preview button stays disabled there. Add .agents/start.sh to the repo (docs/repo-lifecycle.md).`
          }
          tone={
            bootable.length === status.repos.length
              ? "on"
              : bootable.length > 0
                ? "warn"
                : "off"
          }
          label={`${bootable.length}/${status.repos.length} bootable`}
        />
      )}
      <ChecklistRow
        title="Members"
        description={
          status.team.count > 0
            ? `${memberNames}${remainingMembers > 0 ? ` and ${remainingMembers} more` : ""}`
            : "Add everyone who uses this instance so sessions and commits attribute to real people."
        }
        tone={membersTone}
        label={
          status.team.count === 1 ? "1 member" : `${status.team.count} members`
        }
        action={fix("members", membersTone)}
      />
    </SettingCard>
  );
}
