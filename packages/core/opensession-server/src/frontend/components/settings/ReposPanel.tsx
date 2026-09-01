import { mergeStylexOverrideClassName } from "../../ui/cn";
import { useEffect, useState } from "react";
import { useSetupStatus } from "../../hooks/useSetupStatus";
import { errorMessage } from "../../lib/error-message";
import {
  SettingCard,
  SettingCardSkeleton,
  SettingsGroupLabel,
  SettingsHeader,
  SettingsHint,
  SettingsPanel,
} from "../../ui/settings";
import { Select, SettingRow } from "./shared";
import { InlineAlert } from "../../ui/state";
import { ReposSection } from "../SetupRepos";
import {
  configuredNewSessionRepo,
  fetchRepos,
  fetchWorktreeSettings,
  setNewSessionRepoApi,
  setSharedCheckoutMode,
  type RepoInfo,
  type SharedCheckoutMode,
  type WorktreeSettings,
} from "../../lib/api";
import { RepoTile } from "../RepoTile";
import { Radio, RadioGroup } from "../../ui/radio";
import * as stylex from "@stylexjs/stylex";
import { type as typography } from "../../styles/typography.stylex";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
  mt9: {
    marginTop: "calc(4px * 9)",
  },
  flex: {
    display: "flex",
  },
  minH11: {
    minHeight: "calc(4px * 11)",
  },
  cursorPointer: {
    cursor: "pointer",
  },
  itemsStart: {
    alignItems: "flex-start",
  },
  gap3: {
    gap: "calc(4px * 3)",
  },
  px5: {
    paddingInline: "calc(4px * 5)",
  },
  py4: {
    paddingBlock: "calc(4px * 4)",
  },
  transitionBackgroundColor: {
    transitionProperty: "background-color",
    transitionTimingFunction: "var(--tw-ease, var(--ease))",
    transitionDuration: "var(--tw-duration, var(--dur-micro))",
  },
  hoverBgHover: {
    "@media (hover: hover)": {
      ":hover": {
        backgroundColor: "var(--hover)",
      },
    },
  },
  mt05: {
    marginTop: "calc(4px * 0.5)",
  },
  minW0: {
    minWidth: "0",
  },
  block: {
    display: "block",
  },
  fontMedium: {
    fontWeight: "var(--font-weight-medium)",
  },
  textFg: {
    color: "var(--text)",
  },
  mt1: {
    marginTop: "4px",
  },
  textDim: {
    color: "var(--text-dim)",
  },
});

function SharedCheckoutSetting() {
  const [settings, setSettings] = useState<WorktreeSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetchWorktreeSettings()
      .then((value) => alive && setSettings(value))
      .catch(
        (cause: unknown) =>
          alive &&
          setError(errorMessage(cause, "Failed to load worktree settings")),
      );
    return () => {
      alive = false;
    };
  }, []);

  if (!settings) {
    return error ? (
      <InlineAlert className={mergeStylexOverrideClassName("", sx.mt9)}>
        {error}
      </InlineAlert>
    ) : (
      <SettingCardSkeleton
        rows={1}
        label="Loading worktree settings"
        className={mergeStylexOverrideClassName("", sx.mt9)}
      />
    );
  }
  if (!settings.repos.length) return null;

  const repoNames = settings.repos.map((repo) => `"${repo.label}"`).join(", ");
  const groupLabel = "How sessions make changes to shared checkouts";
  async function setMode(mode: SharedCheckoutMode) {
    const previous = settings;
    if (!previous || mode === previous.mode) return;
    setSettings({ ...previous, mode });
    setSaving(true);
    setError(null);
    await (async () => {
      setSettings(await setSharedCheckoutMode(mode));
    })()
      .catch(async (cause: unknown) => {
        setSettings(previous);
        setError(
          errorMessage(cause, "Couldn’t save where sessions make changes"),
        );
      })
      .finally(async () => {
        setSaving(false);
      });
  }

  return (
    <>
      <SettingsGroupLabel>{groupLabel}</SettingsGroupLabel>
      {error && (
        <InlineAlert onDismiss={() => setError(null)}>{error}</InlineAlert>
      )}
      <SettingCard>
        <RadioGroup
          aria-label={groupLabel}
          value={settings.mode}
          disabled={saving}
          onValueChange={(mode) => void setMode(mode as SharedCheckoutMode)}
          className="[&>*+*]:relative [&>*+*]:before:pointer-events-none [&>*+*]:before:absolute [&>*+*]:before:inset-x-5 [&>*+*]:before:top-0 [&>*+*]:before:h-px [&>*+*]:before:bg-line [&>*+*]:before:content-['']"
        >
          <label
            {...stylex.props(
              sx.flex,
              sx.minH11,
              sx.cursorPointer,
              sx.itemsStart,
              sx.gap3,
              sx.px5,
              sx.py4,
              sx.transitionBackgroundColor,
              sx.hoverBgHover,
            )}
          >
            <Radio
              value="shared"
              className={mergeStylexOverrideClassName("", sx.mt05)}
            />
            <span {...stylex.props(sx.minW0)}>
              <span
                {...stylex.props(
                  sx.block,
                  sx.fontMedium,
                  sx.textFg,
                  typography.itemTitle,
                )}
              >
                Local checkout
              </span>
              <span
                {...stylex.props(
                  sx.mt1,
                  sx.block,
                  sx.textDim,
                  typography.supporting,
                )}
              >
                Edit shared checkouts directly. Changes appear there right away,
                and sessions share the same files.
              </span>
            </span>
          </label>
          <label
            {...stylex.props(
              sx.flex,
              sx.minH11,
              sx.cursorPointer,
              sx.itemsStart,
              sx.gap3,
              sx.px5,
              sx.py4,
              sx.transitionBackgroundColor,
              sx.hoverBgHover,
            )}
          >
            <Radio
              value="worktree"
              className={mergeStylexOverrideClassName("", sx.mt05)}
            />
            <span {...stylex.props(sx.minW0)}>
              <span
                {...stylex.props(
                  sx.block,
                  sx.fontMedium,
                  sx.textFg,
                  typography.itemTitle,
                )}
              >
                Separate pull request branch
              </span>
              <span
                {...stylex.props(
                  sx.mt1,
                  sx.block,
                  sx.textDim,
                  typography.supporting,
                )}
              >
                Give each session an isolated Git worktree and branch. Changes
                stay separate from the local checkout, ready for a pull request.
              </span>
            </span>
          </label>
        </RadioGroup>
      </SettingCard>
      <SettingsHint>Only affects new sessions in {repoNames}.</SettingsHint>
    </>
  );
}

