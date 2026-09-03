// Letter shortcuts for the live question card (components/AskCard).
//
// The Questionnaire primitive already assigns A, B, C… to the options and
// answers to them, but only while the card itself holds focus: its listener
// is on the form. A question usually arrives while you are reading the
// transcript or sitting in the composer, so the card has to hear the letters
// from the window as well. These helpers are the shared reading of a
// keystroke so the two paths cannot disagree about which option "B" is.
//
// Pure on purpose: no DOM, so the mapping is unit-testable without a browser.

import type { AskQuestion } from "@tellahq/opensession-protocol/session";

type AskOption = NonNullable<AskQuestion["options"]>[number];

interface LetterKeyEvent {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  repeat?: boolean;
  isComposing?: boolean;
}

/**
 * The option letter a keystroke spells, or null when it is anything else: a
 * chord, a held key, an IME composition, or a key that is not one letter.
 * Shift is allowed through, since "A" and "a" name the same option.
 */
export function askLetterFromKey(e: LetterKeyEvent): string | null {
  if (e.metaKey || e.ctrlKey || e.altKey || e.repeat || e.isComposing)
    return null;
  if (e.key.length !== 1) return null;
  const letter = e.key.toUpperCase();
  return letter >= "A" && letter <= "Z" ? letter : null;
}

/**
 * The option a letter names on one question. Letters are positional, the
 * same way the card labels them: A is the first option, B the second.
 */
export function askOptionForLetter(
  question: AskQuestion,
  letter: string,
): AskOption | null {
  const index = letter.charCodeAt(0) - "A".charCodeAt(0);
  return question.options?.[index] ?? null;
}

/** Whether a keystroke landed in a field that is being typed into. */
export function isTextEntryTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (target instanceof HTMLInputElement) {
    return !["button", "checkbox", "radio", "reset", "submit"].includes(
      target.type,
    );
  }
  return (
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    (target instanceof HTMLElement && target.isContentEditable)
  );
}
