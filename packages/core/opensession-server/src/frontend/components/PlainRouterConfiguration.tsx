import { mergeStylexOverrideClassName } from "../ui/cn";
import { utilityClassName } from "../ui/cn";
import { useEffect, useState } from "react";
import { BASE_PATH } from "../lib/base";
import { errorMessage } from "../lib/error-message";
import { Button } from "../ui/button";
import { cn } from "../ui/cn";
import { OptionSelect } from "../ui/select";
import { SettingsSection, settingsInputClass } from "../ui/settings";
import { InlineAlert, LoadingState } from "../ui/state";
import * as stylex from "@stylexjs/stylex";
import { type as typography } from "../styles/typography.stylex";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
  p4: {
    padding: "calc(4px * 4)",
  },
  minW0: {
    minWidth: "0",
  },
  fontMedium: {
    fontWeight: "var(--font-weight-medium)",
  },
  textFg: {
    color: "var(--text)",
  },
  m0: {
    margin: "0",
  },
  mt1: {
    marginTop: "4px",
  },
  leadingRelaxed: {
    lineHeight: "var(--leading-relaxed)",
  },
  textDim: {
    color: "var(--text-dim)",
  },
  mt3: {
    marginTop: "calc(4px * 3)",
  },
  mt4: {
    marginTop: "calc(4px * 4)",
  },
  flex: {
    display: "flex",
  },
  itemsCenter: {
    alignItems: "center",
  },
  gap25: {
    gap: "calc(4px * 2.5)",
  },
  textFaint: {
    color: "var(--text-faint)",
  },
  phoneFlexCol: {
    "@media (max-width: 720px)": {
      flexDirection: "column",
    },
  },
  phoneItemsStretch: {
    "@media (max-width: 720px)": {
      alignItems: "stretch",
    },
  },
  whitespaceNowrap: {
    whiteSpace: "nowrap",
  },
  flex1: {
    flex: "1",
  },
  phoneMinH11: {
    "@media (max-width: 720px)": {
      minHeight: "calc(4px * 11)",
    },
  },
  mt2: {
    marginTop: "calc(4px * 2)",
  },
  flexWrap: {
    flexWrap: "wrap",
  },
});

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
    void fetch(`${BASE_PATH}/api/models`)
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
      <SettingsSection className={mergeStylexOverrideClassName("", sx.p4)}>
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
    <SettingsSection
      className={mergeStylexOverrideClassName("", sx.minW0, sx.p4)}
    >
      <div {...stylex.props(sx.fontMedium, sx.textFg, typography.itemTitle)}>
        Triage router
      </div>
      <p
        {...stylex.props(
          sx.m0,
          sx.mt1,
          sx.leadingRelaxed,
          sx.textDim,
          typography.supporting,
        )}
      >
        New tickets first run through a lightweight spam and complexity check.
        Basic tickets use the model below; everything else uses the triage
        automation’s model. Changes apply to the next ticket.
      </p>
      {error && (
        <InlineAlert
          className={mergeStylexOverrideClassName("", sx.mt3)}
          onDismiss={() => setError(null)}
        >
          {error}
        </InlineAlert>
      )}
      <div
        {...stylex.props(
          sx.mt4,
          sx.flex,
          sx.minW0,
          sx.itemsCenter,
          sx.gap25,
          sx.textFaint,
          sx.phoneFlexCol,
          sx.phoneItemsStretch,
          typography.meta,
        )}
      >
        <span {...stylex.props(sx.whitespaceNowrap)}>
          Model for basic tickets
        </span>
        <OptionSelect
          className={mergeStylexOverrideClassName(
            "",
            sx.minW0,
            sx.flex1,
            sx.phoneMinH11,
          )}
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
        className={cn(
          settingsInputClass,
          utilityClassName("mt-3 resize-y text-body"),
        )}
      />
      <div
        {...stylex.props(
          sx.mt2,
          sx.flex,
          sx.minW0,
          sx.flexWrap,
          sx.itemsCenter,
          sx.gap25,
          sx.textFaint,
          typography.meta,
        )}
      >
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
        <span {...stylex.props(sx.minW0)}>
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
