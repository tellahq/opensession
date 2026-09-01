import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { PlanItem } from "@tellahq/opensession-protocol/todo-plan";

let statusOpen = false;
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: () => (statusOpen ? "1" : null),
  setItem: () => {},
  removeItem: () => {},
};

const { ComposerAgents } = await import("./ComposerAgents");
const { PlanChecklist } = await import("./PlanChecklist");

const plan: PlanItem[] = [
  { content: "Inspect the current behavior", status: "completed" },
  { content: "Simplify the plan markers", status: "in_progress" },
  { content: "Verify both states", status: "pending" },
];

describe("PlanChecklist", () => {
  test("uses a consistent dot marker for each status", () => {
    const html = renderToStaticMarkup(<PlanChecklist items={plan} />);

    expect(html).toContain("size-2 flex-none rounded-full bg-green");
    expect(html).toContain("size-2 flex-none rounded-full bg-yellow");
    expect(html).toContain("size-2 flex-none rounded-full border border-line");
    expect(html).not.toContain("composer-agents-pulse");
    expect(html).not.toContain("<svg");
  });
});

describe("ComposerAgents plan summary", () => {
  test("shows the active dot and step while collapsed", () => {
    statusOpen = false;
    const html = renderToStaticMarkup(
      <ComposerAgents runs={[]} plan={plan} onOpenPanel={() => {}} />,
    );

    expect(html).toContain('aria-expanded="false"');
    expect(
      html.split("animate-[composer-agents-pulse_1.4s_ease-in-out_infinite]")
        .length - 1,
    ).toBe(1);
    expect(html).toContain("Simplify the plan markers");
    expect(html.indexOf("1/3")).toBeLessThan(
      html.indexOf("Simplify the plan markers"),
    );
    expect(html).not.toContain("Inspect the current behavior");
    // Caret points up: the card opens upward, away from the composer.
    expect(html).toContain("rotate-180");
  });

  test("uses the checklist marker instead of a duplicate footer dot while open", () => {
    statusOpen = true;
    const html = renderToStaticMarkup(
      <ComposerAgents runs={[]} plan={plan} onOpenPanel={() => {}} />,
    );

    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain("Inspect the current behavior");
    expect(html).toContain("bg-yellow");
    expect(
      html.split("animate-[composer-agents-pulse_1.4s_ease-in-out_infinite]")
        .length - 1,
    ).toBe(1);
    // The toggle row comes last, under the checklist. The flap's bottom edge
    // is pinned to the composer, so a summary above the plan would travel the
    // plan's full height on every fold and you'd have to chase it with the
    // mouse to close what you just opened. Source order is the guard.
    expect(html.indexOf("Inspect the current behavior")).toBeLessThan(
      html.indexOf("1/3"),
    );
    expect(html.indexOf("1/3")).toBeLessThan(html.lastIndexOf(">Plan<"));
    expect(html).not.toContain("rotate-180");
    expect(html.match(/Simplify the plan markers/g)).toHaveLength(1);
  });
});
