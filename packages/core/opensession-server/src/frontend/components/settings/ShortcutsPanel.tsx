import { mergeStylexProps, mergeStylexOverrideClassName } from "../../ui/cn";
import { useEffect, useEffectEvent, useState } from "react";
import { useShortcutsVersion } from "../../hooks/useShortcutBindings";
import { isApple } from "../../lib/platform";
import {
  chordFromEvent,
  commandsUsingChord,
  glyphsFor,
  isBindable,
  isShortcutCustomized,
  labelFor,
  resetAllShortcuts,
  resetShortcutBindings,
  setShortcutBindings,
  setShortcutRecording,
  shortcutBindings,
  shortcutCommand,
  shortcutKeys,
  SHORTCUT_COMMANDS,
  SHORTCUT_GROUPS,
  SHORTCUT_REFERENCE,
  type Chord,
  type ShortcutId,
} from "../../lib/shortcuts";
import { Input } from "../../ui/input";
import { Button } from "../../ui/button";
import {
  SettingCard,
  SettingRow,
  SettingRowControl,
  SettingRowDescription,
  SettingRowText,
  SettingRowTitle,
  SettingsGroupLabel,
  SettingsHeader,
  SettingsHint,
  SettingsPanel,
  rowMenuTriggerClasses,
} from "../../ui/settings";
import { Menu, MENU_ICON } from "../../ui/menu";
import {
  IconDotsHorizontal,
  IconPencil,
  IconPlus,
  IconRestore,
  IconSearch,
  IconTrash,
} from "../icons";
import * as stylex from "@stylexjs/stylex";
import { type as typography } from "../../styles/typography.stylex";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
  inlineFlex: {
    display: "inline-flex",
  },
  minW6: {
    minWidth: "calc(4px * 6)",
  },
  itemsCenter: {
    alignItems: "center",
  },
  justifyCenter: {
    justifyContent: "center",
  },
  roundedMd: {
    borderRadius: "calc(7px * var(--rf))",
    cornerShape: "var(--cs)",
  },
  border: {
    borderStyle: "solid",
    borderWidth: "1px",
  },
  borderLineStrong: {
    borderColor: "var(--border-strong)",
  },
  bgHover: {
    backgroundColor: "var(--hover)",
  },
  px15: {
    paddingInline: "calc(4px * 1.5)",
  },
  py05: {
    paddingBlock: "calc(4px * 0.5)",
  },
  fontSans: {
    fontFamily: "var(--sans)",
  },
  textDim: {
    color: "var(--text-dim)",
  },
  flex: {
    display: "flex",
  },
  gap1: {
    gap: "4px",
  },
  itemsStart: {
    alignItems: "flex-start",
  },
  mt2: {
    marginTop: "calc(4px * 2)",
  },
  flexWrap: {
    flexWrap: "wrap",
  },
  gapX2: {
    columnGap: "calc(4px * 2)",
  },
  gapY15: {
    rowGap: "calc(4px * 1.5)",
  },
  mt15: {
    marginTop: "calc(4px * 1.5)",
  },
  textRed: {
    color: "var(--red)",
  },
  flexCol: {
    flexDirection: "column",
  },
  itemsEnd: {
    alignItems: "flex-end",
  },
  gap15: {
    gap: "calc(4px * 1.5)",
  },
  textFaint: {
    color: "var(--text-faint)",
  },
  size7: {
    width: "calc(4px * 7)",
    height: "calc(4px * 7)",
  },
  relative: {
    position: "relative",
  },
  px5: {
    paddingInline: "calc(4px * 5)",
  },
  pointerEventsNone: {
    pointerEvents: "none",
  },
  absolute: {
    position: "absolute",
  },
  left8: {
    left: "calc(4px * 8)",
  },
  top12: {
    top: "calc(1 / 2 * 100%)",
  },
  TranslateY12: {
    translate: "0 calc(calc(1 / 2 * 100%) * -1)",
  },
  pl11: {
    paddingLeft: "calc(4px * 11)",
  },
  roundedControl: {
    borderRadius: "calc(12px * var(--rf))",
    cornerShape: "var(--cs)",
  },
  bgAccentSoft: {
    backgroundColor: "var(--accent-soft)",
  },
  px25: {
    paddingInline: "calc(4px * 2.5)",
  },
  py1: {
    paddingBlock: "4px",
  },
});

/** How many chords one command may answer to. Two covers every default; the
 *  third is headroom for someone whose browser eats one of them. */
const MAX_BINDINGS = 3;

/** A keycap. Matches the palette's kbd treatment so a chord reads the same
 *  wherever it is shown. Unlike the palette's, this one stays on phones: the
 *  page is a reference and hiding the chords would empty it. */
