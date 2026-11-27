import { expect, test } from "bun:test";
import { placeOfRoute } from "./new-layout-place";

test("a route that names its place ignores where you were", () => {
  expect(placeOfRoute({ view: "feed" }, "sessions")).toBe("activity");
  expect(placeOfRoute({ view: "prs" }, "activity")).toBe("library");
  expect(placeOfRoute({ view: "plain" }, "library")).toBe("support");
  expect(placeOfRoute({ view: "archived" }, "activity")).toBe("sessions");
});

test("a session stays in Activity and otherwise belongs to Sessions", () => {
  const session = { view: "session", id: "s1" } as const;
  expect(placeOfRoute(session, "activity")).toBe("activity");
  expect(placeOfRoute(session, "sessions")).toBe("sessions");
  expect(placeOfRoute(session, "library")).toBe("sessions");
  expect(placeOfRoute(session, "support")).toBe("sessions");
});
