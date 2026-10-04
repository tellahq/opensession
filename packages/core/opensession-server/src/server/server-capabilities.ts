import type { ServerDescriptor } from "@tellahq/opensession-protocol/capabilities";
import { version } from "../../package.json";

/** Process-constant metadata: no filesystem, catalog or provider probes. */
export const SERVER_DESCRIPTOR: ServerDescriptor = Object.freeze({
  serverVersion: version,
  protocolVersion: 1,
  capabilities: Object.freeze({
    commandResults: true,
    deskVoice: true,
    sessionVoice: true,
    sessionListSlices: true,
    sessionCreateIdempotency: true,
  }),
});

const descriptorJSON = JSON.stringify(SERVER_DESCRIPTOR);
export function serverCapabilitiesResponse(): Response {
  return new Response(descriptorJSON, {
    headers: {
      "Content-Type": "application/json",
      // Never retain capabilities across an upgrade or downgrade.
      "Cache-Control": "no-store",
    },
  });
}
