import type { EngineCapabilities } from "@tellahq/opensession-protocol/engine";

export const PI_CAPABILITIES: Readonly<EngineCapabilities> = Object.freeze({
  version: 1,
  supportsSteering: true,
  supportsInterrupt: true,
  canResume: true,
  canRewindConversation: true,
  canForkNatively: true,
  supportsMcpTools: true,
  supportsImages: true,
  streamsReasoning: true,
  emitsToolOutput: true,
  terminalStatusQuality: "authoritative",
});
