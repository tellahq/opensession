import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AnsweredAskCard } from "./AnsweredAskCard";
import { MessageBubble } from "./MessageBubble";

Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
  },
});
Object.defineProperty(globalThis, "window", {
  configurable: true,
  value: {
    addEventListener: () => {},
    removeEventListener: () => {},
    matchMedia: () => ({
      matches: false,
      addEventListener: () => {},
      removeEventListener: () => {},
    }),
  },
});

const record = {
  version: 1 as const,
  questions: [
    {
      header: "Demo choice",
      question: "Which **version** should the transcript show?",
      options: [
        { label: "Compact", description: "A calm read-only card." },
        { label: "Detailed" },
        { label: "Both" },
      ],
      answer: "Compact",
    },
  ],
};

test("renders a compact receipt with the question and exact answer", () => {
  const html = renderToStaticMarkup(
    <AnsweredAskCard record={record} entryId="ask-1" />,
  );

  expect(html).toContain('data-answered-ask=""');
  expect(html).toContain("self-end");
  expect(html).toContain("Answer sent");
  expect(html).toContain("Demo choice");
  expect(html).toContain("Which <strong>version</strong>");
  expect(html).toContain("Compact");
});

test("keeps every option and clearly marks the selected one", () => {
  const html = renderToStaticMarkup(
    <AnsweredAskCard record={record} entryId="ask-1" />,
  );

  expect(html).toContain("Detailed");
  expect(html).toContain("A calm read-only card.");
  expect(html).toContain(">A</span>");
  expect(html).toContain(">B</span>");
  expect(html).toContain('aria-label="Compact, selected"');
  expect(html).toContain('aria-label="Detailed"');
  expect(html).not.toContain('aria-label="Detailed, selected"');
  expect(html).not.toContain("<button");
  expect(html).not.toContain("<input");
});

test("MessageBubble slightly mutes a sent message until the engine reads it", () => {
  const html = renderToStaticMarkup(
    <MessageBubble
      entry={{
        id: "pending-steer",
        type: "user",
        content: "Please also check the tests",
        timestamp: "",
      }}
      pendingDelivery
      owner="Kent"
    />,
  );
  expect(html).toContain("opacity-70");
  expect(html).toContain('data-delivery-pending="true"');
});

test("MessageBubble routes ask notices to the sent receipt", () => {
  const html = renderToStaticMarkup(
    <MessageBubble
      entry={{
        id: "ask-1",
        type: "system",
        content: "compatibility body",
        timestamp: "2026-08-19T12:00:00.000Z",
        notice: {
          kind: "ask",
          title: "Answered: Compact",
          tone: "info",
          body: "collapsed",
          ask: record,
        },
      }}
    />,
  );

  expect(html).toContain('data-answered-ask=""');
  expect(html).toContain("Answer sent");
  expect(html).not.toContain("Answered: Compact ·");
  expect(html).not.toContain(">show</span>");
});

test("shows typed and multi-question answers exactly as sent", () => {
  const html = renderToStaticMarkup(
    <AnsweredAskCard
      record={{
        version: 1,
        questions: [
          {
            question: "What should happen next?",
            options: [{ label: "Wait" }],
            answer: "Ship today",
          },
          {
            question: "Who should review it?",
            answer: "Kent",
          },
        ],
      }}
      entryId="ask-2"
    />,
  );

  expect(html).toContain("2 answers sent");
  expect(html).toContain("Wait");
  expect(html).toContain("Ship today");
  expect(html).toContain('aria-label="Ship today, selected"');
  expect(html).toContain("Custom answer");
  expect(html).toContain("Kent");
});
