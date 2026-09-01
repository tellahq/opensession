import { mergeStylexOverrideClassName } from "../ui/cn";
import { BASE_PATH } from "../lib/base";
import React, { useCallback, useEffect, useState } from "react";
import { toast } from "../ui/toast";
import { Button } from "../ui/button";
import { EmptyState, InlineAlert, LoadingState } from "../ui/state";
import {
  SettingCard,
  SettingRow,
  SettingRowControl,
  SettingRowDescription,
  SettingRowText,
  SettingRowTitle,
  SettingsField,
  SettingsForm,
  SettingsFormActions,
  SettingsFormRow,
  SettingsFormTitle,
  SettingsGroupLabel,
  SettingsHint,
  rowMenuTriggerClasses,
  settingsInputClass,
} from "../ui/settings";
import { Menu } from "../ui/menu";
import { IconTile } from "./BrandTile";
import { IconDotsHorizontal, IconPlus, IconTrash } from "./icons";
import { errorMessage } from "../lib/error-message";
import * as stylex from "@stylexjs/stylex";
import { type as typography } from "../styles/typography.stylex";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
  itemsStart: {
    alignItems: "flex-start",
  },
  gapX3: {
    columnGap: "calc(4px * 3)",
  },
  truncate: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  mt15: {
    marginTop: "calc(4px * 1.5)",
  },
  flex: {
    display: "flex",
  },
  flexWrap: {
    flexWrap: "wrap",
  },
  gap1: {
    gap: "4px",
  },
  roundedSm: {
    borderRadius: "calc(4px * var(--rf))",
    cornerShape: "var(--cs)",
  },
  bgActive: {
    backgroundColor: "var(--bg-active)",
  },
  px15: {
    paddingInline: "calc(4px * 1.5)",
  },
  pyPx: {
    paddingBlock: "1px",
  },
  textDim: {
    color: "var(--text-dim)",
  },
  mt1: {
    marginTop: "4px",
  },
  textFaint: {
    color: "var(--text-faint)",
  },
  textRed: {
    color: "var(--red)",
  },
  Mt2: {
    marginTop: "calc(4px * -2)",
  },
  mb3: {
    marginBottom: "calc(4px * 3)",
  },
});

// Settings → Model providers: third-party Pi providers (xai, openrouter,
// groq, …) — API key + optional baseURL, stored server-side (0600, returned
// masked) — plus the model ids each one surfaces in the model picker. The
// anthropic/openai bridges are configured under Accounts, never here; the server
// rejects those ids.

interface ProviderInfo {
  id: string;
  apiKeyMasked: string;
  baseURL?: string;
  /** Full picker ids (pi/<provider>/<model>) registered for it. */
  models: string[];
}

/** Common pi provider slugs, offered as datalist suggestions. */
const COMMON_PROVIDER_IDS = [
  "xai",
  "meta",
  "openrouter",
  "google",
  "groq",
  "mistral",
  "deepseek",
  "cerebras",
  "wafer",
  "fireworks",
  "together",
];

const PROVIDER_MODEL_DEFAULTS: Record<string, string> = {
  cerebras: "gpt-oss-120b, gemma-4-31b, zai-glm-4.7",
  wafer:
    "deepseek-v4-flash-0731-fast, glm-5.2, glm5.2-fast, glm-5.1, kimi-k3, kimi-k3-fast, kimi-k2.6",
};

