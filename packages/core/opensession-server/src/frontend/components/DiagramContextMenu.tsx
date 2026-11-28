import { useEffect, useState } from "react";
import { Menu, MENU_ICON, MenuLabel } from "../ui/menu";
import { toast } from "../ui/toast";
import { diagramCanvasColor } from "../lib/diagram-media";
import { copyImageToClipboard } from "../lib/image-clipboard";
import { suggestedMediaName, type LightboxItem } from "../lib/media-lightbox";
import {
  contextMenuDiagramFor,
  diagramItem,
} from "../lib/media-lightbox-gallery";
import { IconArrowDown, IconCheck, IconCopy } from "./icons";

interface OpenDiagramMenu {
  item: LightboxItem;
  x: number;
  y: number;
}

/**
 * Right-clicking a diagram or chart, in the transcript or in the viewer,
 * offers Copy image and Download. Both are inline SVG, which the browser's
 * own menu treats as page content rather than a picture. Shift-right-click
 * keeps the browser's menu, and so does a text selection inside the diagram.
 *
 * Delegated from the document, like the click that opens the viewer
 * (MediaLightbox.tsx): diagrams are injected markup with no React handlers.
 */
export function DiagramContextMenu() {
  const [menu, setMenu] = useState<OpenDiagramMenu | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    function onContextMenu(event: MouseEvent) {
      if (event.shiftKey || event.defaultPrevented) return;
      if (!(event.target instanceof Element)) return;
      const svg = contextMenuDiagramFor(event.target);
      const item = svg && diagramItem(svg);
      if (!item) return;
      event.preventDefault();
      setCopied(false);
      setMenu({ item, x: event.clientX, y: event.clientY });
    }
    document.addEventListener("contextmenu", onContextMenu);
    return () => document.removeEventListener("contextmenu", onContextMenu);
  }, []);

  const anchor = menu
    ? {
        getBoundingClientRect: () =>
          DOMRect.fromRect({ x: menu.x, y: menu.y, width: 0, height: 0 }),
      }
    : undefined;

  const copy = (item: LightboxItem) => {
    void copyImageToClipboard(item.src, {
      background: diagramCanvasColor(),
    }).then(
      () => setCopied(true),
      () => toast("Could not copy that image"),
    );
  };

  return (
    <Menu.Root
      open={!!menu}
      onOpenChange={(open) => {
        if (!open) setMenu(null);
      }}
      modal={false}
    >
      <Menu.Popup
        anchor={anchor}
        side="bottom"
        align="start"
        sideOffset={2}
        finalFocus={false}
      >
        {menu ? (
          <>
            <Menu.Item closeOnClick={false} onClick={() => copy(menu.item)}>
              {copied ? (
                <IconCheck size={20} className="text-green" />
              ) : (
                <IconCopy size={20} className={MENU_ICON} />
              )}
              <MenuLabel>{copied ? "Copied" : "Copy image"}</MenuLabel>
            </Menu.Item>
            <Menu.Item
              render={
                <a
                  href={menu.item.src}
                  download={suggestedMediaName(menu.item)}
                  className="no-underline"
                />
              }
            >
              <IconArrowDown size={20} className={MENU_ICON} />
              <MenuLabel>Download</MenuLabel>
            </Menu.Item>
          </>
        ) : null}
      </Menu.Popup>
    </Menu.Root>
  );
}
