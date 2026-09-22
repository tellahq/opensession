import { parseArgs } from "node:util";
import { z } from "zod";
import { buildSimulatorViewer } from "./assets";
import { openIdbSimulator } from "./idb";
import { startSimulatorViewer } from "./server";

/**
 * The supervised viewer process behind a simulator Portal. Source installs run
 * this file directly under `bun`; the compiled binary reaches it through the
 * `opensession simulator-portal` subcommand (src/main.ts), which splices the
 * subcommand out so the flags below land at the same argv positions.
 */
export async function runSimulatorPortal() {
  const { values } = parseArgs({
    options: {
      session: { type: "string" },
      workspace: { type: "string" },
      app: { type: "string" },
      "device-type": { type: "string" },
      runtime: { type: "string" },
    },
    strict: true,
  });
  const input = z
    .object({
      session: z.string().min(1),
      workspace: z.string().min(1),
      app: z.string().min(1),
      "device-type": z.string().optional(),
      runtime: z.string().optional(),
    })
    .parse(values);
  const port = z.coerce
    .number()
    .int()
    .min(1024)
    .max(65535)
    .parse(process.env.PORT);
  const origin = z.url({ protocol: /^https?$/ }).parse(process.env.PORTAL_URL);
  const assets = await buildSimulatorViewer();
  const viewer = startSimulatorViewer({
    port,
    origin,
    assets,
    openSimulator: () =>
      openIdbSimulator({
        sessionId: input.session,
        workspaceDir: input.workspace,
        appPath: input.app,
        deviceType: input["device-type"],
        runtime: input.runtime,
      }),
  });
  const stop = () => {
    void viewer.stop().then(
      () => process.exit(0),
      (error) => {
        console.error(error);
        process.exit(1);
      },
    );
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  console.log("Simulator Portal listening. The viewer reports startup status.");
}

if (import.meta.main) {
  await runSimulatorPortal().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
