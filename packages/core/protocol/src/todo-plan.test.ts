import { describe, expect, test } from "bun:test";
import { currentPlanItem, parsePlanItems, planDoneCount } from "./todo-plan";

describe("parsePlanItems", () => {
  test("reads the pi todowrite shape", () => {
    const items = parsePlanItems({
      todos: [
        { content: "Find the view", status: "completed", priority: "high" },
        { content: "Wire the store", status: "in_progress", priority: "high" },
        { content: "Verify", status: "pending", priority: "medium" },
      ],
    });
    expect(items).toEqual([
      { content: "Find the view", status: "completed" },
      { content: "Wire the store", status: "in_progress" },
      { content: "Verify", status: "pending" },
    ]);
    expect(planDoneCount(items)).toBe(1);
    expect(currentPlanItem(items)).toBe("Wire the store");
  });

  test("reads codex's update_plan shape", () => {
    expect(
      parsePlanItems({ plan: [{ step: "Read the spec", status: "active" }] }),
    ).toEqual([{ content: "Read the spec", status: "in_progress" }]);
  });

  test("unknown or missing statuses fall back to pending", () => {
    expect(
      parsePlanItems({
        todos: [{ content: "A" }, { content: "B", status: "?" }],
      }),
    ).toEqual([
      { content: "A", status: "pending" },
      { content: "B", status: "pending" },
    ]);
  });

  test("is empty for inputs that carry no list (todoread, junk)", () => {
    expect(parsePlanItems({})).toEqual([]);
    expect(parsePlanItems({ todos: "nope" })).toEqual([]);
    expect(parsePlanItems(null)).toEqual([]);
    expect(parsePlanItems("todos")).toEqual([]);
  });

  test("skips entries with no usable text", () => {
    expect(
      parsePlanItems({
        todos: [
          { status: "pending" },
          null,
          { content: "  " },
          { content: " Ship " },
        ],
      }),
    ).toEqual([{ content: "Ship", status: "pending" }]);
  });

  test("currentPlanItem is empty when nothing is in progress", () => {
    expect(
      currentPlanItem(
        parsePlanItems({ todos: [{ content: "A", status: "completed" }] }),
      ),
    ).toBe("");
  });
});
