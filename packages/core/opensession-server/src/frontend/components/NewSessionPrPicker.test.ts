import { expect, test } from "bun:test";

test("the pull request menu labels its start-point group inside Menu.Group", async () => {
  const source = await Bun.file(
    new URL("./NewSessionPrPicker.tsx", import.meta.url),
  ).text();
  const groupStart = source.indexOf("<Menu.Group>");
  const label = source.indexOf("<Menu.GroupLabel>Start from</Menu.GroupLabel>");
  const groupEnd = source.indexOf("</Menu.Group>", label);

  expect(groupStart).toBeGreaterThan(-1);
  expect(label).toBeGreaterThan(groupStart);
  expect(groupEnd).toBeGreaterThan(label);
});
