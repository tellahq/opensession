import * as React from "react";
import { Questionnaire } from "@shadcn/react/questionnaire";
import { AGENT_NAME } from "../lib/brand";
import { renderMarkdown } from "../lib/markdown";
import type { AskQuestion } from "../lib/types";
import { Button } from "../ui/button";
import { cn } from "../ui/cn";
import { IconCheck, IconReturn } from "./icons";
import { useMarkdownRepo } from "./MarkdownBody";
import { ASK_CARD_SHELL, ASK_CHOICE_ROW } from "../lib/ask-card-classes";
import {
  askLetterFromKey,
  askOptionForLetter,
  isTextEntryTarget,
} from "../lib/ask-shortcuts";
import { blockingOverlayOpen } from "../lib/blocking-overlay";
import { matchesShortcut } from "../lib/shortcuts";

interface Props {
  questions: AskQuestion[];
  onAnswer: (answers: Record<string, string>) => void;
  /**
   * Whether this card's session is the one the keyboard belongs to. Split
   * tabs can show two live questions at once, and one keystroke must answer
   * only the focused session's. Defaults on for a card standing alone.
   */
  active?: boolean;
}

/**
 * Item names are positional. The wire format keys answers by question TEXT,
 * but that text is prose — over a kilobyte in the wild, and two questions in
 * one ask can repeat it — so it can't be a native form field name. We name the
 * fields q0..qN and map back to the question on submit.
 */
const itemName = (index: number) => `q${index}`;

/**
 * A `hidden` navigation action still lays out, because Button's own
 * `inline-flex` outranks the UA's `[hidden]` rule and this app ships no
 * Preflight. A class plus an attribute outranks the class on its own.
 */
const HIDE_WHEN_INERT = "[&[hidden]]:hidden";

/**
 * Interactive AskUserQuestion card — the agent is waiting on these answers.
 *
 * Behaviour comes from the headless `@shadcn/react` Questionnaire; the optics
 * are ours. That split is the point: the parts give us a real `fieldset` per
 * question, native radios and checkboxes, arrow-key movement between answers,
 * letter shortcuts, Cmd/Ctrl+Enter to send, and an error region that announces
 * — none of which the old hand-rolled `aria-pressed` buttons had. Every class
 * below is still this app's own, so nothing about the card's surface changed.
 *
 * Surfaces: one raised card on the transcript — no outline of its own, the
 * surface step is the edge — with the choices as control-surface rows on top
 * of it. Deliberately two surfaces, not the three nested greys it used to wear
 * (card → section → row), which read as boxes-in-boxes.
 *
 * Selection is NEUTRAL, not accent: the accent is red here, and filling a
 * chosen row with it read as an error/warning rather than a pick. Same reason
 * the composer keeps its resting border on focus (see .composer in legacy.css).
 * It also doesn't tint the row at all — the filled indicator carries it, with
 * the hairline stepping up. The indicator is a circle for single-select and a
 * rounded square for multi-select, so the shape says how many answers are
 * allowed.
 *
 * Two things the primitive can't know about this surface:
 *
 *  - We ship no Tailwind Preflight, so the `fieldset` it renders arrives with
 *    the UA's border, margin and padding — zeroed on the item below, the same
 *    way the free-text field has to zero its own inset border.
 *  - It hides an inactive item with the `hidden` attribute, and a `flex` class
 *    beats the UA's `[hidden]` rule. `[&[hidden]]:hidden` is a class plus an
 *    attribute, so it wins back.
 *
 * A lone single-select question still answers on the first click — that is the
 * hot path (96% of recorded asks are one question) and it stays one
 * interaction, not select-then-send.
 *
 * The letters are the keyboard's click. The primitive answers to A, B, C…
 * only while the form holds focus, but a question lands while you are reading
 * the transcript or sitting in the composer, so the card also listens on the
 * window: a bare letter from anywhere that is not a text field picks that
 * option, and on a lone single-select it sends, exactly as a click would. The
 * composer is the one place the letters cannot reach (they are typing there),
 * so the `ask-focus` chord brings the keyboard to the card instead.
 */
