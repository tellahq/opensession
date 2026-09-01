import { existsSync } from "fs";
import { readConfig } from "./config-edit";
import { ENV_PATH } from "./paths";

type ServerConfig = {
  host?: unknown;
  port?: unknown;
  publicBaseUrl?: unknown;
};

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function envFileValues(contents: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of contents.split("\n")) {
    const match = line.match(/^\s*([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    values[match[1]] = value;
  }
  return values;
}

/** Resolve the public address the running server advertises. */
export function resolveServerUrl(
  config: Record<string, unknown> | undefined,
  env: Record<string, string | undefined> = {},
): string {
  const server = (config?.server ?? {}) as ServerConfig;
  const host = text(env.HOST) || text(server.host) || "127.0.0.1";
  const port = Number(text(env.PORT) || server.port) || 3850;
  const connectHost = /^(0\.0\.0\.0|::|\[::\])$/.test(host)
    ? "127.0.0.1"
    : host;
  const publicUrl =
    text(env.OPENSESSION_UI_BASE) ||
    text(server.publicBaseUrl) ||
    `http://${connectHost}:${port}`;
  return publicUrl.replace(/\/+$/, "");
}

/** Read the same config and service env file used by an installed server. */
export async function configuredServerUrl(): Promise<string> {
  const config = await readConfig().catch(() => undefined);
  let env: Record<string, string> = {};
  if (existsSync(ENV_PATH)) {
    env = envFileValues(
      await Bun.file(ENV_PATH)
        .text()
        .catch(() => ""),
    );
  }
  return resolveServerUrl(config, env);
}
