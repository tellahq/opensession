import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AskCard } from "./AskCard";

test("renders a free-text question without options", () => {
  const html = renderToStaticMarkup(
    <AskCard
      questions={[{ question: "What should happen next?" }]}
      onAnswer={() => {}}
    />,
  );

  expect(html).toContain("What should happen next?");
  expect(html).toContain('placeholder="Type your answer…"');
  expect(html).toContain('aria-label="Answer"');
  expect(html).not.toContain('type="radio"');
});

test("options are native radios inside the question's fieldset", () => {
  const html = renderToStaticMarkup(
    <AskCard
      questions={[
        {
          header: "Human ask",
          question: "Should **this change** ship?",
          options: [
            { label: "Ship it", description: "Push the commit now." },
            { label: "Hold it" },
          ],
        },
      ]}
      onAnswer={() => {}}
    />,
  );

  expect(html).toContain("<strong>this change</strong>");
  expect(html).toContain("<fieldset");
  expect(html).toContain('type="radio"');
  expect(html).toContain('value="Ship it"');
  expect(html).toContain('value="Hold it"');
  expect(html).toContain('aria-label="Custom answer"');
  // The old hand-rolled toggle semantics are gone.
  expect(html).not.toContain("aria-pressed");
  expect(html).not.toContain('role="group"');
});

test("the question names its fieldset, since markdown can't live in a legend", () => {
  const html = renderToStaticMarkup(
    <AskCard
      questions={[{ question: "Ship it?", options: [{ label: "Yes" }] }]}
      onAnswer={() => {}}
    />,
  );

  const labelledBy = html.match(/aria-labelledby="([^"]+)"/)?.[1];
  expect(labelledBy).toBeTruthy();
  // The id it points at is the rendered question, not a <legend>.
  expect(html).toContain(`id="${labelledBy}"`);
  expect(html).not.toContain("<legend");
});

test("each option carries a letter shortcut", () => {
  const html = renderToStaticMarkup(
    <AskCard
      questions={[
        { question: "Pick", options: [{ label: "One" }, { label: "Two" }] },
      ]}
      onAnswer={() => {}}
    />,
  );

  expect(html).toContain('aria-keyshortcuts="A"');
  expect(html).toContain('aria-keyshortcuts="B"');
});

test("a lone question's header rides the status row instead of stacking", () => {
  const html = renderToStaticMarkup(
    <AskCard
      questions={[{ header: "repo tile", question: "Branch or PR state?" }]}
      onAnswer={() => {}}
    />,
  );

  // Rendered once, and on the same row as the status label rather than under it.
  expect(html.split("repo tile").length - 1).toBe(1);
  expect(html).toMatch(/needs input<\/span>.*repo tile/s);
  // One question is not a flow: no progress, and nothing to step to.
  expect(html).not.toContain('role="progressbar"');
});

test("several questions step one at a time, with page dots on the action bar", () => {
  const html = renderToStaticMarkup(
    <AskCard
      questions={[
        { header: "repo tile", question: "Branch or PR state?" },
        { header: "sort order", question: "Newest first?" },
      ]}
      onAnswer={() => {}}
    />,
  );

  // Each section keeps its own header, and neither is pulled into the status
  // row (which now carries the position instead).
  expect(html).toContain("repo tile");
  expect(html).toContain("sort order");
  // The status row is the label and nothing else: with several questions no
  // header rides it, and the position moved down to the action bar.
  expect(html).toMatch(/needs input<\/span><\/div>/);

  // Position is page dots down on the action bar, one per question, with the
  // count still spoken by the primitive's own progressbar role.
  expect(html).toContain('aria-valuetext="Question 1 of 2"');
  const progress = html.match(/<div[^>]*role="progressbar"[^>]*>(.*?)<\/div>/s);
  expect(progress).toBeTruthy();
  expect(progress?.[1].match(/<span/g) ?? []).toHaveLength(2);
  // The dots are the only thing in it: the "Question 1 of 2" sentence the
  // primitive passes as children must not paint beside them.
  expect(progress?.[1]).not.toContain("Question 1 of 2");
  // It sits before the actions, not up in the header.
  expect(html).toMatch(/role="progressbar"[\s\S]*<button/);

  // Only the first question is live; the second is hidden and inert.
  const fieldsets = html.match(/<fieldset[^>]*>/g) ?? [];
  expect(fieldsets).toHaveLength(2);
  expect(fieldsets[0]).toContain("data-active");
  expect(fieldsets[1]).toContain("hidden");
  expect(fieldsets[1]).toContain("inert");
});

