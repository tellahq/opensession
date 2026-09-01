import { expect, test } from "bun:test";

test("the top-level model menu exposes three recent choices with their settings", async () => {
  const source = await Bun.file(
    new URL("./ModelEffortSelect.tsx", import.meta.url),
  ).text();

  expect(source).toContain("<Menu.GroupLabel>Recent models</Menu.GroupLabel>");
  expect(source).toContain(".slice(0, 3)");
  expect(source).toContain("renderModelOption(option, true)");
  expect(source).toContain("pushRecentModel(option.id)");
  expect(source).toContain('recentSettings.join(" · ")');
  const recentSettings = source.slice(
    source.indexOf("const recentSettings"),
    source.indexOf("// Engine stays sticky"),
  );
  expect(recentSettings).toContain("nextModelInfo?.fastModeSupported === true");
  expect(recentSettings).toContain('? "Fast"');
  expect(recentSettings).not.toContain('"Standard"');
  expect(recentSettings).toContain(
    "EFFORTS.find((e) => e.id === nextEffort)?.label",
  );
});