function Keycap({ children }: { children: React.ReactNode }) {
  return (
    <kbd
      {...stylex.props(
        sx.inlineFlex,
        sx.minW6,
        sx.itemsCenter,
        sx.justifyCenter,
        sx.roundedMd,
        sx.border,
        sx.borderLineStrong,
        sx.bgHover,
        sx.px15,
        sx.py05,
        sx.fontSans,
        sx.textDim,
        typography.meta,
      )}
    >
      {children}
    </kbd>
  );
}

function ChordKeys({ keys }: { keys: string[] }) {
  return (
    <span {...stylex.props(sx.flex, sx.itemsCenter, sx.gap1)}>
      {keys.map((key, i) => (
        <Keycap key={`${key}-${i}`}>{key}</Keycap>
      ))}
    </span>
  );
}

/**
 * The live state while a chord is being captured.
 *
 * `index` is which binding is being replaced, or the length of the list when a
 * new one is being added. `held` mirrors the modifiers currently down so the
 * pill shows something as soon as ⌘ goes down, rather than staying blank until
 * the whole chord lands.
 */
interface Recording {
  id: ShortcutId;
  index: number;
  held: string[];
}

/** A captured chord that collides with another command, awaiting a decision. */
interface Conflict {
  id: ShortcutId;
  index: number;
  chord: Chord;
  takenBy: ShortcutId;
}

