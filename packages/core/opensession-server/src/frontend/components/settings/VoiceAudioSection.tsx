import { useState } from "react";
import { useVoiceAudioDevices } from "../../hooks/useVoiceAudioDevices";
import type { VoiceAudioDevice } from "../../lib/os1-shell";
import { voiceAudioDeviceRows } from "../../lib/voice-audio-menu";
import {
  readVoiceAudioSettings,
  voiceAudioBridge,
  writeVoiceAudioSettings,
  type VoiceAudioSettings,
} from "../../lib/voice-audio-settings";
import { Button } from "../../ui/button";
import {
  SettingCard,
  SettingGroup,
  SettingsGroupLabel,
  SettingsHint,
} from "../../ui/settings";
import { Switch } from "../../ui/switch";
import { Select, SettingRow } from "./shared";

function deviceOptions(
  value: string,
  devices: VoiceAudioDevice[] | null,
  kind: "microphone" | "output",
) {
  return voiceAudioDeviceRows(value, devices, kind).map((row) => ({
    value: row.id,
    label: row.note ? `${row.label} · ${row.note}` : row.label,
    disabled: row.disabled,
  }));
}

/**
 * Which microphone dictation and calls use, which output a call plays on,
 * and whether other apps' audio is lowered while someone speaks. Only the
 * Mac desktop shell can route audio, so the section is absent elsewhere.
 * The live dictation pill carries no menu for this: it is set here once.
 */
export function VoiceAudioSection() {
  if (!voiceAudioBridge()) return null;
  return <VoiceAudioRows />;
}

function VoiceAudioRows() {
  const [settings, setSettings] = useState(readVoiceAudioSettings);
  const [saveFailed, setSaveFailed] = useState(false);
  const { state, refresh } = useVoiceAudioDevices();
  const list = state.devices;
  // Unknown until the list arrives; only a known "no" disables the switch,
  // so it does not flicker off and on while loading.
  const duckingSupported = list ? list.advancedDucking : true;
  function update(next: VoiceAudioSettings) {
    setSettings(next);
    setSaveFailed(!writeVoiceAudioSettings(next));
  }
  return (
    <>
      <SettingsGroupLabel
        actions={
          <Button
            size="sm"
            variant="ghost"
            disabled={state.status === "loading"}
            onClick={refresh}
          >
            {state.status === "loading" ? "Checking…" : "Refresh devices"}
          </Button>
        }
      >
        Audio
      </SettingsGroupLabel>
      <SettingCard>
        <SettingGroup>
          <SettingRow
            title="Microphone"
            desc="For dictation and calls."
            control={
              <Select
                label="Microphone"
                value={settings.inputDeviceId}
                options={deviceOptions(
                  settings.inputDeviceId,
                  list?.inputs ?? null,
                  "microphone",
                )}
                onChange={(inputDeviceId) =>
                  update({ ...settings, inputDeviceId })
                }
              />
            }
          />
          <SettingRow
            title="Output"
            desc="For calls."
            control={
              <Select
                label="Output"
                value={settings.outputDeviceId}
                options={deviceOptions(
                  settings.outputDeviceId,
                  list?.outputs ?? null,
                  "output",
                )}
                onChange={(outputDeviceId) =>
                  update({ ...settings, outputDeviceId })
                }
              />
            }
          />
        </SettingGroup>
        <SettingRow
          title="Lower other audio during speech"
          desc={
            duckingSupported
              ? "Off keeps the least fade macOS allows."
              : "Requires macOS 14 or later."
          }
          control={
            <Switch
              aria-label="Lower other audio during speech"
              checked={duckingSupported && settings.ducking}
              disabled={!duckingSupported}
              onCheckedChange={(ducking) => update({ ...settings, ducking })}
            />
          }
        />
      </SettingCard>
      <SettingsHint>
        {state.status === "error"
          ? "Couldn't list audio devices. Your saved choices are kept."
          : saveFailed
            ? "Couldn't save. Applies in this window only."
            : "Applies from the next dictation or call."}
      </SettingsHint>
    </>
  );
}
