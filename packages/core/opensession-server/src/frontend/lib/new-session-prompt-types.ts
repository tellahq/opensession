import type { RefObject } from "react";
import type { StagingCount } from "./attachments";
import type { FileAttachment } from "./images";
import type { PastedTextAttachment } from "./pasted-text";
import type { SendKeyPref } from "./send-key";

export interface NewSessionPromptHandle {
  /** Replace the draft — the reset after a create. */
  setText: (next: string) => void;
  /** Add dictated text to the end of the draft. */
  appendText: (add: string) => void;
  /** Throw away a pending draft write. The create paths clear the stored
   * draft once the prompt has been consumed, and a debounced write landing
   * after that would put the whole thing straight back. */
  dropPendingDraftWrite: () => void;
}

export interface NewSessionPromptConfig {
  /** Read once, at mount: the prefill, the deep link, or the restored draft. */
  initialText: string;
  /** Which repo "@" searches for files in. */
  repo: string;
  /** A non-empty selection narrows which connected tools "@" offers. */
  mcpServers?: string[];
  placeholder: string;
  disabled: boolean;
  images: string[];
  files: FileAttachment[];
  /** Large pastes held as chips, sent beside the prompt as `pastedTexts`. */
  pastedTexts: PastedTextAttachment[];
  /** What is still being written to disk. A pasted screenshot is not attached
   * until its upload lands, and during a slow load that is seconds of a card
   * that looks like it ignored the paste, so each one holds its place in the
   * attachment row as a ghost. */
  staging: StagingCount;
  sendKey: SendKeyPref;
  /** Whether the send key has anything to create, so it can decline the key
   * and let the newline land instead. */
  canCreate: boolean;
}

export interface NewSessionPromptRefs {
  /** The field itself. The palette focuses it and hands it to the dialog as
   * its initial focus, so the ref is created there and passed down. */
  textarea: RefObject<HTMLTextAreaElement | null>;
  /** The draft, written on every commit. This is what a create reads: the
   * palette does not hold the text, so that typing cannot re-render it. */
  value: RefObject<string>;
  /** Dictation and the post-create reset, which are the palette's to trigger
   * and this field's to carry out. */
  handle: RefObject<NewSessionPromptHandle | null>;
}

export interface NewSessionPromptActions {
  removeImage: (index: number) => void;
  removeFile: (index: number) => void;
  removePendingImage?: (index: number) => void;
  removePendingFile?: (index: number) => void;
  addAttachments: (picked: FileList | File[]) => void;
  /** A paste past the collapse threshold becomes a chip instead of text. */
  addPastedText: (text: string) => void;
  removePastedText: (id: string) => void;
  create: () => void;
  /** The draft went from empty to holding something, or back. The one thing
   * about the text the palette needs on every edit. */
  changeHasText: (hasText: boolean) => void;
  /** The draft, once it has held still: the branch name is suggested from it.
   * One report per typing burst, never per character. */
  settleDraft: (text: string) => void;
  changeEdges: (edges: { top: boolean; bottom: boolean }) => void;
  changeMentionOpen: (open: boolean) => void;
}
