import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  fetchModels,
  fetchPersonalOutputStyle,
  fetchPersonalPrompt,
  fetchRepos,
  savePersonalOutputStyle,
  fetchYouShouldKnow,
  saveYouShouldKnow,
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
} from "../../lib/busy-send-pref";
import {
  getDefaultEffortPref,
  onDefaultEffortPrefChanged,
  setDefaultEffortPref,
} from "../../lib/default-effort-pref";
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
import { setDeskShownPref, useDeskShown } from "../../lib/desk-pref";
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
import { MOD_ENTER_GLYPH, MOD_ENTER_LABEL } from "../../lib/send-key";
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
} from "../../lib/session-checkout-pref";
import {
  getTurnActivityPrefs,
  onTurnActivityChanged,
  setToolCallsPref,
  setTurnWorkPref,
} from "../../lib/turn-activity";
import {
  getLiveTypingPref,
  onLiveTypingChanged,
  setLiveTypingPref,
} from "../../lib/live-typing-pref";
import {
  getThinkingMessagesPref,
  onThinkingMessagesChanged,
  setThinkingMessagesPref,
} from "../../lib/thinking-messages-pref";
import {
  getComposerPredictionsPref,
  onComposerPredictionsChanged,
  setComposerPredictionsPref,
  getComposerAutocompletePref,
  onComposerAutocompleteChanged,
  setComposerAutocompletePref,
} from "../../lib/composer-prediction-pref";
import { composerAutocompleteAvailable } from "../../lib/api/composer-autocomplete";
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
  getPrLinksOnGithubPref,
  onPrLinksOnGithubChanged,
  setPrLinksOnGithubPref,
} from "../../lib/pr-links-on-github";
import {
  getPreviewAutoOpenPref,
  onPreviewAutoOpenChanged,
  setPreviewAutoOpenPref,
} from "../../lib/preview-auto-open-pref";
import { setLinksInBrowserTabPref } from "../../lib/links-in-browser-tab-pref";
import { useLinksInBrowserTab } from "../../lib/links-in-browser-tab";
import {
  getServerHealthMonitorPref,
  onServerHealthMonitorChanged,
  setServerHealthMonitorPref,
} from "../../lib/server-health-pref";
import {
  getSessionContextRowPref,
  onSessionContextRowChanged,
  setSessionContextRowPref,
} from "../../lib/session-context-pref";
import { Textarea } from "../../ui/input";
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
import { AppearanceSection } from "./AppearancePanel";
import { PersonalSandboxDefaultRow } from "./SandboxDefaults";
import { PendingSendsSection } from "./PendingSendsSection";
import { VoiceAudioSection } from "./VoiceAudioSection";
import {
  getDictationVocabulary,
  MAX_DICTATION_VOCABULARY_CHARS,
  onDictationVocabularyChanged,
  setDictationVocabulary,
} from "../../lib/dictation-vocabulary";
import { RepoTile } from "../RepoTile";
import { ModelEffortSelect } from "../ModelEffortSelect";
import { IconRepo } from "../icons";

/** Subscribe a component to one local preference: its current value, kept
 *  in step with changes from anywhere else (another tab, the sidebar, a
 *  menu). Every pref module here exposes the same get/onChanged pair. */
function usePref<T>(get: () => T, onChanged: (fn: () => void) => () => void) {
  const [value, setValue] = useState<T>(get);
  useEffect(() => onChanged(() => setValue(get())), [get, onChanged]);
  return value;
}

function SwitchRow({
  title,
  desc,
  checked,
  disabled,
  onChange,
}: {
  title: string;
  desc?: ReactNode;
  checked: boolean;
  disabled?: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <SettingRow
      title={title}
      desc={desc}
      control={
        <Switch
          aria-label={title}
          checked={checked}
          disabled={disabled}
          onCheckedChange={onChange}
        />
      }
    />
  );
}

