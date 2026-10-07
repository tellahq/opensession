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
  SettingsHint,
  SettingsPanel,
} from "../../ui/settings";
import { Switch } from "../../ui/switch";
import { useNotifications } from "../../hooks/useNotifications";
import {
  setNotificationAlerts,
  setPushActive,
  type NotificationAlerts,
} from "../../lib/notifications";
import { getCurrentUser } from "../UserPicker";
import { Select, SettingRow } from "./shared";

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
      const next = await getPushState();
      setPushActive(next === "on");
      setState(next);
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

const ALERT_ROWS: {
  group: keyof NotificationAlerts;
  title: string;
  desc: string;
}[] = [
  {
    group: "reviews",
    title: "Reviews",
    desc: "Someone asks you for a review, or finishes one you asked for",
  },
  {
    group: "teamReviews",
    title: "Team review requests",
    desc: "A team you're on is asked to review, like code owners",
  },
  {
    group: "mentions",
    title: "Mentions and comments",
    desc: "Someone tags you, assigns you a comment, or replies to one you're in",
  },
  {
    group: "collaborators",
    title: "Added to a workspace",
    desc: "Someone adds you as a collaborator",
  },
  { group: "reminders", title: "Reminders", desc: "Desk task reminders" },
];

export function NotificationsPanel() {
  const [s, setS] = useState<NotifSettings>(getNotifSettings);
  const { alerts } = useNotifications();
  const [alertError, setAlertError] = useState<string | null>(null);
  useEffect(() => onNotifSettingsChanged(() => setS(getNotifSettings())), []);

  function patch(p: Partial<NotifSettings>) {
    setS(setNotifSettings(p));
  }

  return (
    <SettingsPanel>
      <SettingsHeader title="Notifications" />

      <SettingsGroupLabel>This device</SettingsGroupLabel>
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
          title="Sound"
          control={
            <div className="flex items-center gap-2">
              <Select
                label="Sound"
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

      <SettingsGroupLabel>Notify me when</SettingsGroupLabel>
      <SettingCard>
        {ALERT_ROWS.map((row) => (
          <SettingRow
            key={row.group}
            title={row.title}
            desc={row.desc}
            control={
              <Switch
                aria-label={row.title}
                checked={alerts[row.group]}
                onCheckedChange={(v) => {
                  setAlertError(null);
                  void setNotificationAlerts({ [row.group]: v }).catch(
                    (error) =>
                      setAlertError(
                        errorMessage(error, "Couldn't save that setting"),
                      ),
                  );
                }}
              />
            }
          />
        ))}
      </SettingCard>
      <SettingsHint className={alertError ? "text-red" : undefined}>
        {alertError ||
          "Switched off events skip your inbox and send no banner, sound or push, on every device."}
      </SettingsHint>
    </SettingsPanel>
  );
}
