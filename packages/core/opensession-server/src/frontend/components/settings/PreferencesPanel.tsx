import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  fetchModels,
  fetchPersonalOutputStyle,
  fetchPersonalPrompt,
  fetchRepos,
  request,
  savePersonalOutputStyle,
  savePersonalPrompt,
  type ModelOption,
  type PersonalOutputStyle,
  type RepoInfo,
} from "../../lib/api";
import { errorMessage } from "../../lib/error-message";
import {
  getBusySendPrefs,
  onBusySendChanged,
  setBusySendPref,
  type BusySendGesture,
  type BusySendPref,
  type BusySendPrefs,
} from "../../lib/busy-send-pref";
import {
  getDefaultModelPref,
  onDefaultModelPrefChanged,
  setDefaultModelPref,
} from "../../lib/default-model-pref";
import {
  getDefaultRepoPref,
  onDefaultRepoPrefChanged,
  setDefaultRepoPref,
} from "../../lib/default-repo-pref";
import {
  getDeskVoicePref,
  onDeskVoiceChanged,
  setDeskVoicePref,
} from "../../lib/desk-voice-pref";
import {
  getPinNewSessions,
  getPinNewWorkspaces,
  onPinNewSessionsChanged,
  onPinNewWorkspacesChanged,
  setPinNewSessions,
  setPinNewWorkspaces,
} from "../../lib/pins";
import {
  MOD_ENTER_GLYPH,
  MOD_ENTER_LABEL,
  type SendKeyPref,
} from "../../lib/send-key";
import {
  getSendKeyPref,
  onSendKeyChanged,
  setSendKeyPref,
} from "../../lib/send-key-pref";
import {
  getSessionCheckoutPrefs,
  onSessionCheckoutPrefChanged,
  sessionCheckoutDefault,
  setSessionCheckoutDefault,
  setSessionCheckoutPref,
  type SessionCheckoutOverride,
  type SessionCheckoutPrefs,
} from "../../lib/session-checkout-pref";
import {
  getTurnActivityPrefs,
  onTurnActivityChanged,
  setToolCallsPref,
  setTurnWorkPref,
  type TurnActivityPrefs,
} from "../../lib/turn-activity";
import {
  getLiveTypingPref,
  onLiveTypingChanged,
  setLiveTypingPref,
} from "../../lib/live-typing-pref";
import {
  getReplySuggestionsPref,
  onReplySuggestionsChanged,
  setReplySuggestionsPref,
} from "../../lib/reply-suggestions";
import {
  getNextChatButtonPref,
  onNextChatButtonChanged,
  setNextChatButtonPref,
} from "../../lib/next-chat-pref";
import {
  getVimModePref,
  onVimModeChanged,
  setVimModePref,
} from "../../lib/vim-pref";
import { Input, Textarea } from "../../ui/input";
import { Button } from "../../ui/button";
import {
  SettingCard,
  SettingGroup,
  SettingsGroupLabel,
  SettingsHeader,
  SettingsHint,
  SettingsPanel,
  SettingsSection,
} from "../../ui/settings";
import { InlineAlert, Skeleton, SkeletonBar } from "../../ui/state";
import { Switch } from "../../ui/switch";
import { toast } from "../../ui/toast";
import { getCurrentUser } from "../UserPicker";
import { Select, SettingRow } from "./shared";
import {
  AppearanceSection,
  SidebarDisplayRows,
  SidebarItemsSection,
} from "./AppearancePanel";
import { PersonalSandboxDefaultRow } from "./SandboxDefaults";
import { RepoTile } from "../RepoTile";
import { ModelMark } from "../ModelMark";
import { IconPlus, IconRepo } from "../icons";

// ── Desk voice ─────────────────────────────────────────────────────────────

interface DeskVoiceStatus {
  configured: boolean;
  keyMasked?: string;
}

