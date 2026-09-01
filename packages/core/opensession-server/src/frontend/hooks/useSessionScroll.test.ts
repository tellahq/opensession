import { expect, test } from "bun:test";
import { shouldDisengageTranscriptFollowing } from "./useSessionScroll";

const source = await Bun.file(
  new URL("./useSessionScroll.ts", import.meta.url),
).text();
test("defers resize fallback writes outside observer delivery", () => {
  expect(source).toContain("resizeFrame = requestAnimationFrame(() => {");
  expect(source).toContain(
    "if (resizeFrame) cancelAnimationFrame(resizeFrame);",
  );
  expect(source).not.toContain(
    "if (followingRef.current || pinnedRef.current) relayout();\n    });",
  );
});

test("following readers stay synchronously pinned through large transcript growth", () => {
  expect(source).toContain(
    "if (!disclosureSettleRef.current) el.scrollTop = el.scrollHeight;",
  );
  expect(source).not.toContain("startFollowGlide");
  expect(source).not.toContain("FOLLOW_GLIDE");
});

test("layout-driven scroll events cannot disengage opening follow", () => {
  expect(
    shouldDisengageTranscriptFollowing({
      atEdge: false,
      following: true,
      gestured: false,
    }),
  ).toBe(false);
  expect(
    shouldDisengageTranscriptFollowing({
      atEdge: false,
      following: true,
      gestured: true,
    }),
  ).toBe(true);
  expect(
    shouldDisengageTranscriptFollowing({
      atEdge: true,
      following: true,
      gestured: true,
    }),
  ).toBe(false);
  expect(
    shouldDisengageTranscriptFollowing({
      atEdge: false,
      following: false,
      gestured: true,
    }),
  ).toBe(false);
});
