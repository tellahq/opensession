import type { AnsweredAskData } from "@tellahq/opensession-protocol/notices";
import { ANSWER_OPTION_LETTERS, answeredAskState } from "../lib/answered-ask";
import { renderMarkdown } from "../lib/markdown";
import { msgRow } from "../lib/msg-classes";
import { cn } from "../ui/cn";
import { IconCheck } from "./icons";
import { useMarkdownRepo } from "./MarkdownBody";

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
        "flex min-h-9 items-start gap-2.5 rounded-md px-2.5 py-2 [corner-shape:var(--cs)]",
        selected ? "bg-control" : "text-dim",
      )}
    >
      <span className="w-3.5 shrink-0 pt-px text-meta leading-5 text-faint">
        {letter}
      </span>
      <span className="min-w-0 flex-1">
        <span
          className={cn(
            "block text-control-label leading-5 [overflow-wrap:anywhere]",
            selected ? "font-semibold text-fg" : "font-medium",
          )}
        >
          {label}
        </span>
        {description && (
          <span
            className={cn(
              "mt-0.5 block text-supporting leading-body [overflow-wrap:anywhere]",
              selected ? "text-dim" : "text-faint",
            )}
          >
            {description}
          </span>
        )}
      </span>
      <span
        aria-hidden="true"
        className={cn(
          "flex h-5 w-5 shrink-0 items-center justify-center rounded-full",
          selected ? "bg-green-soft text-green" : "text-transparent",
        )}
      >
        <IconCheck size={20} />
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
      <div className="max-w-[min(600px,90%)] self-end rounded-2xl bg-panel p-4 [corner-shape:var(--cs)]">
        <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-label font-semibold">
          <span
            aria-hidden="true"
            className="flex h-4 w-4 items-center justify-center rounded-full bg-green-soft text-green"
          >
            <IconCheck size={20} />
          </span>
          <span className="text-dim">
            {count === 1 ? "Answer sent" : `${count} answers sent`}
          </span>
          {lone?.header && (
            <>
              <span aria-hidden="true" className="text-faint">
                ·
              </span>
              <span className="text-faint">{lone.header}</span>
            </>
          )}
        </div>

        <div className="mt-3 flex flex-col gap-4">
          {record.questions.map((question, index) => {
            const { selected, typed } = answeredAskState(question);
            const options = question.options ?? [];
            return (
              <section key={`${question.question}:${index}`}>
                {question.header && !lone && (
                  <div className="mb-1 text-meta font-semibold text-faint">
                    {question.header}
                  </div>
                )}
                <div
                  className="markdown text-control-label leading-5 text-dim [overflow-wrap:anywhere] [text-wrap:pretty]"
                  dangerouslySetInnerHTML={{
                    __html: renderMarkdown(question.question, { repo }),
                  }}
                />
                <div
                  className="mt-2 flex flex-col gap-0.5"
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
