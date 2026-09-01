import React, {
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  useShortcutKeys,
  useShortcutLabel,
} from "../hooks/useShortcutBindings";
import { splitAttachments, imageFilesFromPaste } from "../lib/images";
import {
  appendImageAttachmentComment,
  deleteImageAttachmentComment,
  parseImageAttachmentComments,
  rebaseImageAttachmentReferences,
  updateImageAttachmentComment,
} from "../lib/image-attachment-comment";
import {
  clearDraft,
  loadDraft,
  onDraftsChanged,
  saveDraft,
} from "../lib/drafts";
import { appendDictation } from "../lib/dictation";
import { attachingLabel, isStaging } from "../lib/attachments";
import { useAttachmentUploads } from "../hooks/useAttachmentUploads";
import {
  composerHighlightHtml,
  composerMentionRanges,
  needsComposerHighlight,
  paintPillHover,
  pillRectAt,
} from "../lib/composer-highlight";
import { insertPastedSessionId } from "../lib/session-url";
import {
  composerDisplayOffset,
  projectComposerSessions,
} from "../lib/composer-session-projection";
import { useSessionNameProjection } from "../hooks/useSessionNameProjection";
import { usePeople } from "../lib/people";
import { ImageThumbs } from "./ImageThumbs";
import type { ImageRegionAnnotation } from "../lib/media-lightbox";
import { FileChips } from "./FileChips";
import { QuoteContext } from "./QuoteContext";
import { PastedTextContext } from "./PastedTextContext";
import { ComposerContextChip } from "./ComposerContextChip";
import {
  composePastedText,
  createPastedTextAttachment,
  shouldCollapsePastedText,
} from "../lib/pasted-text";
import { useFileMentions } from "./useFileMentions";
import {
  IconArrowUp,
  IconReturn,
  IconPaperclip,
  IconCrosshair,
  IconEye,
  IconNote,
  IconStopSquare,
  IconPencil,
  IconTrash,
} from "./icons";
import {
  composerBox,
  composerBoxExpanded,
  composerBoxMinimized,
  composerMenuWidth,
  composerSend,
  composerSendDefault,
  composerSendMinimizedFill,
  composerSendQueue,
  composerSendSteer,
  composerSendStop,
  composerMentionSpacing,
  composerTextarea,
  composerTextareaPadding,
  composerTextareaPaddingMinimized,
  composerToolbar,
  composerToolbarMinimized,
  composerToolbarScrollDivider,
} from "../lib/composer-classes";
import { noAutofill } from "../lib/composer-autofill";
import { paletteIconBtn, paletteIconBtnRound } from "../lib/palette-classes";
import { askSurface, noteSurface } from "../lib/tinted-surface";
import { cn } from "../ui/cn";
import { Tooltip } from "../ui/tooltip";
import { ContextMenu, Menu, MENU_ICON } from "../ui/menu";
import {
  effectiveSendKey,
  insideOpenFence,
  isSendCombo,
  MOD_ENTER_GLYPH,
} from "../lib/send-key";
import { getSendKeyPref, onSendKeyChanged } from "../lib/send-key-pref";
import { useDefaultModelPreference } from "../hooks/useDefaultModelPreference";
import { isApple } from "../lib/platform";
import { matchesShortcut } from "../lib/shortcuts";
import {
  getBusySendPrefs,
  onBusySendChanged,
  setBusySendPref,
  type BusySendPref,
} from "../lib/busy-send-pref";
import { getVimModePref, onVimModeChanged } from "../lib/vim-pref";
import { useVimMode } from "../hooks/useVimMode";
import { useIsPhone } from "../hooks/useIsPhone";
import { motion, AnimatePresence } from "motion/react";
import { composerMorph } from "../ui/motion";
import { shortModelLabel } from "./ModelEffortSelect";
import type { ComposerActions, ComposerConfig } from "../lib/composer-types";
import { composerRadius } from "../lib/composer-radius";
import {
  ComposerAddMenu,
  ComposerPressButton,
  StopConfirmModal,
  type ComposerMenu,
} from "./composer/ComposerControls";
import { ModelRow } from "./composer/ModelRow";
import { VoiceControl } from "./composer/VoiceControl";

interface Props {
  /**
   * Controlled draft text. Omit it (with `onChange`) to let the Composer own
   * the draft internally: the parent then receives the text via `onSend` and
   * stops re-rendering on every keystroke (the CommentableDiff draft-text
   * lesson). In uncontrolled mode the draft clears when `onSend` returns true,
   * meaning the message was actually consumed.
   */
  value?: string;
  onChange?: (value: string) => void;
  /** Composer activity for the session's live typing indicator. */
  onTyping?: (active: boolean) => void;
  /** Reports when dictation owns the input so a host can coordinate nearby UI. */
  onDictationActive?: (active: boolean) => void;
  config: ComposerConfig;
  actions: ComposerActions;
  /** Content visually attached to the composer above the draft field. */
  attached?: React.ReactNode;
  /** Extra row for the "+" menu, below the built-in ones. Same shape as
   * `sendMenu`: render a `composerMenuItem` button and call `close()` when it
   * is picked. */
  menuExtra?: (context: { close: () => void }) => React.ReactNode;
  /** Optional action rendered inside the "+" menu, such as scheduling. */
  sendMenu?: (context: {
    text: string;
    disabled: boolean;
    onScheduled: () => void;
  }) => React.ReactNode;
}

/**
 * Shared session composer (Claude/Codex-style): rounded container with an
 * auto-growing textarea and a bottom toolbar carrying compact model/effort pills,
 * a Goal target, a "+" add menu and the send button. Enter sends, Shift+Enter
 * newlines. With `mentionFetch`, typing "@" opens a file-path autocomplete.
 */
