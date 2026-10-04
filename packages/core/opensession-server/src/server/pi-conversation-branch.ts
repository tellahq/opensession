import { access, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUIDv7 } from "bun";
import { stateContext } from "./paths";
import type { TurnConversationAnchor } from "./turn-workspace-checkpoint";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/;
export async function piSessionDirectory(sessionId: string): Promise<string> {
  if (!SAFE_ID.test(sessionId)) throw new Error("Invalid Pi session id");
  const context = stateContext();
  let root: string;
  if (context.stateRoot) root = join(context.stateRoot, ".opensession-pi");
  else {
    root = join(context.home, ".opensession", "pi");
    try {
      await access(root);
    } catch {
      const legacy = join(context.home, ".opensession-pi");
      try {
        await access(legacy);
        root = legacy;
      } catch {
        /* new state root */
      }
    }
  }
  return join(root, "sessions", sessionId);
}
export function branchPiConversationText(
  text: string,
  anchor: TurnConversationAnchor,
  engineId: string,
): string {
  if (Buffer.byteLength(text) > 32 * 1024 * 1024)
    throw new Error("Pi conversation is too large to branch safely");
  const lines = text.trimEnd().split("\n");
  const entries = lines.map(
    (line) =>
      JSON.parse(line) as { type: string; id?: string; version?: number },
  );
  const header = entries[0];
  if (
    header?.type !== "session" ||
    header.id !== anchor.engineId ||
    header.version !== 3
  )
    throw new Error("This Pi conversation cannot be rewound");
  const through =
    anchor.leafId === null
      ? 0
      : entries.findIndex((entry) => entry.id === anchor.leafId);
  if (through < 0)
    throw new Error("The pre-turn Pi conversation entry is missing");
  // Pi reconstructs its active leaf from the last entry on open. A new file
  // containing the exact original prefix is a durable branch, not a mutation
  // of the old engine log or a branch-summary that leaks reverted context.
  return (
    [
      JSON.stringify({ ...header, id: engineId }),
      ...lines.slice(1, through + 1),
    ].join("\n") + "\n"
  );
}
export async function branchPiConversation(
  sessionId: string,
  anchor: TurnConversationAnchor,
): Promise<string> {
  if (!/^[A-Za-z0-9_-]+\.jsonl$/.test(anchor.file))
    throw new Error("Invalid Pi conversation file");
  const dir = await piSessionDirectory(sessionId);
  if ((await stat(join(dir, anchor.file))).size > 32 * 1024 * 1024)
    throw new Error("Pi conversation is too large to branch safely");
  const text = await readFile(join(dir, anchor.file), "utf8");
  const engineId = randomUUIDv7();
  const branched = branchPiConversationText(text, anchor, engineId);
  const filename = `${new Date().toISOString().replace(/[:.]/g, "-")}_${engineId}.jsonl`;
  await writeFile(join(dir, filename), branched, { flag: "wx", mode: 0o600 });
  return engineId;
}
export async function piConversationExists(
  sessionId: string,
  engineId: string,
): Promise<boolean> {
  if (!SAFE_ID.test(engineId)) return false;
  const files = await readdir(await piSessionDirectory(sessionId));
  return files.some((file) => file.endsWith(`_${engineId}.jsonl`));
}
