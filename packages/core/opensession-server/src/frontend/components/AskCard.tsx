import { mergeStylexProps, mergeStylexOverrideClassName } from "../ui/cn";
import { utilityClassName } from "../ui/cn";
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
import * as stylex from "@stylexjs/stylex";
import { type as typography } from "../styles/typography.stylex";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
  flex: {
    display: "flex",
  },
  flexWrap: {
    flexWrap: "wrap",
  },
  itemsCenter: {
    alignItems: "center",
  },
  gapX2: {
    columnGap: "calc(4px * 2)",
  },
  gapY05: {
    rowGap: "calc(4px * 0.5)",
  },
  h15: {
    height: "calc(4px * 1.5)",
  },
  w15: {
    width: "calc(4px * 1.5)",
  },
  shrink0: {
    flexShrink: "0",
  },
  roundedFull: {
    borderRadius: "calc(infinity * 1px)",
    cornerShape: "round",
  },
  bgGreen: {
    backgroundColor: "var(--green)",
  },
  fontSemibold: {
    fontWeight: "var(--font-weight-semibold)",
  },
  textDim: {
    color: "var(--text-dim)",
  },
  textFaint: {
    color: "var(--text-faint)",
  },
  m0: {
    margin: "0",
  },
  minW0: {
    minWidth: "0",
  },
  flexCol: {
    flexDirection: "column",
  },
  gap3: {
    gap: "calc(4px * 3)",
  },
  border0: {
    borderStyle: "solid",
    borderWidth: "0px",
  },
  p0: {
    padding: "0",
  },
  itemsBaseline: {
    alignItems: "baseline",
  },
  leading6: {
    lineHeight: "calc(4px * 6)",
  },
  textFg: {
    color: "var(--text)",
  },
  OverflowWrapAnywhere: {
    overflowWrap: "anywhere",
  },
  gap15: {
    gap: "calc(4px * 1.5)",
  },
  srOnly: {
    position: "absolute",
    width: "1px",
    height: "1px",
    padding: "0",
    margin: "-1px",
    overflow: "hidden",
    clipPath: "inset(50%)",
    whiteSpace: "nowrap",
    borderWidth: "0",
  },
  Mr2: {
    marginRight: "calc(4px * -2)",
  },
  w35: {
    width: "calc(4px * 3.5)",
  },
  leading5: {
    lineHeight: "calc(4px * 5)",
  },
  flex1: {
    flex: "1",
  },
  block: {
    display: "block",
  },
  mt05: {
    marginTop: "calc(4px * 0.5)",
  },
  leading145: {
    lineHeight: "1.45",
  },
  textRed: {
    color: "var(--red)",
  },
  justifyEnd: {
    justifyContent: "flex-end",
  },
  gap2: {
    gap: "calc(4px * 2)",
  },
  mrAuto: {
    marginRight: "auto",
  },
  pl1: {
    paddingLeft: "4px",
  },
});