export function Composer({
  value,
  onChange,
  onTyping,
  onDictationActive,
  config: {
    draftKey,
    placeholder,
    disabled,
    sendDisabled,
    sendTitle,
    busy,
    stopping,
    stopRequest,
    models,
    defaultModel,
    model,
    modelDisabled,
    modelTitle,
    effort,
    fastMode,
    accounts,
    accountId,
    goal,
    usage,
    prefill,
    hint,
    attachmentShortcutActive,
    autoFocus,
    textareaRef: externalRef,
    images,
    files,
    staging,
    quote,
    noteMode,
    askMode,
    askExitPending,
  },
  actions: {
    onSend,
    onStop,
    onModelChange,
    onEffortChange,
    onFastModeChange,
    onAccountChange,
    onSetGoal,
    onImagesChange,
    onFilesChange,
    onAddAttachments,
    onRemovePendingImage,
    onRemovePendingFile,
    onQuoteClear,
    mentionFetch,
    paletteFetch,
    skillsFetch,
    onNoteModeChange,
    onAskModeExit,
  },
  menuExtra,
  attached,
  sendMenu,
}: Props) {
  const internalRef = useRef<HTMLTextAreaElement>(null);
  const textareaRef = externalRef ?? internalRef;
  const fileInputRef = useRef<HTMLInputElement>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const voiceOverlayRef = useRef<HTMLDivElement>(null);
  // Uncontrolled mode (no `value` prop): the draft lives here so keystrokes
  // re-render only the Composer, not the whole parent view. With a `draftKey`
  // it seeds from — and mirrors into — the draft store, so navigating away
  // and back doesn't lose typed work.
  const [innerValue, setInnerValue] = useState(() =>
    draftKey ? loadDraft(draftKey).text : "",
  );
  const [pastedTexts, setPastedTexts] = useState(() =>
    draftKey ? loadDraft(draftKey).pastedTexts : [],
  );
  const localUploads = useAttachmentUploads();
  const activeStaging = staging ?? localUploads.staging;
  const isPhone = useIsPhone();
  const attachChord = useShortcutLabel("composer-attach");
  const stopKeys = useShortcutKeys("run-stop");
  const effortUpLabel = useShortcutLabel("effort-up");
  const effortDownLabel = useShortcutLabel("effort-down");
  // "Send messages with" preference (Settings → Preferences): Enter or ⌘/Ctrl+Enter.
  // The stored answer is for real keyboards; a touch client resolves to
  // ⌘/Ctrl+Enter so its return key stays a newline (see effectiveSendKey).
  const [storedSendKey, setStoredSendKey] = useState(getSendKeyPref);
  useEffect(
    () => onSendKeyChanged(() => setStoredSendKey(getSendKeyPref())),
    [],
  );
  const sendKey = effectiveSendKey(storedSendKey);
  // The preference applies only to new sessions; this session's model remains
  // the value selected in the same menu.
  const { preferredDefaultModel, setPreferredDefaultModel } =
    useDefaultModelPreference();
  // Follow-up behavior preferences (Settings → Preferences): what each send
  // gesture — plain Enter/the send button vs ⌘/Ctrl+Enter — does while the
  // run is busy. Both configurable; defaults queue/steer.
  const [busySendPrefs, setBusySendPrefsState] = useState(getBusySendPrefs);
  useEffect(
    () => onBusySendChanged(() => setBusySendPrefsState(getBusySendPrefs())),
    [],
  );
  const [sendModifierHeld, setSendModifierHeld] = useState(false);
  useEffect(() => {
    const syncModifier = (e: KeyboardEvent) =>
      setSendModifierHeld(e.metaKey || e.ctrlKey);
    const clearModifier = () => setSendModifierHeld(false);
    window.addEventListener("keydown", syncModifier);
    window.addEventListener("keyup", syncModifier);
    window.addEventListener("blur", clearModifier);
    return () => {
      window.removeEventListener("keydown", syncModifier);
      window.removeEventListener("keyup", syncModifier);
      window.removeEventListener("blur", clearModifier);
    };
  }, []);
  // Vim mode preference (Settings → Preferences, default off).
  const [vimEnabled, setVimEnabled] = useState(getVimModePref);
  useEffect(() => onVimModeChanged(() => setVimEnabled(getVimModePref())), []);
  const isControlled = value !== undefined;
  const text = isControlled ? value : innerValue;
  const setText = isControlled ? (onChange ?? (() => {})) : setInnerValue;
  // The lightbox is hosted above the composer and keeps the callback from the
  // moment it opened. Keep its draft source current across several Shift+Enter
  // comments without making the global viewer own composer state.
  const textRef = useRef(text);
  useLayoutEffect(() => {
    textRef.current = text;
  }, [text]);
  // A session reference in the draft is stored as its id and shown as that
  // session's name (hooks/useSessionNameProjection.ts): the field renders
  // `displayText`, while the draft, the send and the clipboard keep the id.
  const sessionNames = useSessionNameProjection({ text, setText, textareaRef });
  const displayText = sessionNames.displayText;
  const setDisplayText = sessionNames.setDisplayText;
  useEffect(() => {
    if (!isControlled && draftKey) {
      saveDraft(draftKey, { text: innerValue, pastedTexts });
    }
  }, [isControlled, draftKey, innerValue, pastedTexts]);
  // A draft can also arrive from elsewhere: typed on the phone, or sent there
  // and cleared. Take it while the field is unfocused, so text can appear (or
  // go) under someone who is not looking, but never under their cursor.
  const pendingRemoteText = useRef<string | null>(null);
  useEffect(() => {
    if (isControlled || !draftKey) return;
    return onDraftsChanged(() => {
      const stored = loadDraft(draftKey).text;
      if (document.activeElement === textareaRef.current) {
        pendingRemoteText.current = stored;
        return;
      }
      pendingRemoteText.current = null;
      setInnerValue((current) => (current === stored ? current : stored));
    });
  }, [isControlled, draftKey, textareaRef]);
  // One-shot prefill (see the prop doc): each new seq folds the given text
  // into the draft and focuses the field for immediate editing. The fold
  // itself reads the latest draft through an effect event, so the trigger
  // stays just the prefill sequence.
  const prefillSeqRef = useRef(0);
  const applyPrefill = useEffectEvent(() => {
    if (!prefill || prefill.seq === prefillSeqRef.current) return;
    prefillSeqRef.current = prefill.seq;
    const next =
      !prefill.replace && text.trim()
        ? `${text.replace(/\s+$/, "")}\n${prefill.text}`
        : prefill.text;
    // Persist the handoff before React commits it. Restoring queued attachments
    // can emit a draft-store change in the same pass; if the store still holds
    // the old empty text, that event otherwise erases the restored message.
    if (!isControlled && draftKey) {
      saveDraft(draftKey, { text: next, pastedTexts });
    }
    setText(next);
    queueMicrotask(() => {
      const el = textareaRef.current;
      if (el) {
        el.focus();
        const at = composerDisplayOffset(
          projectComposerSessions(next),
          next.length,
        );
        el.selectionStart = el.selectionEnd = at;
      }
    });
  });
  useEffect(() => {
    applyPrefill();
  }, [prefill]);
  // Fire a send handler with the current draft; in uncontrolled mode a `true`
  // return means "consumed" — clear the draft (falsy keeps it, e.g. offline).
  function fireSend(
    handler: (
      t: string,
      opts?: { steer?: boolean },
    ) => boolean | void | Promise<boolean | void>,
    opts?: { steer?: boolean },
    /** A draft that has not reached state yet, which is what the dictation
     *  bar's ↑ sends: the transcript and the send land in one gesture, and
     *  the `setDisplayText` beside it has not committed. */
    overrideText?: string,
  ) {
    const sentPastedIds = new Set(
      pastedTexts.map((attachment) => attachment.id),
    );
    const consume = () => {
      onTyping?.(false);
      if (!isControlled) {
        // Clear the store before React commits the empty field. On iOS the send
        // button can blur the textarea first; a pending remote draft would then
        // see the old stored value and restore the message that just sent.
        if (draftKey) clearDraft(draftKey);
        setInnerValue("");
      }
      setPastedTexts((current) =>
        current.filter((attachment) => !sentPastedIds.has(attachment.id)),
      );
    };
    const consumed = handler(
      composePastedText(overrideText ?? text, pastedTexts),
      opts,
    );
    if (consumed instanceof Promise) {
      void consumed.then((result) => {
        if (result === true) consume();
      });
    } else if (consumed === true) {
      consume();
    }
  }
  const outgoingText = composePastedText(text, pastedTexts);
  /** Whether a given draft may be sent right now. The dictation bar asks about
   *  a draft it is about to write, so the question takes the text. */
  const sendBlockedFor = (draft: string) =>
    !!(
      (typeof sendDisabled === "function"
        ? sendDisabled(composePastedText(draft, pastedTexts))
        : sendDisabled) || isStaging(activeStaging)
    );
  const isSendDisabled = sendBlockedFor(text);
  const imgs = images || [];
  const fls = files || [];
  // The draft is the source of truth for annotation dots. Editing or deleting
  // their plain-text references directly therefore updates the next preview.
  const imageComments = parseImageAttachmentComments(text);
  // Notes accept images but not arbitrary files: images remain team-visible,
  // while files are agent-readable workspace context and belong to prompts.
  const canAttachImages = !!onImagesChange;
  const canAttachFiles = !noteMode && !!onFilesChange;
  const canAttach = canAttachImages || canAttachFiles;

  useEffect(() => {
    if (!attachmentShortcutActive || !canAttach) return;
    function onKeyDown(e: KeyboardEvent) {
      if (
        e.defaultPrevented ||
        e.repeat ||
        !matchesShortcut(e, "composer-attach")
      )
        return;
      e.preventDefault();
      fileInputRef.current?.click();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [attachmentShortcutActive, canAttach]);
  // Whether the "+" has anything to show. Images keep the attachment row
  // available in note mode, while the mode row remains the way back out.
  const hasAddMenu =
    canAttach || !!onSetGoal || !!onNoteModeChange || !!menuExtra || !!sendMenu;

  // Phones get a ChatGPT-style resting state: while the field is empty and
  // unfocused, the composer collapses to a single-row pill ("+ · placeholder ·
  // mic · send"), hiding the model/effort/goal chips. Note mode keeps this
  // compact yellow state too; focusing the field reveals its context chip.
  // Focusing the field or adding content expands it to the full toolbar.
  // The open model menu also holds it expanded: the portaled popup takes focus
  // (blurring the textarea), and collapsing would unmount the pill trigger and
  // slam the menu shut mid-interaction.
  const [focused, setFocused] = useState(false);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [dictating, setDictating] = useState(false);
  const [dictationClipping, setDictationClipping] = useState(false);
  const hasAttached = !!attached;
  const hasContent =
    !!text.trim() ||
    imgs.length > 0 ||
    fls.length > 0 ||
    isStaging(activeStaging) ||
    pastedTexts.length > 0 ||
    !!quote ||
    hasAttached;
  const minimized = isPhone && !focused && !hasContent && !modelMenuOpen;
  const composerIconButtonClass = cn(
    paletteIconBtn,
    minimized && paletteIconBtnRound,
    !minimized && "phone:[&_svg]:size-[22px]",
  );
  const addButtonClass = cn(
    composerIconButtonClass,
    minimized ? "ml-0" : "-ml-1.5",
  );
  const showSend = !busy || hasContent;
  function handleDictationActive(active: boolean) {
    setDictating(active);
    if (active) setDictationClipping(true);
    onDictationActive?.(active);
  }
  // Whether the send button/plain send steers right now: each gesture has its
  // own configured busy action — Enter/button uses the "enter" pref, holding
  // ⌘/Ctrl switches to the "mod" pref. (With ⌘/Ctrl+Enter as the send key the
  // modifier is held on every send, so it's one gesture — the "enter"
  // follow-up pref rules and the mod pref is moot.)
  const entSteer = busySendPrefs.enter === "steer";
  const modSteer = busySendPrefs.mod === "steer";
  const modifierPicks = sendKey === "enter";
  // Notes bypass the busy queue/steer machinery entirely — they post straight
  // to the team whether or not a turn is running.
  const steerSend =
    !noteMode &&
    !!busy &&
    (modifierPicks && sendModifierHeld ? modSteer : entSteer);
  // Picking a busy action from the send button's menu hands the OTHER one to
  // ⌘/Ctrl+Enter, so both actions always keep a key and each row shows exactly
  // one — with both prefs on the same action there is no way to reach the other
  // from the keyboard at all. Settings → Preferences still sets the two
  // gestures independently for anyone who wants them to agree.
  const pickBusySend = (pref: BusySendPref) => {
    setBusySendPref("enter", pref);
    if (modifierPicks)
      setBusySendPref("mod", pref === "queue" ? "steer" : "queue");
  };
  // Which keys land on each busy action right now, for that menu: the send key
  // runs the "enter" pref, and — when the modifier is free to pick (i.e. the
  // send key is plain Enter) — ⌘/Ctrl+Enter runs the "mod" pref. Both land on
  // one row when the two prefs agree.
  const busySendKeys = (pref: BusySendPref) =>
    [
      busySendPrefs.enter === pref &&
        (sendKey === "enter" ? "↩" : MOD_ENTER_GLYPH),
      modifierPicks && busySendPrefs.mod === pref && MOD_ENTER_GLYPH,
    ]
      .filter(Boolean)
      .join("  ");
  // The send key as keycaps for the button's tooltip. It is a preference
  // rather than a registry chord — Settings → Preferences owns which key
  // sends — so the caps come from lib/send-key, not from shortcutKeys.
  const sendKeyCaps =
    sendKey === "mod-enter" ? [MOD_ENTER_GLYPH] : [isApple ? "↵" : "Enter"];

  // Escape asked to stop the run and is waiting on an answer. A turn that
  // finishes on its own while the question is up leaves nothing to stop, so
  // the dialog goes away with it rather than stopping the NEXT turn.
  const [stopConfirm, setStopConfirm] = useState(false);
  const busyRef = useRef(busy);
  useLayoutEffect(() => {
    busyRef.current = busy;
  });
  useEffect(() => {
    if (!busy) setStopConfirm(false);
  }, [busy]);
  /** Raise the question. Deferred a microtask so the dialog mounts AFTER the
   *  keystroke that asked for it has finished dispatching: Base UI's dismissal
   *  listener would otherwise consume its own opener. */
  function requestStop() {
    queueMicrotask(() => {
      if (busyRef.current) setStopConfirm(true);
    });
  }
  // The same question, asked from outside (SessionViewer's ⌘. listener, which
  // reaches the reader who is in the transcript rather than the composer).
  // Seeded from the incoming value so a remount — the tab-bar + gives the
  // composer a fresh key — never reads as a fresh request.
  const lastStopRequest = useRef(stopRequest ?? 0);
  useEffect(() => {
    const asked = stopRequest ?? 0;
    if (asked === lastStopRequest.current) return;
    lastStopRequest.current = asked;
    if (busy && onStop && !disabled) requestStop();
  }, [stopRequest, busy, onStop, disabled]);

  // Which toolbar popover is open ("add" menu or "goal" editor). Closed on an
  // outside click or after an action.
  const [menu, setMenu] = useState<ComposerMenu>(null);
  useEffect(() => {
    // The goal editor is a portaled Base UI dialog — it dismisses itself
    // (backdrop / Escape) and lives outside .composer-pop-wrap, so this
    // handler would wrongly close it on any click inside it. Only the anchored
    // "add" menu needs outside-click dismissal here.
    if (menu !== "add") return;
    // Dismiss on a tap/click outside the popover. iOS doesn't reliably fire
    // `mousedown` on non-interactive elements, so listen for `touchstart` too —
    // otherwise the menu gets stuck open on mobile.
    function onDown(e: Event) {
      if (!(e.target as HTMLElement).closest(".composer-pop-wrap"))
        setMenu(null);
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("touchstart", onDown);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("touchstart", onDown);
    };
  }, [menu]);

  // iOS focus-preserving taps: a tap's default continuation (touchend →
  // synthesized mousedown → textarea blur → keyboard dismiss → click) makes
  // toolbar taps close the keyboard and, on an empty draft, collapse the
  // composer mid-tap. Cancelling pointerdown does NOT stop that on iOS — the
  // only reliable point is touchend itself. ComposerPressButton fires the
  // action there and cancels mouse synthesis; mouse and pen still use click.
  function attachFilesFromMenu() {
    setMenu(null);
    fileInputRef.current?.click();
  }
  function mentionFileFromMenu() {
    setMenu(null);
    startMention();
  }

  // Modal editing on the draft (Settings → Preferences → Vim mode). The engine
  // consumes keys in normal/visual modes; insert mode only claims Escape.
  const vim = useVimMode({
    enabled: vimEnabled,
    textareaRef,
    value: displayText,
    onChange: setDisplayText,
  });

  // "@"-mention file autocomplete (shared with the New-session prompt field).
  const {
    inputWrapRef: mentionInputWrapRef,
    popup: mentionPopup,
    inputProps: mentionInputProps,
    sync: syncMentions,
    handleKeyDown: handleMentionKeyDown,
    close: closeMentions,
  } = useFileMentions({
    value: displayText,
    onChange: setDisplayText,
    textareaRef,
    mentionFetch,
    paletteFetch,
    skillsFetch,
    actions: [
      ...(canAttach
        ? [
            {
              id: "add-files",
              label: "Add files and folders",
              description: "Attach context to this message",
              keywords: ["upload", "attach"],
              icon: <IconPaperclip size={16} />,
              run: () => fileInputRef.current?.click(),
            },
          ]
        : []),
      ...(onSetGoal
        ? [
            {
              id: "session-goal",
              label: goal ? "Edit session goal" : "Set session goal",
              description: "Guide every prompt in this session",
              keywords: ["target", "objective"],
              icon: <IconCrosshair size={16} />,
              run: () => setMenu("goal"),
            },
          ]
        : []),
      ...(onNoteModeChange
        ? [
            {
              id: "team-note",
              label: noteMode ? "Back to prompting" : "Write a team note",
              description: noteMode
                ? "Send the next message to the agent"
                : "Only your team will see it",
              keywords: ["internal", "note"],
              icon: <IconNote size={16} />,
              run: () => onNoteModeChange(!noteMode),
            },
          ]
        : []),
    ],
  });

  async function addFiles(picked: FileList | File[]) {
    if (!canAttach) return;
    if (onAddAttachments) {
      await onAddAttachments(picked);
      return;
    }
    const selected = Array.from(picked);
    const noteImageTypes = new Set([
      "image/png",
      "image/jpeg",
      "image/gif",
      "image/webp",
    ]);
    const allowed = (file: File) =>
      file.type.startsWith("image/") &&
      (!noteMode || noteImageTypes.has(file.type));
    const disallowed = canAttachFiles
      ? []
      : selected.filter((file) => !allowed(file));
    const accepted = canAttachFiles ? selected : selected.filter(allowed);
    const results = await localUploads.upload(accepted, (file, signal) =>
      splitAttachments([file], signal),
    );
    const newImgs = results.flatMap((result) => result.images);
    const newFls = results.flatMap((result) => result.files);
    // Images ride the vision channel; other files need a dedicated file channel
    // (if the parent only wired images, non-image files are simply ignored).
    if (newImgs.length) onImagesChange?.([...imgs, ...newImgs]);
    if (newFls.length && canAttachFiles) onFilesChange?.([...fls, ...newFls]);
    // Fail loudly rather than dropping oversized/failed uploads silently.
    const failures = [
      ...results.flatMap((result) => result.rejected),
      ...disallowed.map((file) =>
        noteMode
          ? `${file.name} (notes accept PNG, JPEG, GIF, or WebP images)`
          : `${file.name} (only images are supported)`,
      ),
    ];
    if (failures.length) alert(`Couldn't attach:\n${failures.join("\n")}`);
  }

  function handlePaste(e: React.ClipboardEvent) {
    // A session link goes in as the id it carries, which is the same reference
    // in a third of the room and chips the same way (lib/session-url.ts).
    if (insertPastedSessionId(e)) return;
    const pastedText = e.clipboardData?.getData("text/plain") ?? "";
    if (shouldCollapsePastedText(pastedText)) {
      e.preventDefault();
      setPastedTexts((current) => [
        ...current,
        createPastedTextAttachment(pastedText),
      ]);
      return;
    }
    if (!canAttach) return;
    const pasted = imageFilesFromPaste(e);
    if (pasted.length) {
      e.preventDefault();
      void addFiles(pasted);
    }
  }

  function removeImage(i: number) {
    onImagesChange?.(imgs.filter((_, idx) => idx !== i));
    const next = rebaseImageAttachmentReferences(textRef.current, i);
    textRef.current = next;
    setText(next);
  }

  function writeAnnotationDraft(next: string) {
    textRef.current = next;
    if (!isControlled && draftKey) saveDraft(draftKey, { text: next });
    setText(next);
  }

  function commentOnImage(
    i: number,
    region: { x: number; y: number; width: number; height: number },
    comment: string,
    keepOpen: boolean,
    existing?: ImageRegionAnnotation,
  ) {
    const next = existing
      ? updateImageAttachmentComment(
          textRef.current,
          { ...existing, imageIndex: i },
          region,
          comment,
        )
      : appendImageAttachmentComment(textRef.current, i, region, comment);
    writeAnnotationDraft(next);
    if (!keepOpen) {
      // The lightbox restores focus to its thumbnail first. Run after that
      // cleanup so the newly added reference is ready to edit or send.
      setTimeout(() => {
        const field = textareaRef.current;
        field?.focus({ preventScroll: true });
        if (field)
          field.selectionStart = field.selectionEnd = field.value.length;
      }, 0);
    }
  }

  function deleteCommentOnImage(i: number, annotation: ImageRegionAnnotation) {
    writeAnnotationDraft(
      deleteImageAttachmentComment(textRef.current, {
        ...annotation,
        imageIndex: i,
      }),
    );
  }

  function removeFile(i: number) {
    onFilesChange?.(fls.filter((_, idx) => idx !== i));
  }

  // Insert an "@" at the caret and focus the textarea, opening the mention popup.
  function startMention() {
    const el = textareaRef.current;
    const at = el ? el.selectionStart : displayText.length;
    const next = displayText.slice(0, at) + "@" + displayText.slice(at);
    setDisplayText(next);
    queueMicrotask(() => {
      const t = textareaRef.current;
      if (t) {
        t.focus();
        t.selectionStart = t.selectionEnd = at + 1;
      }
      syncMentions();
    });
  }

  // Once the draft grows past the composer's max-height the textarea scrolls
  // internally, and without help the clipped text ends in a hard cut at both
  // ends of the field. Each end gets the treatment its own edge asks for.
  //
  // The TOP has no chrome to hold a line — the text simply meets the box's
  // padding — so it dissolves: a scroll-aware mask over the input region,
  // applied only once you have actually scrolled down, so a resting first line
  // never fades.
  //
  // The BOTTOM does have chrome: the toolbar row sits right under the fold. A
  // fade there would dim the last line of a draft you are still writing, so it
  // takes a hairline instead (composerToolbarScrollDivider), which says the
  // text continues under the controls without touching the text itself. It is
  // drawn while content sits below the fold and stands down at the end of the
  // draft, so a field that fits keeps an undivided box.
  //
  // Both are driven imperatively (mask straight onto the wrapper, attribute
  // straight onto the toolbar) rather than through React state: a state
  // round-trip lags the scroll by a render, so the edge is a frame stale during
  // momentum scroll and reads as a flicker (or, if a scroll event coalesces,
  // never updates at all). They must track scrollTop exactly, so we set them in
  // the same handler that observes the scroll.
  //
  // Both are written from what was last applied: this runs on every scroll
  // frame and every keystroke, and re-writing the same mask re-invalidates
  // style for nothing. Every measurement is taken BEFORE the first write for
  // the same reason: reading scrollTop after touching the mask forces the
  // layout back out again mid-scroll.
  const FADE_PX = 26;
  const appliedEdges = useRef<{
    wrap: HTMLElement;
    mask: string;
    under: boolean;
  } | null>(null);
  /** Returns the scrollTop it measured, so a caller that has to write it
   *  somewhere else (the mirror) doesn't read the field a second time. */
  function updateScrollEdges(el: HTMLTextAreaElement): number {
    const wrap = el.parentElement; // .composer-input-wrap (masks textarea + hl mirror as one)
    if (!wrap) return el.scrollTop;
    // Not `> 0`: scrollTop is fractional at fractional zoom, and an overscroll
    // bounce drives it past both ends.
    const scrollTop = el.scrollTop;
    const top = scrollTop > 1;
    const under = scrollTop + el.clientHeight < el.scrollHeight - 1;
    const mask = top
      ? `linear-gradient(to bottom, transparent 0, #000 ${FADE_PX}px, #000 100%)`
      : "";
    const applied =
      appliedEdges.current?.wrap === wrap ? appliedEdges.current : null;
    if (!applied || applied.mask !== mask) {
      wrap.style.setProperty("-webkit-mask-image", mask);
      wrap.style.setProperty("mask-image", mask);
    }
    if (!applied || applied.under !== under)
      toolbarRef.current?.toggleAttribute("data-scroll-under", under);
    appliedEdges.current = { wrap, mask, under };
    return scrollTop;
  }

  // Auto-grow to fit the draft. Only a NON-EMPTY draft is measured; an empty
  // one drops the inline height and takes its size straight from CSS — the
  // resting floor of the expanded field (min-height per breakpoint), or a
  // single line in the minimized phone pill (min-height: 0 + rows=1). So the
  // floor and the cap have exactly one home, the stylesheet, instead of magic
  // numbers here that had to be kept in sync with it.
  //
  // Not measuring an empty draft also takes out the only path by which the
  // resting pill can come back several lines tall after sending a long message
  // (seen on the iOS PWA, never reproduced in Chrome): a `scrollHeight` read
  // that doesn't reflect the just-cleared value gets written straight back onto
  // the element. With nothing measured there's nothing stale to write.
  //
  // The reset before the measure is what lets the field shrink, so it can't be
  // skipped while a height is applied. Everything around it is written from
  // what was last applied, so a draft that isn't changing the field's height
  // stops re-writing it.
  const appliedHeight = useRef("");
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    if (appliedHeight.current) el.style.height = "";
    // min-/max-height clamp this, so tall drafts scroll internally at the cap.
    const height = displayText ? `${el.scrollHeight}px` : "";
    if (height) el.style.height = height;
    appliedHeight.current = height;
    // Height (and thus clip state) just changed — re-evaluate both edges.
    updateScrollEdges(el);
  }, [displayText, isPhone, minimized, textareaRef]);

  // The draft can also start or stop clipping without a keystroke: the pane is
  // resized, a split opens, the phone keyboard takes the field's cap down. The
  // observer answers those the same way the effect answers typing.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => updateScrollEdges(el));
    observer.observe(el);
    return () => observer.disconnect();
  }, [textareaRef]);

  // Live code styling: when the draft contains a backtick, a metrics-identical
  // mirror div paints `inline` / ```fence``` tints behind a transparent-text
  // textarea (native caret/selection/undo stay). Plain drafts skip the mirror
  // entirely — the stock opaque textarea has zero desync risk.
  // The same mirror carries the @-mention pills, so it also mounts for a draft
  // that only mentions somebody. The roster is reactive: it arrives from the
  // server after first paint, and without the re-render an already-typed
  // mention would only chip on the next keystroke.
  const people = usePeople();
  const hlRef = useRef<HTMLDivElement>(null);
  const sessionRanges = sessionNames.sessions;
  const hlActive = needsComposerHighlight(displayText, people, sessionRanges);
  const hlHtml = hlActive
    ? composerHighlightHtml(displayText, people, sessionRanges)
    : "";
  const mentionRanges = composerMentionRanges(displayText, people);
  // A mention pill's padding is bought out of the space beside it, so the draft
  // pays a wider word space only while it holds one. Both the field and the
  // mirror wear it, or the painted text slides off the caret behind it. Session
  // pills use a narrower wash instead: a pasted link often sits inside a full
  // sentence, where widening every space is visibly wrong.
  const hasMention = mentionRanges.length > 0;
  useEffect(() => {
    // The textarea scrolls internally at max-height; keep the mirror locked to it.
    const el = textareaRef.current;
    const hl = hlRef.current;
    if (el && hl) hl.scrollTop = el.scrollTop;
  }, [hlHtml, textareaRef]);

  // The menu a press on a pill opens, anchored to the box that was pressed.
  // Held in display offsets, like every other range in this component; any
  // edit closes it, so they cannot go stale under it.
  const [pillMenu, setPillMenu] = useState<{
    kind: "session" | "mention";
    start: number;
    end: number;
    rect: { left: number; top: number; width: number; height: number };
  } | null>(null);

  // How a press finds the pill under it: the textarea covers the mirror, so
  // the press lands on the FIELD, and the browser has already placed the caret
  // by the time click fires. A caret strictly inside a pill came from pressing
  // it. The edges still place an ordinary caret, which is the margin that
  // keeps a click beside a reference from claiming one.
  function pillAtCaret(el: HTMLTextAreaElement) {
    if (el.selectionStart !== el.selectionEnd) return null;
    const caret = el.selectionStart;
    const session = sessionNames.sessions.find(
      (s) => caret > s.start && caret < s.end,
    );
    if (session)
      return {
        kind: "session" as const,
        start: session.start,
        end: session.end,
      };
    const mention = mentionRanges.find((r) => caret > r.start && caret < r.end);
    if (mention)
      return {
        kind: "mention" as const,
        start: mention.start,
        end: mention.end,
      };
    return null;
  }

  // A press used to erase the reference outright, with nothing offered and
  // nothing asked. A pill is one object built out of one gesture, so the same
  // gesture should not be able to destroy it by accident. There was also no
  // way at all to point a reference somewhere else short of deleting it and
  // starting over. Pressing one now selects it and offers what you can do to
  // it; Remove is a row in that menu rather than the whole interaction.
  function openPillMenu(
    el: HTMLTextAreaElement,
    x: number,
    y: number,
  ): boolean {
    const hit = pillAtCaret(el);
    if (!hit) return false;
    // Selected, because the menu is ABOUT that reference and a menu that
    // names no subject is a menu you have to guess at. It is also already the
    // state Change wants to leave behind.
    el.setSelectionRange(hit.start, hit.end);
    // The pressed point is the fallback anchor: a press that reached here
    // found a pill in the TEXT, but the mirror it is painted in only mounts
    // for a draft that needs highlighting, so there is not always a box.
    const rect = pillRectAt(hlRef.current, x, y);
    setPillMenu({
      ...hit,
      rect: rect
        ? {
            left: rect.left,
            top: rect.top,
            width: rect.width,
            height: rect.height,
          }
        : { left: x, top: y, width: 0, height: 0 },
    });
    return true;
  }

  // Base UI positions against an element; a pill is a box of text with no
  // element of its own, so it is handed the box instead. Rebuilt with the
  // menu's own state, which is the only thing that moves it.
  const pillAnchor = pillMenu
    ? {
        getBoundingClientRect: () =>
          new DOMRect(
            pillMenu.rect.left,
            pillMenu.rect.top,
            pillMenu.rect.width,
            pillMenu.rect.height,
          ),
      }
    : null;

  /** Point the reference somewhere else, rather than at nothing. */
  function changePill() {
    const el = textareaRef.current;
    if (!el || !pillMenu) return;
    const { kind, start, end } = pillMenu;
    setPillMenu(null);
    el.focus();
    if (kind === "mention") {
      // Everything after the `@` is selected and the picker re-opens on it, so
      // typing searches for the person to put there instead. Selecting the
      // `@` too would end the mention the moment the first letter replaced it.
      el.setSelectionRange(start + 1, end);
      syncMentions();
    } else {
      // A session has no picker to re-open: the whole token stays selected,
      // and typing or pasting another link over it replaces the reference
      // (the projection consumes a token that any edit touches).
      el.setSelectionRange(start, end);
    }
  }

  /** What the press itself used to do, now that it is asked for. */
  function removePill() {
    const el = textareaRef.current;
    if (!el || !pillMenu) return;
    const { start } = pillMenu;
    setPillMenu(null);
    el.focus();
    // Put the caret back strictly inside the reference and go through the
    // erase path below, which already owns the undo entry each kind needs.
    el.setSelectionRange(start + 1, start + 1);
    removePillAtCaret(el);
  }

  // Erase one whole pill. Mentions keep native undo through execCommand;
  // session tokens use the projection's canonical history.
  function removePillAtCaret(el: HTMLTextAreaElement): boolean {
    // A session reference erases through the projection, which owns its
    // canonical id and its own undo entry.
    if (sessionNames.removeTokenAtCaret(el)) return true;
    if (el.selectionStart !== el.selectionEnd) return false;
    const caret = el.selectionStart;
    const hit = mentionRanges.find((r) => caret > r.start && caret < r.end);
    if (!hit) return false;
    // The trailing space goes with it, so removing a pill mid-sentence
    // doesn't leave a double space behind.
    const end = displayText[hit.end] === " " ? hit.end + 1 : hit.end;
    el.setSelectionRange(hit.start, end);
    if (!document.execCommand("delete")) {
      setDisplayText(
        displayText.slice(0, hit.start) + displayText.slice(end),
        hit.start,
        hit.start,
        { editHint: { start: hit.start, end } },
      );
    }
    return true;
  }

  // Backspace at a pill's end takes the whole reference in one press, and Delete
  // at its start does the same forwards. The pill reads as one object, so it
  // has to erase like one — picking it apart a letter at a time would also
  // spend two keystrokes rendering a half-name that chips back into prose.
  //
  // Backspace one step further out, from just past the space a mention is
  // followed by, takes the space AND the name together. That is the common
  // case, because the picker leaves the caret exactly there — and taking only
  // the space would be worse than useless: the name loses the terminator that
  // makes it a mention, so the pill would vanish into plain text and the next
  // press would start eating letters.
  function deleteWholePill(key: string, el: HTMLTextAreaElement): boolean {
    if (sessionNames.deleteTokenAtEdge(key, el)) return true;
    if (el.selectionStart !== el.selectionEnd) return false;
    const caret = el.selectionStart;
    const back = key === "Backspace";
    const hit = mentionRanges.find((r) =>
      back
        ? caret === r.end || (caret === r.end + 1 && displayText[r.end] === " ")
        : caret === r.start,
    );
    if (!hit) return false;
    const end = back ? Math.max(caret, hit.end) : hit.end;
    el.setSelectionRange(hit.start, end);
    if (!document.execCommand("delete")) {
      setDisplayText(
        displayText.slice(0, hit.start) + displayText.slice(end),
        hit.start,
        hit.start,
        { editHint: { start: hit.start, end } },
      );
    }
    return true;
  }

  const hoveredPill = useRef<HTMLElement | null>(null);
  function updatePillHover(x: number, y: number) {
    paintPillHover(hlRef.current, textareaRef.current, x, y, hoveredPill);
  }
  // Every keystroke rewrites the mirror's innerHTML, so the hovered span is a
  // dangling node from the render before it.
  useEffect(() => {
    hoveredPill.current = null;
    if (textareaRef.current) textareaRef.current.style.cursor = "";
  }, [hlHtml, textareaRef]);
  // The menu holds offsets into the draft and hangs off a box that the next
  // line-break moves, so any edit takes it down, including the one its own
  // Remove row makes. Base UI already closes it on Escape, an outside press
  // and a scroll; typing is the case it cannot see, because the field it
  // would be watching is not the one focus is in.
  useEffect(() => {
    setPillMenu(null);
  }, [displayText]);

  // Dictated text lands at the end of the draft (with a joining space) and
  // focus returns to the textarea so you can touch it up and send. Appending
  // rather than replacing is what lets someone keep ✓, read the transcript,
  // and press the mic again to add to it.
  function insertDictation(t: string) {
    const next = appendDictation(displayText, t);
    setDisplayText(next);
    queueMicrotask(() => {
      const el = textareaRef.current;
      if (el) {
        el.focus();
        el.selectionStart = el.selectionEnd = next.length;
      }
    });
  }

  /** The dictation bar's ↑: the same append, sent as it stands. What leaves is
   *  the CANONICAL draft (a session reference is an id there and a title in
   *  the field), handed to `fireSend` directly because the state write beside
   *  it has not committed yet. A draft that cannot be sent (offline, a host
   *  that vetoes it) still keeps the text, so nothing dictated is lost. */
  function sendDictation(t: string) {
    insertDictation(t);
    const nextCanonical = appendDictation(text, t);
    if (disabled || sendBlockedFor(nextCanonical)) return;
    fireSend(onSend, steerSend ? { steer: true } : undefined, nextCanonical);
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (canAttach && matchesShortcut(e, "composer-attach")) {
      e.preventDefault();
      fileInputRef.current?.click();
      return;
    }
    // An undo that has to cross a session token replays canonical state; every
    // other ⌘Z is left to the field's own history.
    if (sessionNames.handleUndoRedoKey(e)) return;
    if (handleMentionKeyDown(e)) return;
    if (e.nativeEvent.isComposing) return;
    if (
      (e.key === "Backspace" || e.key === "Delete") &&
      !e.metaKey &&
      !e.ctrlKey &&
      !e.altKey &&
      textareaRef.current &&
      deleteWholePill(e.key, textareaRef.current)
    ) {
      e.preventDefault();
      return;
    }
    // Vim mode gets the key before the send/stop logic: in insert mode it only
    // claims Escape (drop to normal mode — a second, bare Escape in normal mode
    // falls through here to the busy-stop below), and Enter is never consumed,
    // so the send combos keep working in any mode.
    if (vim.handleKeyDown(e)) return;
    // Esc while a run is busy asks before interrupting the turn (the stop
    // button itself still stops on the press).
    if (e.key === "Escape" && busy && onStop && !disabled) {
      e.preventDefault();
      e.stopPropagation();
      requestStop();
      return;
    }
    // Inside an unclosed ``` fence, plain Enter inserts a newline instead of
    // sending — you can't type a multi-line code block otherwise. Closing the
    // fence (or ⌘/Ctrl+Enter, or the send button) sends as usual.
    if (
      sendKey === "enter" &&
      e.key === "Enter" &&
      !e.shiftKey &&
      !e.metaKey &&
      !e.ctrlKey
    ) {
      const displayCaret =
        textareaRef.current?.selectionStart ?? displayText.length;
      const canonicalCaret = sessionNames.canonicalOffset(displayCaret);
      if (insideOpenFence(text, canonicalCaret)) return; // let the newline land
    }
    // While a run is busy, ⌘/Ctrl+Enter does its own configured follow-up
    // action (Settings → Preferences, default steer: fold into the running turn
    // now, WITHOUT stopping it). Only when plain Enter is the send key —
    // otherwise ⌘/Ctrl+Enter already means "send".
    if (
      busy &&
      sendKey === "enter" &&
      e.key === "Enter" &&
      (e.metaKey || e.ctrlKey)
    ) {
      e.preventDefault();
      if (!disabled && !isSendDisabled)
        fireSend(onSend, modSteer ? { steer: true } : undefined);
      return;
    }
    if (isSendCombo(e, sendKey)) {
      e.preventDefault();
      if (!disabled && !isSendDisabled)
        fireSend(onSend, busy && entSteer ? { steer: true } : undefined);
    }
  }

  const effectiveModel = model || defaultModel;
  // Ask mode paints the box itself; note mode paints the `before:` layer over
  // it, so note wins for the message you are writing while ask keeps the
  // session's own colour underneath.
  const surfaceStyle = {
    ...(askMode
      ? { backgroundColor: askSurface("var(--composer-surface)") }
      : {}),
    "--composer-note-bg": noteSurface("var(--composer-surface)"),
  } as React.CSSProperties;
  const dictationSurfaceStyle: React.CSSProperties | undefined = noteMode
    ? { backgroundColor: noteSurface("var(--composer-surface)") }
    : askMode
      ? { backgroundColor: askSurface("var(--composer-surface)") }
      : undefined;

  return (
    <div className="mx-auto w-full max-w-[calc(var(--session-col)+40px)]">
      {/* Queued/steered messages fold out from behind the composer box —
          a sibling flap tucked under its top edge, not a box-in-box. */}
      {attached}
      <motion.div
        layout
        // `layout` here is for ONE move: the phone pill morphing to and from the
        // full composer. `layoutDependency` is what keeps it to that move.
        //
        // Without it Motion re-measures on every render, and this component
        // re-renders on every keystroke, so a draft growing by a line was
        // animated like a state change: the box took a 300ms spring, which
        // Motion runs as a scaleY on the box (measured 0.84 on the first frame),
        // and the text slid ~20px up under the caret after the character had
        // already landed while the toolbar dipped 8px and floated back. Anything
        // in the box that isn't itself a projection node was squashed for those
        // 300ms: the attachment rows, the note tint, the vim key bar.
        //
        // Keyed to `minimized`, the measure is skipped entirely while you type
        // (the field just grows, as a textarea does) and taken fresh at the
        // moment the pill flips, which is the only time this box changes shape
        // rather than size. On desktop `minimized` never changes, so the box
        // never measures at all. Content that should still glide animates its
        // OWN height instead. See ComposerContextChip.
        layoutDependency={minimized}
        // Pill when collapsed, --composer-radius when expanded (see
        // composerRadius above) — the same corner the queue flap and the
        // mention popup use, so the surfaces that tuck under and hang off this
        // box share its edge. It used to be a hardcoded 32, which made the
        // composer the only surface on a session page rounder than 18.9px, and
        // the toolbar buttons it was cut to follow are no longer circles.
        // initial={false}: adopt the target radius instantly on mount —
        // otherwise Motion animates from the stylesheet value on load, a
        // visible radius morph.
        //
        // With a flap attached the two are ONE control rather than a pill
        // parked on a panel: the flap keeps the rounded top, this keeps the
        // rounded bottom, and the seam where they meet squares off.
        initial={false}
        animate={{
          borderTopLeftRadius: minimized
            ? 999
            : hasAttached
              ? 0
              : composerRadius(),
          borderTopRightRadius: minimized
            ? 999
            : hasAttached
              ? 0
              : composerRadius(),
          borderBottomLeftRadius: minimized ? 999 : composerRadius(),
          borderBottomRightRadius: minimized ? 999 : composerRadius(),
          // The controls stay in their toolbar positions while the top edge
          // comes down to wrap them. Returning to auto reveals the draft.
          height: dictating ? (minimized ? 50 : isPhone ? 60 : 62) : "auto",
        }}
        transition={composerMorph}
        onAnimationComplete={() => {
          // Keep the draft clipped until the top edge has finished expanding.
          // Dropping overflow at the start would reveal text outside the box.
          if (!dictating) setDictationClipping(false);
        }}
        // `composer` and `composer-min` stay on the markup as hooks, not as
        // styling: `.composer.composer-min .palette-icon-btn` is styled from
        // the stylesheet, and VoiceInput's recording overlay fills `.composer`
        // as its positioned ancestor. (The phone keyboard gap used to read this
        // pair too; it now keys off `--kb-inset` instead, which does not care
        // which composer is up — see lib/session-viewer-classes.ts.)
        className={cn(
          "composer",
          minimized && "composer-min",
          composerBox,
          minimized ? composerBoxMinimized : composerBoxExpanded,
          "isolate before:pointer-events-none before:absolute before:inset-0 before:z-0 before:rounded-[inherit] before:[corner-shape:inherit] before:bg-[var(--composer-note-bg)] before:opacity-0 before:transition-opacity before:duration-150 before:ease-[cubic-bezier(0.32,0.72,0,1)] [&>*]:relative [&>*]:z-[1]",
          noteMode && "before:opacity-100",
          dictationClipping && "overflow-hidden",
          disabled && "opacity-60",
        )}
        style={surfaceStyle}
      >
        {/* The mic lives in the toolbar, but recording replaces this entire
            surface. VoiceInput portals the active bar here so a positioned
            toolbar cannot trap it at one-row height. */}
        <div
          ref={voiceOverlayRef}
          className="pointer-events-none !absolute inset-0 !z-[6]"
        />
        {/* Vim mode indicator — only surfaces outside insert mode, so plain
            typing looks identical with the pref on. Sits above the input wrap's
            scroll-fade mask. */}
        {vimEnabled && vim.mode !== "insert" && (
          <div className="pointer-events-none absolute right-3 top-2 z-[2] select-none rounded-sm border border-line bg-surface px-1.5 py-0.5 text-meta font-semibold tracking-wider text-dim">
            {vim.mode === "normal"
              ? "NORMAL"
              : vim.mode === "visual"
                ? "VISUAL"
                : "V-LINE"}
          </div>
        )}
        <div className="flex flex-wrap items-start gap-x-1">
          <AnimatePresence initial={false}>
            {/* Ask mode first: it encloses everything else in the row, being
                the session's own state rather than something attached to the
                next send, so the row reads outside-in. Hidden in the phone's
                resting pill, which is one line tall and has no room for a
                chip above the field. */}
            {!minimized && askMode && (
              <ComposerContextChip
                key="ask-mode"
                icon={<IconEye size={15} />}
                label="Ask"
                title={
                  onAskModeExit
                    ? "This session can read the code but not change it. The ✕ switches to code mode."
                    : "This session can read the code but not change it."
                }
                meta={askExitPending ? "Switching…" : undefined}
                tone="ask"
                // Leaving cuts a worktree, which the server may refuse or take
                // a moment over, so the ✕ only appears where it is real.
                onRemove={onAskModeExit}
                removeLabel="Switch to code mode"
                disabled={disabled || askExitPending}
              />
            )}
            {/* Note mode is context attached to the next send, exactly like a
                quoted selection, so it says so in the same place and the same
                shape rather than as a marker down in the toolbar. The resting
                phone pill communicates it through its yellow surface and
                placeholder; the named chip appears once the field expands. */}
            {noteMode && !minimized && (
              <ComposerContextChip
                key="note-mode"
                icon={<IconNote size={15} />}
                label="Team note"
                title="The agent won't read this."
                tone="note"
                onRemove={() => onNoteModeChange?.(false)}
                removeLabel="Leave note mode"
                disabled={disabled}
              />
            )}
            {quote && (
              <QuoteContext
                key={quote.id}
                quote={quote}
                // Detaching the passage leaves you in the message you were
                // writing — the ✕ shouldn't cost you the caret as well.
                onRemove={() => {
                  onQuoteClear?.();
                  textareaRef.current?.focus({ preventScroll: true });
                }}
                disabled={disabled}
              />
            )}
            {pastedTexts.map((attachment) => (
              <PastedTextContext
                key={attachment.id}
                attachment={attachment}
                onRemove={() => {
                  setPastedTexts((current) =>
                    current.filter((item) => item.id !== attachment.id),
                  );
                  textareaRef.current?.focus({ preventScroll: true });
                }}
                disabled={disabled}
              />
            ))}
          </AnimatePresence>
        </div>
        <ImageThumbs
          images={imgs}
          pending={activeStaging.images}
          onRemove={removeImage}
          comments={imageComments}
          onComment={canAttachImages ? commentOnImage : undefined}
          onDeleteComment={canAttachImages ? deleteCommentOnImage : undefined}
          onRemovePending={
            staging ? onRemovePendingImage : localUploads.cancelPendingImage
          }
          disabled={disabled}
        />
        <FileChips
          files={fls}
          pending={activeStaging.files}
          onRemove={removeFile}
          onRemovePending={
            staging ? onRemovePendingFile : localUploads.cancelPendingFile
          }
          disabled={disabled}
        />
        {attachingLabel(activeStaging) && (
          <span className="sr-only" role="status">
            {attachingLabel(activeStaging)}
          </span>
        )}
        <motion.div
          layout="position"
          transition={composerMorph}
          // Same dependency as the box above: these wrappers exist so the
          // controls glide when the pill re-orders them, and they have to skip
          // the same renders it does. A wrapper still measuring per keystroke
          // would spring the field's position against a box that isn't moving.
          layoutDependency={minimized}
          // Positioned for the code mirror below (and the scroll-fade mask the
          // auto-grow effect writes onto it).
          className={cn("relative", minimized && "order-2 min-w-0 flex-auto")}
          ref={mentionInputWrapRef}
        >
          {mentionPopup}
          {hlActive && (
            // `composer-hl` stays as a hook: the tint spans inside this mirror
            // are written as innerHTML by lib/composer-highlight.ts, so their
            // `.cmp-code` / `.cmp-fence` rules can only be reached through it.
            <div
              ref={hlRef}
              className={cn(
                "composer-hl",
                composerTextarea,
                composerTextareaPadding,
                "pointer-events-none absolute inset-0 z-0 overflow-hidden text-fg break-words whitespace-pre-wrap select-none",
                hasMention && composerMentionSpacing,
                // A pill's wash reaches past its own box (base.css), so one at
                // either end of a line would be cut off by this box. The
                // padding pushes the clip edge out; the matching negative
                // margin takes it back out of the content origin, so every
                // glyph still lands exactly where the textarea puts it.
                //
                // The width is the third of those three and it was missing.
                // `inset-0` sizes this box from its container, and a negative
                // margin does not grow an over-constrained absolute box — so
                // the padding came out of the CONTENT, leaving the mirror 12px
                // narrower than the field (measured 672 against 684). It wraps
                // a word early at that width, which put the painted text on a
                // different line from the caret and the selection under it on
                // any draft long enough to wrap. Asking for the 12px back
                // makes the two agree glyph for glyph again.
                "-mx-[6px] w-[calc(100%+12px)] px-[6px]",
              )}
              aria-hidden="true"
              dangerouslySetInnerHTML={{ __html: hlHtml }}
            />
          )}
          <textarea
            ref={textareaRef}
            {...mentionInputProps}
            // `composer-textarea` stays as a class NAME hook: the sidebar swipe
            // guard (lib/sidebar-swipe.ts) and SessionViewer's global keys both
            // ask whether the caret is in a composer by looking for it.
            className={cn(
              "composer-textarea",
              composerTextarea,
              hasMention && composerMentionSpacing,
              minimized
                ? composerTextareaPaddingMinimized
                : composerTextareaPadding,
              // A neutral grey placeholder on a tinted surface reads cool and
              // dirty against it, and it loses contrast too: #949494 is 3.03:1
              // on the ordinary white composer but 2.43:1 on the note fill.
              // Warming the ink toward the surface fixes both (2.63:1) —
              // LIGHTENING it, the intuitive move, would have taken it to
              // 1.82:1 and made it dimmer as well as still cool.
              noteMode
                ? "placeholder:text-[color-mix(in_srgb,var(--text-faint)_84%,var(--yellow))]"
                : "placeholder:text-faint",
              // With the mirror painting the styled draft, the field's own
              // glyphs go transparent and only the caret stays visible.
              hlActive
                ? "relative z-[1] break-words text-transparent caret-[var(--text)]"
                : "text-fg",
            )}
            // In the resting pill the full prompt would clip, so show a short
            // "Ask <model>" (ChatGPT-style) that fits the single row; the
            // descriptive placeholder returns once it expands.
            placeholder={
              noteMode
                ? minimized
                  ? "Team note"
                  : "Only your team will see this"
                : minimized
                  ? `Ask ${shortModelLabel(effectiveModel, models)}`
                  : quote
                    ? "Chat with selected text"
                    : placeholder
            }
            value={displayText}
            onBeforeInput={sessionNames.handleBeforeInput}
            onChange={(e) => {
              // A token undo/redo is replayed against canonical state and the
              // caret is already placed, so nothing else is owed here.
              // The mention picker re-syncs from the committed value in its own
              // effect, which is both later and more reliable than a microtask
              // queued from here (see useFileMentions).
              sessionNames.handleChange(e);
              onTyping?.(e.currentTarget.value.length > 0);
            }}
            onKeyDown={handleKeyDown}
            onKeyUp={syncMentions}
            onClick={(e) => {
              if (openPillMenu(e.currentTarget, e.clientX, e.clientY)) return;
              syncMentions();
            }}
            onMouseMove={(e) => updatePillHover(e.clientX, e.clientY)}
            onMouseLeave={() => updatePillHover(-1, -1)}
            onScroll={(e) => {
              // Measure first, then write: the mirror used to be scrolled
              // before the edges were read, which forced the layout back out
              // on every scroll frame.
              const scrollTop = updateScrollEdges(e.currentTarget);
              if (hlRef.current) hlRef.current.scrollTop = scrollTop;
            }}
            onFocus={() => setFocused(true)}
            onBlur={() => {
              setFocused(false);
              onTyping?.(false);
              const remote = pendingRemoteText.current;
              pendingRemoteText.current = null;
              if (
                remote !== null &&
                (!draftKey || loadDraft(draftKey).text === remote)
              ) {
                setInnerValue((current) =>
                  current === remote ? current : remote,
                );
              }
              // Let a click on a suggestion (mousedown) win the race first.
              setTimeout(closeMentions, 120);
            }}
            onCopy={sessionNames.handleCopy}
            onCut={sessionNames.handleCut}
            onPaste={handlePaste}
            disabled={disabled}
            rows={1}
            {...noAutofill}
            autoFocus={autoFocus}
          />
          {/* What a press on a pill gets instead of the reference vanishing.
              Two rows, because removing it is only one of the two things a
              press can reasonably mean and it was the only one on offer.
              Anchored to the pressed box rather than to a trigger: the subject
              is text inside the field, and it has no element of its own.
              `modal={false}`, so the draft behind it stays scrollable: this
              menu is a detail of the field rather than a layer over the page. */}
          <Menu.Root
            open={!!pillMenu}
            onOpenChange={(open) => {
              if (!open) setPillMenu(null);
            }}
            modal={false}
          >
            <Menu.Popup
              anchor={pillAnchor}
              side="top"
              align="start"
              finalFocus={textareaRef}
              className={composerMenuWidth}
            >
              <Menu.Item onClick={changePill}>
                <IconPencil size={17} aria-hidden className={MENU_ICON} />
                Change
              </Menu.Item>
              <Menu.Item onClick={removePill}>
                <IconTrash size={17} aria-hidden className={MENU_ICON} />
                Remove
              </Menu.Item>
            </Menu.Popup>
          </Menu.Root>
        </motion.div>
        <div
          className={cn(
            composerToolbar,
            composerToolbarScrollDivider,
            minimized && composerToolbarMinimized,
          )}
          ref={toolbarRef}
          // Phones: a toolbar tap must not blur the textarea — the blur would
          // collapse the empty composer mid-tap (unmounting the model pill and
          // reflowing + / mic / send under the finger) and dismiss the
          // keyboard. Cancelling pointerdown covers pointer-event browsers,
          // but NOT iOS Safari — there the blur rides the touchend→mousedown
          // synthesis, which only touchend's own preventDefault stops. That's
          // what ComposerPressButton does for each button; this handler is
          // the non-iOS half.
          onPointerDown={(e) => {
            if (isPhone) e.preventDefault();
          }}
        >
          {/* One "+" carries everything you can add to or change about this
              session: attachments, the goal, and whatever the surface
              contributes (mode switch, scheduled send). As a row of icon chips
              these crowded the field, truncated on phones, and gave each action
              a glyph instead of a name; in a menu they each get a real label
              and stay one tap away. State stays visible where it already was —
              a set goal shows above the composer. */}
          {hasAddMenu && (
            <ComposerAddMenu
              menu={menu}
              setMenu={setMenu}
              minimized={minimized}
              addButtonClass={addButtonClass}
              disabled={disabled}
              canAttach={canAttach}
              canAttachFiles={canAttachFiles}
              isPhone={isPhone}
              attachChord={attachChord}
              mentionEnabled={!!mentionFetch}
              goal={goal}
              noteMode={noteMode}
              onNoteModeChange={onNoteModeChange}
              onSetGoal={onSetGoal}
              menuExtra={menuExtra}
              sendMenu={sendMenu}
              outgoingText={outgoingText}
              isSendDisabled={isSendDisabled}
              fileInputRef={fileInputRef}
              onAttachFiles={attachFilesFromMenu}
              onMentionFile={mentionFileFromMenu}
              onAddFiles={addFiles}
              onScheduled={() => {
                if (!isControlled) setInnerValue("");
                setPastedTexts([]);
              }}
            />
          )}

          {/* Ask mode used to keep a marker here, next to the "+". It says
              itself in a chip above the field now, with the ✕ that leaves it
              (see ComposerContextChip), which is where note mode already
              said itself: two states that both wash the box now name
              themselves in the same place and the same shape. */}
          {/* `grow basis-0 shrink-0` rather than `flex-1`: every direct child of
              the toolbar is pinned at flex-shrink 0 so the model pill is the
              only thing that gives way, and a shorthand would take that back. */}
          {!minimized && <div className="shrink-0 grow basis-0" />}

          {/* Model + effort live together on the right edge (ChatGPT-style):
              one pill, effort levels up top, the model behind a submenu.
              Phones reorder it next to the + button via flex order (see
              composerToolbarSelect). It stays out of the resting phone pill
              because that state is minimized, but returns when the installed
              PWA composer expands. */}
          <ModelRow
            minimized={minimized}
            models={models}
            defaultModel={defaultModel}
            model={model}
            onModelChange={onModelChange}
            preferredDefaultModel={preferredDefaultModel}
            onSetAsDefault={setPreferredDefaultModel}
            modelDisabled={modelDisabled}
            modelTitle={modelTitle}
            effort={effort}
            onEffortChange={onEffortChange}
            fastMode={fastMode}
            onFastModeChange={onFastModeChange}
            accounts={accounts}
            accountId={accountId}
            onAccountChange={onAccountChange}
            usage={usage}
            disabled={disabled}
            effortDownLabel={effortDownLabel}
            effortUpLabel={effortUpLabel}
            onOpenChange={setModelMenuOpen}
          />

          {/* Wrapper around the dictation mic — gives Motion a layout box so it
              glides between rows during the morph without disturbing either. */}
          <VoiceControl
            minimized={minimized}
            className={composerIconButtonClass}
            shortcutActive={!!attachmentShortcutActive}
            focused={focused}
            cancelClassName={addButtonClass}
            onText={insertDictation}
            onTextSend={sendDictation}
            textareaRef={textareaRef}
            overlayTargetRef={voiceOverlayRef}
            overlayStyle={dictationSurfaceStyle}
            onActiveChange={handleDictationActive}
            disabled={disabled}
          />

          {busy && onStop && (
            <Tooltip
              label={
                stopping
                  ? "Stopping. The turn ends as soon as the work in flight returns."
                  : "Stop. Interrupts the current turn; the session stays ready."
              }
              // The chord that reaches this from anywhere in the session.
              // Escape does the same from inside the composer, but two chords
              // side by side in one badge row would read as a single one.
              shortcut={stopKeys ?? undefined}
            >
              <ComposerPressButton
                type="button"
                className={cn(
                  composerSend,
                  composerSendStop,
                  // Without an order the stop button defaults to 0 and jumps to
                  // the far left of the resting row; seat it just before send.
                  minimized && "order-4",
                  minimized && composerSendMinimizedFill,
                  // Acknowledged: the press registered, the engine is winding
                  // down. Not `disabled` — pressing again re-sends the cancel.
                  stopping && "opacity-60",
                )}
                onPress={onStop}
                disabled={disabled}
                aria-label={
                  stopping ? "Stopping current turn" : "Stop current turn"
                }
              >
                <IconStopSquare size={24} />
              </ComposerPressButton>
            </Tooltip>
          )}
          {/* One busy-send button: the Enter follow-up preference (Settings →
              Preferences, default queue) picks its busy action; holding
              Command/Ctrl switches to the ⌘/Ctrl+Enter preference (default
              steer). Niche actions such as scheduling live under the + menu. */}
          {showSend && (
            <motion.div
              layout="position"
              transition={composerMorph}
              layoutDependency={minimized}
              className={cn(
                "relative inline-flex shrink-0 items-stretch",
                minimized && "order-5",
              )}
            >
              <ContextMenu.Root>
                <Tooltip
                  label={
                    noteMode
                      ? "Add note"
                      : steerSend
                        ? "Steer message"
                        : sendTitle || (busy ? "Queue message" : "Send")
                  }
                  // Keycaps rather than the key's name in the label: the row
                  // of chips is the same thing every other control shows, and
                  // a name in parentheses read as part of the sentence.
                  // Holding the modifier switches the action to steer, and
                  // the chord with it. A caller-supplied `sendTitle` explains
                  // something other than sending, so it keeps no caps.
                  shortcut={
                    steerSend
                      ? [MOD_ENTER_GLYPH]
                      : !noteMode && sendTitle
                        ? undefined
                        : sendKeyCaps
                  }
                >
                  <ContextMenu.Trigger
                    render={
                      <ComposerPressButton
                        className={cn(
                          composerSend,
                          // A note posts straight away, so it keeps the plain
                          // send plate even while a turn is running.
                          noteMode
                            ? composerSendDefault
                            : steerSend
                              ? composerSendSteer
                              : busy
                                ? composerSendQueue
                                : composerSendDefault,
                          minimized && composerSendMinimizedFill,
                        )}
                        onPress={() =>
                          fireSend(
                            onSend,
                            steerSend ? { steer: true } : undefined,
                          )
                        }
                        disabled={disabled || isSendDisabled}
                        aria-label={
                          noteMode
                            ? "Add note"
                            : steerSend
                              ? "Steer into the running turn"
                              : busy
                                ? "Queue until the current turn finishes"
                                : "Send message"
                        }
                      />
                    }
                  >
                    {/* The arrow comes down with the disc in the resting pill — a
                        24px glyph all but touches the smaller plate's edge. */}
                    {busy && !steerSend && !noteMode ? (
                      <IconReturn size={minimized ? 20 : 24} />
                    ) : (
                      <IconArrowUp size={minimized ? 20 : 24} />
                    )}
                  </ContextMenu.Trigger>
                </Tooltip>
                <ContextMenu.Popup className="min-w-[230px]">
                  <ContextMenu.Item onClick={() => pickBusySend("queue")}>
                    <IconReturn size={20} />
                    <span className="grow">Queue after run finishes</span>
                    {busySendKeys("queue") && (
                      <ContextMenu.Shortcut>
                        {busySendKeys("queue")}
                      </ContextMenu.Shortcut>
                    )}
                    <ContextMenu.Check
                      on={busySendPrefs.enter === "queue"}
                      size={16}
                    />
                  </ContextMenu.Item>
                  <ContextMenu.Item onClick={() => pickBusySend("steer")}>
                    <IconArrowUp size={20} />
                    <span className="grow">Steer into running turn</span>
                    {busySendKeys("steer") && (
                      <ContextMenu.Shortcut>
                        {busySendKeys("steer")}
                      </ContextMenu.Shortcut>
                    )}
                    <ContextMenu.Check
                      on={busySendPrefs.enter === "steer"}
                      size={16}
                    />
                  </ContextMenu.Item>
                </ContextMenu.Popup>
              </ContextMenu.Root>
            </motion.div>
          )}
        </div>
        {/* Phone vim key bar — the on-screen keyboard has no Esc/Tab/arrow
            keys (and the native accessory bar is WebKit chrome we can't
            touch), so give vim users a Termius-style key row pinned above the
            keyboard. Software keys route through vim.injectKey: consumed by
            the engine in normal/visual mode, emulated on the textarea in
            insert mode.

            iOS tap handling is the load-bearing part: a tap's default
            continuation is touchend → synthesized mousedown (blurs the
            textarea, dismissing the keyboard) → click — and the blur flips
            `focused`, which would unmount this bar BEFORE the click fires
            (preventing pointerdown does NOT stop any of that on iOS; it lost
            us the whole bar on-device). So each key acts on touchend and
            cancels it, suppressing the entire mouse-synthesis chain; onClick
            stays for mouse/pen, with a recent-touch guard for browsers that
            fire both. The bar also stays mounted outside insert mode even if
            focus is lost, so it can never vanish mid-interaction. */}
        {vimEnabled &&
          isPhone &&
          !minimized &&
          (focused || vim.mode !== "insert") && (
            <div
              className="mt-1.5 flex gap-1.5 border-t border-line pt-1.5"
              onPointerDown={(e) => e.preventDefault()}
              onMouseDown={(e) => e.preventDefault()}
            >
              {(
                [
                  ["esc", "Escape"],
                  ["tab", "Tab"],
                  ["←", "ArrowLeft"],
                  ["↓", "ArrowDown"],
                  ["↑", "ArrowUp"],
                  ["→", "ArrowRight"],
                ] as const
              ).map(([label, key]) => (
                <ComposerPressButton
                  key={key}
                  type="button"
                  className={`h-8 flex-1 select-none rounded-md border border-line bg-surface text-label font-semibold text-dim active:bg-panel ${
                    key === "Escape" && vim.mode !== "insert"
                      ? "border-accent text-fg"
                      : ""
                  }`}
                  onPress={() => vim.injectKey(key)}
                  aria-label={key}
                >
                  {label}
                </ComposerPressButton>
              ))}
            </div>
          )}
      </motion.div>
      {/* The keyboard-shortcut hint is irrelevant on touch and eats vertical
          space right where the keyboard appears. */}
      {hint && (
        <div className="mt-[7px] text-center text-meta text-faint phone:hidden">
          {hint}
        </div>
      )}
      {/* Outside the toolbar: the stop button lives in a row that the phone
          composer unmounts when it minimizes, and the question has to survive
          the composer losing focus to the dialog. */}
      <StopConfirmModal
        open={stopConfirm}
        onOpenChange={setStopConfirm}
        onConfirm={() => {
          setStopConfirm(false);
          onStop?.();
        }}
      />
    </div>
  );
}
