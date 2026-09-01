import { stripBasePath } from "./base";

export interface NewSessionPrefill {
  mode: "ask" | "code" | "scratch";
  prompt?: string;
  repo?: string;
  branch?: string;
}

export function parseNewSessionLink(
  href: string,
  origin = location.origin,
): NewSessionPrefill | null {
  let url: URL;
  try {
    url = new URL(href, origin);
  } catch {
    return null;
  }
  if (url.origin !== origin || stripBasePath(url.pathname) !== "/new")
    return null;

  return {
    mode:
      url.searchParams.get("mode") === "ask"
        ? "ask"
        : url.searchParams.get("mode") === "scratch"
          ? "scratch"
          : "code",
    prompt: url.searchParams.get("prompt") || undefined,
    repo:
      url.searchParams.get("repo") ||
      url.searchParams.get("project") ||
      undefined,
    branch: url.searchParams.get("branch") || undefined,
  };
}