export function ShortcutsPanel() {
  const version = useShortcutsVersion();
  const [query, setQuery] = useState("");
  const [recording, setRecording] = useState<Recording | null>(null);
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const [problem, setProblem] = useState<{
    id: ShortcutId;
    message: string;
  } | null>(null);
  function stopRecording() {
    setRecording(null);
  }

  // Recording always starts from a menu item, and the menu hands focus back to
  // its own trigger as it closes — which is still mounted, because a capture
  // only replaces the chord beside it. So there is nothing to restore here:
  // the keyboard is already on the row it was working in.
  function beginRecording(id: ShortcutId, index: number) {
    setConflict(null);
    setProblem(null);
    setRecording({ id, index, held: [] });
  }

  function commit(id: ShortcutId, index: number, chord: Chord) {
    const next = [...shortcutBindings(id)];
    next[index] = chord;
    setShortcutBindings(id, next);
  }

  // Capture the next chord. The listener runs in the capture phase at window,
  // so it sees the event before it descends to anything — including handlers
  // inside a Base UI popup, which stops propagation on the way back up. The
  // registry's recording flag is the backstop for any listener that reads the
  // event another way; between them, a keystroke aimed at the recorder can
  // never also run the command it is about to be bound to.
  const recordKeys = useEffectEvent(() => {
    if (!recording) return;
    setShortcutRecording(true);
    const { id, index } = recording;

    function heldModifiers(e: KeyboardEvent): string[] {
      const out: string[] = [];
      if (isApple ? e.metaKey : e.ctrlKey) out.push(isApple ? "⌘" : "Ctrl");
      if (isApple && e.ctrlKey) out.push("⌃");
      if (e.altKey) out.push(isApple ? "⌥" : "Alt");
      if (e.shiftKey) out.push(isApple ? "⇧" : "Shift");
      return out;
    }

    function onKeyDown(e: KeyboardEvent) {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.key === "Escape") {
        stopRecording();
        return;
      }
      const chord = chordFromEvent(e);
      if (!chord) {
        // A modifier on its own: show it building up.
        const held = heldModifiers(e);
        setRecording((r) => (r ? { ...r, held } : r));
        return;
      }
      if (!isBindable(chord)) {
        setProblem({
          id,
          message: isApple
            ? "Hold ⌘, ⌃, or ⌥ as part of the shortcut"
            : "Hold Ctrl or Alt as part of the shortcut",
        });
        setRecording((r) => (r ? { ...r, held: [] } : r));
        return;
      }
      const taken = commandsUsingChord(chord).filter((other) => other !== id);
      const first = taken[0];
      if (first) {
        setProblem(null);
        setConflict({ id, index, chord, takenBy: first });
        stopRecording();
        return;
      }
      setProblem(null);
      commit(id, index, chord);
      stopRecording();
    }

    function onKeyUp(e: KeyboardEvent) {
      e.preventDefault();
      e.stopImmediatePropagation();
      setRecording((r) => (r ? { ...r, held: heldModifiers(e) } : r));
    }

    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
      setShortcutRecording(false);
    };
  });
  const recordingKey = recording ? `${recording.id}:${recording.index}` : "";
  useEffect(() => {
    if (!recordingKey) return;
    const cleanup = recordKeys();
    return cleanup;
  }, [recordingKey]);

  function replaceConflicted() {
    if (!conflict) return;
    const { id, index, chord, takenBy } = conflict;
    // Take the chord off the other command first, so the two writes land as
    // one change rather than leaving both bound for a beat.
    setShortcutBindings(
      takenBy,
      shortcutBindings(takenBy).filter((c) => c !== chord),
    );
    commit(id, index, chord);
    setConflict(null);
  }

  const customizedCount = SHORTCUT_COMMANDS.filter((c) =>
    isShortcutCustomized(c.id),
  ).length;

  const q = query.trim().toLowerCase();
  const matches = (() => {
    if (!q) return SHORTCUT_COMMANDS;
    return SHORTCUT_COMMANDS.filter((command) => {
      const chords = shortcutBindings(command.id)
        .map((chord) => `${labelFor(chord)} ${chord}`)
        .join(" ");
      return `${command.title} ${command.description} ${command.group} ${chords}`
        .toLowerCase()
        .includes(q);
    });
    // Bindings feed the haystack, so a rebind re-filters an open search.
  })();

  const referenceMatches = q
    ? SHORTCUT_REFERENCE.filter((r) =>
        `${r.title} ${r.description} ${r.keys.join(" ")}`
          .toLowerCase()
          .includes(q),
      )
    : SHORTCUT_REFERENCE;

  function renderRow(id: ShortcutId) {
    const command = shortcutCommand(id);
    if (!command) return null;
    const bindings = shortcutBindings(id);
    const keys = shortcutKeys(id);
    const customized = isShortcutCustomized(id);
    const conflicted = conflict?.id === id ? conflict : null;

    return (
      <SettingRow
        key={id}
        className={mergeStylexOverrideClassName("", sx.itemsStart)}
      >
        <SettingRowText>
          <SettingRowTitle>{command.title}</SettingRowTitle>
          <SettingRowDescription>{command.description}</SettingRowDescription>
          {conflicted && (
            <div
              {...stylex.props(
                sx.mt2,
                sx.flex,
                sx.flexWrap,
                sx.itemsCenter,
                sx.gapX2,
                sx.gapY15,
                sx.textDim,
                typography.supporting,
              )}
              role="alert"
            >
              <ChordKeys keys={glyphsFor(conflicted.chord)} />
              <span>
                is already {shortcutCommand(conflicted.takenBy)?.title}
              </span>
              <Button size="sm" variant="primary" onClick={replaceConflicted}>
                Replace
              </Button>
              <Button
                size="sm"
                variant="soft"
                onClick={() => setConflict(null)}
              >
                Cancel
              </Button>
            </div>
          )}
          {problem?.id === id && (
            <div
              {...stylex.props(sx.mt15, sx.textRed, typography.supporting)}
              role="alert"
            >
              {problem.message}
            </div>
          )}
        </SettingRowText>
        <SettingRowControl
          className={mergeStylexOverrideClassName(
            "",
            sx.flex,
            sx.flexCol,
            sx.itemsEnd,
            sx.gap15,
          )}
        >
          {keys.length === 0 && recording?.id !== id && (
            <div {...stylex.props(sx.flex, sx.itemsCenter, sx.gap15)}>
              <span {...stylex.props(sx.textFaint, typography.supporting)}>
                Unassigned
              </span>
              <RowMenu label={`Manage the shortcut for ${command.title}`}>
                <Menu.Item onClick={() => beginRecording(id, 0)}>
                  <IconPencil size={16} className={MENU_ICON} />
                  Set a shortcut…
                </Menu.Item>
                {customized && (
                  <Menu.Item onClick={() => resetShortcutBindings(id)}>
                    <IconRestore size={16} className={MENU_ICON} />
                    Reset to default
                  </Menu.Item>
                )}
              </RowMenu>
            </div>
          )}
          {keys.map((chordKeys, i) => {
            // One menu per chord, so its actions belong to the chord beside
            // them rather than to whichever of a row's chords you meant. The
            // row-wide ones (add another, reset) ride on the LAST chord's
            // menu, which is where a reader who has finished the list is.
            //
            // The trigger stays mounted while this line records, so the chord
            // is the only thing the pill replaces and Base UI still has its
            // trigger to hand focus back to when the menu closes.
            const last = i === keys.length - 1;
            const capturing = recording?.id === id && recording.index === i;
            return (
              <div
                key={`${chordKeys.join("+")}-${i}`}
                {...stylex.props(sx.flex, sx.itemsCenter, sx.gap15)}
              >
                {capturing ? (
                  <RecordingPill held={recording.held} />
                ) : (
                  <ChordKeys keys={chordKeys} />
                )}
                <RowMenu
                  label={`Manage the ${chordKeys.join(" ")} shortcut for ${command.title}`}
                >
                  <Menu.Item onClick={() => beginRecording(id, i)}>
                    <IconPencil size={16} className={MENU_ICON} />
                    Change shortcut…
                  </Menu.Item>
                  {last && keys.length < MAX_BINDINGS && (
                    <Menu.Item
                      onClick={() => beginRecording(id, bindings.length)}
                    >
                      <IconPlus size={16} className={MENU_ICON} />
                      Add another shortcut…
                    </Menu.Item>
                  )}
                  <Menu.Separator />
                  {last && customized && (
                    <Menu.Item onClick={() => resetShortcutBindings(id)}>
                      <IconRestore size={16} className={MENU_ICON} />
                      Reset to default
                    </Menu.Item>
                  )}
                  <Menu.Item
                    className={mergeStylexOverrideClassName(
                      "data-[highlighted]:bg-red-soft",
                      sx.textRed,
                    )}
                    onClick={() =>
                      setShortcutBindings(
                        id,
                        bindings.filter((_, j) => j !== i),
                      )
                    }
                  >
                    <IconTrash size={16} />
                    Remove shortcut
                  </Menu.Item>
                </RowMenu>
              </div>
            );
          })}
          {recording?.id === id && recording.index >= keys.length && (
            <div {...stylex.props(sx.flex, sx.itemsCenter, sx.gap15)}>
              <RecordingPill held={recording.held} />
              {/* The chord being added has no menu yet. Hold its place so
							    the pill lines up with the ones on the chords above. */}
              <span {...stylex.props(sx.size7)} aria-hidden />
            </div>
          )}
        </SettingRowControl>
      </SettingRow>
    );
  }

  return (
    <SettingsPanel>
      <SettingsHeader
        title="Keyboard shortcuts"
        actions={
          customizedCount > 0 ? (
            <Button size="sm" variant="soft" onClick={resetAllShortcuts}>
              Reset all
            </Button>
          ) : undefined
        }
      />

      <div {...stylex.props(sx.relative, sx.px5)}>
        <IconSearch
          size={20}
          className={mergeStylexOverrideClassName(
            "",
            sx.pointerEventsNone,
            sx.absolute,
            sx.left8,
            sx.top12,
            sx.TranslateY12,
            sx.textFaint,
          )}
        />
        <Input
          className={mergeStylexOverrideClassName("", sx.pl11)}
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search shortcuts"
          aria-label="Search shortcuts"
        />
      </div>

      {SHORTCUT_GROUPS.map((group) => {
        const rows = matches.filter((c) => c.group === group);
        if (rows.length === 0) return null;
        return (
          <div key={group}>
            <SettingsGroupLabel>{group}</SettingsGroupLabel>
            <SettingCard>{rows.map((c) => renderRow(c.id))}</SettingCard>
          </div>
        );
      })}

      {referenceMatches.length > 0 && (
        <>
          <SettingsGroupLabel>Always on</SettingsGroupLabel>
          <SettingCard>
            {referenceMatches.map((entry) => (
              <SettingRow key={entry.title}>
                <SettingRowText>
                  <SettingRowTitle>{entry.title}</SettingRowTitle>
                  <SettingRowDescription>
                    {entry.description}
                  </SettingRowDescription>
                </SettingRowText>
                <SettingRowControl>
                  <ChordKeys keys={entry.keys} />
                </SettingRowControl>
              </SettingRow>
            ))}
          </SettingCard>
          <SettingsHint>
            These are part of the interface rather than commands, so they stay
            as they are.
          </SettingsHint>
        </>
      )}

      {matches.length === 0 && referenceMatches.length === 0 && (
        <SettingsHint>No shortcuts match “{query.trim()}”.</SettingsHint>
      )}
    </SettingsPanel>
  );
}

