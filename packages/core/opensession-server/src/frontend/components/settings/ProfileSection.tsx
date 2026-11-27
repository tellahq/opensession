import React, { useEffect, useRef, useState } from "react";
import {
  fetchProfile,
  removeProfileImage,
  saveProfile,
  uploadProfileImage,
  type Profile,
} from "../../lib/api/profile";
import { useIsPhone } from "../../hooks/useIsPhone";
import { refreshPeople } from "../../lib/people";
import { isTouchPrimary } from "../../lib/platform";
import { errorMessage } from "../../lib/error-message";
import { Button } from "../../ui/button";
import { cn } from "../../ui/cn";
import { Field, FieldGrid, Input } from "../../ui/input";
import { OVERLAY_ACTION_HOST, OverlayAction } from "../../ui/overlay-action";
import { SettingsForm, SettingsGroupLabel } from "../../ui/settings";
import { ResponsiveDialog } from "../../ui/sheet";
import { Spinner } from "../../ui/spinner";
import { EmptyState, InlineAlert, Skeleton, SkeletonBar } from "../../ui/state";
import { toast } from "../../ui/toast";
import { IconImage, IconPencil, IconTrash } from "../icons";
import { useCurrentUser } from "../UserPicker";
import { UserAvatar } from "../UserAvatar";

/**
 * Settings > Personal > Account, first block: who you are on this instance.
 *
 * At rest it is a portrait, not a form: your picture and your name. Editing is
 * a dialog, so the page a person opens to check something is not four input
 * rectangles they have to read past (and on a phone the fields get the whole
 * screen instead of a card's width).
 *
 * The identifiers you cannot move yourself (your GitHub login, your Slack id)
 * are not listed as dead rows: the accounts below already show the GitHub one,
 * and a disabled field is not information. Aliases are gone from the form too.
 * They are matching wiring rather than profile, and the one case a person hits
 * is handled for them: renaming keeps the old short name automatically
 * (routes/profile.ts).
 */
export function ProfileSection() {
  const currentUser = useCurrentUser();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setProfile(null);
    setLoadError(null);
    fetchProfile(currentUser)
      .then((p) => alive && setProfile(p))
      .catch(
        (error) =>
          alive && setLoadError(errorMessage(error, "Failed to load profile")),
      );
    return () => {
      alive = false;
    };
  }, [currentUser]);

  return (
    <>
      <SettingsGroupLabel className="mt-0">Profile</SettingsGroupLabel>
      {loadError ? (
        <InlineAlert>{loadError}</InlineAlert>
      ) : !profile ? (
        <ProfileSkeleton />
      ) : !profile.editable ? (
        <EmptyState placement="card">
          You ({profile.user}) are not on this instance&rsquo;s roster yet. An
          admin can add you on Settings &rsaquo; Members.
        </EmptyState>
      ) : (
        <ProfileCard profile={profile} onChange={setProfile} />
      )}
    </>
  );
}

/**
 * The portrait on its way: the card it lands in, the picture at the size it
 * lands at, and the name under it.
 *
 * The lines are bars rather than text-height rectangles on purpose. A grey box
 * the size of a line of type reads as a disabled control, a thing you are not
 * allowed to use, where a thin bar reads as a line about to be written. The
 * picture is the one exception, because it really is an 80px squircle and
 * drawing it smaller would move everything under it when the real one arrives.
 */
function ProfileSkeleton() {
  return (
    <Skeleton label="Loading your profile">
      <SettingsForm className="items-center gap-0 py-7">
        <SkeletonBar className="size-20 rounded-avatar" />
        <SkeletonBar className="mt-4 h-3 w-40" />
      </SettingsForm>
    </Skeleton>
  );
}

/**
 * The portrait, and the dialog behind it.
 *
 * Both live in one component because they share the picture: uploading and
 * removing happen from the dialog but change what the portrait shows, and one
 * busy flag keeps a second click from racing the first. The picture saves on
 * pick (choosing a file already is the confirmation), the fields save on Save.
 */