function DeskVoiceApiKeyRow() {
  const [status, setStatus] = useState<DeskVoiceStatus | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    request<DeskVoiceStatus>("/desk/voice/status", {
      label: "Failed to load voice settings",
    })
      .then(setStatus)
      .catch((error: unknown) =>
        setError(errorMessage(error, "Failed to load voice settings")),
      );
  }, []);

  async function put(value: string) {
    setBusy(true);
    setError(null);
    try {
      const status = await request<DeskVoiceStatus>("/desk/voice/key", {
        method: "PUT",
        body: { apiKey: value },
        label: "Failed to save the API key",
      });
      setStatus(status);
      setApiKey("");
    } catch (error: unknown) {
      setError(errorMessage(error, "Failed to save the API key"));
    }
    setBusy(false);
  }

  return (
    <>
      {status?.configured && (
        <SettingRow
          title="OpenAI API key"
          desc={status.keyMasked}
          control={
            <Button size="sm" disabled={busy} onClick={() => put("")}>
              Remove
            </Button>
          }
        />
      )}
      <SettingRow
        title={status?.configured ? "Replace key" : "OpenAI API key"}
        desc={error || "Anyone signed in can start calls."}
        control={
          <div className="flex items-center gap-2">
            <Input
              type="password"
              autoComplete="off"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="sk-…"
            />
            <Button
              size="sm"
              variant="primary"
              disabled={busy || !apiKey.trim()}
              onClick={() => put(apiKey.trim())}
            >
              {busy ? "Saving…" : "Save"}
            </Button>
          </div>
        }
      />
    </>
  );
}

function DeskVoicePanel() {
  const [on, setOn] = useState(getDeskVoicePref);
  useEffect(() => onDeskVoiceChanged(() => setOn(getDeskVoicePref())), []);

  return (
    <>
      <SettingsGroupLabel>Desk voice</SettingsGroupLabel>
      <SettingCard>
        <SettingGroup>
          <SettingRow
            title="Voice mode"
            control={
              <Switch
                aria-label="Voice mode"
                checked={on}
                onCheckedChange={setDeskVoicePref}
              />
            }
          />
          <DeskVoiceApiKeyRow />
        </SettingGroup>
      </SettingCard>
      <SettingsHint>
        Adds a microphone to Desk, opened with ⌘J. The API key is shared across
        this instance.
      </SettingsHint>
    </>
  );
}

/** A server-backed personal choice, rather than localStorage: sessions started
 * from the web, native app, Slack, and GitHub all report work the same way. */
function PersonalOutputStyleRow() {
  const user = getCurrentUser();
  const [style, setStyle] = useState<PersonalOutputStyle | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetchPersonalOutputStyle(user)
      .then((result) => {
        if (!alive) return;
        setStyle(result.outputStyle);
        setError(null);
      })
      .catch(
        (error: unknown) =>
          alive && setError(errorMessage(error, "Failed to load output style")),
      );
    return () => {
      alive = false;
    };
  }, [user]);

  async function change(next: PersonalOutputStyle) {
    const previous = style ?? "default";
    setStyle(next);
    setSaving(true);
    setError(null);
    try {
      const saved = await savePersonalOutputStyle(user, next);
      setStyle(saved.outputStyle);
    } catch (error) {
      const message = errorMessage(error, "Failed to save output style");
      setStyle(previous);
      setError(message);
      toast(message, { variant: "error" });
    }
    setSaving(false);
  }

  return (
    <SettingRow
      title="Output style"
      desc={error || "Concise skips preamble without reducing the work."}
      control={
        <Select
          label="Output style"
          value={style ?? "default"}
          options={[
            { value: "default", label: "Default" },
            { value: "concise", label: "Concise" },
          ]}
          disabled={style === null || saving}
          onChange={change}
        />
      }
    />
  );
}

/** Settings → Personal prompt: a per-user standing-instructions block injected
 * into the system note of every interactive run the user starts (server-side:
 * personal-prompts.ts via memoryNoteFor). Automations never receive it. */
