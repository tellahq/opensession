import {
  type MouseEvent,
  type Ref,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { Menu, MENU_ICON } from "../ui/menu";
import { useCopy } from "../ui/copy";
import { IconArrowUpRight, IconCheck, IconCopy, IconGlobe } from "./icons";

/**
 * The link a right-click landed on, if it is a web page on another origin.
 * Links into this app already open in it.
 */
export function webLink(href: string | null, origin: string): string | null {
  if (!href) return null;
  try {
    const url = new URL(href);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.origin === origin ? null : url.href;
  } catch {
    return null;
  }
}

function anchorHref(target: EventTarget | null): string | null {
  if (!(target instanceof Element)) return null;
  const anchor = target.closest("a[href]");
  return anchor instanceof HTMLAnchorElement ? anchor.href : null;
}

interface OpenLinkMenu {
  url: string;
  x: number;
  y: number;
}

interface LinkMenuHandle {
  open: (menu: OpenLinkMenu) => void;
}

/**
 * Right-clicking a web link in a transcript offers to open it in the
 * workspace's Browser tab. Shift-right-click keeps the browser's own menu.
 *
 * The menu owns its open state, so opening, closing and copying render the
 * menu alone instead of the transcript region that hosts it.
 */
export function useLinkContextMenu(openBrowser: (url: string) => void) {
  const menuRef = useRef<LinkMenuHandle>(null);

  function onContextMenu(event: MouseEvent) {
    if (event.shiftKey || event.defaultPrevented) return;
    const url = webLink(anchorHref(event.target), window.location.origin);
    if (!url) return;
    event.preventDefault();
    menuRef.current?.open({ url, x: event.clientX, y: event.clientY });
  }

  const element = <LinkContextMenu ref={menuRef} openBrowser={openBrowser} />;

  return { onContextMenu, element };
}

function LinkContextMenu({
  ref,
  openBrowser,
}: {
  ref: Ref<LinkMenuHandle>;
  openBrowser: (url: string) => void;
}) {
  const [menu, setMenu] = useState<OpenLinkMenu | null>(null);
  const { copied, copy } = useCopy();

  useImperativeHandle(ref, () => ({ open: setMenu }));

  const anchor = menu
    ? {
        getBoundingClientRect: () =>
          DOMRect.fromRect({ x: menu.x, y: menu.y, width: 0, height: 0 }),
      }
    : undefined;

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
            <Menu.Item onClick={() => openBrowser(menu.url)}>
              <IconGlobe size={20} className={MENU_ICON} />
              <span className="grow">Open in Browser tab</span>
            </Menu.Item>
            <Menu.Item
              render={
                <a
                  href={menu.url}
                  target="_blank"
                  rel="noopener"
                  className="no-underline"
                />
              }
            >
              <IconArrowUpRight size={20} className={MENU_ICON} />
              <span className="grow">Open in new tab</span>
            </Menu.Item>
            <Menu.Item closeOnClick={false} onClick={() => copy(menu.url)}>
              {copied ? (
                <IconCheck size={20} className="text-green" />
              ) : (
                <IconCopy size={20} className={MENU_ICON} />
              )}
              <span className="grow">{copied ? "Copied" : "Copy link"}</span>
            </Menu.Item>
          </>
        ) : null}
      </Menu.Popup>
    </Menu.Root>
  );
}
