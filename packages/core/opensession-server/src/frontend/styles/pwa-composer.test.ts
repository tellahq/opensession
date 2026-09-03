import { expect, test } from "bun:test";
import { composerBox, composerFlapBorder } from "../lib/composer-classes";
import { readBaseCss } from "./base-css-test-support";
const SHIPPED = new URL(
  "../components/ShippedChangeComposer.tsx",
  import.meta.url,
);
const COMPOSER = new URL("../components/Composer.tsx", import.meta.url);
const COMPOSER_CONTROLS = new URL(
  "../components/composer/ComposerControls.tsx",
  import.meta.url,
);
const MODEL_ROW = new URL(
  "../components/composer/ModelRow.tsx",
  import.meta.url,
);
const VOICE_CONTROL = new URL(
  "../components/composer/VoiceControl.tsx",
  import.meta.url,
);

test("phone composers use the same quiet edge as the desktop ring", () => {
  expect(composerBox).toContain(
    "border-[color:color-mix(in_srgb,var(--composer-border)_35%,transparent)]",
  );
  expect(composerFlapBorder).toContain(
    "border-[color:color-mix(in_srgb,var(--composer-border)_35%,transparent)]",
  );
});

test("team note mode stays compact at rest and names itself when expanded", async () => {
  const composer = await Bun.file(COMPOSER).text();
  const minimizedStart = composer.indexOf("const minimized =");
  const minimizedEnd = composer.indexOf(";", minimizedStart);

  expect(minimizedStart).toBeGreaterThan(-1);
  expect(composer.slice(minimizedStart, minimizedEnd)).not.toContain(
    "noteMode",
  );
  expect(composer).toContain("{noteMode && !minimized && (");
  expect(composer).toContain('noteMode && "before:opacity-100"');
});

test("the installed phone composer restores model selection when expanded", async () => {
  const css = await readBaseCss();
  const shipped = await Bun.file(SHIPPED).text();
  const composer = await Bun.file(COMPOSER).text();
  const composerControls = await Bun.file(COMPOSER_CONTROLS).text();
  const modelRow = await Bun.file(MODEL_ROW).text();
  const voiceControl = await Bun.file(VOICE_CONTROL).text();
  const mediaStart = css.indexOf(
    "@media (display-mode: standalone) and (max-width: 720px)",
  );
  const mediaEnd = css.indexOf("\n}\n", mediaStart) + 3;
  const standalonePhone = css.slice(mediaStart, mediaEnd);

  expect(standalonePhone).toContain(".app .composer");
  expect(standalonePhone).toContain(".app .pwa-composer-edge");
  expect(composerFlapBorder).toContain("pwa-composer-edge");
  expect(shipped).toContain("pwa-composer-edge");
  expect(standalonePhone).toContain(
    "border-color: color-mix(in srgb, var(--composer-border) 35%, transparent)",
  );
  expect(standalonePhone).toContain(".app .pwa-composer-dictation");
  expect(standalonePhone).toContain("display: none");
  expect(voiceControl.match(/pwa-composer-dictation/g)).toHaveLength(1);
  expect(composer).not.toContain("pwa-composer-auxiliary");
  expect(composer).not.toContain("pwa-note-option");
  expect(modelRow).toContain("className={composerToolbarSelect}");
  expect(modelRow).toContain("{!minimized && (");
  expect(composerControls).toContain(
    '"composer-pop-wrap relative inline-flex shrink-0"',
  );
});