function PersonalPromptPanel() {
  const user = getCurrentUser();
  const [prompt, setPrompt] = useState<string | null>(null);
  const [savedPrompt, setSavedPrompt] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<"idle" | "saving" | "saved">("idle");

  useEffect(() => {
    let alive = true;
    fetchPersonalPrompt(user)
      .then((result) => {
        if (!alive) return;
        setPrompt(result.prompt);
        setSavedPrompt(result.prompt);
      })
      .catch(
        (error: unknown) =>
          alive && setError(errorMessage(error, "Failed to load your prompt")),
      );
    return () => {
      alive = false;
    };
  }, [user]);

  // There is no Save button: the prompt commits when the box loses focus and
  // again when the panel goes away, so leaving the page keeps your edit. The
  // latest values live in a ref because the unmount effect must run once (a
  // dependency on `prompt` would re-fire the cleanup on every keystroke).
  const latest = useRef({ prompt, savedPrompt, user });
  useLayoutEffect(() => {
    latest.current = { prompt, savedPrompt, user };
  });

  // Stable identity: reads the latest-values ref, so the unmount effect can
  // list it and still only run its cleanup once.
  const commit = useCallback(async () => {
    const { prompt: draft, savedPrompt: saved, user: who } = latest.current;
    if (draft === null || draft === saved) return;
    setStatus("saving");
    try {
      const result = await savePersonalPrompt(who, draft);
      setSavedPrompt(result.prompt);
      setStatus("saved");
    } catch (error) {
      setStatus("idle");
      toast(errorMessage(error, "Failed to save personal prompt"), {
        variant: "error",
      });
    }
  }, []);

  useEffect(() => {
    // Fire-and-forget on the way out — nothing is left to render a result to.
    return () => void commit();
  }, [commit]);

  const label = <SettingsGroupLabel>Personal prompt</SettingsGroupLabel>;

  if (prompt === null)
    return (
      <>
        {label}
        {error ? (
          <InlineAlert>{error}</InlineAlert>
        ) : (
          // The section it lands in, with the prose it holds — not a
          // ten-row grey slab, which is the editor's box rather than its
          // contents and reads as a field you have been locked out of.
          <Skeleton label="Loading your prompt">
            <SettingsSection className="flex flex-col gap-2.5">
              <SkeletonBar className="h-2.5 w-[72%]" />
              <SkeletonBar className="h-2.5 w-[88%]" />
              <SkeletonBar className="h-2.5 w-[46%]" />
            </SettingsSection>
          </Skeleton>
        )}
      </>
    );

  const dirty = prompt !== savedPrompt;
  return (
    <>
      {label}
      <SettingsSection>
        <Textarea
          rows={10}
          placeholder='e.g. "Keep answers short. Prefer tables."'
          value={prompt}
          onChange={(e) => {
            setPrompt(e.target.value);
            setStatus("idle");
          }}
          onBlur={() => void commit()}
        />
        <div className="mt-2 h-4 text-label font-medium text-faint">
          {status === "saving"
            ? "Saving…"
            : dirty
              ? "Saves when you click away"
              : status === "saved"
                ? "Saved"
                : ""}
        </div>
      </SettingsSection>
      <SettingsHint>
        Used in every session you start. Syncs across devices. Automations never
        receive it.
      </SettingsHint>
    </>
  );
}

/** One send gesture's busy behavior, labelled with the chord it belongs to.
 *  The two gestures used to be two rows explaining each other; as a labelled
 *  pair they read as the one choice they are. */
function BusyGestureSelect({
  gesture,
  glyph,
  value,
}: {
  gesture: BusySendGesture;
  glyph: string;
  value: BusySendPref;
}) {
  const label = `Follow-up behavior for ${glyph}`;
  return (
    <span className="flex flex-col items-start gap-1">
      <span className="px-0.5 text-meta font-medium text-faint">{glyph}</span>
      <Select
        label={label}
        value={value}
        options={[
          { value: "queue" as const, label: "Queue" },
          { value: "steer" as const, label: "Steer" },
        ]}
        onChange={(v) => setBusySendPref(gesture, v)}
      />
    </span>
  );
}

/**
 * How the app looks and behaves for you: theme and accent, the composer keys,
 * what a follow-up does mid-run, and how much of a turn's work the transcript
 * shows. Everything here is yours alone, and the prefs backed by ui-prefs
 * follow you across devices.
 */