interface Props {
  questions: AskQuestion[];
  onAnswer: (answers: Record<string, string>) => void;
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
 */
export function AskCard({ questions, onAnswer }: Props) {
  const repo = useMarkdownRepo();
  const titleBase = React.useId();
  const [picks, setPicks] = React.useState<Record<string, string[]>>({});
  const [custom, setCustom] = React.useState<Record<string, string>>({});
  const [submitted, setSubmitted] = React.useState(false);
  // Only a pointer answers on the spot. Arrow keys and letter shortcuts pick
  // by calling click() on the radio, which is indistinguishable from a real
  // click by the time the change lands — so a keyboard user browsing the
  // options with ArrowDown would send the first one they touched. A pointer
  // press always precedes its change; a synthesised click never does.
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
      setPicks({ [name]: [label] });
      setSubmitted(true);
      onAnswer({ [q.question]: label });
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
      items={items}
      shortcuts="letters"
      onSubmit={handleSubmit}
      className={ASK_CARD_SHELL}
    >
      <div
        {...stylex.props(
          sx.flex,
          sx.flexWrap,
          sx.itemsCenter,
          sx.gapX2,
          sx.gapY05,
        )}
      >
        <span
          aria-hidden="true"
          {...mergeStylexProps(
            "shadow-[0_0_0_3px_var(--green-soft)]",
            sx.h15,
            sx.w15,
            sx.shrink0,
            sx.roundedFull,
            sx.bgGreen,
          )}
        />
        <span {...stylex.props(sx.fontSemibold, sx.textDim, typography.label)}>
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
            <span
              aria-hidden="true"
              {...stylex.props(sx.textFaint, typography.label)}
            >
              ·
            </span>
            <span
              {...stylex.props(sx.fontSemibold, sx.textFaint, typography.label)}
            >
              {lone.header}
            </span>
          </>
        )}
      </div>

      {questions.map((q, i) => (
        <Questionnaire.Item
          key={itemName(i)}
          name={itemName(i)}
          required
          multiple={q.multiSelect}
          aria-labelledby={titleId(i)}
          // Zero the UA fieldset (no Preflight), and win back `hidden`
          // against the `flex` on the same element.
          className={mergeStylexOverrideClassName(
            "[&[hidden]]:hidden",
            sx.m0,
            sx.flex,
            sx.minW0,
            sx.flexCol,
            sx.gap3,
            sx.border0,
            sx.p0,
          )}
        >
          {((q.header && !lone) || q.multiSelect) && (
            <div
              {...stylex.props(
                sx.flex,
                sx.flexWrap,
                sx.itemsBaseline,
                sx.gapX2,
                sx.gapY05,
              )}
            >
              {q.header && !lone && (
                <span
                  {...stylex.props(
                    sx.fontSemibold,
                    sx.textFaint,
                    typography.label,
                  )}
                >
                  {q.header}
                </span>
              )}
              {q.multiSelect && (
                <Questionnaire.Description
                  className={mergeStylexOverrideClassName(
                    "",
                    sx.textFaint,
                    typography.meta,
                  )}
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
                {...mergeStylexProps(
                  "markdown",
                  sx.leading6,
                  sx.textFg,
                  sx.OverflowWrapAnywhere,
                  typography.body,
                )}
                dangerouslySetInnerHTML={{
                  __html: renderMarkdown(q.question, { repo }),
                }}
              />
            }
          />
          <Questionnaire.Choices
            className={mergeStylexOverrideClassName(
              "",
              sx.flex,
              sx.flexCol,
              sx.gap15,
            )}
          >
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
                  <Questionnaire.ChoiceInput
                    className={mergeStylexOverrideClassName("", sx.srOnly)}
                  />
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
                  <Questionnaire.ChoiceShortcut
                    className={mergeStylexOverrideClassName(
                      "",
                      sx.Mr2,
                      sx.w35,
                      sx.shrink0,
                      sx.leading5,
                      sx.textFaint,
                      typography.label,
                    )}
                  />
                  <Questionnaire.ChoiceLabel
                    className={mergeStylexOverrideClassName(
                      "",
                      sx.minW0,
                      sx.flex1,
                    )}
                  >
                    <span
                      {...stylex.props(
                        sx.block,
                        sx.fontSemibold,
                        sx.leading5,
                        sx.textFg,
                        typography.controlLabel,
                      )}
                    >
                      {opt.label}
                    </span>
                    {opt.description && (
                      <span
                        {...stylex.props(
                          sx.mt05,
                          sx.block,
                          sx.leading145,
                          sx.textDim,
                          typography.supporting,
                        )}
                      >
                        {opt.description}
                      </span>
                    )}
                  </Questionnaire.ChoiceLabel>
                  <span
                    aria-hidden="true"
                    className={cn(
                      utilityClassName(
                        "mt-px flex h-5 w-5 shrink-0 items-center justify-center border transition-[background-color,border-color,color]",
                      ),
                      q.multiSelect
                        ? utilityClassName(
                            "rounded-[calc(6px*var(--rf))] [corner-shape:var(--cs)]",
                          )
                        : utilityClassName("rounded-full"),
                      active
                        ? utilityClassName("border-transparent bg-fg text-bg")
                        : utilityClassName(
                            "border-line-strong text-transparent",
                          ),
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
                utilityClassName(
                  "h-11 w-full rounded-[calc(12px*var(--rf))] border-0 bg-control px-3 text-base text-fg outline-none placeholder:text-faint disabled:opacity-60 sm:text-control-label [corner-shape:var(--cs)]",
                ),
                q.options?.length && utilityClassName("mt-1.5"),
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
          <Questionnaire.Error
            className={mergeStylexOverrideClassName(
              "",
              sx.textRed,
              typography.meta,
            )}
          />
        </Questionnaire.Item>
      ))}

      {/* An action the active question has no use for arrives carrying
			    `hidden`, and Button's own `inline-flex` outranks the UA's
			    `[hidden]` rule — so each one has to win it back the same way the
			    item does. Without this, every single-question ask (almost all of
			    them) wears a dead Previous and Next. */}
      <div {...stylex.props(sx.flex, sx.itemsCenter, sx.justifyEnd, sx.gap2)}>
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
                {...stylex.props(
                  sx.mrAuto,
                  sx.flex,
                  sx.itemsCenter,
                  sx.gap15,
                  sx.pl1,
                )}
              >
                {Array.from({ length: state.total }, (_, i) => (
                  <span
                    key={i}
                    aria-hidden="true"
                    className={cn(
                      utilityClassName(
                        "h-1.5 w-1.5 rounded-full transition-[background-color]",
                      ),
                      // Two states, the way page dots work: here, and not
                      // here. Marking answered ones a third way would put
                      // three greys in a 6px dot, which nobody can read.
                      //
                      // 30% rather than the 20% a resting dot would take:
                      // the dots exist to say HOW MANY questions there are,
                      // so an unreachable inactive dot leaves you looking at
                      // one dot and none the wiser. Measured on the card's
                      // own surface, 20% resolved to #c9c9c9 on #f6f6f6.
                      i + 1 === state.current
                        ? utilityClassName("bg-fg")
                        : utilityClassName("bg-fg/30"),
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
