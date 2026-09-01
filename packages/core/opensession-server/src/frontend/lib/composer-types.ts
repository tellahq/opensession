import type { RefObject } from "react";
import type { FileMention, ModelOption, ProviderAccountOption } from "./api";
import type { StagingCount } from "./attachments";
import type { FileAttachment } from "./images";
import type { Quote } from "./quotes";
import type { SessionUsage } from "./types";

export interface ComposerConfig {
  /**
   * Uncontrolled mode only: persist the text draft under this key (lib/drafts)
   * so it survives the component unmounting — switching to another session,
   * workspace or view. Restored on mount; cleared when a send is consumed.
   * Controlled parents own their value and persist it themselves.
   */
  draftKey?: string;
  placeholder?: string;
  disabled?: boolean;
  /** Boolean, or a predicate on the current draft (for uncontrolled mode,
   * where the parent cannot read the text). */
  sendDisabled?: boolean | ((text: string) => boolean);
  /** Shows on the send button tooltip when busy-queueing. */
  sendTitle?: string;
  busy?: boolean;
  /** A stop was asked for and the turn has not settled yet. The button stays
   * live (a second press re-sends the cancel, which is what people already do
   * when nothing seems to happen) but reads as acknowledged rather than
   * ignored. */
  stopping?: boolean;
  /**
   * Ask for the stop confirmation from outside the composer: the parent bumps
   * this counter, and each bump opens the same dialog Escape does. A counter
   * rather than a callback ref because the question is "has one more been
   * asked for", which a boolean cannot say twice in a row.
   */
  stopRequest?: number;
  models: ModelOption[];
  defaultModel: string;
  /** Current model id; an empty string selects the default. */
  model: string;
  modelDisabled?: boolean;
  modelTitle?: string;
  /**
   * Reasoning-effort control (stowed as a compact pill, mirroring the
   * new-session palette). Forward-compatible: threaded through but not yet
   * consumed server-side. When omitted, the effort pill is hidden.
   */
  effort?: string;
  fastMode?: boolean;
  /** Pinnable provider accounts plus the current pin for the model pill's
   * account submenu. Empty or omitted hides it. */
  accounts?: ProviderAccountOption[];
  accountId?: string;
  /** Session goal pinned via /goal and sent with every prompt. */
  goal?: string | null;
  /** Conversation usage shown in the model menu. */
  usage?: SessionUsage;
  /**
   * One-shot draft injection, such as editing a queued message. Applied when
   * `seq` changes: appended to a non-empty draft, otherwise it becomes the
   * draft; the caret lands at the end. `replace` prevents a separate draft
   * from being folded into the queued message being edited. Works in both
   * controlled and uncontrolled modes.
   */
  prefill?: { seq: number; text: string; replace?: boolean } | null;
  hint?: string;
  /** Lets the focused session pane claim the attachment shortcut even when
   * focus is in the transcript rather than the textarea. */
  attachmentShortcutActive?: boolean;
  autoFocus?: boolean;
  /** Exposes the textarea so parents can focus it. */
  textareaRef?: RefObject<HTMLTextAreaElement | null>;
  /** Attached images as data URLs. Supplying `onImagesChange` also enables
   * pasted and dropped screenshots plus thumbnails. */
  images?: string[];
  /** Non-image attachments staged to disk. Supplying `onFilesChange` lets the
   * composer accept any dropped or picked file. */
  files?: FileAttachment[];
  /** Uploads managed by the parent, used when a larger surface shares this
   * composer's attachment path. Omit this and `onAddAttachments` for
   * Composer-owned staging. */
  staging?: StagingCount;
  /** The transcript selection currently attached as ephemeral context. */
  quote?: Quote | null;
  /** Plain-style internal notes post to the team transcript, never the agent.
   * When `onNoteModeChange` is wired, the composer can toggle the mode and
   * tints yellow so the state is unmistakable. */
  noteMode?: boolean;
  /**
   * Ask mode lets the session read the checkout but not change it. It washes
   * the writing surface green and names itself in a chip above the field, the
   * same pair note mode takes.
   *
   * The pair is the point. The wash alone could not carry the state: at 7%
   * green under note mode's 10% yellow the two surfaces were one faint tint
   * apart (8.6 dE in light, less in dark), and you never see them side by side
   * to compare, so a tinted composer stopped saying which mode was active.
   * With a named chip on both, the wash says something is different and the
   * chip says what, so neither state can be mistaken for the other.
   */
  askMode?: boolean;
  /** The exit is in flight: the chip says so and its close button stops taking
   * clicks. */
  askExitPending?: boolean;
}

export interface ComposerActions {
  /**
   * `steer` folds the send into the running turn right away, and the turn keeps
   * running. Busy sends otherwise follow the user's follow-up preference
   * (queue by default, delivered after the run fully finishes). Command or
   * Control plus Enter, or Command or Control-click, flips the default action.
   */
  onSend: (
    text: string,
    options?: { steer?: boolean },
  ) => boolean | void | Promise<boolean | void>;
  onStop?: () => void;
  onModelChange: (model: string) => void;
  onEffortChange?: (effort: string) => void;
  onFastModeChange?: (fastMode: boolean) => void;
  onAccountChange?: (accountId: string) => void;
  /** Sets or clears the session goal from the inline target control. */
  onSetGoal?: (goal: string | null) => void;
  onImagesChange?: (images: string[]) => void;
  onFilesChange?: (files: FileAttachment[]) => void;
  onAddAttachments?: (picked: FileList | File[]) => void | Promise<void>;
  onRemovePendingImage?: (index: number) => void;
  onRemovePendingFile?: (index: number) => void;
  onQuoteClear?: () => void;
  /** Enables @-mention file autocomplete. */
  mentionFetch?: (query: string) => Promise<FileMention[]>;
  /** Supplies fast non-file rows for the inline @ palette. */
  paletteFetch?: (query: string) => Promise<FileMention[]>;
  /** Enables /-skill autocomplete at the start of a draft. */
  skillsFetch?: (query: string) => Promise<FileMention[]>;
  onNoteModeChange?: (active: boolean) => void;
  /**
   * Leaves ask mode from the chip's close button. Cutting a worktree is the
   * server's call and not every session may promote, so when this is omitted
   * the chip renders without an exit rather than offering one that fails.
   */
  onAskModeExit?: () => void;
}
