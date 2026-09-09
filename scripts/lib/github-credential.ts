/**
 * Git credential helper for github.com remotes.
 *
 * Registered per checkout by setup-repos.ts and reached through the stable
 * `opensession github-credential` command. It answers only from this
 * process's environment: GH_TOKEN, the one credential a run or a server-owned
 * Git call was explicitly handed. Agent runs carry a repository-scoped App
 * installation token there; server-side calls on a person's behalf carry that
 * person's token. A process with no GH_TOKEN gets no answer and no way to
 * resolve one from the server-side account store.
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

  const token = process.env.GH_TOKEN;
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
