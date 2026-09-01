import { expect, test } from "bun:test";

test("settings uses a full-screen phone page without sheet drag chrome", async () => {
  const sheetSource = await Bun.file(
    new URL("./sheet.tsx", import.meta.url),
  ).text();
  const settingsSource = await Bun.file(
    new URL("../components/Settings.tsx", import.meta.url),
  ).text();

  expect(settingsSource).toContain("<PhonePage");
  expect(settingsSource).not.toContain(
    'className={cn("settings-sheet h-[93dvh]"',
  );
  expect(sheetSource).toContain(
    '"inset-0 h-dvh max-h-none rounded-none bg-surface',
  );
  expect(sheetSource).toContain("phone && !phonePage && showPhoneGrabber");
});
