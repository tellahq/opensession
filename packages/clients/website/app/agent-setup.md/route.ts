import { readFile } from "node:fs/promises";
import path from "node:path";

// Agents fetch this page as Markdown. It is rendered once at build time from
// the repository copy, so the website and docs/setup/agent.md never drift.
export const dynamic = "force-static";

export async function GET() {
  const guide = await readFile(
    path.resolve(process.cwd(), "../../../docs/setup/agent.md"),
    "utf8",
  );
  return new Response(guide, {
    headers: { "content-type": "text/markdown; charset=utf-8" },
  });
}
