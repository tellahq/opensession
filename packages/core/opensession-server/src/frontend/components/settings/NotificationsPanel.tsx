import { useEffect, useState } from "react";
import { errorMessage } from "../../lib/error-message";
import {
  ensureNotificationPermission,
  getNotifSettings,
  onNotifSettingsChanged,
  playSound,
  setNotifSettings,
  SOUND_OPTIONS,
  WHEN_OPTIONS,
  type NotifSettings,
} from "../../lib/notify";
import {
  disablePush,
  enablePush,
  getPushState,
  type PushState,
} from "../../lib/push";
import { Button } from "../../ui/button";
import {
  SettingCard,
  SettingsGroupLabel,
  SettingsHeader,
  SettingsPanel,
} from "../../ui/settings";
import { Switch } from "../../ui/switch";
import { getCurrentUser } from "../UserPicker";
import { Select, SettingRow } from "./shared";
import * as stylex from "@stylexjs/stylex";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
  flex: {
    display: "flex",
  },
  itemsCenter: {
    alignItems: "center",
  },
  gap2: {
    gap: "calc(4px * 2)",
  },
});

// ── Notifications ──────────────────────────────────────────────────────────

/** The device-level Web Push toggle inside Notifications. */
function PushRow() {
  const [state, setState] = useState<PushState | "loading">("loading");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getPushState().then(setState);
  }, []);

  async function toggle(v: boolean) {
    if (busy) return;
    setBusy(true);
    setError(null);
    await (async () => {
      if (v) await enablePush(getCurrentUser());
      else await disablePush();
      setState(await getPushState());
    })().catch(async (error) => {
      setError(errorMessage(error, "Failed to update push notifications"));
      setState(await getPushState());
    });
    setBusy(false);
  }

  return (
    <SettingRow
      title="Push to this device"
      desc={
        error ||
        (state === "unsupported"
          ? "Push needs an HTTPS origin. It isn't available on plain http."
          : state === "denied"
            ? "Notifications are blocked for this site. Allow them in your browser to enable push."
            : "Alerts even when the app is closed. Turn it on separately on each device.")
      }
      control={
        <Switch
          aria-label="Push to this device"
          checked={state === "on"}
          onCheckedChange={toggle}
        />
      }
    />
  );
}

export function NotificationsPanel() {
  const [s, setS] = useState<NotifSettings>(getNotifSettings);
  useEffect(() => onNotifSettingsChanged(() => setS(getNotifSettings())), []);

  function patch(p: Partial<NotifSettings>) {
    setS(setNotifSettings(p));
  }

  return (
    <SettingsPanel>
      <SettingsHeader title="Notifications" />

      <SettingsGroupLabel>Alerts</SettingsGroupLabel>
      <SettingCard>
        <PushRow />
        <SettingRow
          title="Desktop notifications"
          control={
            <Switch
              aria-label="Desktop notifications"
              checked={s.desktop}
              onCheckedChange={(v) => {
                if (v) ensureNotificationPermission();
                patch({ desktop: v });
              }}
            />
          }
        />
        <SettingRow
          title="Completion sound"
          control={
            <div {...stylex.props(sx.flex, sx.itemsCenter, sx.gap2)}>
              <Select
                label="Completion sound"
                value={s.sound}
                options={SOUND_OPTIONS}
                onChange={(v) => patch({ sound: v })}
              />
              <Button
                size="sm"
                variant="ghost"
                onClick={() => playSound(s.sound)}
                disabled={s.sound === "none"}
                title="Play sound"
              >
                <svg width="20" height="20" viewBox="0 0 16 16" fill="none">
                  <path
                    d="M3 6v4h2.5L9 13V3L5.5 6H3z"
                    stroke="currentColor"
                    strokeWidth="1.3"
                    strokeLinejoin="round"
                  />
                  <path
                    d="M11 6.2c.6.5.9 1.1.9 1.8s-.3 1.3-.9 1.8"
                    stroke="currentColor"
                    strokeWidth="1.3"
                    strokeLinecap="round"
                  />
                </svg>
                Test
              </Button>
            </div>
          }
        />
        <SettingRow
          title="When to notify"
          control={
            <Select
              label="When to notify"
              value={s.when}
              options={WHEN_OPTIONS}
              onChange={(v) => patch({ when: v })}
            />
          }
        />
      </SettingCard>

      <SettingsGroupLabel>Events</SettingsGroupLabel>
      <SettingCard>
        <SettingRow
          title="Needs input"
          control={
            <Switch
              aria-label="Needs input alerts"
              checked={s.needsInput}
              onCheckedChange={(v) => patch({ needsInput: v })}
            />
          }
        />
        <SettingRow
          title="Run complete"
          control={
            <Switch
              aria-label="Run complete alerts"
              checked={s.done}
              onCheckedChange={(v) => patch({ done: v })}
            />
          }
        />
      </SettingCard>
    </SettingsPanel>
  );
}
