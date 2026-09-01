import { mergeStylexProps } from "../ui/cn";
import { utilityClassName } from "../ui/cn";
import type { AnsweredAskData } from "@tellahq/opensession-protocol/notices";
import { ANSWER_OPTION_LETTERS, answeredAskState } from "../lib/answered-ask";
import { renderMarkdown } from "../lib/markdown";
import { msgRow } from "../lib/msg-classes";
import { cn } from "../ui/cn";
import { IconCheck } from "./icons";
import { useMarkdownRepo } from "./MarkdownBody";
import * as stylex from "@stylexjs/stylex";
import { type as typography } from "../styles/typography.stylex";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
  w35: {
    width: "calc(4px * 3.5)",
  },
  shrink0: {
    flexShrink: "0",
  },
  ptPx: {
    paddingTop: "1px",
  },
  leading5: {
    lineHeight: "calc(4px * 5)",
  },
  textFaint: {
    color: "var(--text-faint)",
  },
  minW0: {
    minWidth: "0",
  },
  flex1: {
    flex: "1",
  },
  maxWMin600px90: {
    maxWidth: "min(600px, 90%)",
  },
  selfEnd: {
    alignSelf: "flex-end",
  },
  rounded2xl: {
    borderRadius: "calc(22px * var(--rf))",
    cornerShape: "var(--cs)",
  },
  bgPanel: {
    backgroundColor: "var(--bg-panel)",
  },
  p4: {
    padding: "calc(4px * 4)",
  },
  CornerShapeVarCs: {
    cornerShape: "var(--cs)",
  },
  flex: {
    display: "flex",
  },
  flexWrap: {
    flexWrap: "wrap",
  },
  itemsCenter: {
    alignItems: "center",
  },
  gapX15: {
    columnGap: "calc(4px * 1.5)",
  },
  gapY05: {
    rowGap: "calc(4px * 0.5)",
  },
  fontSemibold: {
    fontWeight: "var(--font-weight-semibold)",
  },
  h4: {
    height: "calc(4px * 4)",
  },
  w4: {
    width: "calc(4px * 4)",
  },
  justifyCenter: {
    justifyContent: "center",
  },
  roundedFull: {
    borderRadius: "calc(infinity * 1px)",
    cornerShape: "round",
  },
  bgGreenSoft: {
    backgroundColor: "var(--green-soft)",
  },
  textGreen: {
    color: "var(--green)",
  },
  textDim: {
    color: "var(--text-dim)",
  },
  mt3: {
    marginTop: "calc(4px * 3)",
  },
  flexCol: {
    flexDirection: "column",
  },
  gap4: {
    gap: "calc(4px * 4)",
  },
  mb1: {
    marginBottom: "4px",
  },
  OverflowWrapAnywhere: {
    overflowWrap: "anywhere",
  },
  TextWrapPretty: {
    textWrap: "pretty",
  },
  mt2: {
    marginTop: "calc(4px * 2)",
  },
  gap05: {
    gap: "calc(4px * 0.5)",
  },
});

function ChoiceRow({
  letter,
  label,
  description,
  selected,
}: {
  letter: string;
  label: string;
  description?: string;
  selected: boolean;
}) {
  return (
    <div
      role="listitem"
      aria-label={`${label}${selected ? ", selected" : ""}`}
      data-selected={selected ? "" : undefined}
      className={cn(
        utilityClassName(
          "flex min-h-9 items-start gap-2.5 rounded-md px-2.5 py-2 [corner-shape:var(--cs)]",
        ),
        selected
          ? utilityClassName("bg-control")
          : utilityClassName("text-dim"),
      )}
    >
      <span
        {...stylex.props(
          sx.w35,
          sx.shrink0,
          sx.ptPx,
          sx.leading5,
          sx.textFaint,
          typography.meta,
        )}
      >
        {letter}
      </span>
      <span {...stylex.props(sx.minW0, sx.flex1)}>
        <span
          className={cn(
            utilityClassName(
              "block text-control-label leading-5 [overflow-wrap:anywhere]",
            ),
            selected
              ? utilityClassName("font-semibold text-fg")
              : utilityClassName("font-medium"),
          )}
        >
          {label}
        </span>
        {description && (
          <span
            className={cn(
              utilityClassName(
                "mt-0.5 block text-supporting leading-[1.45] [overflow-wrap:anywhere]",
              ),
              selected
                ? utilityClassName("text-dim")
                : utilityClassName("text-faint"),
            )}
          >
            {description}
          </span>
        )}
      </span>
      <span
        aria-hidden="true"
        className={cn(
          utilityClassName(
            "flex h-5 w-5 shrink-0 items-center justify-center rounded-full",
          ),
          selected
            ? utilityClassName("bg-green-soft text-green")
            : utilityClassName("text-transparent"),
        )}
      >
        <IconCheck size={16} />
      </span>
    </div>
  );
}

