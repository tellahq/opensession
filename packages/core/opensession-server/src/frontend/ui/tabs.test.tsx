import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { UnderlineTabs } from "./tabs";

test("underline tabs mark the current page and show counts", () => {
  const html = renderToStaticMarkup(
    <UnderlineTabs.Root label="Pages" value="files" onValueChange={() => {}}>
      <UnderlineTabs.Tab value="overview">Overview</UnderlineTabs.Tab>
      <UnderlineTabs.Tab value="files" count={7}>
        Files changed
      </UnderlineTabs.Tab>
    </UnderlineTabs.Root>,
  );
  expect(html).toContain('role="tablist"');
  expect(html).toContain('aria-label="Pages"');
  expect(html).toMatch(/aria-selected="true"[^>]*>.*Files changed/);
  expect(html).toContain(">7<");
});
