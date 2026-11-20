import { expect, test } from "bun:test";
import { applyTicketChange } from "./support-ticket-changes";
import type { SupportThread } from "./types";

const ticket = (
  id: string,
  extra: Partial<SupportThread> = {},
): SupportThread => ({
  id,
  title: `Ticket ${id}`,
  previewText: null,
  status: "TODO",
  statusChangedAt: null,
  createdAt: null,
  priority: 2,
  labels: [],
  customer: { name: "Acme", email: "ops@example.test" },
  assignee: null,
  ...extra,
});

test("closing, snoozing or spamming a ticket takes it out of the Todo queue", () => {
  const queue = [ticket("a"), ticket("b")];
  for (const change of [
    { kind: "status", status: "done" },
    { kind: "status", status: "snoozed", durationSeconds: 3600 },
    { kind: "spam" },
  ] as const)
    expect(applyTicketChange(queue, "a", change).map((t) => t.id)).toEqual([
      "b",
    ]);
});

test("priority and assignee edit the row in place", () => {
  const queue = [ticket("a"), ticket("b")];
  const moved = applyTicketChange(queue, "a", {
    kind: "priority",
    priority: 0,
  });
  expect(moved[0].priority).toBe(0);
  expect(moved[1]).toBe(queue[1]);
  const assigned = applyTicketChange(queue, "a", {
    kind: "assignee",
    user: { id: "u1", name: "Sam" },
  });
  expect(assigned[0].assignee).toEqual({ id: "u1", name: "Sam", isBot: false });
  expect(
    applyTicketChange(assigned, "a", { kind: "assignee", user: null })[0]
      .assignee,
  ).toBeNull();
});

test("a label toggles on by kind and off by its own id", () => {
  const queue = [ticket("a")];
  const added = applyTicketChange(queue, "a", {
    kind: "label",
    labelType: { id: "lt_bug", name: "Bug" },
  });
  expect(added[0].labels).toEqual([
    { id: "lt_bug", typeId: "lt_bug", name: "Bug", icon: null },
  ]);
  const withReal = [
    ticket("a", {
      labels: [{ id: "l_1", typeId: "lt_bug", name: "Bug", icon: null }],
    }),
  ];
  const removed = applyTicketChange(withReal, "a", {
    kind: "label",
    labelType: { id: "lt_bug", name: "Bug" },
    existing: { id: "l_1", typeId: "lt_bug", name: "Bug" },
  });
  expect(removed[0].labels).toEqual([]);
});