/**
 * A chord's overflow menu, in the shape every other settings row uses. The
 * actions live here rather than as a row of glyphs because a page of 22 rows
 * each wearing three or four icon buttons reads as a form, and because a named
 * row says what it does: nothing explains a bare + to the person meeting it.
 */
function RowMenu({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <Menu.Root>
      <Menu.Trigger className={rowMenuTriggerClasses} aria-label={label}>
        <IconDotsHorizontal size={18} />
      </Menu.Trigger>
      <Menu.Popup align="end" sideOffset={4}>
        {children}
      </Menu.Popup>
    </Menu.Root>
  );
}

/** The pill a row wears while it waits for a chord. */
function RecordingPill({ held }: { held: string[] }) {
  return (
    <span
      {...mergeStylexProps(
        "text-accent",
        sx.flex,
        sx.itemsCenter,
        sx.gap15,
        sx.roundedControl,
        sx.bgAccentSoft,
        sx.px25,
        sx.py1,
        typography.meta,
      )}
      role="status"
      aria-live="polite"
    >
      {held.length > 0 ? (
        <span {...stylex.props(sx.flex, sx.itemsCenter, sx.gap1)}>
          {held.map((key) => (
            <Keycap key={key}>{key}</Keycap>
          ))}
        </span>
      ) : null}
      <span>Press a shortcut</span>
    </span>
  );
}
