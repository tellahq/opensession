import { useState, type ReactNode } from "react";
import { useIsPhone } from "../../hooks/useIsPhone";
import { useVoiceAudioDevices } from "../../hooks/useVoiceAudioDevices";
import type { VoiceAudioDevice } from "../../lib/os1-shell";
import { voiceAudioDeviceRows } from "../../lib/voice-audio-menu";
import {
  readVoiceAudioSettings,
  resolveVoiceAudioDevice,
  voiceAudioBridge,
  writeVoiceAudioSettings,
  type VoiceAudioSettings,
} from "../../lib/voice-audio-settings";
import { cn } from "../../ui/cn";
import { Menu } from "../../ui/menu";
import { Tooltip } from "../../ui/tooltip";
import { IconChevronDown, IconChevronRight } from "../icons";

/**
 * Audio routing on the Mac desktop shell: which microphone (and, for a
 * call, which output) the next dictation or call uses, and whether other
 * apps' audio is lowered while someone speaks. The choices are one shared
 * preference, reachable from a small chevron that appears once dictation or
 * a call has started, so the idle composer carries no extra button.
 *
 * Nothing here renders unless the shell
 * exposes `window.os1.voiceAudio`, so the web, phone and older shells are
 * untouched. Devices come from the native bridge, which lists names without
 * opening the microphone, and are only asked for while the menu is open.
 */

const DUCKING_LABEL = "Lower other audio during speech";
// Off is not a promise of silence from the system: macOS keeps the least
// fade it allows, so the copy says "least", not "none".
const DUCKING_OFF_NOTE = "Off keeps the least fade macOS allows.";
const DUCKING_REQUIREMENT = "Requires macOS 14 or later.";
const SAVE_FAILED = "Couldn't save. Applies in this window only.";
const SHARED_HINT = "Shared by dictation and calls. Applies next time.";

/** A small round chevron. It only exists while dictation or a call is live,
 *  so it sits beside the controls that end them rather than on the idle mic. */
const triggerClasses =
  "inline-flex size-8 shrink-0 items-center justify-center rounded-full text-dim transition-colors hover:bg-hover hover:text-fg data-[popup-open]:bg-hover data-[popup-open]:text-fg disabled:cursor-default disabled:opacity-50 phone:size-11";

const itemClasses = "phone:min-h-11 data-[disabled]:opacity-50";

function MenuNote({
  tone = "dim",
  children,
}: {
  tone?: "dim" | "warn";
  children: ReactNode;
}) {
  return (
    <p
      className={cn(
        "m-0 px-2 py-1 text-supporting leading-snug",
        tone === "warn" ? "text-yellow" : "text-dim",
      )}
    >
      {children}
    </p>
  );
}

function DeviceRadioGroup({
  kind,
  value,
  devices,
  onChange,
}: {
  kind: "microphone" | "output";
  value: string;
  devices: VoiceAudioDevice[] | null;
  onChange: (id: string) => void;
}) {
  return (
    <Menu.RadioGroup
      value={value}
      onValueChange={(next) => onChange(String(next))}
    >
      {voiceAudioDeviceRows(value, devices, kind).map((row) => (
        <Menu.RadioItem
          key={row.id}
          value={row.id}
          disabled={row.disabled}
          className={cn(itemClasses, "justify-between gap-3")}
        >
          <span className="flex min-w-0 flex-col">
            <span className="truncate">{row.label}</span>
            {row.note && (
              <span className="text-supporting text-dim">{row.note}</span>
            )}
          </span>
          <Menu.Check on={row.id === value} />
        </Menu.RadioItem>
      ))}
    </Menu.RadioGroup>
  );
}

/** The menu's rows. Mounted only while the menu is open, so each opening
 *  reads the stored choice afresh (a change made from the other menu
 *  shows here) and asks the shell for its devices only then. */
