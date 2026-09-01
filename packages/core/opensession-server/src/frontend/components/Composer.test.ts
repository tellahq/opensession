import { expect, test } from "bun:test";

async function source(relativePath: string) {
  return Bun.file(new URL(relativePath, import.meta.url)).text();
}

test("composer groups configuration and actions behind a bounded prop API", async () => {
  const [component, types] = await Promise.all([
    source("./Composer.tsx"),
    source("../lib/composer-types.ts"),
  ]);
  const propsStart = component.indexOf("interface Props {");
  const propsEnd = component.indexOf("\n}\n", propsStart);
  const props = component.slice(propsStart, propsEnd);
  const propNames = [...props.matchAll(/^  (\w+)\??:/gm)].map(
    (match) => match[1],
  );

  expect(propsStart).toBeGreaterThanOrEqual(0);
  expect(propNames.length).toBeLessThanOrEqual(20);
  expect(propNames).toEqual([
    "value",
    "onChange",
    "onTyping",
    "onDictationActive",
    "config",
    "actions",
    "attached",
    "menuExtra",
    "sendMenu",
  ]);
  expect(types).toContain("export interface ComposerConfig {");
  expect(types).toContain("export interface ComposerActions {");
});

test("a consumed draft clears persistence before clearing React state", async () => {
  const component = await source("./Composer.tsx");
  const consumeStart = component.indexOf("const consume = () => {");
  const consumeEnd = component.indexOf(
    "const consumed = handler",
    consumeStart,
  );
  const consume = component.slice(consumeStart, consumeEnd);

  expect(consumeStart).toBeGreaterThan(-1);
  expect(consume.indexOf("clearDraft(draftKey)")).toBeGreaterThan(-1);
  expect(consume.indexOf("clearDraft(draftKey)")).toBeLessThan(
    consume.indexOf('setInnerValue("")'),
  );
});
