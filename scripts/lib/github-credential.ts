/**
 * Git credential helper for github.com remotes.
 *
 * Registered per checkout by setup-repos.ts and reached through the stable
 * `opensession github-credential` command. It answers only from this
 * process's environment: OPENSESSION_GITHUB_PUSH_TOKEN when the operator
 * configured a dedicated git-transport credential, otherwise GH_TOKEN. The
 * split lets git clone/pull/push run as a push-scoped identity while API
 * calls (gh, octokit) keep GH_TOKEN. Trusted interactive runs and explicit
 * server-side Git calls inject those values; unattended runs receive neither
 * a token nor a way to resolve one from the server-side account store.
 */

export function githubCredentialResponse(
  action: string | undefined,
  input: string,
): string {
  if (action !== "get") return "";

  const attrs: Record<string, string> = {};
  for (const line of input.split("\n")) {
    if (!line) break;
    const eq = line.indexOf("=");
    if (eq > 0) attrs[line.slice(0, eq)] = line.slice(eq + 1);
  }
  if (attrs.protocol !== "https" || attrs.host !== "github.com") return "";

  const token =
    process.env.OPENSESSION_GITHUB_PUSH_TOKEN || process.env.GH_TOKEN;
  return token ? `username=x-access-token\npassword=${token}\n` : "";
}

export async function githubCredentialHelper(
  action: string | undefined,
): Promise<number> {
  process.stdout.write(
    githubCredentialResponse(action, await Bun.stdin.text()),
  );
  return 0;
}
