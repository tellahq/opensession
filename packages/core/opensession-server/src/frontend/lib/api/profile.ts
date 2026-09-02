import { ApiError, BASE, request } from "./request";

/**
 * Your own profile (Settings > Personal > Account). The server takes no member
 * identifier on these routes: it resolves your row from your signed-in
 * identity, so there is no id to pass and no way to address anyone else.
 * `user` rides only for instances with sign-in turned off, where the client's
 * own name is all there is (server: routes/profile.ts).
 */
export interface Profile {
  /** Who the server resolved this request to. */
  user: string;
  /** False when the signed-in person has no roster row to edit. */
  editable: boolean;
  name: string;
  /** First word of the name: the identity key mentions and attribution use. */
  shortName: string;
  email: string;
  github: string;
  slackId: string;
  timezone: string;
  aliases: string[];
  /** `/media` URL of the uploaded picture, or "" for none. */
  image: string;
  imageMaxBytes: number;
}

export interface ProfileSaveResult extends Profile {
  /** Set when the save changed the short name, with the per-user stores that
   *  were carried across to the new one. */
  renamedFrom?: string;
  carriedState?: string[];
}

function withUser(path: string, user?: string): string {
  return user ? `${path}?user=${encodeURIComponent(user)}` : path;
}

export function fetchProfile(user?: string): Promise<Profile> {
  return request(withUser("/profile", user), {
    label: "Failed to load your profile",
  });
}

export function saveProfile(
  patch: Partial<Pick<Profile, "name" | "email" | "timezone" | "aliases">>,
  user?: string,
): Promise<ProfileSaveResult> {
  return request(withUser("/profile", user), {
    method: "PUT",
    body: patch,
    label: "Failed to save your profile",
  });
}

/**
 * Upload a picture. Raw bytes rather than multipart, matching /api/upload:
 * one file needs no envelope, and `request()` only speaks JSON, so this posts
 * directly and reuses its error shape.
 */
export async function uploadProfileImage(
  file: File,
  user?: string,
): Promise<{ image: string }> {
  const res = await fetch(`${BASE}${withUser("/profile/image", user)}`, {
    method: "POST",
    headers: { "Content-Type": file.type },
    body: file,
  });
  if (!res.ok) {
    const body: { error?: string } | null = await res.json().catch(() => null);
    throw new ApiError(
      body?.error || `Failed to upload the picture: ${res.status}`,
      res.status,
    );
  }
  const body: { image: string } = await res.json();
  return body;
}

export function removeProfileImage(user?: string): Promise<{ image: string }> {
  return request(withUser("/profile/image", user), {
    method: "DELETE",
    label: "Failed to remove the picture",
  });
}
