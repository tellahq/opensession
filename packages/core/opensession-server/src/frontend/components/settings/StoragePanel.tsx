import React, { useEffect, useState } from "react";
import {
  fetchAssetStorageSettings,
  saveAssetStorageSettings,
  testAssetStorageSettings,
  type AssetStorageSettingsDto,
  type AssetStorageSettingsInput,
} from "../../lib/api";
import { errorMessage } from "../../lib/error-message";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { OptionSelect } from "../../ui/select";
import {
  SettingCardSkeleton,
  SettingsField,
  SettingsForm,
  SettingsFormActions,
  SettingsFormRow,
  SettingsGroupLabel,
  SettingsHeader,
  SettingsHint,
  SettingsPanel,
  StatusChip,
} from "../../ui/settings";
import { InlineAlert } from "../../ui/state";
import { Switch } from "../../ui/switch";
import { toast } from "../../ui/toast";

interface StorageDraft {
  provider: "local" | "s3";
  bucket: string;
  region: string;
  endpoint: string;
  prefix: string;
  accessKeyId: string;
  secretAccessKey: string;
  secretAccessKeySet: boolean;
  forcePathStyle: boolean;
}

function draftFrom(settings: AssetStorageSettingsDto): StorageDraft {
  return { ...settings, secretAccessKey: "" };
}

function payload(draft: StorageDraft): AssetStorageSettingsInput {
  const input: AssetStorageSettingsInput = { provider: draft.provider };
  if (draft.provider === "s3") {
    input.bucket = draft.bucket;
    input.region = draft.region;
    input.endpoint = draft.endpoint;
    input.prefix = draft.prefix;
    input.accessKeyId = draft.accessKeyId;
    input.secretAccessKey = draft.secretAccessKey;
    input.forcePathStyle = draft.forcePathStyle;
  }
  return input;
}

