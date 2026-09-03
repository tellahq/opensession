import React, { useEffect, useEffectEvent, useState } from "react";
import {
  fetchGithubOrganizationProfile,
  fetchOrganizationSettings,
  removeOrganizationIcon,
  saveOrganizationSettings,
  uploadOrganizationIcon,
  type OrganizationSettingsDto,
} from "../../lib/api";
import { rememberOrganizationIcon } from "../../hooks/useOrganizationIcon";
import { PRODUCT_NAME } from "../../lib/brand";
import { pngFromImageFile, pngFromImageUrl } from "../../lib/icon-image";
import { REPO_TILE_INK, repoColor, repoIconFill } from "../../lib/repo-colors";
import { errorMessage } from "../../lib/error-message";
import { cn } from "../../ui/cn";
import { OverlayAction } from "../../ui/overlay-action";
import { Field } from "../../ui/input";
import {
  SettingCard,
  SettingCardSkeleton,
  SettingRow,
  SettingRowControl,
  SettingRowText,
  SettingRowTitle,
  SettingsHeader,
  SettingsHint,
  SettingsPanel,
  settingsInputClass,
} from "../../ui/settings";
import { toast } from "../../ui/toast";
import { InlineAlert } from "../../ui/state";
import { IconArrowUpToLine, IconTrash } from "../icons";
import { IdentityRows } from "../SetupIdentity";

const NAME_INPUT_CLASS = cn(settingsInputClass, "w-[220px] max-w-full");

/**
 * The organization's name and mark.
 *
 * In onboarding this step runs directly after GitHub, and `githubOrganization`
 * is the org that was just connected. Rather than ask for two things the
 * connection already knows, the first render of a fresh instance fills them in
 * from GitHub: the org's display name and avatar. It leaves both editable and
 * only fills values nobody has set, so re-opening onboarding cannot overwrite
 * a rename.
 */