test("a lone question shows only the send action, never Previous/Next", () => {
  const html = renderToStaticMarkup(
    <AskCard
      questions={[{ question: "Ship it?", options: [{ label: "Yes" }] }]}
      onAnswer={() => {}}
    />,
  );

  // Match the ATTRIBUTE, not the word: every action now carries a class that
  // spells `hidden` too, and a filter that reads the whole tag counts the
  // visible button as hidden.
  const buttons = html.match(/<button[^>]*>/g) ?? [];
  const visible = buttons.filter((b) => !b.includes('hidden=""'));
  expect(visible).toHaveLength(1);
  expect(visible[0]).toContain('type="submit"');

  // The `hidden` attribute alone does not hide them: Button paints
  // `inline-flex`, which outranks the UA rule, and we ship no Preflight. Each
  // hidden action has to carry the class that wins it back.
  for (const button of buttons.filter((b) => b.includes('hidden=""'))) {
    expect(button).toContain("[hidden]]:hidden");
  }
});

test("a stepped ask shows Next only, with no dead Answer beside it", () => {
  const html = renderToStaticMarkup(
    <AskCard
      questions={[
        { question: "Shape?", options: [{ label: "Compact" }] },
        { question: "Where?", options: [{ label: "Transcript" }] },
      ]}
      onAnswer={() => {}}
    />,
  );

  const buttons = html.match(/<button[^>]*>/g) ?? [];
  const visible = buttons.filter((b) => !b.includes('hidden=""'));

  // Send belongs to the LAST question. Until then Next is the only action:
  // an Answer button here is both dead (the primitive marks it inert) and a
  // second thing to press.
  expect(visible).toHaveLength(1);
  expect(visible[0]).not.toContain('type="submit"');

  // Every inert action has to win `hidden` back against Button's own
  // `inline-flex` — submit included, which is the one that got missed.
  const inert = buttons.filter((b) => b.includes('hidden=""'));
  expect(inert).toHaveLength(2);
  for (const button of inert) expect(button).toContain("[hidden]]:hidden");
});

test("the send action is held back until the ask has an answer", () => {
  const html = renderToStaticMarkup(
    <AskCard
      questions={[
        {
          question: "Pick all",
          multiSelect: true,
          options: [{ label: "One" }],
        },
      ]}
      onAnswer={() => {}}
    />,
  );

  // Answer is on screen from the start here, because a multi-select pick is not
  // a send. Nothing has been answered yet though, so it must not be pressable:
  // the primitive shows the action on the last question and leaves it live, and
  // pressing it would validate, refuse, and jump focus back with an error.
  const submit = (html.match(/<button[^>]*>/g) ?? []).find((b) =>
    b.includes('type="submit"'),
  );
  expect(submit).toBeTruthy();
  expect(submit).toContain("disabled");
});

test("a free-text ask cannot be sent empty", () => {
  const html = renderToStaticMarkup(
    <AskCard
      questions={[{ question: "What should happen next?" }]}
      onAnswer={() => {}}
    />,
  );

  const submit = (html.match(/<button[^>]*>/g) ?? []).find((b) =>
    b.includes('type="submit"'),
  );
  expect(submit).toContain("disabled");
});

test("multi-select and free-text answers retain the explicit Answer action", () => {
  const html = renderToStaticMarkup(
    <AskCard
      questions={[
        {
          question: "Pick all",
          multiSelect: true,
          options: [{ label: "One" }],
        },
      ]}
      onAnswer={() => {}}
    />,
  );

  // Button wraps a string label in its own span (cap-band trim), so the
  // label is the button's last element rather than its text node.
  expect(html).toContain(">Answer</span></button>");
  expect(html).toContain("Select all that apply");
  // Several answers allowed means checkboxes, not radios.
  expect(html).toContain('type="checkbox"');
  expect(html).not.toContain('type="radio"');
});
