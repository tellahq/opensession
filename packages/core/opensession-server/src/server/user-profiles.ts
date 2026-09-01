/**
 * Per-user profile picture: the one part of a person's profile that is not
 * identity of record.
 *
 * Everything else on Settings > Personal > Account (name, email, timezone,
 * aliases) IS the roster. It lives in `identity.team` in config.json, because
 * commit attribution, mention matching and `allowedUsers` scoping all resolve
 * through it. A picture resolves nothing. It is machine state, an uploaded
 * file, and config.json is hand-edited, validated by the config loader and
 * diffed by admins, so an upload path has no business in it.
 *
 * So the picture lives here, in the shared per-user flat-file store
 * (shared/user-store.ts), and `teamDirectory()` merges it into GET /api/people,
 * the single roster every people surface already reads. Nothing else has to
 * learn where pictures come from.
 *
 * The store identity is NOT the display name, for the same reason the profile
 * page exists at all: a name can change. It resolves through the roster to the
 * most stable id the member has (GitHub login, then Slack id), the same
 * follow-the-person move personal-prompts.ts makes, so a rename never orphans
 * someone's picture. Off-roster users fall back to their sanitized name, which
 * keeps a signed-out instance working.
 */

import { existsSync, mkdirSync, readdirSync, unlinkSync } from "fs";
import { stateDir } from "./paths";
import { userStore } from "./shared/user-store";
import { configuredIdentity, type TeamMember } from "./config";

/** Where uploaded pictures land. Under $HOME, which is what lets /media serve
 *  them with no route of their own (routes/media.ts scopes by prefix). */
export function profileImagesDir(): string {
  return `${stateDir("profiles")}/images`;
}

/** Accepted picture formats, and the extension each is stored under. A stored
 *  file carries no media type, so the extension is the only record of what it
 *  is, and /media types the response from it too. */
export const PROFILE_IMAGE_TYPES: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

/** A picture rides in every roster response and every avatar, so keep it small
 *  enough to stay a picture rather than a payload. */
export const MAX_PROFILE_IMAGE_BYTES = 5 * 1024 * 1024;

/**
 * The roster row a user reference names, matched the way every other identity
 * surface matches: full name, first name, alias, GitHub login, email or Slack
 * id. Deliberately not `resolveTeammate` (shared/user-mappings.ts), which only
 * answers for members that carry BOTH an email and a Slack id. A member with
 * just a GitHub login is exactly the person this store must still key stably.
 */
function findMember(ref: string): TeamMember | null {
  const key = ref.trim().replace(/^@/, "").toLowerCase();
  if (!key) return null;
  const team = configuredIdentity().team;
  return (
    team.find((m) => m.name.trim().toLowerCase() === key) ||
    team.find((m) => m.github?.trim().toLowerCase() === key) ||
    team.find((m) => m.email?.trim().toLowerCase() === key) ||
    team.find((m) => m.slackId?.trim() === ref.trim()) ||
    team.find((m) => m.aliases?.some((a) => a.trim().toLowerCase() === key)) ||
    team.find((m) => m.name.trim().split(/\s+/)[0]?.toLowerCase() === key) ||
    null
  );
}

/** The most stable id a member has. This is what the store keys on. */
function keyForMember(member: TeamMember): string {
  if (member.github?.trim())
    return `github-${member.github.trim().toLowerCase()}`;
  if (member.slackId?.trim()) return `slack-${member.slackId.trim()}`;
  return `name-${member.name.trim().toLowerCase()}`;
}

function keyFor(user: string): string | null {
  const trimmed = user?.trim();
  if (!trimmed) return null;
  const member = findMember(trimmed);
  if (member) return keyForMember(member);
  const slug = trimmed
    .toLowerCase()
    .replace(/[^a-z0-9@._-]+/g, "-")
    .slice(0, 64);
  return slug ? `name-${slug}` : null;
}