function ProfileCard({
  profile,
  onChange,
}: {
  profile: Profile;
  onChange: (next: Profile) => void;
}) {
  const isPhone = useIsPhone();
  const fileRef = useRef<HTMLInputElement>(null);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(profile.name);
  const [email, setEmail] = useState(profile.email);
  const [timezone, setTimezone] = useState(profile.timezone);
  const [busy, setBusy] = useState<"picture" | "fields" | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Reset the draft whenever the dialog opens, so a Cancel really discards:
  // the fields are also re-seeded when a save lands, since that replaces the
  // profile this reads from.
  useEffect(() => {
    if (!editing) return;
    setName(profile.name);
    setEmail(profile.email);
    setTimezone(profile.timezone);
    setError(null);
  }, [editing, profile]);

  const nextShort = name.trim().split(/\s+/)[0] ?? "";
  const shortNameChanging =
    !!nextShort && nextShort.toLowerCase() !== profile.shortName.toLowerCase();
  const dirty =
    name.trim() !== profile.name ||
    email.trim() !== profile.email ||
    timezone.trim() !== profile.timezone;
  // The picture control's accessible name. A glyph on a badge says "picture"
  // but not which way it goes, and someone with no picture yet is being
  // offered a different thing than someone replacing one.
  const pictureAction = profile.image ? "Change picture" : "Upload picture";

  async function pickPicture(file: File | undefined) {
    if (!file) return;
    setError(null);
    const limitMb = Math.round(profile.imageMaxBytes / 1024 / 1024);
    if (file.size > profile.imageMaxBytes) {
      setError(
        `That picture is ${Math.round(file.size / 1024 / 1024)}MB. The limit is ${limitMb}MB.`,
      );
      return;
    }
    setBusy("picture");
    await (async () => {
      const { image } = await uploadProfileImage(file, profile.user);
      onChange({ ...profile, image });
      await refreshPeople();
      toast("Picture updated");
    })()
      .catch(async (error) => {
        setError(errorMessage(error, "Failed to update picture"));
      })
      .finally(async () => {
        setBusy(null);
        // Clear the input or picking the same file twice does nothing.
        if (fileRef.current) fileRef.current.value = "";
      });
  }

  async function removePicture() {
    setBusy("picture");
    setError(null);
    await (async () => {
      await removeProfileImage(profile.user);
      onChange({ ...profile, image: "" });
      await refreshPeople();
      toast("Picture removed");
    })()
      .catch(async (error) => {
        setError(errorMessage(error, "Failed to remove picture"));
      })
      .finally(async () => {
        setBusy(null);
      });
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!name.trim() || busy || !dirty) return;
    setBusy("fields");
    setError(null);
    await (async () => {
      const saved = await saveProfile(
        { name: name.trim(), email: email.trim(), timezone: timezone.trim() },
        profile.user,
      );
      onChange(saved);
      await refreshPeople();
      toast(
        saved.renamedFrom
          ? `Saved. You are ${saved.shortName} everywhere now.`
          : "Profile saved",
      );
      setEditing(false);
    })()
      .catch(async (error) => {
        setError(errorMessage(error, "Failed to save profile"));
      })
      .finally(async () => {
        setBusy(null);
      });
  }

  return (
    <>
      <input
        ref={fileRef}
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp"
        className="hidden"
        onChange={(e) => void pickPicture(e.target.files?.[0])}
      />
      <SettingsForm className="items-center gap-0 py-7">
        {/* The whole portrait opens the editor, with the badge as the mark
				    that says so. A badge that is the only target makes a 28px hit
				    area out of a 80px one, and the picture is what the eye goes to
				    anyway. */}
        <button
          type="button"
          onClick={() => setEditing(true)}
          aria-label="Edit profile"
          className="focus-ring relative flex rounded-avatar"
        >
          <UserAvatar
            name={profile.name}
            login={profile.github}
            image={profile.image}
            size={80}
          />
          {/* Straddling the bottom-right corner, so it marks the picture
					    without covering the face in it. Hard white rather than a
					    themed surface: it sits on whatever photo a person uploaded,
					    so it has to hold its own contrast in both themes instead of
					    following the page. Same reason its ink is hard black. */}
          <span
            className="absolute -bottom-0.5 -right-0.5 grid size-8 place-items-center rounded-full bg-white text-black smooth-shadow-sm"
            aria-hidden
          >
            {busy === "picture" ? (
              <Spinner size="sm" />
            ) : (
              <IconPencil size={16} dense />
            )}
          </span>
        </button>
        {/* Your name and nothing under it. The GitHub login is already on
				    the account row below, and a timezone is a setting rather than
				    something you recognize yourself by. */}
        <div className="mt-3.5 text-item-title font-semibold text-fg">
          {profile.name}
        </div>
      </SettingsForm>
      {/* An error from the picture has to be visible when the dialog is shut,
			    since removing can be triggered from inside it and then reported
			    after it closes. */}
      {error && !editing && (
        <InlineAlert onDismiss={() => setError(null)}>{error}</InlineAlert>
      )}
      <ResponsiveDialog
        open={editing}
        onClose={() => setEditing(false)}
        phone={isPhone}
        label="Edit profile"
        modalClassName="w-[min(420px,calc(100vw-32px))]"
      >
        {(dismiss) => (
          <form className="flex flex-col gap-3.5 p-5" onSubmit={submit}>
            <div className="text-item-title font-semibold text-fg">
              Edit profile
            </div>
            {/* The picture is the control: the whole square picks a file,
						    and the glyph arrives over the middle of it on hover rather
						    than riding a corner all the time. A picture glyph rather
						    than a camera, because this replaces a FILE rather than
						    taking a shot, and a word under the glyph because a glyph
						    alone says "picture" without saying which way it goes.

						    Left rather than centered, so it starts on the same x as
						    the fields under it and the dialog reads as one column.

						    Removing rides the opposite corner of the same picture: it
						    acts on that picture, so it belongs on it, and the far
						    corner keeps a destructive click away from the target you
						    reach for. It is a sibling of the picture button and never
						    a child, since a button inside a button is invalid.

						    A touch client has no hover, so there the overlay stays
						    on. */}
            <div
              className={cn(OVERLAY_ACTION_HOST, "relative mb-1 mt-1 w-max")}
            >
              <button
                type="button"
                disabled={busy !== null}
                onClick={() => fileRef.current?.click()}
                aria-label={pictureAction}
                title={pictureAction}
                className="focus-ring group relative flex rounded-avatar disabled:pointer-events-none"
              >
                <UserAvatar
                  name={name || profile.name}
                  login={profile.github}
                  image={profile.image}
                  size={72}
                />
                {/* Hard black and white rather than themed tokens: this
								    lies on whatever photo a person uploaded, so it has
								    to hold its own contrast instead of following the
								    page. */}
                <span
                  className={cn(
                    "absolute inset-0 flex flex-col items-center justify-center gap-1 rounded-avatar bg-black/45 text-white transition-opacity",
                    busy === "picture" || isTouchPrimary
                      ? "opacity-100"
                      : "opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100",
                  )}
                  aria-hidden
                >
                  {busy === "picture" ? (
                    <Spinner size="md" />
                  ) : (
                    <>
                      <IconImage size={18} dense />
                      {/* One word: the button already carries the whole
											    sentence as its accessible name, and 72px of
											    picture cannot hold two. */}
                      <span className="text-[10px] font-medium leading-none">
                        {profile.image ? "Change" : "Upload"}
                      </span>
                    </>
                  )}
                </span>
              </button>
              {profile.image && (
                <OverlayAction
                  disabled={busy !== null}
                  onClick={() => void removePicture()}
                  aria-label="Remove picture"
                  title="Remove picture"
                  icon={<IconTrash className="text-red" size={16} />}
                />
              )}
            </div>
            {/* The note is a sibling of the Field, not a child: `Field` is
						    the `<label>`, so text inside it joins the input's accessible
						    name. The wrapper gives it the gap the label already has
						    above the input, rather than the form's row gap. */}
            <div className="flex min-w-0 flex-col gap-1.5">
              <Field label="Name">
                <Input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Ada Lovelace"
                  spellCheck={false}
                />
              </Field>
              {/* Not a warning: nothing is wrong, and the rename is handled
							    for them by routes/profile.ts, which keeps the old short
							    name as an alias and carries the per-user stores across.
							    All they need is which name their teammates will see, and
							    that the old one still finds them. */}
              {shortNameChanging && (
                <p className="m-0 text-supporting text-dim">
                  {profile.shortName} becomes {nextShort} in mentions and
                  attribution. {profile.shortName} keeps working.
                </p>
              )}
            </div>
            <FieldGrid>
              <Field label="Email">
                <Input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="ada@example.com"
                  spellCheck={false}
                />
              </Field>
              <Field label="Timezone">
                <Input
                  value={timezone}
                  onChange={(e) => setTimezone(e.target.value)}
                  placeholder="Europe/Amsterdam"
                  spellCheck={false}
                  autoCapitalize="none"
                />
              </Field>
            </FieldGrid>
            {error && (
              <InlineAlert onDismiss={() => setError(null)}>
                {error}
              </InlineAlert>
            )}
            <div className="mt-1 flex justify-end gap-2">
              <Button
                variant="ghost"
                className={isPhone ? "min-h-11" : undefined}
                onClick={dismiss}
              >
                Cancel
              </Button>
              <Button
                variant="primary"
                className={isPhone ? "min-h-11" : undefined}
                type="submit"
                disabled={!name.trim() || !dirty || busy !== null}
              >
                {busy === "fields" ? "Saving…" : "Save"}
              </Button>
            </div>
          </form>
        )}
      </ResponsiveDialog>
    </>
  );
}
