import { mergeStylexProps, mergeStylexOverrideClassName } from "../../ui/cn";
import { utilityClassName } from "../../ui/cn";
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
import { OverlayAction } from "../../ui/overlay-action";
import { SettingsForm, SettingsGroupLabel } from "../../ui/settings";
import { ResponsiveDialog } from "../../ui/sheet";
import { Spinner } from "../../ui/spinner";
import { EmptyState, InlineAlert, Skeleton, SkeletonBar } from "../../ui/state";
import { toast } from "../../ui/toast";
import { IconImage, IconPencil, IconTrash } from "../icons";
import { useCurrentUser } from "../UserPicker";
import { UserAvatar } from "../UserAvatar";
import * as stylex from "@stylexjs/stylex";
import { type as typography } from "../../styles/typography.stylex";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
  mt0: {
    marginTop: "0",
  },
  itemsCenter: {
    alignItems: "center",
  },
  gap0: {
    gap: "0",
  },
  py7: {
    paddingBlock: "calc(4px * 7)",
  },
  size20: {
    width: "calc(4px * 20)",
    height: "calc(4px * 20)",
  },
  roundedAvatar: {
    borderRadius: "calc(32% * var(--rp))",
    cornerShape: "var(--cs)",
  },
  mt4: {
    marginTop: "calc(4px * 4)",
  },
  h3: {
    height: "calc(4px * 3)",
  },
  w40: {
    width: "calc(4px * 40)",
  },
  hidden: {
    display: "none",
  },
  relative: {
    position: "relative",
  },
  flex: {
    display: "flex",
  },
  absolute: {
    position: "absolute",
  },
  Bottom05: {
    bottom: "calc(4px * -0.5)",
  },
  Right05: {
    right: "calc(4px * -0.5)",
  },
  grid: {
    display: "grid",
  },
  size8: {
    width: "calc(4px * 8)",
    height: "calc(4px * 8)",
  },
  placeItemsCenter: {
    placeItems: "center",
  },
  roundedFull: {
    borderRadius: "calc(infinity * 1px)",
    cornerShape: "round",
  },
  bgWhite: {
    backgroundColor: "var(--color-white)",
  },
  textBlack: {
    color: "var(--color-black)",
  },
  mt35: {
    marginTop: "calc(4px * 3.5)",
  },
  fontSemibold: {
    fontWeight: "var(--font-weight-semibold)",
  },
  textFg: {
    color: "var(--text)",
  },
  flexCol: {
    flexDirection: "column",
  },
  gap35: {
    gap: "calc(4px * 3.5)",
  },
  p5: {
    padding: "calc(4px * 5)",
  },
  mb1: {
    marginBottom: "4px",
  },
  mt1: {
    marginTop: "4px",
  },
  wMax: {
    width: "max-content",
  },
  disabledPointerEventsNone: {
    ":disabled": {
      pointerEvents: "none",
    },
  },
  text10px: {
    fontSize: "10px",
  },
  fontMedium: {
    fontWeight: "var(--font-weight-medium)",
  },
  leadingNone: {
    lineHeight: "1",
  },
  textRed: {
    color: "var(--red)",
  },
  minW0: {
    minWidth: "0",
  },
  gap15: {
    gap: "calc(4px * 1.5)",
  },
  m0: {
    margin: "0",
  },
  textDim: {
    color: "var(--text-dim)",
  },
  justifyEnd: {
    justifyContent: "flex-end",
  },
  gap2: {
    gap: "calc(4px * 2)",
  },
});

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
      <SettingsGroupLabel className={mergeStylexOverrideClassName("", sx.mt0)}>
        Profile
      </SettingsGroupLabel>
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
      <SettingsForm
        className={mergeStylexOverrideClassName(
          "",
          sx.itemsCenter,
          sx.gap0,
          sx.py7,
        )}
      >
        <SkeletonBar
          className={mergeStylexOverrideClassName(
            "",
            sx.size20,
            sx.roundedAvatar,
          )}
        />
        <SkeletonBar
          className={mergeStylexOverrideClassName("", sx.mt4, sx.h3, sx.w40)}
        />
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
        {...stylex.props(sx.hidden)}
        onChange={(e) => void pickPicture(e.target.files?.[0])}
      />
      <SettingsForm
        className={mergeStylexOverrideClassName(
          "",
          sx.itemsCenter,
          sx.gap0,
          sx.py7,
        )}
      >
        {/* The whole portrait opens the editor, with the badge as the mark
				    that says so. A badge that is the only target makes a 28px hit
				    area out of a 80px one, and the picture is what the eye goes to
				    anyway. */}
        <button
          type="button"
          onClick={() => setEditing(true)}
          aria-label="Edit profile"
          {...mergeStylexProps(
            "focus-ring",
            sx.relative,
            sx.flex,
            sx.roundedAvatar,
          )}
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
            {...mergeStylexProps(
              "shadow-sm",
              sx.absolute,
              sx.Bottom05,
              sx.Right05,
              sx.grid,
              sx.size8,
              sx.placeItemsCenter,
              sx.roundedFull,
              sx.bgWhite,
              sx.textBlack,
            )}
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
        <div
          {...stylex.props(
            sx.mt35,
            sx.fontSemibold,
            sx.textFg,
            typography.itemTitle,
          )}
        >
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
        modalClassName={utilityClassName("w-[min(420px,calc(100vw-32px))]")}
      >
        {(dismiss) => (
          <form
            {...stylex.props(sx.flex, sx.flexCol, sx.gap35, sx.p5)}
            onSubmit={submit}
          >
            <div
              {...stylex.props(
                sx.fontSemibold,
                sx.textFg,
                typography.itemTitle,
              )}
            >
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
              {...mergeStylexProps(
                "group/overlay-action",
                sx.relative,
                sx.mb1,
                sx.mt1,
                sx.wMax,
              )}
            >
              <button
                type="button"
                disabled={busy !== null}
                onClick={() => fileRef.current?.click()}
                aria-label={pictureAction}
                title={pictureAction}
                {...mergeStylexProps(
                  "focus-ring group",
                  sx.relative,
                  sx.flex,
                  sx.roundedAvatar,
                  sx.disabledPointerEventsNone,
                )}
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
                    utilityClassName(
                      "absolute inset-0 flex flex-col items-center justify-center gap-1 rounded-avatar bg-black/45 text-white transition-opacity",
                    ),
                    busy === "picture" || isTouchPrimary
                      ? utilityClassName("opacity-100")
                      : utilityClassName(
                          "opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100",
                        ),
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
                      <span
                        {...stylex.props(
                          sx.text10px,
                          sx.fontMedium,
                          sx.leadingNone,
                        )}
                      >
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
                  icon={
                    <IconTrash
                      className={mergeStylexOverrideClassName("", sx.textRed)}
                      size={16}
                    />
                  }
                />
              )}
            </div>
            {/* The note is a sibling of the Field, not a child: `Field` is
						    the `<label>`, so text inside it joins the input's accessible
						    name. The wrapper gives it the gap the label already has
						    above the input, rather than the form's row gap. */}
            <div {...stylex.props(sx.flex, sx.minW0, sx.flexCol, sx.gap15)}>
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
                <p {...stylex.props(sx.m0, sx.textDim, typography.supporting)}>
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
            <div {...stylex.props(sx.mt1, sx.flex, sx.justifyEnd, sx.gap2)}>
              <Button
                variant="ghost"
                className={isPhone ? utilityClassName("min-h-11") : undefined}
                onClick={dismiss}
              >
                Cancel
              </Button>
              <Button
                variant="primary"
                className={isPhone ? utilityClassName("min-h-11") : undefined}
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
