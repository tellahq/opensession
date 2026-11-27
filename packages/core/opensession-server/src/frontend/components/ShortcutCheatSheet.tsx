import * as React from "react";
import { useShortcutsVersion } from "../hooks/useShortcutBindings";
import {
  shortcutKeys,
  SHORTCUT_COMMANDS,
  SHORTCUT_GROUPS,
  SHORTCUT_REFERENCE,
} from "../lib/shortcuts";
import { Button } from "../ui/button";
import { Modal, useEnterOnMount } from "../ui/modal";
import { cn } from "../ui/cn";
import { IconX } from "./icons";

/**
 * The whole keyboard surface on one card, summoned by its own chord.
 *
 * It reads the same registry the settings page does, so a rebind shows up here
 * without a second list to keep in step, and the reference rows ride along —
 * the picture is only whole if the keys that are part of the interface are in
 * it too. What this is NOT is a second place to edit bindings: an overlay you
 * opened mid-task is the wrong place to start recording chords, so it points
 * at the settings page and stays read-only.
 *
 * The dialog body is deliberately a separate component from the shell. The
 * shell is Base UI's portal, focus trap and Escape handling, none of which
 * render under `react-dom/server`; the body is plain markup, so the rows and
 * their keycaps can be asserted in a test without a DOM.
 */
export function ShortcutCheatSheet({
  open,
  onOpenChange,
  onCustomize,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Send the reader to Settings → Keyboard shortcuts. */
  onCustomize?: () => void;
}) {
  // Nothing mounts until it is asked for: this hangs off a window listener on
  // every route, and a closed overlay must cost nothing to have around.
  if (!open) return null;
  return <CheatSheet onOpenChange={onOpenChange} onCustomize={onCustomize} />;
}

function CheatSheet({
  onOpenChange,
  onCustomize,
}: {
  onOpenChange: (open: boolean) => void;
  onCustomize?: () => void;
}) {
  // The parent mounts us only while we are open, so Base UI needs one frame
  // at closed to play the enter transition (see ui/modal).
  const open = useEnterOnMount();
  // Land the keyboard on the list rather than on the first tabbable, which
  // is Customize: a reference you opened to read something should not arm a
  // navigation under Enter. The list takes focus so it can be scrolled with
  // the arrows, and Tab still reaches the actions.
  const listRef = React.useRef<HTMLDivElement>(null);
  return (
    <Modal.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) onOpenChange(false);
      }}
    >
      <Modal.Content
        variant="palette"
        widthClassName="w-[min(720px,100%)]"
        initialFocus={listRef}
      >
        <div className="flex items-center gap-3 border-b border-divider px-5 py-4">
          <Modal.Title className="m-0 min-w-0 flex-1 text-item-title font-semibold leading-tight tracking-tight text-fg">
            Keyboard shortcuts
          </Modal.Title>
          {onCustomize && (
            <Button size="sm" variant="soft" onClick={onCustomize}>
              Customize
            </Button>
          )}
          <Modal.Close
            aria-label="Close"
            className="focus-ring relative -mr-1.5 flex size-8 shrink-0 items-center justify-center rounded-control p-0 text-faint transition-colors after:absolute after:-inset-1 after:content-[''] hover:bg-hover hover:text-fg"
          >
            <IconX size={20} />
          </Modal.Close>
        </div>
        <div
          ref={listRef}
          tabIndex={-1}
          className="max-h-[68dvh] overflow-y-auto overscroll-contain px-5 py-4 outline-none"
        >
          <ShortcutCheatSheetBody />
        </div>
      </Modal.Content>
    </Modal.Root>
  );
}

/**
 * Every group, then the keys that are part of the interface. Multi-column
 * rather than a grid: the groups are different lengths, and a column flow
 * keeps each one whole instead of leaving ragged holes between them.
 */
export function ShortcutCheatSheetBody() {
  // Repaint on a rebind, so the caps here are what the reader's keyboard
  // actually answers to rather than the shipped defaults.
  useShortcutsVersion();
  return (
    <div className="columns-1 gap-8 desktop:columns-2">
      {SHORTCUT_GROUPS.map((group) => {
        const rows = SHORTCUT_COMMANDS.filter((c) => c.group === group);
        if (rows.length === 0) return null;
        return (
          <Section key={group} title={group}>
            {rows.map((command) => (
              <Row
                key={command.id}
                title={command.title}
                keys={shortcutKeys(command.id)[0]}
              />
            ))}
          </Section>
        );
      })}
      <Section title="Always on">
        {SHORTCUT_REFERENCE.map((entry) => (
          <Row key={entry.title} title={entry.title} keys={entry.keys} />
        ))}
      </Section>
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    // `break-inside-avoid` on the section, not the rows: a group split down
    // the middle reads as two groups sharing a name.
    <section className="mb-5 break-inside-avoid">
      <h3 className="m-0 mb-1.5 text-label font-semibold text-faint">
        {title}
      </h3>
      <ul className="m-0 flex list-none flex-col p-0">{children}</ul>
    </section>
  );
}

/** One command and its primary chord. An unassigned command still shows: the
 *  page is a picture of the keyboard, and a blank row is what says a chord is
 *  there to be claimed. */
function Row({ title, keys }: { title: string; keys?: string[] }) {
  return (
    <li className="flex min-h-8 items-center justify-between gap-4 py-0.5">
      <span className="min-w-0 truncate text-supporting text-fg">{title}</span>
      {keys && keys.length > 0 ? (
        <span className="flex shrink-0 items-center gap-1">
          {keys.map((key, i) => (
            <Keycap key={`${key}-${i}`}>{key}</Keycap>
          ))}
        </span>
      ) : (
        <span className="shrink-0 text-meta text-faint">Not set</span>
      )}
    </li>
  );
}

/** The settings page's keycap treatment, so one chord reads the same in both
 *  places. Kept local rather than shared out of ShortcutsPanel: a settings
 *  panel is the wrong module for an overlay to import from, and the two are
 *  four declarations that have never diverged. */
function Keycap({ children }: { children: React.ReactNode }) {
  return (
    <kbd
      className={cn(
        "inline-flex min-w-6 items-center justify-center rounded-md border border-line-strong bg-hover px-1.5 py-0.5",
        "font-sans text-meta text-dim",
      )}
    >
      {children}
    </kbd>
  );
}
