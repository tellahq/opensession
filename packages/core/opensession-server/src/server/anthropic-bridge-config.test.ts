import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bridgeDesignationError } from "./anthropic-bridge";

test("disabled bridge guidance names the config files this process actually reads", async () => {
  const root = await mkdtemp(join(tmpdir(), "acme-bridge-config-"));
  const prevPi = process.env.OPENSESSION_PI_CONFIG;
  const prevProviders = process.env.OPENSESSION_MODEL_PROVIDERS_CONFIG;
  const piPath = join(root, "pi.json");
  const providersPath = join(root, "model-providers.json");
  try {
    await writeFile(piPath, JSON.stringify({ enabled: false }));
    await writeFile(providersPath, JSON.stringify({ enabled: false }));
    process.env.OPENSESSION_PI_CONFIG = piPath;
    process.env.OPENSESSION_MODEL_PROVIDERS_CONFIG = providersPath;
    const error = bridgeDesignationError();
    expect(error).toContain(piPath);
    expect(error).toContain(providersPath);
    expect(error).not.toContain("~/.opensession-");
  } finally {
    if (prevPi === undefined) delete process.env.OPENSESSION_PI_CONFIG;
    else process.env.OPENSESSION_PI_CONFIG = prevPi;
    if (prevProviders === undefined)
      delete process.env.OPENSESSION_MODEL_PROVIDERS_CONFIG;
    else process.env.OPENSESSION_MODEL_PROVIDERS_CONFIG = prevProviders;
    await rm(root, { recursive: true, force: true });
  }
});
