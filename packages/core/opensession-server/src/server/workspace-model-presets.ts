import {
  DIAL_ORACLE_AGENTS,
  DIAL_PRESETS,
  resolveModel,
  toPiModel,
} from "./models";
import { getWorkspace, workspaceModelSettings } from "./workspaces";

export interface ResolvedWorkspaceModelPreset {
  /** The picker id retained on the session, so the UI and history keep the preset name. */
  id: string;
  label: string;
  model: string;
  effort?: string;
  note: string;
  /** A built-in preset with the same complete configuration can use its real oracle/worker wiring. */
  enginePresetId?: string;
}

/** A detached sandbox cannot read the server's workspace store. Convert a
 * resolved workspace preset into a self-contained runtime selection before
 * the RunHostSpec crosses that boundary, while retaining the picker id for
 * attribution and fallback bookkeeping. */
export function portableWorkspacePresetRun(
  preset: ResolvedWorkspaceModelPreset,
): {
  model: string;
  selectedModel: string;
  effort?: string;
} {
  const enginePresetId = preset.enginePresetId?.trim();
  return {
    model: enginePresetId
      ? enginePresetId.startsWith("pi/")
        ? enginePresetId
        : `pi/${enginePresetId}`
      : preset.model,
    selectedModel: preset.id,
    ...(preset.effort ? { effort: preset.effort } : {}),
  };
}

/** Return the Dial preset with the exact same lead and oracle configuration. */
function matchingDialPreset(preset: {
  lead: { model: string; effort?: string };
  supporting?: Array<{ model: string; effort?: string }>;
}): string | undefined {
  return DIAL_PRESETS.find((candidate) => {
    const oracle = DIAL_ORACLE_AGENTS[candidate.oracleAgent];
    return (
      toPiModel(preset.lead.model) === toPiModel(candidate.model) &&
      preset.lead.effort === candidate.effort &&
      preset.supporting?.length === 1 &&
      toPiModel(preset.supporting[0].model) === toPiModel(oracle.model) &&
      preset.supporting[0].effort === oracle.variant
    );
  })?.id;
}

/** Resolve a picker preset into the model and stable instructions it represents. */
export function resolveWorkspaceModelPreset(
  requested: unknown,
  workspaceId?: unknown,
): ResolvedWorkspaceModelPreset | undefined {
  if (typeof requested !== "string") return undefined;
  const pi = requested.startsWith("pi/");
  const id = (pi ? requested.slice(3) : requested).trim();
  const match = id.match(/^workspace-preset\/([^/]+)\/([A-Za-z0-9_-]{1,64})$/);
  if (!match || (typeof workspaceId === "string" && match[1] !== workspaceId))
    return undefined;
  // Resolve through workspaceModelSettings so the default presets stay
  // selectable in workspaces that never saved their own copy.
  const workspace = getWorkspace(match[1]);
  const preset = workspace
    ? workspaceModelSettings(workspace).presets?.find(
        (item) => item.id === match[2],
      )
    : undefined;
  if (!preset?.lead?.model?.trim()) return undefined;
  const lead = preset.lead.model.trim();
  const routed =
    pi && !lead.startsWith("pi/")
      ? lead.startsWith("pi/")
        ? `pi/${lead.slice("pi/".length)}`
        : `pi/${lead}`
      : lead;
  const model = resolveModel(routed)?.id;
  if (!model) return undefined;
  // The default Opus + Fable combination is also a real Dial preset. Keep
  // the editable workspace id on the session, but activate its actual oracle
  // wiring when the full configuration still matches — on every engine: the
  // pi runner, the direct SDKs, and pi (its dial oracle tool) all
  // follow enginePresetId.
  const enginePresetId = matchingDialPreset(preset);
  const supporting = (preset.supporting || [])
    .filter((member) => member.model?.trim())
    .map((member) => {
      const configuredModel = member.model.trim();
      const supportingModel = pi
        ? toPiModel(configuredModel) || configuredModel
        : configuredModel;
      return `- ${member.role?.trim() || "Supporting worker"}: ${supportingModel}${member.effort ? ` at ${member.effort} effort` : ""}`;
    })
    .join("\n");
  return {
    id: `${pi ? "pi/" : ""}${id}`,
    label: preset.label.trim(),
    model,
    effort: preset.lead.effort,
    ...(enginePresetId ? { enginePresetId } : {}),
    note: [
      `## Workspace model preset · ${preset.label.trim()}`,
      preset.instructions?.trim() ||
        "Lead this task and use the supporting models when a focused second perspective or implementation worker helps.",
      supporting
        ? `Supporting models for this preset:\n${supporting}\nUse opensession-sessions to create focused worker sessions with these models. Give each worker a self-contained brief, then integrate and verify its result yourself.`
        : "",
    ]
      .filter(Boolean)
      .join("\n\n"),
  };
}
