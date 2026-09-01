import { mergeStylexProps, mergeStylexOverrideClassName } from "../ui/cn";
import type { ReviewAsker } from "../lib/review-queue";
import { personNameForGithubLogin } from "../lib/people";
import { UserAvatar } from "./UserAvatar";
import { IconEye } from "./icons";
import * as stylex from "@stylexjs/stylex";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
  relative: {
    position: "relative",
  },
  ml1: {
    marginLeft: "4px",
  },
  flex: {
    display: "flex",
  },
  shrink0: {
    flexShrink: "0",
  },
  itemsCenter: {
    alignItems: "center",
  },
  absolute: {
    position: "absolute",
  },
  Bottom1: {
    bottom: "calc(4px * -1)",
  },
  Right1: {
    right: "calc(4px * -1)",
  },
  size3: {
    width: "calc(4px * 3)",
    height: "calc(4px * 3)",
  },
  justifyCenter: {
    justifyContent: "center",
  },
  roundedFull: {
    borderRadius: "calc(infinity * 1px)",
    cornerShape: "round",
  },
  bgBlue: {
    backgroundColor: "var(--blue)",
  },
  textWhite: {
    color: "var(--color-white)",
  },
});

/**
 * Whose review request this row is carrying: their face, badged so it cannot
 * read as one of the presence faces further along the same row.
 *
 * The rail's blue dot says a review is waiting on you; this says who is
 * waiting, which is what decides whether you do it now. Same construction as
 * the mention badge beside it (a 16px face with a corner mark), in the blue
 * the app spends on "blocked on you" everywhere else.
 *
 * A GitHub request names the pull request's AUTHOR, because GitHub does not
 * record who added you as a reviewer — so the label says "opened by" there
 * and "asked you to review" only for a request made in Open Session, where
 * that is a fact rather than an inference.
 */
export function ReviewAskerFace({ asker }: { asker: ReviewAsker }) {
  // A teammate's GitHub login pictures and reads better as their own name.
  const name =
    (asker.login && personNameForGithubLogin(asker.login)) || asker.name;
  const label = asker.viaPr
    ? `Review requested on ${name}'s pull request`
    : `${name} asked you to review this`;
  return (
    <span
      {...stylex.props(
        sx.relative,
        sx.ml1,
        sx.flex,
        sx.shrink0,
        sx.itemsCenter,
      )}
      title={label}
      aria-label={label}
    >
      <UserAvatar
        name={name}
        login={asker.login ?? undefined}
        size={16}
        className={mergeStylexOverrideClassName("", sx.shrink0)}
      />
      {/* Same 12px corner mark the mention badge uses: big enough to read as
			    deliberate, small enough to leave the face recognisable. */}
      <span
        aria-hidden="true"
        {...mergeStylexProps(
          "ring-2 ring-panel",
          sx.absolute,
          sx.Bottom1,
          sx.Right1,
          sx.flex,
          sx.size3,
          sx.itemsCenter,
          sx.justifyCenter,
          sx.roundedFull,
          sx.bgBlue,
          sx.textWhite,
        )}
      >
        <IconEye size={8} />
      </span>
    </span>
  );
}
