/**
 * Voice dictation: turn a short audio clip (Composer mic button) into text.
 *
 * Provider chain, best-first: OpenAI (OPENAI_API_KEY) → Groq (GROQ_API_KEY) →
 * local whisper.cpp. The hosted providers are optional quality/speed upgrades —
 * the local fallback means dictation works with zero configuration. whisper.cpp
 * lives outside the repo (~/tools/whisper.cpp, built once on the VPS); override
 * the binary/model with WHISPER_CLI / WHISPER_MODEL. Audio arrives as whatever
 * MediaRecorder produced (webm/opus on Chrome, mp4/AAC on iOS Safari); ffmpeg
 * normalizes to 16k mono wav for whisper.cpp, while the hosted APIs take the
 * original container as-is.
 */

import { homeDir } from "./paths";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unlink } from "node:fs/promises";

const WHISPER_CLI =
  process.env.WHISPER_CLI ||
  join(homeDir(), "tools/whisper.cpp/build/bin/whisper-cli");
const WHISPER_MODEL =
  process.env.WHISPER_MODEL ||
  join(homeDir(), "tools/whisper.cpp/models/ggml-small-q5_1.bin");

/** Max clip we accept — dictation, not podcasts. */
export const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

function extForMime(mime: string): string {
  if (mime.includes("mp4") || mime.includes("aac") || mime.includes("m4a"))
    return "m4a";
  if (mime.includes("ogg")) return "ogg";
  if (mime.includes("wav")) return "wav";
  if (mime.includes("mpeg") || mime.includes("mp3")) return "mp3";
  return "webm";
}

/** OpenAI-compatible transcription endpoint (OpenAI itself and Groq). */
async function transcribeHosted(
  endpoint: string,
  apiKey: string,
  model: string,
  audio: Blob,
  ext: string,
): Promise<string> {
  const form = new FormData();
  form.append("file", audio, `audio.${ext}`);
  form.append("model", model);
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${endpoint} ${res.status}: ${text.slice(0, 300)}`);
  }
  const json = (await res.json()) as { text?: string };
  if (typeof json.text !== "string")
    throw new Error("no text in transcription response");
  return json.text.trim();
}

async function transcribeLocal(audio: Blob, ext: string): Promise<string> {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const inPath = join(tmpdir(), `dictate-${stamp}.${ext}`);
  const wavPath = join(tmpdir(), `dictate-${stamp}.wav`);
  try {
    await Bun.write(inPath, audio);
    const ffmpeg = Bun.spawn(
      [
        "ffmpeg",
        "-y",
        "-i",
        inPath,
        "-ar",
        "16000",
        "-ac",
        "1",
        "-f",
        "wav",
        wavPath,
      ],
      { stdout: "ignore", stderr: "pipe" },
    );
    if ((await ffmpeg.exited) !== 0) {
      const err = await new Response(ffmpeg.stderr).text();
      throw new Error(`ffmpeg failed: ${err.slice(-300)}`);
    }
    const whisper = Bun.spawn(
      [
        WHISPER_CLI,
        "-m",
        WHISPER_MODEL,
        "-f",
        wavPath,
        "-t",
        "14",
        "-bs",
        "1",
        "-np", // no progress/system prints on stderr
        "-nt", // no timestamps — plain text lines on stdout
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [code, out, err] = await Promise.all([
      whisper.exited,
      new Response(whisper.stdout).text(),
      new Response(whisper.stderr).text(),
    ]);
    if (code !== 0) throw new Error(`whisper-cli failed: ${err.slice(-300)}`);
    return out
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .join(" ");
  } finally {
    void unlink(inPath).catch(() => {});
    void unlink(wavPath).catch(() => {});
  }
}

export async function localWhisperAvailable(): Promise<boolean> {
  return (
    (await Bun.file(WHISPER_CLI).exists()) &&
    (await Bun.file(WHISPER_MODEL).exists())
  );
}

/**
 * Transcribe a dictation clip. Tries each configured provider in order and
 * falls through on failure so one bad key doesn't kill dictation entirely.
 */
export async function transcribeAudio(
  audio: Blob,
  mime: string,
): Promise<{ text: string; provider: string }> {
  const ext = extForMime(mime);
  const errors: string[] = [];

  const openaiKey = process.env.OPENAI_API_KEY;
  if (openaiKey) {
    try {
      return {
        text: await transcribeHosted(
          "https://api.openai.com/v1/audio/transcriptions",
          openaiKey,
          "gpt-4o-mini-transcribe",
          audio,
          ext,
        ),
        provider: "openai",
      };
    } catch (e: any) {
      errors.push(`openai: ${e?.message || e}`);
    }
  }

  const groqKey = process.env.GROQ_API_KEY;
  if (groqKey) {
    try {
      return {
        text: await transcribeHosted(
          "https://api.groq.com/openai/v1/audio/transcriptions",
          groqKey,
          "whisper-large-v3-turbo",
          audio,
          ext,
        ),
        provider: "groq",
      };
    } catch (e: any) {
      errors.push(`groq: ${e?.message || e}`);
    }
  }

  if (await localWhisperAvailable()) {
    try {
      return {
        text: await transcribeLocal(audio, ext),
        provider: "whisper.cpp",
      };
    } catch (e: any) {
      errors.push(`whisper.cpp: ${e?.message || e}`);
    }
  } else {
    errors.push(
      "whisper.cpp: binary or model missing (see src/server/transcribe.ts header)",
    );
  }

  throw new Error(
    `transcription failed — ${errors.join("; ") || "no provider configured"}`,
  );
}