function VoiceAudioMenuContent({
  mode,
}: {
  mode: "dictation" | "conversation";
}) {
  const [settings, setSettings] = useState(readVoiceAudioSettings);
  const [saveFailed, setSaveFailed] = useState(false);
  const { state, refresh } = useVoiceAudioDevices();
  // A phone-width window gets the output list as a submenu so the menu
  // stays one screen tall.
  const compact = useIsPhone();
  const list = state.devices;
  // Unknown until the list arrives; only a known "no" disables the row, so
  // it does not flicker off and on while loading.
  const duckingSupported = list ? list.advancedDucking : true;
  const loading = state.status === "loading";
  function update(next: VoiceAudioSettings) {
    setSettings(next);
    setSaveFailed(!writeVoiceAudioSettings(next));
  }
  const output = (
    <DeviceRadioGroup
      kind="output"
      value={settings.outputDeviceId}
      devices={list?.outputs ?? null}
      onChange={(outputDeviceId) => update({ ...settings, outputDeviceId })}
    />
  );
  return (
    <>
      <Menu.Group>
        <Menu.GroupLabel>Microphone</Menu.GroupLabel>
        <DeviceRadioGroup
          kind="microphone"
          value={settings.inputDeviceId}
          devices={list?.inputs ?? null}
          onChange={(inputDeviceId) => update({ ...settings, inputDeviceId })}
        />
      </Menu.Group>
      {mode === "conversation" && (
        <>
          <Menu.Separator />
          {compact ? (
            <Menu.SubmenuRoot>
              <Menu.SubmenuTrigger
                className={cn(itemClasses, "justify-between gap-3")}
              >
                <span>Output</span>
                <span className="flex min-w-0 items-center gap-1 text-dim">
                  <span className="truncate">
                    {
                      resolveVoiceAudioDevice(
                        settings.outputDeviceId,
                        list?.outputs ?? null,
                        "output",
                      ).label
                    }
                  </span>
                  <IconChevronRight className="shrink-0 text-faint" size={17} />
                </span>
              </Menu.SubmenuTrigger>
              <Menu.Popup className="max-w-[min(300px,calc(100vw-1rem))]">
                {output}
              </Menu.Popup>
            </Menu.SubmenuRoot>
          ) : (
            <Menu.Group>
              <Menu.GroupLabel>Output</Menu.GroupLabel>
              {output}
            </Menu.Group>
          )}
        </>
      )}
      <Menu.Separator />
      <Menu.CheckboxItem
        checked={duckingSupported && settings.ducking}
        disabled={!duckingSupported}
        onCheckedChange={(ducking) => update({ ...settings, ducking })}
        className={cn(itemClasses, "justify-between gap-3")}
      >
        {/* Wraps rather than truncates: the row is 280px wide in a
            narrow window and the label is the whole row's meaning. */}
        <span className="min-w-0">{DUCKING_LABEL}</span>
        <Menu.Check on={duckingSupported && settings.ducking} />
      </Menu.CheckboxItem>
      <MenuNote>
        {duckingSupported ? DUCKING_OFF_NOTE : DUCKING_REQUIREMENT}
      </MenuNote>
      <Menu.Separator />
      {state.status === "error" ? (
        <>
          <MenuNote tone="warn">
            Couldn't list audio devices. Your saved choices are kept.
          </MenuNote>
          <Menu.Item
            closeOnClick={false}
            className={itemClasses}
            onClick={refresh}
          >
            Try again
          </Menu.Item>
        </>
      ) : (
        <Menu.Item
          closeOnClick={false}
          disabled={loading}
          className={itemClasses}
          onClick={refresh}
        >
          {loading ? "Checking devices…" : "Refresh devices"}
        </Menu.Item>
      )}
      {saveFailed && <MenuNote tone="warn">{SAVE_FAILED}</MenuNote>}
      <MenuNote>{SHARED_HINT}</MenuNote>
    </>
  );
}

/**
 * The audio options menu for a live dictation (`mode="dictation"`) or call
 * (`mode="conversation"`, which also offers the output). It renders nothing
 * unless the Mac shell exposes the native bridge, so the web, phone and older
 * shells draw no button.
 */
export function VoiceAudioOptions({
  mode,
  className,
}: {
  mode: "dictation" | "conversation";
  className?: string;
}) {
  if (!voiceAudioBridge()) return null;
  const label =
    mode === "dictation" ? "Dictation audio options" : "Call audio options";
  return (
    <Menu.Root modal={false}>
      <Tooltip label={label}>
        <Menu.Trigger
          className={cn(triggerClasses, className)}
          aria-label={label}
          // The composer toolbar cancels pointerdown at phone width so a tap
          // does not blur the textarea, which also suppresses the mousedown
          // Base UI opens this menu on. Keep this press out of that guard.
          onPointerDown={(event) => event.stopPropagation()}
        >
          <IconChevronDown size={20} />
        </Menu.Trigger>
      </Tooltip>
      <Menu.Popup align="end" className="w-[280px]">
        <VoiceAudioMenuContent mode={mode} />
      </Menu.Popup>
    </Menu.Root>
  );
}
