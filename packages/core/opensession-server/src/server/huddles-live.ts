/**
 * The gateway's one huddle switchboard (huddles.ts), wired to its sockets,
 * the helper model and comment threads. Created on first use, never at
 * import.
 */

import { createHuddles, type HuddleRoomState } from "./huddles";
import { allClients } from "./ws-hub";

const g = globalThis as { __huddles?: ReturnType<typeof createHuddles> };

export function huddles(): ReturnType<typeof createHuddles> {
  g.__huddles ??= createHuddles({
    clients: () => allClients,
    summarize: summarizeHuddle,
    now: Date.now,
    newId: () => crypto.randomUUID(),
  });
  return g.__huddles;
}

function clock(at: number): string {
  return new Date(at).toISOString().slice(11, 16);
}

/** Write a finished call's notes as a team note on the session it began in. */
async function summarizeHuddle(
  room: HuddleRoomState,
  transcript: Array<{ user: string; at: number; text: string }>,
): Promise<void> {
  if (!room.sessionId) return;
  const [{ oneShot }, { createThread, agentName }] = await Promise.all([
    import("./one-shot"),
    import("./comment-thread-service"),
  ]);
  const people = [...new Set(transcript.map((line) => line.user))];
  const lines = transcript
    .map((line) => `[${clock(line.at)}] ${line.user}: ${line.text}`)
    .join("\n")
    .slice(-60_000);
  const summary = await oneShot(
    [
      `Summarize this voice huddle for the people who were in it and anyone who missed it. Use short Markdown: a one-line gist, then "Decisions" and "Action items" as bullet lists (name the owner when it is clear). Leave out a section with nothing in it. Do not invent anything that was not said.`,
      "",
      `Huddle: ${room.label}`,
      `People: ${people.join(", ")}`,
      "",
      "Transcript (each person's own microphone, transcribed in chunks; lines marked (in chat) were typed in the huddle's chat):",
      lines,
    ].join("\n"),
    { label: "huddle-summary", timeoutMs: 90_000 },
  );
  const minutes = Math.max(
    1,
    Math.round((Date.now() - room.startedAt) / 60_000),
  );
  const text = [
    `**Huddle notes** · ${minutes} min · ${people.join(", ")}`,
    "",
    summary?.trim() ||
      "The summary could not be written. The transcript follows.\n\n" +
        lines.slice(0, 8_000),
  ].join("\n");
  await createThread({
    sessionId: room.sessionId,
    user: agentName(),
    text,
  });
}
