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
import { IconSpeaker } from "../icons";
import { useIsPhone } from "../../hooks/useIsPhone";
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
          ? "Needs HTTPS."
          : state === "denied"
            ? "Blocked for this site. Allow it in your browser."
            : "Alerts when the app is closed. Set per device.")
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
  desc?: string;
}[] = [
  {
    group: "reviews",
    title: "Reviews",
    desc: "Requests for you, and reviews of your work.",
  },
  {
    group: "teamReviews",
    title: "Team review requests",
    desc: "Like code owners.",
  },
  {
    group: "mentions",
    title: "Mentions and comments",
  },
  {
    group: "collaborators",
    title: "Added to a workspace",
  },
  {
    group: "huddles",
    title: "Huddle invites",
  },
  { group: "reminders", title: "Reminders", desc: "From Desk tasks." },
];

export function NotificationsPanel() {
  const [s, setS] = useState<NotifSettings>(getNotifSettings);
  const { alerts } = useNotifications();
  const isPhone = useIsPhone();
  const [alertError, setAlertError] = useState<string | null>(null);
  useEffect(() => onNotifSettingsChanged(() => setS(getNotifSettings())), []);

  function patch(p: Partial<NotifSettings>) {
    setS(setNotifSettings(p));
  }

  return (
    <SettingsPanel>
      <SettingsHeader
        title="Notifications"
        description="When and how you hear about your sessions."
      />

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
              {/* On a phone the row's control half holds the picker and this
                  button together, so the button drops its word: with it the
                  picker shrank to its first letter. */}
              <Button
                size="sm"
                variant="ghost"
                icon={<IconSpeaker size={20} />}
                onClick={() => playSound(s.sound)}
                disabled={s.sound === "none"}
                title="Play sound"
                aria-label={isPhone ? "Play sound" : undefined}
                className="shrink-0"
              >
                {isPhone ? undefined : "Test"}
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
        {alertError || "Everything still lands in your inbox."}
      </SettingsHint>
    </SettingsPanel>
  );
}
