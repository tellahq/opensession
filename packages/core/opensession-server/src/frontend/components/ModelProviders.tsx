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
import { Checkbox } from "../ui/checkbox";
import { IconTile } from "./BrandTile";
import { IconDotsHorizontal, IconPlus, IconSearch, IconTrash } from "./icons";
import { errorMessage } from "../lib/error-message";

// Settings → Model providers: third-party Pi providers (xai, openrouter,
// groq, …) — API key + optional baseURL, stored server-side (0600, returned
// masked) — plus the model ids each one surfaces in the model picker. The
// anthropic/openai bridges are configured under Accounts, never here; the server
// rejects those ids.

interface ProviderInfo {
  id: string;
  apiKeyMasked: string;
  baseURL?: string;
  /** Set when the id is a custom OpenAI-compatible gateway rather than a
   *  slug Pi already knows. */
  api?: string;
  name?: string;
  discoverModels?: boolean;
  discoveredAt?: string;
  catalogFile?: string;
  /** Rows in the operator catalog (inline, file, or discovered). */
  catalogModels: number;
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

  async function handleDiscover(p: ProviderInfo) {
    await (async () => {
      const res = await fetch(
        `${BASE_PATH}/api/settings/model-providers/${encodeURIComponent(p.id)}/discover`,
        { method: "POST" },
      );
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `Failed: ${res.status}`);
      toast(
        `${body.models.length} models listed, ${body.added} added to the picker`,
      );
      load();
    })().catch(async (error) => {
      toast(errorMessage(error, "Failed to discover models"), {
        variant: "error",
      });
    });
  }

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
            <SettingRow key={p.id} className="items-start gap-x-3">
              <IconTile name={p.id} size={28} />
              <SettingRowText>
                <SettingRowTitle>
                  {p.name || p.id}
                  {p.name && (
                    <span className="ml-1.5 text-meta text-faint">{p.id}</span>
                  )}
                </SettingRowTitle>
                <SettingRowDescription className="truncate">
                  {p.apiKeyMasked || "no API key stored"}
                  {p.baseURL && ` · ${p.baseURL}`}
                  {p.api && " · OpenAI-compatible"}
                  {p.catalogModels > 0 &&
                    ` · ${p.catalogModels} catalog ${
                      p.catalogModels === 1 ? "row" : "rows"
                    }`}
                  {p.discoverModels && " · discovery on"}
                </SettingRowDescription>
                {p.models.length > 0 ? (
                  <div className="mt-1.5 flex flex-wrap gap-1">
                    {p.models.map((m) => (
                      <span
                        key={m}
                        className="rounded-sm bg-active px-1.5 py-px text-meta text-dim"
                        title={m}
                      >
                        {m.split("/").slice(2).join("/")}
                      </span>
                    ))}
                  </div>
                ) : (
                  <div className="mt-1 text-supporting text-faint">
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
                    {p.baseURL && (
                      <Menu.Item onClick={() => handleDiscover(p)}>
                        <IconSearch size={16} />
                        Discover models
                      </Menu.Item>
                    )}
                    <Menu.Item
                      onClick={() => handleRemove(p)}
                      className="text-red data-[highlighted]:bg-red-soft"
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
        with your API key, or any OpenAI-compatible gateway with its base URL.
        Keys are stored on the server (0600) and only ever shown masked. Changes
        apply to new session runs immediately, and saved models appear in the
        picker without a restart. To update a provider, add it again with the
        same id. The key, base URL and model list are replaced. Discover models
        reads the gateway's model list into the picker. Per-model limits and
        pricing come from a catalog in model-providers.json.
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
  const [custom, setCustom] = useState(false);
  const [name, setName] = useState("");
  const [discover, setDiscover] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cleanId = id.trim().toLowerCase();
  const idValid = /^[a-z0-9-]+$/.test(cleanId);
  const needsBaseURL = (custom || discover) && !baseURL.trim();

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
            api: custom ? "openai-completions" : "",
            ...(name.trim() ? { name: name.trim() } : {}),
            discoverModels: discover,
          }),
        },
      );
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `Failed: ${res.status}`);
      if (body.discoveryError) {
        toast(`Provider ${cleanId} saved. ${body.discoveryError}`, {
          variant: "error",
        });
      } else if (body.discovery) {
        toast(
          `Provider ${cleanId} saved, ${body.discovery.models.length} models discovered`,
        );
      } else toast(`Provider ${cleanId} saved`);
      onSaved();
    })().catch(async (error) => {
      setError(errorMessage(error, "Failed to save provider"));
      setSaving(false);
    });
  }

  return (
    <SettingsForm>
      <SettingsFormTitle>Add provider</SettingsFormTitle>
      <SettingRowDescription className="-mt-2 mb-3">
        Use pi's slug for a known provider (xai, openrouter, groq, …), or any id
        with a base URL for an OpenAI-compatible gateway. Models are registered
        in the picker as <code>pi/&lt;provider&gt;/&lt;model&gt;</code>. List
        the provider's own model ids, e.g. <code>grok-4</code> for xai.
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

      <SettingsFormRow>
        <SettingsField>
          Display name (optional)
          <input
            className={settingsInputClass}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="My gateway"
          />
        </SettingsField>
        <div className="flex flex-col justify-end gap-2 pb-1.5">
          <label className="flex cursor-pointer items-center gap-2 text-label">
            <Checkbox
              checked={custom}
              onCheckedChange={(v) => setCustom(v === true)}
            />
            OpenAI-compatible gateway (id not known to pi)
          </label>
          <label className="flex cursor-pointer items-center gap-2 text-label">
            <Checkbox
              checked={discover}
              onCheckedChange={(v) => setDiscover(v === true)}
            />
            Discover models from /v1/models on save
          </label>
        </div>
      </SettingsFormRow>
      {needsBaseURL && (
        <SettingsHint>A base URL is required for these options.</SettingsHint>
      )}

      {error && <InlineAlert>{error}</InlineAlert>}

      <SettingsFormActions>
        <Button variant="soft" onClick={onClose} disabled={saving}>
          Cancel
        </Button>
        <Button
          variant="primary"
          onClick={handleSave}
          disabled={
            saving || !cleanId || !idValid || !apiKey.trim() || needsBaseURL
          }
        >
          {saving ? "Saving…" : "Save provider"}
        </Button>
      </SettingsFormActions>
    </SettingsForm>
  );
}
