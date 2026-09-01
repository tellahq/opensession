import type { PrComment, PrDetails } from "./types";

function trimCommentBody(body: string): string {
  return body.trim().replace(/\n{3,}/g, "\n\n");
}

/** Bot comments hide bookkeeping in HTML comments (`<!-- marker -->`) — drop them from previews. */
export function stripHtmlComments(body: string): string {
  return body.replace(/<!--[\s\S]*?-->/g, "").trim();
}

export function formatPrCommentPrompt(
  comment: PrComment,
  pr: PrDetails,
): string {
  const author = comment.author ? ` from ${comment.author}` : "";
  const link = comment.url ? `\nURL: ${comment.url}` : "";
  return `Please address this PR comment${author} on PR #${pr.number} (${pr.title}).${link}\n\n${trimCommentBody(comment.body)}`;
}
