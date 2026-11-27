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
  // A page fills the dynamic viewport edge to edge, no rounded sheet top.
  expect(sheetSource).toContain(
    "phone ? (phonePage ? styles.page : styles.sheet) : styles.dialog",
  );
  expect(sheetSource).toMatch(
    /page: \{\s*inset: space\.s0,\s*height: geometry\.fullHeight,\s*maxHeight: "none",\s*borderRadius: 0,/,
  );
  expect(sheetSource).toContain("phone && !phonePage && showPhoneGrabber");
});
