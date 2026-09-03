import {
  forwardRef,
  useEffect,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
  type Dispatch,
  type ReactNode,
  type RefObject,
  type SetStateAction,
} from "react";
import { motion } from "motion/react";
import {
  composerMenuAnchorLeft,
  composerMenuIcon,
  composerMenuItem,
  composerMenuPopup,
  composerMenuWidth,
} from "../../lib/composer-classes";
import { noAutofill } from "../../lib/composer-autofill";
import { cn } from "../../ui/cn";
import { Button } from "../../ui/button";
import { MenuShortcut } from "../../ui/menu";
import { Modal } from "../../ui/modal";
import { composerMorph } from "../../ui/motion";
import { Tooltip } from "../../ui/tooltip";
import {
  IconAtSign,
  IconCrosshair,
  IconNote,
  IconPaperclip,
  IconPlus,
} from "../icons";

export type ComposerMenu = null | "add" | "goal";

type ComposerPressButtonProps = Omit<
  ComponentPropsWithoutRef<"button">,
  "onClick" | "onTouchEnd"
> & { onPress: () => void };

export const ComposerPressButton = forwardRef<
  HTMLButtonElement,
  ComposerPressButtonProps
>(function ComposerPressButton({ onPress, ...props }, ref) {
  const touchFiredAt = useRef(0);
  return (
    <button
      {...props}
      ref={ref}
      onTouchEnd={(event) => {
        event.preventDefault();
        touchFiredAt.current = Date.now();
        onPress();
      }}
      onClick={() => {
        if (Date.now() - touchFiredAt.current < 700) return;
        onPress();
      }}
    />
  );
});

/** Set / update / clear the session goal — a centered dialog on the shared
 *  Modal primitive (Base UI, squircle shell, focus-trapped, exit-animated). */
function GoalModal({
  open,
  initial,
  onOpenChange,
  onSubmit,
}: {
  open: boolean;
  initial: string;
  onOpenChange: (open: boolean) => void;
  onSubmit: (goal: string | null) => void;
}) {
  const [text, setText] = useState(initial);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // Reseed the field to the current goal (and select it) each time we open.
  useEffect(() => {
    if (open) {
      setText(initial);
      queueMicrotask(() => inputRef.current?.select());
    }
  }, [open, initial]);

  return (
    <Modal.Root open={open} onOpenChange={onOpenChange}>
      <Modal.Content initialFocus={inputRef}>
        <Modal.Header
          title="Session goal"
          description="Pinned to the session. It rides along with every prompt you send."
        />

        <textarea
          ref={inputRef}
          className="min-h-[120px] w-full resize-y rounded-lg border border-line-strong bg-surface px-4 py-3.5 text-body leading-relaxed text-fg outline-none"
          value={text}
          rows={3}
          {...noAutofill}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            // Plain / ⌘/Ctrl+Enter submits; Shift+Enter newlines.
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              onSubmit(text.trim() || null);
            }
          }}
          placeholder="e.g. Ship the onboarding redesign. Keep every reply focused on that."
        />

        <Modal.Footer>
          {initial && (
            <Button variant="danger" onClick={() => onSubmit(null)}>
              Clear goal
            </Button>
          )}
          <div className="flex-1" />
          <Button
            variant="primary"
            className="px-5"
            onClick={() => onSubmit(text.trim() || null)}
            disabled={text.trim() === initial.trim()}
          >
            {initial ? "Update goal" : "Set goal"}
          </Button>
        </Modal.Footer>
      </Modal.Content>
    </Modal.Root>
  );
}

interface ComposerAddMenuProps {
  menu: ComposerMenu;
  setMenu: Dispatch<SetStateAction<ComposerMenu>>;
  minimized: boolean;
  addButtonClass: string;
  disabled?: boolean;
  canAttach: boolean;
  canAttachFiles: boolean;
  isPhone: boolean;
  attachChord: string | null;
  mentionEnabled: boolean;
  goal?: string | null;
  noteMode?: boolean;
  onNoteModeChange?: (active: boolean) => void;
  onSetGoal?: (goal: string | null) => void;
  menuExtra?: (context: { close: () => void }) => ReactNode;
  sendMenu?: (context: {
    text: string;
    disabled: boolean;
    onScheduled: () => void;
  }) => ReactNode;
  outgoingText: string;
  isSendDisabled: boolean;
  fileInputRef: RefObject<HTMLInputElement | null>;
  onAttachFiles: () => void;
  onMentionFile: () => void;
  onAddFiles: (picked: FileList) => Promise<void>;
  onScheduled: () => void;
}

