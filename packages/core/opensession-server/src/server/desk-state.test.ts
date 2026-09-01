import { describe, expect, test } from "bun:test";
import { renderDeskBriefing } from "./desk-state";
import type { DeskState } from "./desk-state";

function state(over: Partial<DeskState> = {}): DeskState {
  return {
    waiting: [],
    running: [],
    review: [],
    todos: [],
    more: { waiting: 0, running: 0, review: 0, todos: 0 },
    generatedAt: "2026-08-09T09:41:00.000Z",
    ...over,
  };
}

const item = (id: string, title: string, over = {}) => ({
  sessionId: id,
  title,
  lastActivity: "2026-08-09T09:00:00.000Z",
  ...over,
});

describe("Desk live-state briefing", () => {
  test("says so plainly when there is nothing running or blocked", () => {
    const note = renderDeskBriefing(state());
    expect(note).toContain(
      "Nothing is running, and nothing is waiting on them.",
    );
    // No empty section headers — a quiet world reads quiet, not as a wall
    // of zeros (the same rule the UI follows).
    expect(note).not.toContain("Running right now");
    expect(note).not.toContain("Waiting on the user");
    expect(note).not.toContain("Finished and not yet read");
  });

  test("lists each bucket with session ids so the Desk can steer them", () => {
    const note = renderDeskBriefing(
      state({
        waiting: [
          item("os-a", "iOS composer jank", {
            question: {
              questionId: "q1",
              text: "Device or simulator?",
              options: ["Device", "Simulator"],
            },
          }),
        ],
        running: [item("os-b", "Ship os1-mac", { repo: "os1-mac" })],
        review: [
          item("os-c", "Export retry backoff", {
            pr: {
              number: 5521,
              checks: { passed: 4, failed: 0, pending: 0 },
            },
          }),
        ],
      }),
    );
    expect(note).toContain("os-a");
    expect(note).toContain('asked: "Device or simulator?"');
    expect(note).toContain("os-b — Ship os1-mac (os1-mac)");
    expect(note).toContain("PR #5521 open, checks green");
  });

  test("reports check health honestly rather than always 'green'", () => {
    const failing = renderDeskBriefing(
      state({
        review: [
          item("os-c", "X", {
            pr: { number: 1, checks: { passed: 1, failed: 2, pending: 0 } },
          }),
        ],
      }),
    );
    expect(failing).toContain("checks failing");
    const pending = renderDeskBriefing(
      state({
        review: [
          item("os-c", "X", {
            pr: { number: 1, checks: { passed: 1, failed: 0, pending: 3 } },
          }),
        ],
      }),
    );
    expect(pending).toContain("checks pending");
  });

  test("a PR with no checks is not reported as green", () => {
    const note = renderDeskBriefing(
      state({
        review: [
          item("os-c", "X", {
            pr: { number: 7, checks: { passed: 0, failed: 0, pending: 0 } },
          }),
        ],
      }),
    );
    expect(note).toContain("PR #7 open");
    expect(note).not.toContain("green");
  });

  test("counts include what the caps left out", () => {
    const note = renderDeskBriefing(
      state({
        running: [item("os-b", "One")],
        more: { waiting: 0, running: 4, review: 0, todos: 0 },
      }),
    );
    expect(note).toContain("Running right now (5)");
  });

  test("tells the Desk to steer rather than duplicate running work", () => {
    const note = renderDeskBriefing(state({ running: [item("os-b", "One")] }));
    expect(note).toContain("send_to_session");
    expect(note).toContain("rebuilt every turn");
  });
});