function NewSessionsSection() {
  // Per-user default model and effort, picked together in the same menu
  // sessions use ("" = no preference: the instance default at its own effort).
  const modelPref = usePref(getDefaultModelPref, onDefaultModelPrefChanged);
  const effortPref = usePref(getDefaultEffortPref, onDefaultEffortPrefChanged);
  // "" = no preference: the workspace's own default repo applies.
  const repoPref = usePref(getDefaultRepoPref, onDefaultRepoPrefChanged);
  const checkoutPrefs = usePref(
    getSessionCheckoutPrefs,
    onSessionCheckoutPrefChanged,
  );
  const [models, setModels] = useState<ModelOption[]>([]);
  const [catalogDefault, setCatalogDefault] = useState("");
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [repos, setRepos] = useState<RepoInfo[]>([]);
  const [reposError, setReposError] = useState<string | null>(null);
  useEffect(() => {
    fetchModels()
      .then((result) => {
        setModels(result.models);
        setCatalogDefault(result.default);
      })
      .catch((error) =>
        setModelsError(errorMessage(error, "Failed to load models")),
      );
    fetchRepos()
      .then(setRepos)
      .catch((error) =>
        setReposError(errorMessage(error, "Failed to load repositories")),
      );
  }, []);

  return (
    <>
      <SettingsGroupLabel>New sessions</SettingsGroupLabel>
      <SettingCard>
        <SettingRow
          title="Model"
          desc={modelsError}
          control={
            <ModelEffortSelect
              selection={{
                models,
                defaultModel: catalogDefault,
                model: models.some((m) => m.id === modelPref) ? modelPref : "",
                effort: effortPref,
              }}
              appearance={{ triggerVariant: "field" }}
              actions={{
                changeModel: setDefaultModelPref,
                changeEffort: setDefaultEffortPref,
                reset: () => {
                  setDefaultModelPref("");
                  setDefaultEffortPref("");
                },
              }}
            />
          }
        />
        <SettingRow
          title="Repository"
          desc={reposError}
          control={
            <Select
              label="Default repository"
              value={repos.some((r) => r.id === repoPref) ? repoPref : ""}
              options={[
                {
                  value: "",
                  label: "Workspace default",
                  icon: <IconRepo size={20} />,
                },
                ...repos.map((r) => ({
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
        <SettingRow
          title="Code workspace"
          control={
            <Select
              label="Where code sessions make changes"
              value={sessionCheckoutDefault(checkoutPrefs)}
              options={[
                { value: "default", label: "Repository default" },
                { value: "checkout", label: "Local checkout" },
                { value: "worktree", label: "Separate worktree" },
              ]}
              onChange={setSessionCheckoutDefault}
            />
          }
        />
        <PersonalOutputStyleRow />
      </SettingCard>
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
        (error) =>
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
      desc={error || "Concise skips the preamble."}
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

/** Server-backed like the output style: the side agent runs on the server
 * during a turn, so the choice has to be readable there. */
function YouShouldKnowRow() {
  const user = getCurrentUser();
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetchYouShouldKnow(user)
      .then((result) => {
        if (!alive) return;
        setEnabled(result.enabled);
        setError(null);
      })
      .catch(
        (error) =>
          alive &&
          setError(errorMessage(error, "Failed to load You should know")),
      );
    return () => {
      alive = false;
    };
  }, [user]);

  async function change(next: boolean) {
    const previous = enabled ?? false;
    setEnabled(next);
    setSaving(true);
    setError(null);
    try {
      const saved = await saveYouShouldKnow(user, next);
      setEnabled(saved.enabled);
    } catch (error) {
      const message = errorMessage(error, "Failed to save You should know");
      setEnabled(previous);
      setError(message);
      toast(message, { variant: "error" });
    }
    setSaving(false);
  }

  return (
    <SettingRow
      title="You should know"
      desc={error || "Flags what you might miss in long turns."}
      control={
        <Switch
          aria-label="You should know"
          checked={enabled ?? false}
          disabled={enabled === null || saving}
          onCheckedChange={change}
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
        (error) =>
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
      <SettingsHint>Added to every session you start.</SettingsHint>
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

function ComposerSection() {
  const sendKey = usePref(getSendKeyPref, onSendKeyChanged);
  const busySend = usePref(getBusySendPrefs, onBusySendChanged);
  const quickReplies = usePref(
    getReplySuggestionsPref,
    onReplySuggestionsChanged,
  );
  const predictions = usePref(
    getComposerPredictionsPref,
    onComposerPredictionsChanged,
  );
  const autocomplete = usePref(
    getComposerAutocompletePref,
    onComposerAutocompleteChanged,
  );
  const nextChatButton = usePref(
    getNextChatButtonPref,
    onNextChatButtonChanged,
  );
  const [autocompleteAvailable, setAutocompleteAvailable] = useState(true);
  useEffect(() => {
    let live = true;
    void composerAutocompleteAvailable().then((ok) => {
      if (live) setAutocompleteAvailable(ok);
    });
    return () => {
      live = false;
    };
  }, []);

  return (
    <>
      <SettingsGroupLabel>Composer</SettingsGroupLabel>
      <SettingCard>
        <SettingGroup>
          <SettingRow
            title="Send with"
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
            title="While a turn runs"
            desc="Queue waits. Steer joins the current turn."
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
        <SettingGroup>
          <SwitchRow
            title="Quick replies"
            checked={quickReplies}
            onChange={setReplySuggestionsPref}
          />
          <SwitchRow
            title="Predicted reply"
            checked={predictions}
            onChange={setComposerPredictionsPref}
          />
          <SwitchRow
            title="Autocomplete"
            desc={
              autocompleteAvailable
                ? undefined
                : "Needs an OpenAI key in Settings, Models."
            }
            checked={autocomplete && autocompleteAvailable}
            disabled={!autocompleteAvailable}
            onChange={setComposerAutocompletePref}
          />
        </SettingGroup>
        <SwitchRow
          title="Next button"
          desc="Jump to the next unread chat."
          checked={nextChatButton}
          onChange={setNextChatButtonPref}
        />
      </SettingCard>
    </>
  );
}

function TranscriptSection() {
  const turnActivity = usePref(getTurnActivityPrefs, onTurnActivityChanged);
  const thinking = usePref(getThinkingMessagesPref, onThinkingMessagesChanged);
  const liveTyping = usePref(getLiveTypingPref, onLiveTypingChanged);
  return (
    <>
      <SettingsGroupLabel>Transcript</SettingsGroupLabel>
      <SettingCard>
        <SettingGroup>
          <SettingRow
            title="Steps"
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
            title="Thinking"
            control={
              <Select
                label="Thinking messages"
                value={thinking}
                options={[
                  { value: "none", label: "None" },
                  { value: "latest", label: "Latest" },
                  { value: "all", label: "All" },
                ]}
                onChange={setThinkingMessagesPref}
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
        <SwitchRow
          title="Live typing"
          desc="Show replies as they are written."
          checked={liveTyping}
          onChange={setLiveTypingPref}
        />
        <YouShouldKnowRow />
      </SettingCard>
    </>
  );
}

function SidebarSection() {
  const pinNew = usePref(getPinNewSessions, onPinNewSessionsChanged);
  const pinNewWs = usePref(getPinNewWorkspaces, onPinNewWorkspacesChanged);
  return (
    <>
      <SettingsGroupLabel>Sidebar</SettingsGroupLabel>
      <SettingCard>
        <SwitchRow
          title="Pin new sessions"
          checked={pinNew}
          onChange={setPinNewSessions}
        />
        <SwitchRow
          title="Pin new workspaces"
          checked={pinNewWs}
          onChange={setPinNewWorkspaces}
        />
      </SettingCard>
      <SettingsHint>
        Filters and tools are in the sidebar&rsquo;s own menu.
      </SettingsHint>
    </>
  );
}

function LinksSection() {
  const onGithub = usePref(getPrLinksOnGithubPref, onPrLinksOnGithubChanged);
  const autoOpen = usePref(getPreviewAutoOpenPref, onPreviewAutoOpenChanged);
  const inBrowserTab = useLinksInBrowserTab();
  return (
    <>
      <SettingsGroupLabel>Links</SettingsGroupLabel>
      <SettingCard>
        <SwitchRow
          title="Open links in the Browser tab"
          desc="Off uses your own browser."
          checked={inBrowserTab}
          onChange={setLinksInBrowserTabPref}
        />
        {inBrowserTab && (
          <SwitchRow
            title="Open previews when ready"
            checked={autoOpen}
            onChange={setPreviewAutoOpenPref}
          />
        )}
        <SwitchRow
          title="Open pull requests on GitHub"
          desc="This device only."
          checked={onGithub}
          onChange={setPrLinksOnGithubPref}
        />
      </SettingCard>
    </>
  );
}

function DeskSection() {
  const shown = useDeskShown();
  const voice = usePref(getDeskVoicePref, onDeskVoiceChanged);
  return (
    <>
      <SettingsGroupLabel>Desk</SettingsGroupLabel>
      <SettingCard>
        <SwitchRow
          title="Show Desk"
          desc="Adds the Desk button and ⌘J."
          checked={shown}
          onChange={setDeskShownPref}
        />
        {shown && (
          <SwitchRow
            title="Voice mode"
            checked={voice}
            onChange={setDeskVoicePref}
          />
        )}
      </SettingCard>
    </>
  );
}

function DebugSection() {
  const sessionContext = usePref(
    getSessionContextRowPref,
    onSessionContextRowChanged,
  );
  const serverHealth = usePref(
    getServerHealthMonitorPref,
    onServerHealthMonitorChanged,
  );
  return (
    <>
      <SettingsGroupLabel>Debug</SettingsGroupLabel>
      <SettingCard>
        <SwitchRow
          title="Session context"
          desc="Show what the model received first."
          checked={sessionContext}
          onChange={setSessionContextRowPref}
        />
        <SwitchRow
          title="Server health"
          desc="CPU, memory and disk in the sidebar."
          checked={serverHealth}
          onChange={setServerHealthMonitorPref}
        />
      </SettingCard>
    </>
  );
}

/** How the app looks and behaves for you. Everything here is yours alone. */
export function PreferencesPanel() {
  return (
    <SettingsPanel>
      <SettingsHeader title="Preferences" />
      <AppearanceSection />
      <NewSessionsSection />
      <ComposerSection />
      <TranscriptSection />
      <SidebarSection />
      <LinksSection />
      <VoiceAudioSection />
      <DictationVocabularySection />
      <DeskSection />
      <PersonalPromptPanel />
      <PendingSendsSection />
      <DebugSection />
    </SettingsPanel>
  );
}

function DictationVocabularySection() {
  const [saved, setSaved] = useState(getDictationVocabulary);
  const [draft, setDraft] = useState(saved);
  useEffect(
    () =>
      onDictationVocabularyChanged(() => {
        const next = getDictationVocabulary();
        setSaved(next);
        setDraft(next);
      }),
    [],
  );
  const dirty = draft.trim() !== saved;

  function save() {
    const next = setDictationVocabulary(draft);
    setSaved(next);
    setDraft(next);
  }

  return (
    <>
      <SettingsGroupLabel>Dictation words</SettingsGroupLabel>
      <SettingCard>
        <div className="flex flex-col gap-2.5 px-3.5 py-3">
          <Textarea
            aria-label="Dictation custom vocabulary"
            rows={2}
            maxLength={MAX_DICTATION_VOCABULARY_CHARS}
            value={draft}
            placeholder="Open Session, Daytona, TypeScript, oxlint"
            onChange={(event) => setDraft(event.target.value)}
            onBlur={() => {
              if (dirty) save();
            }}
          />
          <div className="flex items-center justify-between gap-2">
            <span className="text-meta text-faint">
              {draft.length}/{MAX_DICTATION_VOCABULARY_CHARS}
            </span>
            <div className="flex items-center gap-2">
              {saved && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setDictationVocabulary("");
                    setSaved("");
                    setDraft("");
                  }}
                >
                  Clear
                </Button>
              )}
              <Button size="sm" disabled={!dirty} onClick={save}>
                Save
              </Button>
            </div>
          </div>
        </div>
      </SettingCard>
      <SettingsHint>Names and terms dictation should spell right.</SettingsHint>
    </>
  );
}