export function ComposerAddMenu({
  menu,
  setMenu,
  minimized,
  addButtonClass,
  disabled,
  canAttach,
  canAttachFiles,
  isPhone,
  attachChord,
  mentionEnabled,
  goal,
  noteMode,
  onNoteModeChange,
  onSetGoal,
  menuExtra,
  sendMenu,
  outgoingText,
  isSendDisabled,
  fileInputRef,
  onAttachFiles,
  onMentionFile,
  onAddFiles,
  onScheduled,
}: ComposerAddMenuProps) {
  return (
    <motion.div
      layout="position"
      transition={composerMorph}
      layoutDependency={minimized}
      // `composer-pop-wrap` stays as a hook: the outside-click handler
      // above dismisses the menu for any mousedown that isn't inside one.
      className={cn(
        "composer-pop-wrap relative inline-flex shrink-0",
        // Phones pull the model pill to the front of the toolbar, so the
        // "+" has to lead it; in the resting pill it opens the row.
        minimized ? "order-1" : "phone:order-[-2]",
      )}
    >
      <Tooltip label="Attach files and session options">
        <ComposerPressButton
          type="button"
          // The "+" is a 40px target around a 22px glyph, so aligning
          // its BOX with the composer's padding parks the visible ink
          // 10px further in than the text above it. Pull the button (not
          // its wrapper, which the menu anchors to) back out so the glyph
          // sits about where the send circle does. The resting pill
          // insets everything by 4px already, so it stays put there.
          className={addButtonClass}
          onPress={() => setMenu(menu === "add" ? null : "add")}
          disabled={disabled}
          aria-label="Attach files and session options"
          aria-expanded={menu === "add"}
        >
          <IconPlus size={22} />
        </ComposerPressButton>
      </Tooltip>
      {menu === "add" && (
        <div
          className={cn(
            composerMenuPopup,
            composerMenuWidth,
            composerMenuAnchorLeft,
          )}
        >
          {canAttach && (
            <ComposerPressButton
              type="button"
              className={composerMenuItem}
              onPress={onAttachFiles}
            >
              <span className={composerMenuIcon}>
                <IconPaperclip size={22} />
              </span>
              <span className="grow whitespace-nowrap">
                {canAttachFiles ? "Attach files" : "Attach an image"}
              </span>
              {!isPhone && attachChord && (
                <MenuShortcut>{attachChord}</MenuShortcut>
              )}
            </ComposerPressButton>
          )}
          {canAttach && mentionEnabled && (
            <ComposerPressButton
              type="button"
              className={composerMenuItem}
              onPress={onMentionFile}
            >
              <span className={composerMenuIcon}>
                <IconAtSign size={22} />
              </span>
              <span className="grow whitespace-nowrap">Reference a file</span>
              {/* Not a chord: typing @ in the field opens the same
                  picker, which is the faster way once you know it.
                  Hidden on phones, where there are no keys to press —
                  the same call the Enter hint under the field makes. */}
              {!isPhone && <MenuShortcut>@</MenuShortcut>}
            </ComposerPressButton>
          )}
          {onSetGoal && (
            <ComposerPressButton
              type="button"
              className={composerMenuItem}
              // Opens the goal editor: `menu` is single-valued, so this
              // closes the add menu and opens the modal in one step.
              onPress={() => setMenu("goal")}
              title={goal ? `Goal: ${goal}` : undefined}
            >
              <span className={composerMenuIcon}>
                <IconCrosshair size={22} />
              </span>
              <span className="grow whitespace-nowrap">
                {goal ? "Edit goal" : "Set a goal"}
              </span>
            </ComposerPressButton>
          )}
          {onNoteModeChange && (
            <ComposerPressButton
              type="button"
              className={composerMenuItem}
              onPress={() => {
                setMenu(null);
                onNoteModeChange(!noteMode);
              }}
              title={
                noteMode ? "Prompt the agent again" : "Only your team sees it"
              }
            >
              <span className={composerMenuIcon}>
                <IconNote size={22} />
              </span>
              <span className="grow whitespace-nowrap">
                {noteMode ? "Back to prompting" : "Write a team note"}
              </span>
            </ComposerPressButton>
          )}
          {menuExtra?.({ close: () => setMenu(null) })}
          {sendMenu?.({
            text: outgoingText,
            disabled: !!(disabled || isSendDisabled),
            onScheduled: () => {
              onScheduled();
              setMenu(null);
            },
          })}
        </div>
      )}
      {onSetGoal && (
        <GoalModal
          open={menu === "goal"}
          initial={goal || ""}
          onOpenChange={(open) => setMenu(open ? "goal" : null)}
          onSubmit={(nextGoal) => {
            onSetGoal(nextGoal);
            setMenu(null);
          }}
        />
      )}
      <input
        ref={fileInputRef}
        type="file"
        {...(canAttachFiles
          ? {}
          : {
              accept: noteMode
                ? "image/png,image/jpeg,image/gif,image/webp"
                : "image/*",
            })}
        multiple
        hidden
        onChange={(event) => {
          if (event.target.files?.length) void onAddFiles(event.target.files);
          // Reset so picking the same file again still fires onChange.
          event.target.value = "";
        }}
      />
    </motion.div>
  );
}

/** Confirms stopping from Escape. The stop button stays immediate because its
 *  press is already deliberate. Escape dismisses this dialog, while initial
 *  focus on Stop lets Enter confirm. */
export function StopConfirmModal({
  open,
  onOpenChange,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}) {
  const stopRef = useRef<HTMLButtonElement>(null);
  return (
    <Modal.Root open={open} onOpenChange={onOpenChange}>
      <Modal.Content
        initialFocus={stopRef}
        widthClassName="max-w-[32rem]"
        className="gap-5 p-7 phone:w-[calc(100vw-1.5rem)] phone:p-6"
      >
        <div className="flex flex-col">
          <Modal.Title className="m-0 text-balance text-section-title font-semibold leading-tight tracking-[-0.01em] text-fg">
            Stop this response?
          </Modal.Title>
          <Modal.Description className="m-0 mt-2 text-pretty text-base font-normal leading-relaxed text-dim">
            You can ask again or send a follow-up anytime.
          </Modal.Description>
        </div>
        <Modal.Footer className="mt-3 gap-3">
          <Modal.Close render={<Button size="lg">Keep going</Button>} />
          <Button ref={stopRef} variant="primary" size="lg" onClick={onConfirm}>
            Stop
          </Button>
        </Modal.Footer>
      </Modal.Content>
    </Modal.Root>
  );
}
