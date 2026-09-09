import { writeFileSync } from "node:fs";
import { SESSION_KERNEL_ACTOR_VERSION } from "../actor-protocol";

const databasePath = process.env.OPENSESSION_SESSION_KERNEL_DB_PATH;
if (!databasePath) throw new Error("Test worker requires a database path");
const restartMarker = `${databasePath}.delayed-restart`;

self.addEventListener(
  "message",
  async (event: MessageEvent<Record<string, unknown>>) => {
    const request = event.data;
    if (request.t === "hello" && typeof request.rpcId === "string") {
      if (await Bun.file(restartMarker).exists()) await Bun.sleep(250);
      self.postMessage({
        t: "ready",
        rpcId: request.rpcId,
        version: SESSION_KERNEL_ACTOR_VERSION,
      });
      return;
    }
    if (request.t === "call") {
      writeFileSync(restartMarker, "restart");
      return;
    }
    self.postMessage({
      t: "error",
      rpcId: request.rpcId,
      error: `Unexpected test request ${String(request.t)}`,
    });
  },
);
