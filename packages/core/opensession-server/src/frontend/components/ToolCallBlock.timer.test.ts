import { expect, test } from "bun:test";

const source = await Bun.file(
  new URL("./ToolCallBlock.tsx", import.meta.url),
).text();

test("mounts the running duration ticker only while its label is discoverable", () => {
  expect(source).toContain(
    "onMouseEnter={pending ? () => setDurationVisible(true) : undefined}",
  );
  expect(source).toContain(
    "onFocus={pending ? () => setDurationVisible(true) : undefined}",
  );
  expect(source).toContain(
    "{pending && durationVisible && <RunningToolDuration entry={entry} />}",
  );
});
