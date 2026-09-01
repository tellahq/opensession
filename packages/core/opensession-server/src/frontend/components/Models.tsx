import { BASE_PATH } from "../lib/base";
import { errorMessage } from "../lib/error-message";
import { useEffect, useState } from "react";
import { shortModelLabel, splitModelOptions } from "./ModelEffortSelect";
import { ModelMark } from "./ModelMark";
import { Select } from "../ui/select";
import {
  SettingCard,
  SettingRow,
  SettingRowControl,
  SettingRowDescription,
  SettingRowText,
  SettingRowTitle,
  SettingsGroupLabel,
  SettingsHint,
} from "../ui/settings";
import { Switch } from "../ui/switch";

// The default-model half of Settings → Providers: which model a run starts on
// and which engine carries it. The subscription accounts those runs draw from,
// and how full they are, sit further down the same page
// (settings/ModelAccounts.tsx). Everything here follows the Settings idiom
// (setting-card row lists), not the Connections card grid.

interface ModelInfo {
  id: string;
  provider: "claude" | "codex" | "pi";
  label: string;
  aliases: string[];
  efforts: string[];
  composition?: string[];
}

/** The model half of Settings → Providers: what new runs start on. Renders as
 * groups, not a page: ProvidersPanel owns the header. */
export function ModelDefaultsSection({
  onChanged,
}: {
  compact?: boolean;
  onChanged?: () => void | Promise<void>;
} = {}) {
  return (
    <>
      <SettingsGroupLabel className="mt-0">Default model</SettingsGroupLabel>
      <SettingCard>
        <DefaultModelRow onChanged={onChanged} />
        <AutoFallbackRow />
      </SettingCard>
      <SettingsHint>
        Applies to new runs unless the session has its own model.
      </SettingsHint>
    </>
  );
}

// ── Default model ──────────────────────────────────────────────────────────

function DefaultModelRow({
  onChanged,
}: {
  onChanged?: () => void | Promise<void>;
}) {
  const [models, setModels] = useState<ModelInfo[] | null>(null);
  const [current, setCurrent] = useState<string>("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(`${BASE_PATH}/api/models`)
      .then((response) => {
        if (!response.ok)
          throw new Error(`Failed to load models (${response.status})`);
        return response.json();
      })
      .then((body) => {
        setModels(body.models);
        setCurrent(body.default);
      })
      .catch((error: unknown) => {
        setError(errorMessage(error, "Failed to load models"));
      });
  }, []);

  async function handleChange(id: string) {
    if (id === current) return;
    setSaving(true);
    setError(null);
    await (async () => {
      const res = await fetch(`${BASE_PATH}/api/models/default`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: id }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `Failed: ${res.status}`);
      setCurrent(body.default);
      await onChanged?.();
    })().catch(async (error: unknown) => {
      setError(errorMessage(error, "Failed to update the default model"));
    });
    setSaving(false);
  }

  // Engine entries (Pi) are the first-class list — Pi with
  // friendly names and no engine noise, pi keeping its registry label ("Pi ·
  // Claude Opus 5") so it never reads as a duplicate row in this flat select.
  // The native claude/codex entries stay selectable under de-emphasized
  // legacy groups while the migration lands.
  const { primary: primaryModels, legacy } = splitModelOptions(models || []);
  const claudeModels = legacy.filter((m) => m.provider === "claude");
  const codexModels = legacy.filter((m) => m.provider === "codex");
  const legacyGroup = (engine: string) =>
    primaryModels.length > 0 ? `Legacy · ${engine} (direct SDK)` : engine;
  const engineLabel = (m: (typeof primaryModels)[number]) =>
    m.provider === "pi" ? m.label : shortModelLabel(m.id, models || []);
  // The trigger reads the selected model's label from this flat list, so a
  // closed select shows "Fable 5.1" rather than pi/anthropic/claude-fable-5-1.
  const items = [
    ...primaryModels.map((m) => ({ value: m.id, label: engineLabel(m) })),
    ...claudeModels.map((m) => ({ value: m.id, label: m.label })),
    ...codexModels.map((m) => ({ value: m.id, label: m.label })),
  ];
  // Vendor mark per row; combo presets show each participating vendor while
  // the slot stays reserved on every row (and the trigger) for alignment.
  const markFor = (m: ModelInfo) => (
    <ModelMark id={m.id} provider={m.provider} composition={m.composition} />
  );
  const currentModel = (models || []).find((m) => m.id === current);

  return (
    <SettingRow>
      <SettingRowText>
        <SettingRowTitle>What new sessions run on</SettingRowTitle>
        <SettingRowDescription>
          {error ||
            "Sessions and agent runs (Slack, Linear, Plain, automations without their own model) start on this."}
        </SettingRowDescription>
      </SettingRowText>
      <SettingRowControl>
        <Select.Root
          items={items}
          value={current}
          disabled={!models || saving}
          onValueChange={(id) => handleChange(String(id))}
        >
          <Select.Trigger
            aria-label="Default model"
            icon={currentModel ? markFor(currentModel) : null}
            sizeTo={items.map((m) => m.label)}
          />
          <Select.Popup align="end">
            {primaryModels.map((m) => (
              <Select.Item key={m.id} value={m.id} icon={markFor(m)}>
                {engineLabel(m)}
              </Select.Item>
            ))}
            {claudeModels.length > 0 && (
              <Select.Group>
                <Select.GroupLabel>{legacyGroup("Claude")}</Select.GroupLabel>
                {claudeModels.map((m) => (
                  <Select.Item key={m.id} value={m.id} icon={markFor(m)}>
                    {m.label}
                  </Select.Item>
                ))}
              </Select.Group>
            )}
            {codexModels.length > 0 && (
              <Select.Group>
                <Select.GroupLabel>{legacyGroup("Codex")}</Select.GroupLabel>
                {codexModels.map((m) => (
                  <Select.Item key={m.id} value={m.id} icon={markFor(m)}>
                    {m.label}
                  </Select.Item>
                ))}
              </Select.Group>
            )}
          </Select.Popup>
        </Select.Root>
      </SettingRowControl>
    </SettingRow>
  );
}