export function PreferencesPanel() {
  const [sendKey, setSendKey] = useState<SendKeyPref>(getSendKeyPref);
  const [busySend, setBusySend] = useState<BusySendPrefs>(getBusySendPrefs);
  const [vimMode, setVimMode] = useState<boolean>(getVimModePref);
  const [quickReplies, setQuickReplies] = useState<boolean>(
    getReplySuggestionsPref,
  );
  const [nextChatButton, setNextChatButton] = useState<boolean>(
    getNextChatButtonPref,
  );
  const [pinNew, setPinNew] = useState<boolean>(getPinNewSessions);
  const [pinNewWs, setPinNewWs] = useState<boolean>(getPinNewWorkspaces);
  useEffect(() => onSendKeyChanged(() => setSendKey(getSendKeyPref())), []);
  useEffect(() => onBusySendChanged(() => setBusySend(getBusySendPrefs())), []);
  useEffect(() => onVimModeChanged(() => setVimMode(getVimModePref())), []);
  useEffect(
    () =>
      onReplySuggestionsChanged(() =>
        setQuickReplies(getReplySuggestionsPref()),
      ),
    [],
  );
  useEffect(
    () =>
      onNextChatButtonChanged(() => setNextChatButton(getNextChatButtonPref())),
    [],
  );
  useEffect(
    () => onPinNewSessionsChanged(() => setPinNew(getPinNewSessions())),
    [],
  );
  useEffect(
    () => onPinNewWorkspacesChanged(() => setPinNewWs(getPinNewWorkspaces())),
    [],
  );
  // Per-user default model for NEW sessions ("" = no preference — the
  // workspace default from GET /api/models applies).
  const [modelPref, setModelPref] = useState<string>(getDefaultModelPref);
  const [modelOptions, setModelOptions] = useState<ModelOption[]>([]);
  const [modelOptionsError, setModelOptionsError] = useState<string | null>(
    null,
  );
  useEffect(
    () => onDefaultModelPrefChanged(() => setModelPref(getDefaultModelPref())),
    [],
  );
  // Per-user default repo for NEW sessions ("" = no preference — the
  // workspace's own default from GET /api/repos applies).
  const [repoPref, setRepoPref] = useState<string>(getDefaultRepoPref);
  const [repoOptions, setRepoOptions] = useState<RepoInfo[]>([]);
  const [repoOptionsError, setRepoOptionsError] = useState<string | null>(null);
  useEffect(
    () => onDefaultRepoPrefChanged(() => setRepoPref(getDefaultRepoPref())),
    [],
  );
  const [checkoutPrefs, setCheckoutPrefs] = useState<SessionCheckoutPrefs>(
    getSessionCheckoutPrefs,
  );
  const [checkoutOverrideDraft, setCheckoutOverrideDraft] = useState<{
    repo: string;
    mode: SessionCheckoutOverride;
  } | null>(null);
  useEffect(
    () =>
      onSessionCheckoutPrefChanged(() =>
        setCheckoutPrefs(getSessionCheckoutPrefs()),
      ),
    [],
  );
  const [turnActivity, setTurnActivity] =
    useState<TurnActivityPrefs>(getTurnActivityPrefs);
  useEffect(
    () => onTurnActivityChanged(() => setTurnActivity(getTurnActivityPrefs())),
    [],
  );
  const [liveTyping, setLiveTyping] = useState<boolean>(getLiveTypingPref);
  useEffect(
    () => onLiveTypingChanged(() => setLiveTyping(getLiveTypingPref())),
    [],
  );
  useEffect(() => {
    fetchModels()
      .then((models) => setModelOptions(models.models))
      .catch((error: unknown) =>
        setModelOptionsError(errorMessage(error, "Failed to load models")),
      );
  }, []);
  useEffect(() => {
    fetchRepos()
      .then(setRepoOptions)
      .catch((error: unknown) =>
        setRepoOptionsError(errorMessage(error, "Failed to load repositories")),
      );
  }, []);

  const checkoutDefault = sessionCheckoutDefault(checkoutPrefs);
  const checkoutOverrideRepos = repoOptions.filter((repo) => {
    const override = checkoutPrefs[repo.id];
    return override !== undefined && override !== checkoutDefault;
  });
  const availableCheckoutRepos = repoOptions.filter(
    (repo) => checkoutPrefs[repo.id] === undefined,
  );

  return (
    <SettingsPanel>
      <SettingsHeader title="Preferences" />
      <SettingsGroupLabel className="mt-0">Messages</SettingsGroupLabel>
      <SettingCard>
        {/* These four choices become one starting state for every new session. */}
        <SettingGroup>
          <SettingRow
            title="Default model"
            desc={modelOptionsError}
            control={
              <Select
                label="Default model"
                value={
                  modelPref && modelOptions.some((m) => m.id === modelPref)
                    ? modelPref
                    : ""
                }
                options={[
                  { value: "", label: "No preference" },
                  ...modelOptions.map((m) => ({
                    value: m.id,
                    label: m.label,
                    icon: (
                      <ModelMark
                        id={m.id}
                        provider={m.provider}
                        composition={m.composition}
                      />
                    ),
                  })),
                ]}
                onChange={setDefaultModelPref}
              />
            }
          />

          <SettingRow
            title="Default repository"
            desc={repoOptionsError}
            control={
              <Select
                label="Default repository"
                value={
                  repoOptions.some((r) => r.id === repoPref) ? repoPref : ""
                }
                options={[
                  {
                    value: "",
                    label: "Use the workspace default",
                    icon: <IconRepo size={16} />,
                  },
                  ...repoOptions.map((r) => ({
                    value: r.id,
                    label: r.label || r.id,
                    icon: <RepoTile name={r.id} size={16} />,
                  })),
                ]}
                onChange={setDefaultRepoPref}
              />
            }
          />
          <PersonalSandboxDefaultRow />
          <PersonalOutputStyleRow />
        </SettingGroup>
        {/* The send key also determines which busy-turn gesture is available. */}
        <SettingGroup>
          <SettingRow
            title="Send messages with"
            desc={
              sendKey === "mod-enter"
                ? "↵ adds a new line."
                : "⇧↵ adds a new line. On phones, use the send button."
            }
            control={
              <Select
                label="Send messages with"
                value={sendKey}
                options={[
                  { value: "enter", label: "Enter" },
                  { value: "mod-enter", label: MOD_ENTER_LABEL },
                ]}
                onChange={setSendKeyPref}
              />
            }
          />
          <SettingRow
            title="Follow-up while busy"
            desc="Queue waits for the run to finish. Steer adds the message to the current turn."
            control={
              <div className="flex flex-wrap items-end justify-end gap-x-3 gap-y-2">
                <BusyGestureSelect
                  gesture="enter"
                  glyph={sendKey === "enter" ? "↩" : MOD_ENTER_GLYPH}
                  value={busySend.enter}
                />
                {/* The modifier only has its own answer while plain Enter is
							    the send key; otherwise ⌘↵ IS sending, set just above. */}
                {sendKey === "enter" && (
                  <BusyGestureSelect
                    gesture="mod"
                    glyph={MOD_ENTER_GLYPH}
                    value={busySend.mod}
                  />
                )}
              </div>
            }
          />
        </SettingGroup>
        <SettingRow
          title="Quick replies"
          desc="Suggest follow-ups when a turn ends on a choice."
          control={
            <Switch
              aria-label="Quick replies"
              checked={quickReplies}
              onCheckedChange={setReplySuggestionsPref}
            />
          }
        />
        <SettingRow
          title="Next button"
          control={
            <Switch
              aria-label="Next button"
              checked={nextChatButton}
              onCheckedChange={setNextChatButtonPref}
            />
          }
        />
        <SettingRow
          title="Vim mode"
          control={
            <Switch
              aria-label="Vim mode"
              checked={vimMode}
              onCheckedChange={setVimModePref}
            />
          }
        />
      </SettingCard>
      <SettingsGroupLabel
        actions={
          !checkoutOverrideDraft && availableCheckoutRepos.length > 0 ? (
            <Button
              size="sm"
              variant="ghost"
              icon={<IconPlus size={16} />}
              className="phone:min-h-11"
              onClick={() =>
                setCheckoutOverrideDraft({
                  repo: "",
                  mode:
                    checkoutDefault === "checkout" ? "worktree" : "checkout",
                })
              }
            >
              Add override
            </Button>
          ) : undefined
        }
      >
        Code workspaces
      </SettingsGroupLabel>
      <SettingCard>
        <SettingRow
          title="Default for all repositories"
          desc="Where new code sessions make changes."
          controlClassName="phone:ml-0 phone:w-full phone:max-w-none phone:basis-full"
          control={
            <Select
              label="Default code workspace"
              value={checkoutDefault}
              options={[
                { value: "default", label: "Use repository defaults" },
                { value: "checkout", label: "Local checkout" },
                { value: "worktree", label: "Separate worktree" },
              ]}
              className="phone:min-h-11 phone:w-full"
              onChange={(value) => {
                setSessionCheckoutDefault(value);
                setCheckoutOverrideDraft((draft) =>
                  draft?.mode === value
                    ? {
                        ...draft,
                        mode: value === "checkout" ? "worktree" : "checkout",
                      }
                    : draft,
                );
              }}
            />
          }
        />
        {checkoutOverrideRepos.map((repo) => {
          const label = repo.label || repo.id;
          const checkoutPref = checkoutPrefs[repo.id];
          if (!checkoutPref) return null;
          return (
            <SettingRow
              key={repo.id}
              title={
                <span className="flex min-w-0 items-center gap-2">
                  <RepoTile name={repo.id} size={18} />
                  <span className="truncate">{label}</span>
                </span>
              }
              desc="Overrides the default above."
              controlClassName="phone:ml-0 phone:w-full phone:max-w-none phone:basis-full"
              control={
                <Select
                  label={`${label} code workspace`}
                  value={checkoutPref}
                  options={[
                    { value: "default", label: "Use default for all" },
                    { value: "checkout", label: "Local checkout" },
                    { value: "worktree", label: "Separate worktree" },
                  ]}
                  className="phone:min-h-11 phone:w-full"
                  onChange={(value) => setSessionCheckoutPref(repo.id, value)}
                />
              }
            />
          );
        })}
        {checkoutOverrideDraft && (
          <SettingRow
            title="New override"
            desc="Choose a repository and workspace."
            controlClassName="phone:ml-0 phone:w-full phone:max-w-none phone:basis-full"
            control={
              <div className="flex flex-wrap items-center justify-end gap-2 phone:w-full">
                <Select
                  label="Repository to override"
                  value={checkoutOverrideDraft.repo}
                  options={[
                    {
                      value: "",
                      label: "Choose repository",
                      icon: <IconRepo size={16} />,
                    },
                    ...availableCheckoutRepos.map((repo) => ({
                      value: repo.id,
                      label: repo.label || repo.id,
                      icon: <RepoTile name={repo.id} size={16} />,
                    })),
                  ]}
                  className="phone:min-h-11 phone:max-w-full"
                  onChange={(repo) =>
                    setCheckoutOverrideDraft((draft) =>
                      draft ? { ...draft, repo } : draft,
                    )
                  }
                />
                <Select
                  label="Override code workspace"
                  value={checkoutOverrideDraft.mode}
                  options={(
                    [
                      { value: "checkout", label: "Local checkout" },
                      { value: "worktree", label: "Separate worktree" },
                    ] satisfies {
                      value: SessionCheckoutOverride;
                      label: string;
                    }[]
                  ).filter((option) => option.value !== checkoutDefault)}
                  className="phone:min-h-11"
                  onChange={(mode) =>
                    setCheckoutOverrideDraft((draft) =>
                      draft ? { ...draft, mode } : draft,
                    )
                  }
                />
                <Button
                  variant="soft"
                  className="phone:min-h-11"
                  disabled={!checkoutOverrideDraft.repo}
                  onClick={() => {
                    setSessionCheckoutPref(
                      checkoutOverrideDraft.repo,
                      checkoutOverrideDraft.mode,
                    );
                    setCheckoutOverrideDraft(null);
                  }}
                >
                  Add
                </Button>
                <Button
                  variant="ghost"
                  className="phone:min-h-11"
                  onClick={() => setCheckoutOverrideDraft(null)}
                >
                  Cancel
                </Button>
              </div>
            }
          />
        )}
      </SettingCard>
      <SettingsHint>Changes apply to new sessions only.</SettingsHint>
      <AppearanceSection />
      <SettingsGroupLabel>Sidebar</SettingsGroupLabel>
      <SettingCard>
        <SidebarDisplayRows repos={repoOptions} />
        <SettingGroup>
          <SettingRow
            title="Pin new sessions"
            control={
              <Switch
                aria-label="Pin new sessions"
                checked={pinNew}
                onCheckedChange={setPinNewSessions}
              />
            }
          />
          <SettingRow
            title="Pin new workspaces"
            control={
              <Switch
                aria-label="Pin new workspaces"
                checked={pinNewWs}
                onCheckedChange={setPinNewWorkspaces}
              />
            }
          />
        </SettingGroup>
      </SettingCard>
      <SidebarItemsSection />
      <SettingsGroupLabel>Transcript</SettingsGroupLabel>
      <SettingCard>
        <SettingGroup>
          <SettingRow
            title="Steps"
            desc="Choose when steps open."
            control={
              <Select
                label="Steps"
                value={turnActivity.work}
                options={[
                  { value: "folded", label: "Closed" },
                  { value: "running", label: "With updates" },
                  { value: "open", label: "Open" },
                ]}
                onChange={setTurnWorkPref}
              />
            }
          />
          <SettingRow
            title="Tool calls"
            control={
              <Select
                label="Tool calls"
                value={turnActivity.tools}
                options={[
                  { value: "folded", label: "Closed" },
                  { value: "open", label: "Open" },
                ]}
                onChange={setToolCallsPref}
              />
            }
          />
        </SettingGroup>
        <SettingRow
          title="Live typing"
          desc="Show replies as the model writes them."
          control={
            <Switch
              aria-label="Live typing"
              checked={liveTyping}
              onCheckedChange={setLiveTypingPref}
            />
          }
        />
      </SettingCard>

      <DeskVoicePanel />
      <PersonalPromptPanel />
    </SettingsPanel>
  );
}
