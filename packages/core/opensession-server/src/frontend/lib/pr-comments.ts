import { GITHUB_BOT_LOGINS } from "./brand";

/** Superseded automated reviews remain on GitHub for history, not as actionable discussion. */
export function isOutdatedReviewComment(body: string): boolean {
  return /<!--\s*os-review-outdated\s*-->/.test(body);
}

/**
 * Is this GitHub author a machine? The instance's own bot (the login the
 * agent's reviews and replies post as, `policy.githubBotLogins`) plus the
 * suffixes GitHub hands its apps.
 */
export function isBotAuthor(author?: string | null): boolean {
  const login = author?.trim().toLowerCase();
  if (!login) return false;
  return (
    GITHUB_BOT_LOGINS.has(login) ||
    login.endsWith("[bot]") ||
    login.endsWith("-bot")
  );
}

/**
 * A comment a person wrote from the Review tab, which the server signs
 * `**Kent** via OS:` (routes/pr.ts, which renders the configured persona
 * name). Without a per-user GitHub token
 * those go out under the bot account, so the author says machine and only the
 * body says person.
 */
const RELAYED_BY_PERSON = /^\s*(?:Review by\s+)?\*\*[^*\n]+\*\*\s+via\s+\S/;

/**
 * Was this comment written by a machine rather than a teammate? Author alone
 * misses in both directions: integrations post under a plain login (Vercel is
 * `vercel`, Linear is `linear-code`), and the instance bot relays comments
 * people wrote. So the body decides too — a bot opens with the hidden marker
 * or link reference it uses to find its own comment again
 * (`<!-- os-review -->`, `[vc]: #…`), and a person never does.
 */
export function isMachinePrComment(comment: {
  author?: string | null;
  body?: string | null;
}): boolean {
  const body = comment.body || "";
  if (RELAYED_BY_PERSON.test(body)) return false;
  if (isBotAuthor(comment.author)) return true;
  return /^\s*(?:<!--|\[[a-z][a-z0-9-]*\]:\s*#)/i.test(body);
}