// ── Auto model-switch on out-of-credits ─────────────────────────────────────

/**
 * Manual vs auto: when a session's model runs out of usage credits pool-wide,
 * either drop it to a fallback model and keep going (auto, the default) or stop
 * on the limit notice and let the human pick the next model (manual). Global,
 * read fresh per run. The switch is always announced in the session as a divider.
 */
function AutoFallbackRow() {
  const [auto, setAuto] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(`${BASE_PATH}/api/models`)
      .then((response) => {
        if (!response.ok)
          throw new Error(`Failed to load auto-switching (${response.status})`);
        return response.json();
      })
      .then((body) => setAuto(body.autoFallback !== false))
      .catch((error: unknown) => {
        setError(errorMessage(error, "Failed to load auto-switching"));
      });
  }, []);

  async function toggle(next: boolean) {
    if (saving) return;
    setSaving(true);
    setError(null);
    const prev = auto;
    setAuto(next); // optimistic
    await (async () => {
      const res = await fetch(`${BASE_PATH}/api/models/auto-fallback`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ auto: next }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `Failed: ${res.status}`);
      setAuto(body.autoFallback);
    })().catch(async (error: unknown) => {
      setError(errorMessage(error, "Failed to update auto-switching"));
      setAuto(prev ?? null);
    });
    setSaving(false);
  }

  const on = auto ?? true;
  return (
    <SettingRow>
      <SettingRowText>
        <SettingRowTitle>Auto-switch when out of credits</SettingRowTitle>
        <SettingRowDescription>
          {error ||
            "Switch to the configured fallback when the current model runs out of credits."}
        </SettingRowDescription>
      </SettingRowText>
      <SettingRowControl>
        <Switch
          checked={on}
          aria-label="Auto-switch model when out of credits"
          disabled={auto === null || saving}
          onCheckedChange={toggle}
        />
      </SettingRowControl>
    </SettingRow>
  );
}
