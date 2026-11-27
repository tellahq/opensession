/**
 * Google Vertex AI as a Pi provider (`google-vertex`).
 *
 * Vertex takes either a Vertex API key or a Google Cloud service account
 * key file. Both are stored in the provider's `apiKey` field: a key runs as
 * a plain API key, a service account JSON runs as Application Default
 * Credentials. Pi's Vertex adapter reads service accounts only from a file,
 * so the run writes the JSON to a 0600 file under the state dir and hands Pi
 * its path, project and location as a provider-scoped credential. Nothing is
 * written to the process environment.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ModelProviderConfig } from "./model-providers";
import { stateDir } from "./paths";

export const VERTEX_PROVIDER_ID = "google-vertex";
/** Vertex's global endpoint serves every Gemini model, including the ones
 *  not offered in a single region. */
export const VERTEX_DEFAULT_LOCATION = "global";

/** Models Pi's bundled Vertex catalog describes. Others run by id. */
export const VERTEX_PICKER_MODELS = [
  "gemini-3.8-flash",
  "gemini-3.1-pro-preview",
] as const;

export interface VertexServiceAccount {
  projectId?: string;
  clientEmail: string;
}

function parseJsonObject(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/** The service account a stored Vertex credential names, or undefined when
 *  it is a plain API key. */
export function vertexServiceAccount(
  credential: string | undefined,
): VertexServiceAccount | undefined {
  if (!credential?.trimStart().startsWith("{")) return undefined;
  const json = parseJsonObject(credential);
  if (
    json?.type !== "service_account" ||
    typeof json.client_email !== "string" ||
    typeof json.private_key !== "string"
  )
    return undefined;
  return {
    clientEmail: json.client_email,
    ...(typeof json.project_id === "string" && json.project_id
      ? { projectId: json.project_id }
      : {}),
  };
}

/**
 * Normalize what Settings received as the Vertex credential. A service
 * account file is validated and stored compact (whitespace inside its
 * private key must survive, so it is never stripped); anything else is an
 * API key with its pasted line wraps removed.
 */
export function normalizeVertexCredential(input: string): string {
  const text = input.trim();
  if (!text.startsWith("{")) return text.replace(/\s+/g, "");
  const json = parseJsonObject(text);
  if (!json) throw new Error("The service account key is not valid JSON");
  if (!vertexServiceAccount(text)) {
    throw new Error(
      "Expected a service account key file (type service_account with client_email and private_key)",
    );
  }
  return JSON.stringify(json);
}

/** Display form of a stored Vertex credential: the service account's email,
 *  which is not a secret. Undefined for a plain API key. */
export function vertexCredentialLabel(
  credential: string | undefined,
): string | undefined {
  const account = vertexServiceAccount(credential);
  return account ? `Service account ${account.clientEmail}` : undefined;
}

/** The project a Vertex provider bills: the configured one, else the
 *  service account's own project. */
export function vertexProject(
  provider: Pick<ModelProviderConfig, "apiKey" | "project">,
): string | undefined {
  return provider.project || vertexServiceAccount(provider.apiKey)?.projectId;
}

function credentialsDir(): string {
  return join(stateDir("secrets"), VERTEX_PROVIDER_ID);
}

/** Write the service account JSON where Pi can read it (0600, content
 *  addressed, rewritten only when missing or changed). */
async function writeCredentialsFile(json: string, dir: string) {
  const name = createHash("sha256").update(json).digest("hex").slice(0, 16);
  const path = join(dir, `${name}.json`);
  const existing = await readFile(path, "utf-8").catch(() => undefined);
  if (existing === json) return path;
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, json, { mode: 0o600 });
  await rename(tmp, path);
  return path;
}

/** Pi's stored-credential shape for Vertex Application Default Credentials. */
export interface VertexPiCredential {
  type: "api_key";
  env: {
    GOOGLE_APPLICATION_CREDENTIALS: string;
    GOOGLE_CLOUD_PROJECT: string;
    GOOGLE_CLOUD_LOCATION: string;
  };
}

/**
 * The credential a run seeds into Pi for a service-account Vertex provider.
 * Undefined when the provider holds a plain API key, which Pi sends as is.
 * Throws when no project is known, since Vertex cannot run without one.
 */
export async function vertexPiCredential(
  provider: ModelProviderConfig,
  dir: string = credentialsDir(),
): Promise<VertexPiCredential | undefined> {
  if (!provider.apiKey || !vertexServiceAccount(provider.apiKey))
    return undefined;
  const project = vertexProject(provider);
  if (!project) {
    throw new Error(
      `Provider "${VERTEX_PROVIDER_ID}" needs a Google Cloud project: the service account key has no project_id, so set one in Settings → Providers`,
    );
  }
  return {
    type: "api_key",
    env: {
      GOOGLE_APPLICATION_CREDENTIALS: await writeCredentialsFile(
        provider.apiKey,
        dir,
      ),
      GOOGLE_CLOUD_PROJECT: project,
      GOOGLE_CLOUD_LOCATION: provider.location || VERTEX_DEFAULT_LOCATION,
    },
  };
}

/** Standard PayGo USD per million tokens, before account discounts and invoice
 * credits (including Carbon/Argon's introductory 50% credit). Thinking tokens
 * use the output rate. Source: https://cloud.google.com/model-garden/pricing
 * Cache-write billing for Neon/Hydrogen begins on 2027-01-12; the current Pi
 * adapter reports no cache writes, but metadata must not price them early. */
export function vertexModelCost(
  id: string,
  location = VERTEX_DEFAULT_LOCATION,
  at = Date.now(),
) {
  const input = {
    "gemini-4-neon": 3,
    "gemini-4-hydrogen": 1.5,
    "gemini-4-carbon": 4,
    "gemini-4-argon": 4,
  }[id];
  if (input === undefined) return undefined;
  const regional = location === VERTEX_DEFAULT_LOCATION ? 1 : 1.1;
  const price = (rate: number) => Number((rate * regional).toFixed(6));
  const writes =
    (id === "gemini-4-neon" || id === "gemini-4-hydrogen") &&
    at >= Date.parse("2027-01-12T00:00:00Z");
  return {
    input: price(input),
    output: price(input * 5),
    cacheRead: price(input * 0.05),
    cacheWrite: writes ? price(input * 1.25) : 0,
  };
}

/**
 * The row a Gemini model missing from Pi's Vertex catalog runs with. Every
 * Gemini since 2.5 takes images and a 1M-token window with 64K output.
 * Thinking is left at the model's default: Pi picks the thinking wire format
 * from the model id, and a newer family may reject the one it guesses.
 */
export function vertexFallbackModel(
  id: string,
  location = VERTEX_DEFAULT_LOCATION,
) {
  const gemini = /^gemini-/.test(id);
  return {
    id,
    name: id,
    reasoning: false,
    input: (gemini ? ["text", "image"] : ["text"]) as Array<"text" | "image">,
    cost: vertexModelCost(id, location) ?? {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: gemini ? 1_048_576 : 131_072,
    maxTokens: gemini ? 65_536 : 32_768,
  };
}