/** A durable receipt for an answer sent through AskCard. It sits on the
 * sender side of the transcript, while its quiet surface and status label
 * distinguish it from an ordinary message. Every offered option stays for
 * context, with the exact choice marked as selected. */
export function AnsweredAskCard({
  record,
  entryId,
}: {
  record: AnsweredAskData;
  entryId: string;
}) {
  const repo = useMarkdownRepo();
  const count = record.questions.length;
  const lone = count === 1 ? record.questions[0] : undefined;

  return (
    <div className={msgRow} data-eid={entryId} data-answered-ask="">
      <div
        {...stylex.props(
          sx.maxWMin600px90,
          sx.selfEnd,
          sx.rounded2xl,
          sx.bgPanel,
          sx.p4,
          sx.CornerShapeVarCs,
        )}
      >
        <div
          {...stylex.props(
            sx.flex,
            sx.flexWrap,
            sx.itemsCenter,
            sx.gapX15,
            sx.gapY05,
            sx.fontSemibold,
            typography.label,
          )}
        >
          <span
            aria-hidden="true"
            {...stylex.props(
              sx.flex,
              sx.h4,
              sx.w4,
              sx.itemsCenter,
              sx.justifyCenter,
              sx.roundedFull,
              sx.bgGreenSoft,
              sx.textGreen,
            )}
          >
            <IconCheck size={14} />
          </span>
          <span {...stylex.props(sx.textDim)}>
            {count === 1 ? "Answer sent" : `${count} answers sent`}
          </span>
          {lone?.header && (
            <>
              <span aria-hidden="true" {...stylex.props(sx.textFaint)}>
                ·
              </span>
              <span {...stylex.props(sx.textFaint)}>{lone.header}</span>
            </>
          )}
        </div>

        <div {...stylex.props(sx.mt3, sx.flex, sx.flexCol, sx.gap4)}>
          {record.questions.map((question, index) => {
            const { selected, typed } = answeredAskState(question);
            const options = question.options ?? [];
            return (
              <section key={`${question.question}:${index}`}>
                {question.header && !lone && (
                  <div
                    {...stylex.props(
                      sx.mb1,
                      sx.fontSemibold,
                      sx.textFaint,
                      typography.meta,
                    )}
                  >
                    {question.header}
                  </div>
                )}
                <div
                  {...mergeStylexProps(
                    "markdown",
                    sx.leading5,
                    sx.textDim,
                    sx.OverflowWrapAnywhere,
                    sx.TextWrapPretty,
                    typography.controlLabel,
                  )}
                  dangerouslySetInnerHTML={{
                    __html: renderMarkdown(question.question, { repo }),
                  }}
                />
                <div
                  {...stylex.props(sx.mt2, sx.flex, sx.flexCol, sx.gap05)}
                  role="list"
                  aria-label="Answer choices"
                >
                  {options.map((option, optionIndex) => (
                    <ChoiceRow
                      key={`${option.label}:${optionIndex}`}
                      letter={ANSWER_OPTION_LETTERS[optionIndex] ?? "–"}
                      label={option.label}
                      description={option.description}
                      selected={selected.has(option.label)}
                    />
                  ))}
                  {typed.map((answer, typedIndex) => (
                    <ChoiceRow
                      key={`${answer}:${typedIndex}`}
                      letter="–"
                      label={answer}
                      description={options.length ? "Custom answer" : undefined}
                      selected
                    />
                  ))}
                  {!question.answer.trim() && (
                    <ChoiceRow letter="–" label="No answer" selected />
                  )}
                </div>
              </section>
            );
          })}
        </div>
      </div>
    </div>
  );
}
