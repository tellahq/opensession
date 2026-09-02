import { os1Shell } from "./os1-shell";

declare global {
  interface Navigator {
    readonly userAgentData?: {
      readonly platform?: string;
    };
  }
}

type DesktopLinkInput = {
  pathname: string;
  search: string;
  hash: string;
  platform: string;
  maxTouchPoints: number;
  desktop: boolean;
  standalone: boolean;
};

const SHARED_ROUTE = /^\/(?:session|workspace|pr)(?:\/|$)/;

/** Convert a shared web route into the desktop shell's registered protocol. */
export function desktopProtocolUrl(
  input: Pick<
    DesktopLinkInput,
    | "pathname"
    | "search"
    | "hash"
    | "platform"
    | "maxTouchPoints"
    | "desktop"
    | "standalone"
  >,
): string | null {
  if (
    input.desktop ||
    input.standalone ||
    !/Mac/i.test(input.platform) ||
    input.maxTouchPoints > 1
  )
    return null;

  const pathname = input.pathname.replace(
    /^\/(?:opensession|backstage)(?=\/|$)/,
    "",
  );
  if (!SHARED_ROUTE.test(pathname)) return null;

  return `os1://${pathname.slice(1)}${input.search}${input.hash}`;
}

export function desktopProtocolUrlFromBrowser(): string | null {
  return desktopProtocolUrl({
    pathname: location.pathname,
    search: location.search,
    hash: location.hash,
    platform: navigator.userAgentData?.platform || navigator.platform || "",
    maxTouchPoints: navigator.maxTouchPoints || 0,
    desktop: os1Shell()?.desktop === true,
    standalone: matchMedia("(display-mode: standalone)").matches,
  });
}
