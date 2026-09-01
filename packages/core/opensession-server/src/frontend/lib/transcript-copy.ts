// Turn a session's transcript into clipboard text — used by the tab context menu
// ("Copy concise/full transcript") and the ⌘⌥C shortcut. Entries are fetched
// fresh from the server, so this works for any tab, not just the open session.
import { fetchTranscript } from "./api";
import { copyToClipboard } from "./share-link";
import type { TranscriptEntry, UnifiedSession } from "./types";

/**
 * Markdown rendering of a transcript. Concise keeps just the conversation
 * (user prompts + assistant replies); full also includes tool calls with
 * their input, tool results, and system entries.
 */
export function formatTranscript(
  entries: TranscriptEntry[],
  mode: "concise" | "full",
): string {
  const parts: string[] = [];
  for (const e of entries) {
    const text = (e.content || "").trim();
    if (e.type === "user" && text) {
      parts.push(`## User\n\n${text}`);
    } else if (e.type === "assistant" && text) {
      parts.push(`## Assistant\n\n${text}`);
    } else if (mode === "full") {
      if (e.type === "tool_use") {
        // `content` is the parser's one-line summary of the call.
        const input =
          e.toolInput === undefined
            ? ""
            : `\n\n\`\`\`json\n${JSON.stringify(e.toolInput, null, 2)}\n\`\`\``;
        parts.push(`### Tool: ${e.toolName || "unknown"} · ${text}${input}`);
      } else if (e.type === "tool_result") {
        parts.push(
          `### Tool result${e.isError ? " (error)" : ""}\n\n\`\`\`\n${text}\n\`\`\``,
        );
      } else if (e.type === "system" && text) {
        parts.push(`### System\n\n${text}`);
      }
    }
  }
  return parts.join("\n\n");
}

/** Fetch, format, and copy a session's transcript; reports the outcome via onToast. */
export async function copySessionTranscript(
  session: Pick<UnifiedSession, "id" | "title">,
  mode: "concise" | "full",
  onToast: (message: string) => void,
): Promise<void> {
  const okToast = () =>
    onToast(
      mode === "concise"
        ? "Concise transcript copied"
        : "Full transcript copied",
    );

  // Fetch → format into the final clipboard string. Rejects with a sentinel so
  // callers can tell "load failed" from "nothing to copy" and surface the right
  // toast.
  const build = async (): Promise<string> => {
    const entries =
      ((await fetchTranscript(session.id)) as TranscriptEntry[]) || [];
    const body = formatTranscript(entries, mode);
    if (!body) throw new Error("empty");
    return `# ${session.title}\n\n${body}\n`;
  };

  // The transcript needs an async fetch, but writing to the clipboard *after* an
  // await loses the click's transient user-activation — so
  // `navigator.clipboard.writeText(await …)` is rejected in WebKit/Safari (the
  // copy silently fails while the toast still claims success). The async
  // ClipboardItem pattern fixes it: we hand `clipboard.write()` a Promise<Blob>
  // synchronously inside the gesture and the browser awaits the fetch while
  // keeping activation. Secure-context only (needs navigator.clipboard).
  if (navigator.clipboard?.write && typeof ClipboardItem !== "undefined") {
    try {
      const blob = build().then(
        (text) => new Blob([text], { type: "text/plain" }),
      );
      await navigator.clipboard.write([
        new ClipboardItem({ "text/plain": blob }),
      ]);
      okToast();
      return;
    } catch {
      // Fall through to the fetch-then-textarea path (covers browsers that
      // reject a pending ClipboardItem, and lets us report load/empty state).
    }
  }

  let text: string;
  try {
    text = await build();
  } catch (e) {
    onToast(
      (e as Error).message === "empty"
        ? "Nothing to copy yet"
        : "Couldn't load the transcript",
    );
    return;
  }
  copyToClipboard(text, okToast);
}
