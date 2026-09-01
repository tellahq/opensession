import { expect, test } from "bun:test";

const [subagent, catchUp, workflow] = await Promise.all([
  Bun.file(new URL("./SubagentPane.tsx", import.meta.url)).text(),
  Bun.file(new URL("./CatchUpDeck.tsx", import.meta.url)).text(),
  Bun.file(new URL("./WorkflowAgentTranscript.tsx", import.meta.url)).text(),
]);

test("transcript hosts outside SessionViewer provide their own scroll contract", () => {
  expect(subagent).toContain("scrollElement={bodyElement}");
  expect(subagent).toContain("shouldMaintainEnd={shouldMaintainEnd}");
  expect(catchUp).toContain("scrollElement={scrollElement}");
  expect(catchUp).toContain("shouldMaintainEnd={shouldMaintainEnd}");
  expect(workflow).toContain("virtualize={false}");
});