/**
 * Where a new session starts for everyone who hasn't set their own preference
 * (Settings → Preferences overrides this).
 */
function DefaultRepoRow() {
  const [repos, setRepos] = useState<RepoInfo[]>([]);
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    // fetchRepos carries the setting alongside the list, so one load fills
    // both the options and the current choice.
    fetchRepos()
      .then((items) => {
        setRepos(items);
        setValue(configuredNewSessionRepo());
      })
      .catch((cause: unknown) =>
        setError(errorMessage(cause, "Failed to load repositories")),
      );
  }, []);
  return (
    <SettingCard>
      <SettingRow
        title="Default repository"
        desc={
          error ||
          "Where a new session starts, for anyone who hasn't set their own."
        }
        control={
          <Select
            label="Default repository"
            value={
              repos.some((repo) => repo.id === value)
                ? value
                : repos[0]?.id || ""
            }
            options={repos.map((r) => ({
              value: r.id,
              label: r.label || r.id,
              icon: <RepoTile name={r.id} size={16} />,
            }))}
            onChange={(next) => {
              setValue(next);
              setError(null);
              void setNewSessionRepoApi(next).catch((cause: unknown) =>
                setError(
                  errorMessage(cause, "Failed to set the default repository"),
                ),
              );
            }}
          />
        }
      />
    </SettingCard>
  );
}

// Workspace → Repositories: the registered repos, and the add flow, on a page
// of their own. Same section the Setup wizard's repos step renders — a repo
// added here and a repo added there are the same act. No restart banner:
// registering a repo takes effect immediately.

export function ReposPanel() {
  const { status, failed, refetch, applyRepo } = useSetupStatus();
  return (
    <SettingsPanel>
      <SettingsHeader
        title="Repositories"
        description="Register repositories and choose where their sessions work."
      />
      {!status ? (
        // A failure is an alert, not a quiet label under a spinner: it used
        // to render in the loading register, so the sentence saying the
        // page had given up sat beside a mark saying it was still trying.
        failed ? (
          <InlineAlert>Couldn&rsquo;t load the repositories.</InlineAlert>
        ) : (
          <>
            <SettingCardSkeleton rows={1} label="Loading repositories" />
            {/* mt-9 stands in for the group label above the list, which
						    counts the repos and so cannot be drawn before they
						    arrive. */}
            <SettingCardSkeleton
              rows={3}
              icon={28}
              className={mergeStylexOverrideClassName("", sx.mt9)}
            />
          </>
        )
      ) : (
        <>
          <DefaultRepoRow />
          <SharedCheckoutSetting />
          <ReposSection
            repos={status.repos}
            onChanged={refetch}
            onRepoUpdated={applyRepo}
          />
        </>
      )}
    </SettingsPanel>
  );
}
