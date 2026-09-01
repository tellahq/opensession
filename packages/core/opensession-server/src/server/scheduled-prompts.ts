/**
 * Durable prompts scheduled for an existing session.
 *
 * The JSON file remains the UI listing format. Delivery authority is a
 * SessionKernel timer, so a process timeout is only a wake-up and the stable
 * schedule id is also the prompt delivery id.
 */
import { randomUUIDv7 } from "bun";
import { existsSync, readFileSync } from "fs";
import { writeJsonAtomic } from "./shared/atomic-write";
import { stateDir } from "./paths";
import { registerSessionTimerHandler, sessionKernel } from "./session-kernel";
import { getSessionControl } from "./session-control";

let STORE_PATH = stateDir("scheduled-prompts.json");

export function __setScheduledPromptStoreForTest(path: string): string {
  const previous = STORE_PATH;
  STORE_PATH = path;
  return previous;
}
const TIMER_KIND = "scheduled_prompt";

export interface ScheduledPrompt {
  id: string;
  sessionId: string;
  prompt: string;
  user: string;
  at: string;
  createdAt: string;
}

interface Store {
  prompts: ScheduledPrompt[];
}

function readStore(): Store {
  try {
    if (existsSync(STORE_PATH)) {
      const stored = JSON.parse(readFileSync(STORE_PATH, "utf-8"));
      if (Array.isArray(stored.prompts)) return stored;
    }
  } catch {}
  return { prompts: [] };
}

function writeStore(store: Store): void {
  writeJsonAtomic(STORE_PATH, store);
}

function removeFromListing(id: string): boolean {
  const store = readStore();
  const before = store.prompts.length;
  store.prompts = store.prompts.filter((prompt) => prompt.id !== id);
  if (store.prompts.length === before) return false;
  writeStore(store);
  return true;
}

async function schedule(prompt: ScheduledPrompt): Promise<void> {
  await sessionKernel(prompt.sessionId).scheduleTimer({
    timerId: prompt.id,
    kind: TIMER_KIND,
    dueAt: Date.parse(prompt.at),
    payload: prompt,
  });
}

registerSessionTimerHandler(TIMER_KIND, async (timer) => {
  const prompt = timer.payload as ScheduledPrompt;
  if (
    !prompt ||
    prompt.id !== timer.timerId ||
    prompt.sessionId !== timer.sessionId ||
    typeof prompt.prompt !== "string"
  )
    throw new Error("Invalid scheduled prompt timer payload");
  const result = await getSessionControl().deliverToSession(
    prompt.sessionId,
    prompt.prompt,
    prompt.user,
    { deliveryId: prompt.id },
  );
  if (result.status === "error") throw new Error(result.message);
  removeFromListing(prompt.id);
  console.log(
    `[scheduled-prompts] ${prompt.id} -> ${prompt.sessionId}: ${result.status}`,
  );
});

export function hydrateScheduledPromptTimers(): number {
  const prompts = readStore().prompts;
  for (const prompt of prompts) schedule(prompt);
  return prompts.length;
}

export function listScheduledPrompts(sessionId?: string): ScheduledPrompt[] {
  const all = readStore().prompts;
  return (
    sessionId ? all.filter((prompt) => prompt.sessionId === sessionId) : all
  ).sort((a, b) => a.at.localeCompare(b.at));
}

export function createScheduledPrompt(input: {
  sessionId: string;
  prompt: string;
  at: string;
  user: string;
}): ScheduledPrompt | { error: string } {
  if (!input.sessionId?.trim()) return { error: "sessionId required" };
  if (!input.prompt?.trim()) return { error: "Prompt is required" };
  const time = Date.parse(input.at || "");
  if (Number.isNaN(time)) return { error: `Invalid time: "${input.at}"` };
  if (time < Date.now() - 60_000) return { error: "That time is in the past" };
  const prompt: ScheduledPrompt = {
    id: `sched-${randomUUIDv7()}`,
    sessionId: input.sessionId.trim(),
    prompt: input.prompt.trim(),
    user: input.user?.trim() || "Anonymous",
    at: new Date(time).toISOString(),
    createdAt: new Date().toISOString(),
  };
  const store = readStore();
  store.prompts.push(prompt);
  writeStore(store);
  schedule(prompt);
  return prompt;
}

export async function deleteScheduledPrompt(id: string): Promise<boolean> {
  const prompt = readStore().prompts.find((candidate) => candidate.id === id);
  if (!prompt) return false;
  const removed = removeFromListing(id);
  if (removed) await sessionKernel(prompt.sessionId).cancelTimer(prompt.id);
  return removed;
}

/** Compatibility read for old callers. Delivery is no longer destructive. */
export function takeDuePrompts(now = Date.now()): ScheduledPrompt[] {
  return readStore().prompts.filter((prompt) => Date.parse(prompt.at) <= now);
}
