import type { ReviewAsker } from "../lib/review-queue";
import { personNameForGithubLogin } from "../lib/people";
import { UserAvatar } from "./UserAvatar";
import { IconEye } from "./icons";

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
      className="relative ml-1 flex shrink-0 items-center"
      title={label}
      aria-label={label}
    >
      <UserAvatar
        name={name}
        login={asker.login ?? undefined}
        size={16}
        className="shrink-0"
      />
      {/* Same 12px corner mark the mention badge uses: big enough to read as
			    deliberate, small enough to leave the face recognisable. */}
      <span
        aria-hidden="true"
        className="absolute -bottom-1 -right-1 flex size-3 items-center justify-center rounded-full bg-blue text-white ring-2 ring-panel"
      >
        <IconEye size={20} />
      </span>
    </span>
  );
}
