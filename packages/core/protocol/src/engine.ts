/** Versioned driver features. Unknown versions should be treated conservatively. */
export interface EngineCapabilities {
  version: 1;
  supportsSteering: boolean;
  supportsInterrupt: boolean;
  canResume: boolean;
  canRewindConversation: boolean;
  canForkNatively: boolean;
  supportsMcpTools: boolean;
  supportsImages: boolean;
  streamsReasoning: boolean;
  emitsToolOutput: boolean;
  terminalStatusQuality: "authoritative" | "best-effort";
}
