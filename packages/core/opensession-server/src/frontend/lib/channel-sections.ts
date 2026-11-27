// Your own sections in the Channels sidebar, the way Slack's sidebar has
// them (Start, Projects, ...). Slack keeps its sections behind an API only
// its own client may call, so these are Open Session's: a per-person pref
// that follows you across devices. A conversation sits in at most one
// section; the rest stay under Channels and Direct messages.

import { useSyncExternalStore } from "react";
import {
  decodeSections,
  movedChannel,
  withoutChannel,
  type ChannelSection,
} from "./channel-section-model";
import * as userPref from "./user-pref";

export {
  sidebarGroups,
  type ChannelSection,
  type SidebarGroup,
} from "./channel-section-model";

const EMPTY: ChannelSection[] = [];

// The stored string is the snapshot, so a read returns the same value until
// something changes (useSyncExternalStore compares by identity).
const pref = userPref.makeUserPref<string>({
  localKey: "opensession-channel-sections",
  prefKey: "channel-sections",
  changeEvent: "opensession-channel-sections-changed",
  defaultValue: "[]",
  perUser: true,
  decode: (raw) => (decodeSections(raw) ? raw! : null),
  encode: (value) => value,
});

let cachedRaw = "";
let cached: ChannelSection[] = EMPTY;
function parsed(raw: string): ChannelSection[] {
  if (raw !== cachedRaw) {
    cachedRaw = raw;
    cached = decodeSections(raw) ?? EMPTY;
  }
  return cached;
}

export function useChannelSections(): ChannelSection[] {
  return parsed(useSyncExternalStore(pref.onChanged, pref.get, pref.get));
}

function save(sections: ChannelSection[]) {
  pref.set(JSON.stringify(sections));
}

function current(): ChannelSection[] {
  return parsed(pref.get());
}

function newId(): string {
  return `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export function moveChannelToSection(
  channelId: string,
  sectionId: string | null,
): void {
  save(movedChannel(current(), channelId, sectionId));
}

/** A new section at the end, holding `channelId` when one is given. */
export function createSection(name: string, channelId?: string): void {
  const base = channelId ? withoutChannel(current(), channelId) : current();
  save([
    ...base,
    { id: newId(), name: name.trim(), channels: channelId ? [channelId] : [] },
  ]);
}

export function renameSection(id: string, name: string): void {
  save(
    current().map((section) =>
      section.id === id ? { ...section, name: name.trim() } : section,
    ),
  );
}

/** Delete a section; its conversations go back to Channels and Direct
 *  messages. */
export function deleteSection(id: string): void {
  save(current().filter((section) => section.id !== id));
}

export function moveSection(id: string, by: -1 | 1): void {
  const sections = [...current()];
  const from = sections.findIndex((section) => section.id === id);
  const to = from + by;
  if (from < 0 || to < 0 || to >= sections.length) return;
  [sections[from], sections[to]] = [sections[to]!, sections[from]!];
  save(sections);
}