export function OrganizationProfileSection({
  githubOrganization,
  onboarding = false,
}: {
  githubOrganization?: string;
  onboarding?: boolean;
} = {}) {
  const [settings, setSettings] = useState<OrganizationSettingsDto | null>(
    null,
  );
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [iconFailed, setIconFailed] = useState(false);
  const fileInput = React.useRef<HTMLInputElement>(null);
  // One attempt per mount: a failed lookup must not retry on every render, and
  // a successful one must not fight the operator's own edits.
  const prefilled = React.useRef(false);

  async function load(cancelled?: () => boolean) {
    setLoadError(null);
    await (async () => {
      const next = await fetchOrganizationSettings();
      if (cancelled?.()) return;
      setSettings(next);
      setDraft(next.organizationName);
      rememberOrganizationIcon(next);
    })().catch(async (error) => {
      if (cancelled?.()) return;
      const message = errorMessage(
        error,
        "Couldn’t load organization settings",
      );
      setLoadError(message);
      toast(message, { variant: "error" });
    });
  }

  useEffect(() => {
    let cancelled = false;
    void load(() => cancelled);
    return () => {
      cancelled = true;
    };
  }, []);

  async function update(
    work: () => Promise<OrganizationSettingsDto>,
    message: string,
  ) {
    if (busy) return;
    setBusy(true);
    await (async () => {
      const next = await work();
      setSettings(next);
      setDraft(next.organizationName);
      setIconFailed(false);
      rememberOrganizationIcon(next);
      toast(message, { variant: "success" });
    })()
      .catch(async (error) => {
        toast(errorMessage(error, "Couldn’t save organization settings"), {
          variant: "error",
        });
        if (settings) setDraft(settings.organizationName);
      })
      .finally(async () => {
        setBusy(false);
      });
  }

  async function commitName() {
    const next = draft.trim();
    if (!settings || next === settings.organizationName || busy) {
      if (settings) setDraft(settings.organizationName);
      return;
    }
    await update(
      () => saveOrganizationSettings({ organizationName: next }),
      "Organization name saved.",
    );
  }

  // Fill only what is still unset. A fresh install has no icon and a name that
  // is still the product's own.
  // The body reads `update` through an effect event: the trigger set stays the
  // org/settings state, while the call always reaches the latest closure.
  const maybePrefillFromGithub = useEffectEvent(() => {
    const login = githubOrganization?.trim();
    if (!login || !settings || prefilled.current || busy) return;
    const needsName =
      !settings.organizationName || settings.organizationName === PRODUCT_NAME;
    const needsIcon = !settings.organizationIconUrl;
    if (!needsName && !needsIcon) return;
    prefilled.current = true;
    void (async () => {
      const profile = await fetchGithubOrganizationProfile(login);
      await update(async () => {
        if (needsIcon && profile?.avatarUrl) {
          const icon = await pngFromImageUrl(profile.avatarUrl);
          if (icon) await uploadOrganizationIcon(icon);
        }
        return needsName
          ? saveOrganizationSettings({
              organizationName: profile?.name || login,
            })
          : saveOrganizationSettings({});
      }, `Filled in from ${login} on GitHub.`);
    })();
  });
  useEffect(() => {
    maybePrefillFromGithub();
  }, [githubOrganization, settings, busy]);

  async function upload(file: File) {
    await update(async () => {
      const png = await pngFromImageFile(file);
      return uploadOrganizationIcon(png);
    }, "Organization icon updated.");
  }

  function removeIcon() {
    void update(removeOrganizationIcon, "Organization icon removed.");
  }

  const nameParts = (settings?.organizationName || "Organization")
    .trim()
    .split(/\s+/);
  const initials = (
    nameParts.length > 1
      ? `${nameParts[0].charAt(0)}${nameParts.at(-1)?.charAt(0) || ""}`
      : nameParts[0].slice(0, 2)
  ).toUpperCase();
  const showIcon = !!settings?.organizationIconUrl && !iconFailed;
  const fallbackColor = repoColor(settings?.organizationName || "organization");
  const iconEditor = (
    <div className="group/overlay-action relative flex shrink-0 flex-col items-center gap-1.5">
      <button
        type="button"
        disabled={busy}
        onClick={() => fileInput.current?.click()}
        aria-label={
          showIcon ? "Change organization icon" : "Upload organization icon"
        }
        className={cn(
          "focus-ring group/upload relative flex shrink-0 items-center justify-center overflow-hidden rounded-lg text-section-title font-semibold outline outline-1 outline-divider disabled:pointer-events-none",
          onboarding ? "size-16" : "size-14",
        )}
        style={
          showIcon
            ? undefined
            : {
                backgroundImage: repoIconFill(fallbackColor),
                color: REPO_TILE_INK,
              }
        }
      >
        {showIcon ? (
          <img
            src={settings?.organizationIconUrl || undefined}
            alt=""
            className="size-full object-cover"
            onError={() => setIconFailed(true)}
          />
        ) : (
          initials
        )}
        <span className="pointer-events-none absolute inset-0 grid place-items-center rounded-[inherit] bg-black/50 text-white opacity-0 transition-opacity duration-150 group-hover/upload:opacity-100 group-focus-visible/upload:opacity-100">
          <IconArrowUpToLine size={20} />
        </span>
      </button>
      {settings?.organizationIconUrl && (
        <OverlayAction
          icon={<IconTrash className="text-red" size={20} />}
          disabled={busy}
          onClick={removeIcon}
          aria-label="Remove organization icon"
          title="Remove icon"
          className="phone:pointer-events-auto! phone:opacity-100!"
        />
      )}
      <input
        ref={fileInput}
        type="file"
        disabled={busy}
        accept="image/*"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) void upload(file);
        }}
      />
    </div>
  );
  const organizationNameInput = (
    <input
      className={cn(
        NAME_INPUT_CLASS,
        onboarding && "h-12! min-h-12! w-full! px-3.5! text-base!",
      )}
      // data-setup-field: FirstMile promotes this to the large field step.
      data-setup-field="org-name"
      value={draft}
      maxLength={80}
      disabled={busy}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => void commitName()}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur();
        else if (event.key === "Escape")
          setDraft(settings?.organizationName || "");
      }}
      aria-label="Organization name"
    />
  );

  return (
    <>
      {loadError && !settings ? (
        <InlineAlert onRetry={() => void load()}>{loadError}</InlineAlert>
      ) : settings ? (
        <>
          <SettingCard
            className={
              onboarding
                ? "mx-auto max-w-[560px] bg-[color-mix(in_srgb,var(--popup-surface)_76%,transparent)]!"
                : undefined
            }
          >
            {onboarding ? (
              <div className="p-6 phone:p-5">
                <div className="flex justify-center py-4">{iconEditor}</div>
                <div className="mx-auto mt-5 grid w-full max-w-[400px] grid-cols-1 gap-4">
                  <Field
                    label={<span className="text-fg">Organization name</span>}
                  >
                    {organizationNameInput}
                  </Field>
                  <IdentityRows compact showProductName={false} />
                </div>
              </div>
            ) : (
              <>
                <SettingRow className="items-center">
                  <SettingRowText>
                    <SettingRowTitle>Upload icon</SettingRowTitle>
                  </SettingRowText>
                  <SettingRowControl className="flex flex-wrap items-center justify-end gap-2">
                    {iconEditor}
                  </SettingRowControl>
                </SettingRow>
                <SettingRow>
                  <SettingRowText>
                    <SettingRowTitle>Organization name</SettingRowTitle>
                  </SettingRowText>
                  {organizationNameInput}
                </SettingRow>
                <IdentityRows />
              </>
            )}
          </SettingCard>
          {!onboarding && (
            <SettingsHint>
              Shared by everyone in this organization. Clearing the name
              restores the product name.
            </SettingsHint>
          )}
        </>
      ) : (
        <SettingCardSkeleton rows={2} label="Loading organization settings" />
      )}
    </>
  );
}

export function GeneralPanel() {
  return (
    <SettingsPanel>
      <SettingsHeader title="General" className="phone:hidden" />
      <OrganizationProfileSection />
    </SettingsPanel>
  );
}
