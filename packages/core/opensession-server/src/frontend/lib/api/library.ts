/** The library catalog (server: src/server/library.ts). Read-only. */

import { request } from "./request";

export type LibraryEntryType =
  | "tool"
  | "automation"
  | "integration"
  | "connection"
  | "package";
export type LibraryInstallKind = "one-click" | "draft" | "guided" | "client";

export interface LibraryEntry {
  id: string;
  type: LibraryEntryType;
  slug: string;
  name: string;
  description: string;
  category: string;
  requires?: string[];
  install: LibraryInstallKind;
  /** null when the server has no truth to report — see the module doc. */
  installed: boolean | null;
  /** Automations only: the prompt they run, and how. The native app prefills
   *  its new-session composer from these; this panel does not use them. */
  prompt?: string;
  mode?: "ask" | "code";
  model?: string;
  href: string;
  source: "builtin" | "repo";
}

export async function fetchLibrary(): Promise<LibraryEntry[]> {
  const body = await request<{ entries?: LibraryEntry[] }>("/library", {
    label: "Failed to load the library",
  });
  return Array.isArray(body?.entries) ? body.entries : [];
}