export function ModelProvidersPanel() {
  const [providers, setProviders] = useState<ProviderInfo[] | null>(null);
  const [showAdd, setShowAdd] = useState(false);

  const load = useCallback(async () => {
    await (async () => {
      const res = await fetch(`${BASE_PATH}/api/settings/model-providers`);
      if (res.ok) setProviders((await res.json()).providers);
    })().catch(async () => {});
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function handleRemove(p: ProviderInfo) {
    if (
      !confirm(
        `Remove provider "${p.id}"? Its API key and its ${p.models.length} picker model${
          p.models.length === 1 ? "" : "s"
        } are deleted; runs on its models will stop authenticating.`,
      )
    )
      return;
    await (async () => {
      const res = await fetch(
        `${BASE_PATH}/api/settings/model-providers/${encodeURIComponent(p.id)}`,
        { method: "DELETE" },
      );
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `Failed: ${res.status}`);
      toast(`Provider ${p.id} removed`);
      load();
    })().catch(async (error) => {
      toast(errorMessage(error, "Failed to remove provider"), {
        variant: "error",
      });
    });
  }

  return (
    <>
      <SettingsGroupLabel
        actions={
          <Button
            size="sm"
            icon={<IconPlus size={16} />}
            onClick={() => setShowAdd(true)}
          >
            Add provider
          </Button>
        }
      >
        Your own providers
      </SettingsGroupLabel>

      {showAdd && (
        <AddProviderForm
          onClose={() => setShowAdd(false)}
          onSaved={() => {
            setShowAdd(false);
            load();
          }}
        />
      )}

      <SettingCard>
        {!providers ? (
          <LoadingState placement="row">Loading providers…</LoadingState>
        ) : providers.length === 0 ? (
          <EmptyState placement="row">
            No providers yet. Add one to run sessions on models beyond the
            Anthropic/OpenAI subscriptions.
          </EmptyState>
        ) : (
          providers.map((p) => (
            <SettingRow
              key={p.id}
              className={mergeStylexOverrideClassName(
                "",
                sx.itemsStart,
                sx.gapX3,
              )}
            >
              <IconTile name={p.id} size={28} />
              <SettingRowText>
                <SettingRowTitle>{p.id}</SettingRowTitle>
                <SettingRowDescription
                  className={mergeStylexOverrideClassName("", sx.truncate)}
                >
                  {p.apiKeyMasked || "no API key stored"}
                  {p.baseURL && ` · ${p.baseURL}`}
                </SettingRowDescription>
                {p.models.length > 0 ? (
                  <div
                    {...stylex.props(sx.mt15, sx.flex, sx.flexWrap, sx.gap1)}
                  >
                    {p.models.map((m) => (
                      <span
                        key={m}
                        {...stylex.props(
                          sx.roundedSm,
                          sx.bgActive,
                          sx.px15,
                          sx.pyPx,
                          sx.textDim,
                          typography.meta,
                        )}
                        title={m}
                      >
                        {m.split("/").slice(2).join("/")}
                      </span>
                    ))}
                  </div>
                ) : (
                  <div
                    {...stylex.props(
                      sx.mt1,
                      sx.textFaint,
                      typography.supporting,
                    )}
                  >
                    No picker models, so its models are type-in only (pi/{p.id}
                    /&lt;model&gt;).
                  </div>
                )}
              </SettingRowText>
              <SettingRowControl>
                <Menu.Root>
                  <Menu.Trigger
                    className={rowMenuTriggerClasses}
                    aria-label={`Manage ${p.id}`}
                  >
                    <IconDotsHorizontal size={18} />
                  </Menu.Trigger>
                  <Menu.Popup align="end" sideOffset={4}>
                    <Menu.Item
                      onClick={() => handleRemove(p)}
                      className={mergeStylexOverrideClassName(
                        "data-[highlighted]:bg-red-soft",
                        sx.textRed,
                      )}
                    >
                      <IconTrash size={16} />
                      Remove provider
                    </Menu.Item>
                  </Menu.Popup>
                </Menu.Root>
              </SettingRowControl>
            </SettingRow>
          ))
        )}
      </SettingCard>

      <SettingsHint>
        Any provider the Pi engine supports (xAI, OpenRouter, Groq, Mistral, …)
        with your API key. Keys are stored on the server (0600) and only ever
        shown masked. Changes apply to new session runs immediately, and saved
        models appear in the picker without a restart. To update a provider, add
        it again with the same id. The key, base URL and model list are
        replaced.
      </SettingsHint>
    </>
  );
}

function AddProviderForm({
  onClose,
  onSaved,
}: {
  onClose: () => void;
  onSaved: () => void;
}) {
  const [id, setId] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [baseURL, setBaseURL] = useState("");
  const [models, setModels] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cleanId = id.trim().toLowerCase();
  const idValid = /^[a-z0-9-]+$/.test(cleanId);

  async function handleSave() {
    setSaving(true);
    setError(null);
    await (async () => {
      const modelIds = models
        .split(/[\s,]+/)
        .map((m) => m.trim())
        .filter(Boolean);
      const res = await fetch(
        `${BASE_PATH}/api/settings/model-providers/${encodeURIComponent(cleanId)}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            // Strip all whitespace — pasted keys often carry newlines.
            ...(apiKey.trim() ? { apiKey: apiKey.replace(/\s+/g, "") } : {}),
            ...(baseURL.trim() ? { baseURL: baseURL.trim() } : {}),
            ...(modelIds.length ? { models: modelIds } : {}),
          }),
        },
      );
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `Failed: ${res.status}`);
      toast(`Provider ${cleanId} saved`);
      onSaved();
    })().catch(async (error) => {
      setError(errorMessage(error, "Failed to save provider"));
      setSaving(false);
    });
  }

  return (
    <SettingsForm>
      <SettingsFormTitle>Add provider</SettingsFormTitle>
      <SettingRowDescription
        className={mergeStylexOverrideClassName("", sx.Mt2, sx.mb3)}
      >
        The provider id must match pi's slug for it (xai, openrouter, groq, …).
        Models are registered in the picker as{" "}
        <code>pi/&lt;provider&gt;/&lt;model&gt;</code>. List the provider's own
        model ids, e.g. <code>grok-4</code> for xai.
      </SettingRowDescription>

      <SettingsFormRow>
        <SettingsField>
          Provider id
          <input
            className={settingsInputClass}
            value={id}
            onChange={(e) => setId(e.target.value)}
            placeholder="xai"
            list="model-provider-ids"
          />
          <datalist id="model-provider-ids">
            {COMMON_PROVIDER_IDS.map((p) => (
              <option key={p} value={p} />
            ))}
          </datalist>
        </SettingsField>
        <SettingsField>
          API key
          <input
            className={settingsInputClass}
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="xai-…"
          />
        </SettingsField>
      </SettingsFormRow>
      <SettingsFormRow>
        <SettingsField>
          Base URL (optional)
          <input
            className={settingsInputClass}
            value={baseURL}
            onChange={(e) => setBaseURL(e.target.value)}
            placeholder="https://api.x.ai/v1"
          />
        </SettingsField>
        <SettingsField>
          Model ids (optional, comma or space separated)
          <input
            className={settingsInputClass}
            value={models}
            onChange={(e) => setModels(e.target.value)}
            placeholder={
              PROVIDER_MODEL_DEFAULTS[cleanId] || "grok-4, grok-4-mini"
            }
          />
        </SettingsField>
      </SettingsFormRow>

      {error && <InlineAlert>{error}</InlineAlert>}

      <SettingsFormActions>
        <Button variant="soft" onClick={onClose} disabled={saving}>
          Cancel
        </Button>
        <Button
          variant="primary"
          onClick={handleSave}
          disabled={saving || !cleanId || !idValid || !apiKey.trim()}
        >
          {saving ? "Saving…" : "Save provider"}
        </Button>
      </SettingsFormActions>
    </SettingsForm>
  );
}
