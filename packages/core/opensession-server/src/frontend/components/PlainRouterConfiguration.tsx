import { useEffect, useState } from "react";
import { modelCatalogPath } from "../lib/api/automations";
import { BASE_PATH } from "../lib/base";
import { errorMessage } from "../lib/error-message";
import { Button } from "../ui/button";
import { cn } from "../ui/cn";
import { OptionSelect } from "../ui/select";
import { SettingsSection, settingsInputClass } from "../ui/settings";
import { InlineAlert, LoadingState } from "../ui/state";

interface ModelInfo {
  id: string;
  provider: "claude" | "codex";
  label: string;
}

interface RouterConfig {
  prompt: string;
  isCustom: boolean;
  basicModel: string;
  defaultPrompt: string;
  defaultBasicModel: string;
}

/** Plain's pre-triage spam gate and basic-ticket model routing. Kept with the
 * integration that feeds it rather than on the general MCP connections page. */
export function PlainRouterConfiguration() {
  const [config, setConfig] = useState<RouterConfig | null>(null);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState(0);

  useEffect(() => {
    void fetch(`${BASE_PATH}/api/connections/plain-router`)
      .then((response) => {
        if (!response.ok)
          throw new Error(
            `Could not load the triage router (${response.status})`,
          );
        return response.json();
      })
      .then((body: RouterConfig) => {
        setConfig(body);
        setDraft(body.prompt);
      })
      .catch((cause: unknown) => {
        setLoadError(errorMessage(cause, "Could not load the triage router"));
      });
    void fetch(`${BASE_PATH}/api${modelCatalogPath()}`)
      .then((response) => {
        if (!response.ok)
          throw new Error(`Could not load models (${response.status})`);
        return response.json();
      })
      .then((body) =>
        setModels(
          (body.models || []).filter(
            (model: ModelInfo) => model.provider === "claude",
          ),
        ),
      )
      .catch((cause: unknown) => {
        setError(errorMessage(cause, "Could not load models"));
      });
  }, []);

  async function save(patch: { prompt?: string; basicModel?: string }) {
    setSaving(true);
    setError(null);
    await (async () => {
      const response = await fetch(
        `${BASE_PATH}/api/connections/plain-router`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(patch),
        },
      );
      const body = await response.json();
      if (!response.ok)
        return Promise.reject(
          new Error(body.error || `Failed: ${response.status}`),
        );
      setConfig((current) => (current ? { ...current, ...body } : current));
      if ("prompt" in patch) setDraft(body.prompt);
      setSavedAt(Date.now());
    })().catch(async (cause: unknown) => {
      setError(errorMessage(cause, "Could not save the triage router"));
    });
    setSaving(false);
  }

  if (!config) {
    return (
      <SettingsSection className="p-4">
        {loadError ? (
          <InlineAlert>{loadError}</InlineAlert>
        ) : (
          <LoadingState>Loading triage router</LoadingState>
        )}
      </SettingsSection>
    );
  }

  const dirty = draft !== config.prompt;

  return (
    <SettingsSection className="min-w-0 p-4">
      <div className="text-item-title font-medium text-fg">Triage router</div>
      <p className="m-0 mt-1 text-supporting leading-relaxed text-dim">
        New tickets first run through a lightweight spam and complexity check.
        Basic tickets use the model below; everything else uses the triage
        automation’s model. Changes apply to the next ticket.
      </p>
      {error && (
        <InlineAlert className="mt-3" onDismiss={() => setError(null)}>
          {error}
        </InlineAlert>
      )}
      <div className="mt-4 flex min-w-0 items-center gap-2.5 text-meta text-faint phone:flex-col phone:items-stretch">
        <span className="whitespace-nowrap">Model for basic tickets</span>
        <OptionSelect
          className="min-w-0 flex-1 phone:min-h-11"
          label="Model for basic tickets"
          value={config.basicModel}
          disabled={saving}
          options={models.map((model) => ({
            value: model.id,
            label: model.label,
          }))}
          onChange={(basicModel) => void save({ basicModel })}
        />
      </div>
      <textarea
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        rows={12}
        spellCheck={false}
        aria-label="Routing prompt"
        className={cn(settingsInputClass, "mt-3 resize-y text-body")}
      />
      <div className="mt-2 flex min-w-0 flex-wrap items-center gap-2.5 text-meta text-faint">
        <Button
          variant="primary"
          disabled={saving || !dirty}
          onClick={() => void save({ prompt: draft })}
        >
          {saving ? "Saving…" : "Save prompt"}
        </Button>
        <Button
          variant="soft"
          disabled={saving || (!config.isCustom && !dirty)}
          onClick={() => void save({ prompt: "" })}
        >
          Reset to default
        </Button>
        <span className="min-w-0">
          {dirty
            ? "Unsaved changes"
            : savedAt
              ? "Saved."
              : config.isCustom
                ? "Custom prompt active"
                : "Using the built-in default"}
        </span>
      </div>
    </SettingsSection>
  );
}