export function AskCard({ questions, onAnswer, active = true }: Props) {
  const repo = useMarkdownRepo();
  const titleBase = React.useId();
  const [picks, setPicks] = React.useState<Record<string, string[]>>({});
  const [custom, setCustom] = React.useState<Record<string, string>>({});
  const [submitted, setSubmitted] = React.useState(false);
  const formRef = React.useRef<HTMLFormElement>(null);
  const itemRefs = React.useRef<Array<HTMLFieldSetElement | null>>([]);
  // Which question the primitive is showing. It steps through them itself;
  // this only mirrors that so a letter from outside the form resolves against
  // the question on screen rather than the first one.
  const [activeName, setActiveName] = React.useState(itemName(0));
  // Only a pointer answers on the spot through the change handler. Arrow keys
  // pick by calling click() on the radio, which is indistinguishable from a
  // real click by the time the change lands — so a keyboard user browsing the
  // options with ArrowDown would send the first one they touched. A pointer
  // press always precedes its change; a synthesised click never does. (The
  // letters are the other deliberate pick, and take their own path below.)
  const pointerPick = React.useRef(false);

  // Mirrors what we render below. Handing the collection to the root is what
  // gets item order and answer shortcuts into the first paint, rather than
  // waiting for each part to register itself.
  const items = questions.map((q, i) => ({
    name: itemName(i),
    required: true,
    choices: (q.options ?? []).map((o) => ({ value: o.label })),
  }));

  // A card asking one thing: its header belongs on the status row (below).
  const lone = questions.length === 1 ? questions[0] : undefined;
  const titleId = (i: number) => `${titleBase}-q${i}`;

  function answerFor(index: number): string {
    const name = itemName(index);
    const parts = [...(picks[name] ?? [])];
    const typed = (custom[name] ?? "").trim();
    if (typed) parts.push(typed);
    return parts.join(", ");
  }

  function choose(
    index: number,
    q: AskQuestion,
    label: string,
    checked: boolean,
  ) {
    if (submitted) return;
    const name = itemName(index);
    const byPointer = pointerPick.current;
    pointerPick.current = false;

    if (q.multiSelect) {
      setPicks((prev) => {
        const current = prev[name] ?? [];
        return {
          ...prev,
          [name]: checked
            ? [...current, label]
            : current.filter((l) => l !== label),
        };
      });
      return;
    }

    // One single-select question is the common ask: clicking IS answering.
    if (lone && byPointer) {
      answerLone(q, label);
      return;
    }

    // Otherwise a pick replaces the pick and clears anything typed: the
    // field says "Or type your own answer…", and the primitive treats the
    // two as one answer slot.
    setPicks((prev) => ({ ...prev, [name]: [label] }));
    setCustom((prev) => ({ ...prev, [name]: "" }));
  }

  function write(index: number, q: AskQuestion, value: string) {
    if (submitted) return;
    const name = itemName(index);
    setCustom((prev) => ({ ...prev, [name]: value }));
    if (!q.multiSelect && value.trim()) {
      setPicks((prev) => ({ ...prev, [name]: [] }));
    }
  }

  // Send is offered only when the whole ask can actually be sent. The
  // primitive shows the action on the last question and leaves it live there
  // whether or not anything has been answered, so an unanswered question got a
  // button that refuses: pressing it validates, blocks, and jumps focus back
  // with an error. A button that is visibly not ready yet says the same thing
  // before you spend a click on it.
  //
  // The condition is every question, not just the active one. Required items
  // mean Next already validates on the way forward, so in practice the earlier
  // ones are answered by the time send appears, but this is the honest reading
  // of "ready to send" and it survives a skipped or controlled jump.
  //
  // Cmd/Ctrl+Enter is unaffected and still routes through the primitive's own
  // validation, so a keyboard user gets the spoken error rather than silence.
  const allAnswered = questions.every((_, i) => answerFor(i) !== "");

  function answerLone(q: AskQuestion, label: string) {
    setPicks({ [itemName(0)]: [label] });
    setSubmitted(true);
    onAnswer({ [q.question]: label });
  }

  /**
   * Answer a letter the way a click on that row would: a lone single-select
   * sends, anything else picks (or toggles) and moves focus to the row so
   * Enter and the arrows carry on from there. False when the letter names
   * nothing on the current question, so the keystroke stays the browser's.
   */
  function pressLetter(letter: string): boolean {
    if (submitted) return false;
    const index = questions.findIndex((_, i) => itemName(i) === activeName);
    const q = questions[index];
    if (!q) return false;
    const option = askOptionForLetter(q, letter);
    if (!option) return false;
    if (lone && !q.multiSelect) {
      answerLone(q, option.label);
      return true;
    }
    const input = Array.from(
      itemRefs.current[index]?.querySelectorAll<HTMLInputElement>(
        "input[type=radio], input[type=checkbox]",
      ) ?? [],
    ).find((el) => el.value === option.label);
    if (!input) return false;
    input.focus();
    input.click();
    return true;
  }

  // Letters typed into the card's own free-text field are text, and inside
  // the form the primitive would otherwise pick without sending; taking the
  // keystroke here first keeps a letter meaning the same thing wherever it
  // is pressed.
  function handleKeyDownCapture(e: React.KeyboardEvent<HTMLFormElement>) {
    if (e.defaultPrevented || isTextEntryTarget(e.target)) return;
    const letter = askLetterFromKey(e.nativeEvent);
    if (letter && pressLetter(letter)) e.preventDefault();
  }

  // Hearing the rest of the page. Keystrokes inside the form already went
  // through the capture handler above; the composer and every other field
  // keep their letters; an open palette or dialog keeps the keyboard.
  const onWindowKeyDown = React.useEffectEvent((e: KeyboardEvent) => {
    if (e.defaultPrevented || blockingOverlayOpen()) return;
    const form = formRef.current;
    if (!form) return;
    if (matchesShortcut(e, "ask-focus")) {
      e.preventDefault();
      const item = form.querySelector<HTMLElement>("fieldset:not([hidden])");
      const target =
        item?.querySelector<HTMLElement>("input:checked") ??
        item?.querySelector<HTMLElement>("input:not([type=hidden])") ??
        item;
      target?.focus();
      return;
    }
    if (e.target instanceof Node && form.contains(e.target)) return;
    if (isTextEntryTarget(e.target)) return;
    const letter = askLetterFromKey(e);
    if (letter && pressLetter(letter)) e.preventDefault();
  });
  React.useEffect(() => {
    if (!active || submitted) return;
    window.addEventListener("keydown", onWindowKeyDown);
    return () => window.removeEventListener("keydown", onWindowKeyDown);
  }, [active, submitted]);

  // Only reached once every item validates — the root holds the submit back
  // and focuses the first unanswered question otherwise.
  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitted) return;
    setSubmitted(true);
    const answers: Record<string, string> = {};
    questions.forEach((q, i) => {
      answers[q.question] = answerFor(i);
    });
    onAnswer(answers);
  }

  return (
    <Questionnaire.Root
      ref={formRef}
      items={items}
      shortcuts="letters"
      onItemChange={setActiveName}
      onKeyDownCapture={handleKeyDownCapture}
      onSubmit={handleSubmit}
      className={ASK_CARD_SHELL}
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
        <span
          aria-hidden="true"
          className="h-1.5 w-1.5 shrink-0 rounded-full bg-green shadow-[0_0_0_3px_var(--green-soft)]"
        />
        <span className="text-label font-semibold text-dim">
          {AGENT_NAME} needs input
        </span>
        {/* One question's header rides this row instead of claiming a line of
				    its own: it is a two-word topic tag, so stacked under the status it
				    made a three-deep ladder of labels before the question itself. Slack
				    joins them the same way (`*header* — question`, see asks.ts). With
				    several questions each section keeps its own header, since there it
				    says which of them you are looking at. */}
        {lone?.header && (
          <>
            <span aria-hidden="true" className="text-label text-faint">
              ·
            </span>
            <span className="text-label font-semibold text-faint">
              {lone.header}
            </span>
          </>
        )}
      </div>

      {questions.map((q, i) => (
        <Questionnaire.Item
          key={itemName(i)}
          ref={(el) => {
            itemRefs.current[i] = el;
          }}
          name={itemName(i)}
          required
          multiple={q.multiSelect}
          aria-labelledby={titleId(i)}
          // Zero the UA fieldset (no Preflight), and win back `hidden`
          // against the `flex` on the same element.
          className="m-0 flex min-w-0 flex-col gap-3 border-0 p-0 [&[hidden]]:hidden"
        >
          {((q.header && !lone) || q.multiSelect) && (
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
              {q.header && !lone && (
                <span className="text-label font-semibold text-faint">
                  {q.header}
                </span>
              )}
              {q.multiSelect && (
                <Questionnaire.Description
                  className="text-meta text-faint"
                  render={<span />}
                >
                  Select all that apply
                </Questionnaire.Description>
              )}
            </div>
          )}
          {/* The question is prose, not a title: it is often several sentences,
					    and setting it semibold turned whole paragraphs bold. Body weight
					    on the transcript's own 14px/24px rhythm — the raised card and the
					    "needs input" label already mark it as the thing being asked.
					    It replaces the fieldset's `legend` (markdown is block content,
					    which a legend may not hold), so it names the item by id. */}
          <Questionnaire.Title
            id={titleId(i)}
            render={
              <div
                className="markdown text-body leading-6 text-fg [overflow-wrap:anywhere]"
                dangerouslySetInnerHTML={{
                  __html: renderMarkdown(q.question, { repo }),
                }}
              />
            }
          />
          <Questionnaire.Choices className="flex flex-col gap-1.5">
            {q.options?.map((opt) => {
              const active = (picks[itemName(i)] ?? []).includes(opt.label);
              return (
                <Questionnaire.Choice
                  key={opt.label}
                  value={opt.label}
                  checked={active}
                  onPointerDown={() => {
                    pointerPick.current = true;
                  }}
                  onChange={(e) => choose(i, q, opt.label, e.target.checked)}
                  // No hairline: the row's own surface against the card is the
                  // edge. And a pick doesn't tint the row — the filled
                  // indicator says it. Washing the row grey made the chosen
                  // option look dimmed, not chosen, and collided with the
                  // hover wash on its neighbours.
                  className={ASK_CHOICE_ROW}
                >
                  <Questionnaire.ChoiceInput className="sr-only" />
                  {/* The letter leads the row, the way a lettered list does. It is
									    how the options are named (in the transcript above, in Slack,
									    and out loud), so it belongs where a marker goes rather than
									    trailing the description as a key hint. Fixed width so the
									    labels start on one line; still the quiet weight a menu row's
									    shortcut wears (MenuShortcut).

									    It sits on the option's own line: same 13px/20px line box as
									    the label beside it, so their cap-heights meet, and flush
									    left in its column rather than centred in it, so the three
									    letters share an edge with each other and with the text in
									    the free-text row below. Pulling only its trailing margin
									    keeps the answer close without tightening the indicator. */}
                  <Questionnaire.ChoiceShortcut className="-mr-2 w-3.5 shrink-0 text-label leading-5 text-faint" />
                  <Questionnaire.ChoiceLabel className="min-w-0 flex-1">
                    <span className="block text-control-label font-semibold leading-5 text-fg">
                      {opt.label}
                    </span>
                    {opt.description && (
                      <span className="mt-0.5 block text-supporting leading-[1.45] text-dim">
                        {opt.description}
                      </span>
                    )}
                  </Questionnaire.ChoiceLabel>
                  <span
                    aria-hidden="true"
                    className={cn(
                      "mt-px flex h-5 w-5 shrink-0 items-center justify-center border transition-[background-color,border-color,color]",
                      q.multiSelect
                        ? "rounded-[calc(6px*var(--rf))] [corner-shape:var(--cs)]"
                        : "rounded-full",
                      active
                        ? "border-transparent bg-fg text-bg"
                        : "border-line-strong text-transparent",
                    )}
                  >
                    <IconCheck size={20} />
                  </span>
                </Questionnaire.Choice>
              );
            })}
            <Questionnaire.Input
              aria-label={q.options?.length ? "Custom answer" : "Answer"}
              /* border-0 is load-bearing, not tidying: this app deliberately
							   doesn't ship Tailwind's Preflight (see styles/tailwind.css), so
							   an <input> with no border utility keeps the UA's 2px inset
							   border — the dark outline this field used to wear. Any borderless
							   input here has to zero it explicitly.

							   No ring on focus either — same call the composer makes: it read
							   as an error state on a field you're simply typing in, and the
							   caret is affordance enough. */
              className={cn(
                "h-11 w-full rounded-[calc(12px*var(--rf))] border-0 bg-control px-3 text-base text-fg outline-none placeholder:text-faint disabled:opacity-60 sm:text-control-label [corner-shape:var(--cs)]",
                q.options?.length && "mt-1.5",
              )}
              placeholder={
                q.options?.length
                  ? "Or type your own answer…"
                  : "Type your answer…"
              }
              value={custom[itemName(i)] ?? ""}
              onChange={(e) => write(i, q, e.target.value)}
            />
          </Questionnaire.Choices>
          <Questionnaire.Error className="text-meta text-red" />
        </Questionnaire.Item>
      ))}

      {/* An action the active question has no use for arrives carrying
			    `hidden`, and Button's own `inline-flex` outranks the UA's
			    `[hidden]` rule — so each one has to win it back the same way the
			    item does. Without this, every single-question ask (almost all of
			    them) wears a dead Previous and Next. */}
      <div className="flex items-center justify-end gap-2">
        {/* Where you are in a stepped ask, as page dots on the action bar:
				    beside the button you press to move, rather than up on the status
				    row where it read as one more label in the header. `mr-auto` parks
				    them left without making the row justify-between, so a lone
				    question's actions stay right-aligned with nothing to balance.

				    The dots are the visual half only: the primitive's own
				    `role="progressbar"` and `aria-valuetext` ("Question 1 of 2") ride
				    along in `props`, so a screen reader still hears the count that the
				    dots show. Count and position come from the primitive's state, not
				    from indexing `questions` here, so they cannot drift from the item
				    it is actually stepping through. */}
        {questions.length > 1 && (
          <Questionnaire.Progress
            render={(props, state) => (
              <div
                {...props}
                className="mr-auto flex items-center gap-1.5 pl-1"
              >
                {Array.from({ length: state.total }, (_, i) => (
                  <span
                    key={i}
                    aria-hidden="true"
                    className={cn(
                      "h-1.5 w-1.5 rounded-full transition-[background-color]",
                      // Two states, the way page dots work: here, and not
                      // here. Marking answered ones a third way would put
                      // three greys in a 6px dot, which nobody can read.
                      //
                      // 30% rather than the 20% a resting dot would take:
                      // the dots exist to say HOW MANY questions there are,
                      // so an unreachable inactive dot leaves you looking at
                      // one dot and none the wiser. Measured on the card's
                      // own surface, 20% resolved to #c9c9c9 on #f6f6f6.
                      i + 1 === state.current ? "bg-fg" : "bg-fg/30",
                    )}
                  />
                ))}
              </div>
            )}
          />
        )}
        <Questionnaire.Previous
          render={
            <Button variant="ghost" size="lg" className={HIDE_WHEN_INERT} />
          }
        >
          Previous
        </Questionnaire.Previous>
        <Questionnaire.Next
          render={
            <Button
              variant="default"
              size="lg"
              icon={<IconReturn size={20} />}
              className={HIDE_WHEN_INERT}
            />
          }
        >
          Next
        </Questionnaire.Next>
        {/* The glyph reports the state the label also names: an answer on its
				    way out before you press, a tick once it has gone.

				    It needs HIDE_WHEN_INERT for the same reason the other two do, and
				    it is the one that hurts: send is the LAST question's action, so on
				    a multi-question ask it arrives hidden and `inert` beside Next.
				    Without the class it still paints, and inert means it ignores the
				    click — a live-looking primary button that does nothing, which is
				    the one people reach for. */}
        <Questionnaire.Submit
          disabled={submitted || !allAnswered}
          render={
            <Button
              variant="primary"
              size="lg"
              icon={
                submitted ? <IconCheck size={20} /> : <IconReturn size={20} />
              }
              className={HIDE_WHEN_INERT}
            />
          }
        >
          {submitted ? "Sent" : "Answer"}
        </Questionnaire.Submit>
      </div>
    </Questionnaire.Root>
  );
}
