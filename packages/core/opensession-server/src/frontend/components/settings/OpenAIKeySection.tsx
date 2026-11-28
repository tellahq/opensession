import { useEffect, useState } from "react";
import { request } from "../../lib/api";
import { errorMessage } from "../../lib/error-message";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { Segmented, SegmentedOption } from "../../ui/segmented";
import {
  SettingCard,
  SettingsGroupLabel,
  SettingsHint,
} from "../../ui/settings";
import { SettingRow } from "./shared";

interface VoiceKeyStatus {
  configured: boolean;
  keyMasked?: string;
  /** The GPT-Live backend voice calls use (instance-wide). */
  backendModel?: string;
}

/** The two backends the server accepts; anything else it refuses. */
const VOICE_BACKENDS = [
  { value: "gpt-5.6-terra", label: "Terra" },
  { value: "gpt-5.6-luna", label: "Luna" },
];

/**
 * The instance's OpenAI key for Desk voice and composer Autocomplete, and the
 * voice backend calls use. Both are shared by everyone, so they live with the
 * other model providers rather than in anyone's Preferences.
 */
export function OpenAIKeySection() {
  const [status, setStatus] = useState<VoiceKeyStatus | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    request<VoiceKeyStatus>("/desk/voice/status", {
      label: "Failed to load voice settings",
    })
      .then(setStatus)
      .catch((cause) =>
        setError(errorMessage(cause, "Failed to load voice settings")),
      );
  }, []);

  async function putKey(value: string) {
    setBusy(true);
    setError(null);
    try {
      setStatus(
        await request<VoiceKeyStatus>("/desk/voice/key", {
          method: "PUT",
          body: { apiKey: value },
          label: "Failed to save the API key",
        }),
      );
      setApiKey("");
    } catch (cause) {
      setError(errorMessage(cause, "Failed to save the API key"));
    }
    setBusy(false);
  }

  async function pickBackend(model: string) {
    if (busy || !status) return;
    const previous = status;
    setBusy(true);
    setError(null);
    setStatus({ ...status, backendModel: model });
    try {
      setStatus(
        await request<VoiceKeyStatus>("/desk/voice/backend", {
          method: "PUT",
          body: { model },
          label: "Failed to save the voice backend",
        }),
      );
    } catch (cause) {
      setStatus(previous);
      setError(errorMessage(cause, "Failed to save the voice backend"));
    }
    setBusy(false);
  }

  return (
    <>
      <SettingsGroupLabel>OpenAI</SettingsGroupLabel>
      <SettingCard>
        {status?.configured ? (
          <SettingRow
            title="API key"
            desc={status.keyMasked}
            control={
              <Button size="sm" disabled={busy} onClick={() => putKey("")}>
                Remove
              </Button>
            }
          />
        ) : (
          <SettingRow
            title="API key"
            control={
              <div className="flex items-center gap-2">
                <Input
                  type="password"
                  autoComplete="off"
                  aria-label="OpenAI API key"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder="sk-…"
                  disabled={!status}
                />
                <Button
                  size="sm"
                  variant="primary"
                  disabled={busy || !apiKey.trim()}
                  onClick={() => putKey(apiKey.trim())}
                >
                  Save
                </Button>
              </div>
            }
          />
        )}
        <SettingRow
          title="Voice backend"
          desc="Luna costs less."
          control={
            <Segmented
              label="Voice backend"
              value={status?.backendModel ?? null}
              onValueChange={(model) => void pickBackend(model)}
            >
              {VOICE_BACKENDS.map(({ value, label }) => (
                <SegmentedOption
                  key={value}
                  value={value}
                  disabled={!status || busy}
                  className="phone:min-h-11"
                >
                  {label}
                </SegmentedOption>
              ))}
            </Segmented>
          }
        />
      </SettingCard>
      <SettingsHint>
        {error || "Used for Desk voice and Autocomplete."}
      </SettingsHint>
    </>
  );
}
