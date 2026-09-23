import { resolve } from "node:path";

/** Resolve once in the gateway and pin in both helper commands. Host Portals
 * deliberately do not inherit the gateway's instance environment. */
export function simulatorStorageRoot(): string {
  const stateRoot = process.env.OPENSESSION_STATE_DIR;
  if (stateRoot !== undefined) return resolve(stateRoot, "simulator-storage");
  const home = process.env.HOME;
  if (!home)
    throw new Error("Simulator storage requires HOME or OPENSESSION_STATE_DIR");
  return resolve(home, ".opensession", "simulator-storage");
}
