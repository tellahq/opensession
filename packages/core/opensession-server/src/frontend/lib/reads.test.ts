import { expect, test } from "bun:test";
import { mergeReadMaps } from "./reads";

test("read hydration merges persisted server and local marks", () => {
  expect(
    mergeReadMaps(
      {
        server: "2026-08-11T10:00:00.000Z",
        shared: "2026-08-11T10:00:00.000Z",
      },
      { local: "2026-08-11T11:00:00.000Z", shared: "2026-08-11T12:00:00.000Z" },
    ),
  ).toEqual({
    server: "2026-08-11T10:00:00.000Z",
    local: "2026-08-11T11:00:00.000Z",
    shared: "2026-08-11T12:00:00.000Z",
  });
});

test("an explicit mark made before hydration wins over persisted maps", () => {
  expect(
    mergeReadMaps(
      { session: "2026-08-11T12:00:00.000Z" },
      { session: "2026-08-11T11:00:00.000Z" },
      { session: "1970-01-01T00:00:00.000Z" },
    ),
  ).toEqual({ session: "1970-01-01T00:00:00.000Z" });
});

test("hydrated read maps retain only the most recent 500 entries", () => {
  const server = Object.fromEntries(
    Array.from({ length: 501 }, (_, index) => [
      `session-${index}`,
      "2026-08-11T10:00:00.000Z",
    ]),
  );
  const reads = mergeReadMaps(server, {});
  expect(Object.keys(reads)).toHaveLength(500);
  expect(reads["session-0"]).toBeUndefined();
  expect(reads["session-500"]).toBe("2026-08-11T10:00:00.000Z");
});
