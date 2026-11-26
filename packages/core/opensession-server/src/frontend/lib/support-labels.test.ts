import { describe, expect, test } from "bun:test";
import {
  filterSupportThreadsByLabel,
  supportLabelOptions,
} from "./support-labels";
import type { SupportThread } from "./types";

function thread(id: string, labels: string[]): SupportThread {
  return {
    id,
    title: id,
    previewText: null,
    status: "TODO",
    statusChangedAt: null,
    createdAt: null,
    priority: 2,
    labels: labels.map((name, i) => ({
      id: `l_${id}_${i}`,
      typeId: `lt_${name}`,
      name,
      icon: null,
    })),
    customer: { name: null, email: null },
  };
}

const threads = [
  thread("a", ["bug", "New Timeline"]),
  thread("b", ["New Timeline"]),
  thread("c", ["question"]),
  { ...thread("d", []), labels: undefined },
];

describe("supportLabelOptions", () => {
  test("counts each label once per ticket, most used first", () => {
    expect(supportLabelOptions(threads)).toEqual([
      { name: "New Timeline", count: 2 },
      { name: "bug", count: 1 },
      { name: "question", count: 1 },
    ]);
  });
});

describe("filterSupportThreadsByLabel", () => {
  test("keeps every ticket when no label is picked", () => {
    expect(filterSupportThreadsByLabel(threads, "")).toBe(threads);
  });

  test("keeps only tickets carrying the label", () => {
    expect(
      filterSupportThreadsByLabel(threads, "New Timeline").map((t) => t.id),
    ).toEqual(["a", "b"]);
    expect(filterSupportThreadsByLabel(threads, "feedback")).toEqual([]);
  });
});