export function StoragePanel() {
  const [saved, setSaved] = useState<AssetStorageSettingsDto | null>(null);
  const [draft, setDraft] = useState<StorageDraft | null>(null);
  const [busy, setBusy] = useState<"test" | "save" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tested, setTested] = useState(false);

  async function load(cancelled?: () => boolean) {
    setError(null);
    await (async () => {
      const next = await fetchAssetStorageSettings();
      if (cancelled?.()) return;
      setSaved(next);
      setDraft(draftFrom(next));
    })().catch(async (cause) => {
      if (!cancelled?.())
        setError(errorMessage(cause, "Couldn’t load asset storage"));
    });
  }

  useEffect(() => {
    let cancelled = false;
    void load(() => cancelled);
    return () => {
      cancelled = true;
    };
  }, []);

  function patch(values: Partial<StorageDraft>) {
    setTested(false);
    setDraft((current) => (current ? { ...current, ...values } : current));
  }

  async function testConnection() {
    if (!draft || busy) return;
    setBusy("test");
    setError(null);
    await (async () => {
      await testAssetStorageSettings(payload(draft));
      setTested(true);
      toast("Storage connection works.", { variant: "success" });
    })()
      .catch(async (cause) => {
        setTested(false);
        setError(errorMessage(cause, "Couldn’t connect to storage"));
      })
      .finally(async () => {
        setBusy(null);
      });
  }

  async function save() {
    if (!draft || busy) return;
    setBusy("save");
    setError(null);
    await (async () => {
      const next = await saveAssetStorageSettings(payload(draft));
      setSaved(next);
      setDraft(draftFrom(next));
      setTested(next.provider === "s3");
      toast(
        next.provider === "s3"
          ? "S3-compatible storage enabled."
          : "Local asset storage enabled.",
        { variant: "success" },
      );
    })()
      .catch(async (cause) => {
        setError(errorMessage(cause, "Couldn’t save asset storage"));
      })
      .finally(async () => {
        setBusy(null);
      });
  }

  const changed =
    !!draft &&
    !!saved &&
    (draft.provider !== saved.provider ||
      draft.bucket !== saved.bucket ||
      draft.region !== saved.region ||
      draft.endpoint !== saved.endpoint ||
      draft.prefix !== saved.prefix ||
      draft.accessKeyId !== saved.accessKeyId ||
      !!draft.secretAccessKey ||
      draft.forcePathStyle !== saved.forcePathStyle);
  const ready =
    !!draft &&
    (draft.provider === "local" ||
      !!(
        draft.bucket.trim() &&
        draft.accessKeyId.trim() &&
        (draft.secretAccessKey.trim() || draft.secretAccessKeySet)
      ));

  return (
    <SettingsPanel>
      <SettingsHeader
        title="Storage"
        description="Choose where session assets are kept."
      />
      <SettingsGroupLabel
        actions={
          draft?.provider === "s3" && (tested || saved?.provider === "s3") ? (
            <StatusChip
              label={tested ? "Tested" : "Configured"}
              dot="var(--green)"
            />
          ) : undefined
        }
      >
        Asset storage
      </SettingsGroupLabel>

      {error && (
        <InlineAlert onDismiss={() => setError(null)}>{error}</InlineAlert>
      )}

      {!draft ? (
        <SettingCardSkeleton rows={4} label="Loading asset storage" />
      ) : (
        <SettingsForm>
          <SettingsField>
            Storage backend
            <OptionSelect
              label="Storage backend"
              value={draft.provider}
              disabled={!!busy}
              className="w-full"
              options={[
                { value: "local", label: "Local disk" },
                { value: "s3", label: "S3-compatible" },
              ]}
              onChange={(provider) => patch({ provider })}
            />
          </SettingsField>

          {draft.provider === "s3" && (
            <>
              <SettingsFormRow>
                <SettingsField>
                  Bucket
                  <Input
                    value={draft.bucket}
                    disabled={!!busy}
                    placeholder="opensession-assets"
                    autoCapitalize="none"
                    spellCheck={false}
                    onChange={(event) => patch({ bucket: event.target.value })}
                  />
                </SettingsField>
                <SettingsField>
                  Region
                  <Input
                    value={draft.region}
                    disabled={!!busy}
                    placeholder="us-east-1"
                    autoCapitalize="none"
                    spellCheck={false}
                    onChange={(event) => patch({ region: event.target.value })}
                  />
                </SettingsField>
              </SettingsFormRow>
              <SettingsField>
                Endpoint
                <Input
                  value={draft.endpoint}
                  disabled={!!busy}
                  placeholder="https://account-id.r2.cloudflarestorage.com"
                  autoCapitalize="none"
                  spellCheck={false}
                  onChange={(event) => patch({ endpoint: event.target.value })}
                />
              </SettingsField>
              <SettingsFormRow>
                <SettingsField>
                  Access key ID
                  <Input
                    value={draft.accessKeyId}
                    disabled={!!busy}
                    autoComplete="off"
                    autoCapitalize="none"
                    spellCheck={false}
                    onChange={(event) =>
                      patch({ accessKeyId: event.target.value })
                    }
                  />
                </SettingsField>
                <SettingsField>
                  Secret access key
                  <Input
                    type="password"
                    value={draft.secretAccessKey}
                    disabled={!!busy}
                    autoComplete="off"
                    placeholder={
                      draft.secretAccessKeySet
                        ? "Leave blank to keep current key"
                        : "Secret key"
                    }
                    onChange={(event) =>
                      patch({ secretAccessKey: event.target.value })
                    }
                  />
                </SettingsField>
              </SettingsFormRow>
              <SettingsFormRow>
                <SettingsField>
                  Object prefix
                  <Input
                    value={draft.prefix}
                    disabled={!!busy}
                    placeholder="opensession-assets"
                    autoCapitalize="none"
                    spellCheck={false}
                    onChange={(event) => patch({ prefix: event.target.value })}
                  />
                </SettingsField>
                <label className="mb-3 flex min-h-10 items-center justify-between gap-4 text-label font-medium text-dim">
                  Path-style URLs
                  <Switch
                    aria-label="Path-style URLs"
                    checked={draft.forcePathStyle}
                    disabled={!!busy}
                    onCheckedChange={(forcePathStyle) =>
                      patch({ forcePathStyle })
                    }
                  />
                </label>
              </SettingsFormRow>
            </>
          )}

          <SettingsFormActions>
            {draft.provider === "s3" && (
              <Button
                variant="soft"
                disabled={!!busy || !ready}
                onClick={() => void testConnection()}
              >
                {busy === "test" ? "Testing…" : "Test connection"}
              </Button>
            )}
            <Button
              variant="primary"
              disabled={!!busy || !changed || !ready}
              onClick={() => void save()}
            >
              {busy === "save" ? "Saving…" : "Save"}
            </Button>
          </SettingsFormActions>
        </SettingsForm>
      )}
      <SettingsHint>
        S3-compatible mode works with AWS S3, Cloudflare R2, and compatible
        services. New assets go directly to the bucket. Existing local assets
        stay readable.
      </SettingsHint>
    </SettingsPanel>
  );
}
