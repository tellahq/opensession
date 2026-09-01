export function parseMcpEnvironment(source: string): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const line of source.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const separator = trimmed.indexOf("=");
    if (separator === -1) {
      throw new Error(`Env line "${trimmed}" must be KEY=VALUE`);
    }
    environment[trimmed.slice(0, separator).trim()] = trimmed
      .slice(separator + 1)
      .trim();
  }
  return environment;
}
