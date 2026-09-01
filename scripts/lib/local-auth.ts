import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";

/**
 * Machine identity for server-local CLI/CDP work.
 *
 * Never fall back to a human row: doing that made every abandoned inspection
 * tab look like the first teammate in the session store and let automation act
 * with their attribution. The server creates this record on boot whenever web
 * auth is enabled.
 */
export function localAutomationToken(): string | null {
  const home = homedir();
  const current = `${home}/.opensession/web-sessions.json`;
  const legacy = `${home}/.opensession-web-sessions.json`;
  const path =
    process.env.OPENSESSION_WEB_SESSIONS_STORE ||
    (existsSync(current) || !existsSync(legacy) ? current : legacy);
  if (!existsSync(path)) return null;
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  const sessions = Array.isArray(parsed?.sessions) ? parsed.sessions : [];
  const automation = sessions.find(
    (session: any) =>
      session?.kind === "automation" &&
      typeof session.token === "string" &&
      session.token,
  );
  if (automation) return automation.token;
  if (sessions.length === 0) return null;
  throw new Error(
    "Open Session has no Automation web identity; restart the server before running local browser tooling",
  );
}
