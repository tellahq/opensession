import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Menu } from "./menu";
import { Popover } from "./popover";
import { PopupArmingRegion } from "./popup-arming-region";
import { Tooltip, TooltipProvider } from "./tooltip";

function MenuWithTooltip() {
  return (
    <Menu.Root>
      <Tooltip label="Add reaction">
        <Menu.Trigger aria-label="Add reaction" className="size-7">
          +
        </Menu.Trigger>
      </Tooltip>
      <Menu.Popup>
        <Menu.Item>Thumbs up</Menu.Item>
      </Menu.Popup>
    </Menu.Root>
  );
}

describe("PopupArmingRegion", () => {
  test("renders a closed plain trigger until someone reaches for the row", () => {
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <PopupArmingRegion className="row">
          <MenuWithTooltip />
        </PopupArmingRegion>
      </TooltipProvider>,
    );
    expect(html).toBe(
      '<div class="row"><button type="button" aria-haspopup="menu" aria-expanded="false" aria-label="Add reaction" class="focus-ring size-7">+</button></div>',
    );
  });

  test("leaves popups outside a region untouched", () => {
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <MenuWithTooltip />
      </TooltipProvider>,
    );
    // Base UI's own trigger carries its generated id.
    expect(html).toMatch(/<button[^>]+id="[^"]+"/);
    expect(html).toContain('aria-haspopup="menu"');
  });

  test("defers a popover trigger and keeps a controlled popover live", () => {
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <PopupArmingRegion>
          <Popover.Root>
            <Popover.Trigger openOnHover delay={300} className="chip">
              file.ts
            </Popover.Trigger>
            <Popover.Popup>diff</Popover.Popup>
          </Popover.Root>
          <Popover.Root open>
            <Popover.Popup>stats</Popover.Popup>
          </Popover.Root>
        </PopupArmingRegion>
      </TooltipProvider>,
    );
    expect(html).toContain(
      '<button type="button" aria-haspopup="dialog" aria-expanded="false" class="chip">file.ts</button>',
    );
    expect(html).not.toContain("diff");
  });
});