interface Profile {
  /** Absolute path to the stored picture, or "" for none. The URL form is a
   *  rendering detail (see profileImageUrl), so the record stays a file
   *  reference and the serving route can change without a migration. */
  image: string;
}

const store = userStore<Profile>({
  name: "profiles",
  field: "profile",
  clean: (raw) => {
    const image =
      raw &&
      typeof raw === "object" &&
      typeof (raw as Profile).image === "string"
        ? (raw as Profile).image
        : "";
    // A path that no longer resolves reads as "no picture" rather than as a
    // broken tile: the file can be deleted out from under the record.
    return { image: image && existsSync(image) ? image : "" };
  },
  identity: keyFor,
  extra: () => ({ updatedAt: new Date().toISOString() }),
});

/** The `/media` URL for a stored picture. The `v` stamp busts the browser and
 *  service-worker cache when someone replaces their picture: the filename is
 *  stable per person, so without it the old picture keeps showing. */
export function profileImageUrl(path: string): string {
  if (!path) return "";
  let version = "";
  try {
    version = String(Bun.file(path).lastModified || "");
  } catch {}
  return `/media?path=${encodeURIComponent(path)}${version ? `&v=${version}` : ""}`;
}

/** One user's picture as a URL, or "" when they have none. */
export function profileImageFor(user: string | undefined | null): string {
  try {
    return profileImageUrl(store.get(user ?? "").image);
  } catch {
    return "";
  }
}

/** Pictures for the whole roster, keyed by the member's full name. What
 *  teamDirectory() needs to merge them in without a lookup per call site. */
export function profileImagesByMemberName(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const member of configuredIdentity().team) {
    const image = profileImageFor(member.name);
    if (image) out[member.name] = image;
  }
  return out;
}

/**
 * Store `bytes` as this user's picture and return its `/media` URL.
 *
 * The previous picture is deleted rather than kept: this is the one upload in
 * the app that is a REPLACEMENT, so a history of past avatars would grow
 * forever for nobody's benefit.
 */
export async function setProfileImage(
  user: string,
  bytes: Uint8Array,
  contentType: string,
): Promise<string> {
  const ext = PROFILE_IMAGE_TYPES[contentType];
  if (!ext) throw new Error("Pictures must be PNG, JPEG, GIF or WebP");
  if (bytes.byteLength > MAX_PROFILE_IMAGE_BYTES)
    throw new Error("That picture is too large. The limit is 5MB.");
  const key = keyFor(user);
  if (!key) throw new Error("Unknown user");
  const dir = profileImagesDir();
  mkdirSync(dir, { recursive: true });
  // One file per person, named for the store key, so a replacement overwrites
  // in place and a stale record can never point at someone else's picture.
  const path = `${dir}/${fileStem(key)}.${ext}`;
  removeStoredImages(key, path);
  await Bun.write(path, bytes);
  store.set(user, { image: path });
  return profileImageUrl(path);
}

/** Drop this user's picture. The avatar falls back to GitHub and then to their
 *  initial, exactly as it did before they set one. */
export function clearProfileImage(user: string): void {
  const key = keyFor(user);
  const current = store.get(user).image;
  store.set(user, { image: "" });
  if (key) removeStoredImages(key);
  else if (current) tryUnlink(current);
}

function fileStem(key: string): string {
  return key.replace(/[^a-z0-9_-]/gi, "_");
}

/** Delete this key's stored pictures, except `keep`. Extensions differ per
 *  upload, so a PNG replaced by a JPEG would otherwise leave the old file. */
function removeStoredImages(key: string, keep?: string): void {
  const dir = profileImagesDir();
  if (!existsSync(dir)) return;
  const stem = `${fileStem(key)}.`;
  try {
    for (const entry of readdirSync(dir)) {
      if (!entry.startsWith(stem)) continue;
      const path = `${dir}/${entry}`;
      if (path !== keep) tryUnlink(path);
    }
  } catch {}
}

function tryUnlink(path: string): void {
  try {
    unlinkSync(path);
  } catch {}
}
