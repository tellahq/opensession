export const GATEWAY_COMMAND_OPERATIONS = [
  "websocket_command",
  "delete_session",
  "session_file_updated",
  "plain_archive_clear",
  "plain_archive_set",
  "archive_override",
  "title_override",
  "status_override",
  "review_request",
  "model_migration",
  "session_delete",
  "transcript_append",
  "transcript_destination_append",
  "transcript_import",
  "transcript_replace",
  "transcript_delete",
] as const;

export type GatewayCommandOperation =
  (typeof GATEWAY_COMMAND_OPERATIONS)[number];

/** Only operations whose destination consumes the same immutable request id may
 * be re-admitted after an ambiguous process loss. Projection callbacks are not. */
export const DESTINATION_IDEMPOTENT_GATEWAY_OPERATIONS =
  new Set<GatewayCommandOperation>([
    "websocket_command",
    "delete_session",
    "transcript_destination_append",
  ]);

export type GatewayCommandRequest =
  | {
      op: "request";
      sessionId: string;
      requestId: string;
      operation: GatewayCommandOperation;
      identity?: unknown;
    }
  | {
      op: "complete";
      sessionId: string;
      requestId: string;
      operation: GatewayCommandOperation;
      result: unknown;
    }
  | {
      op: "fail";
      sessionId: string;
      requestId: string;
      operation: GatewayCommandOperation;
      error: string;
      retryable: boolean;
    };

export type GatewayCommandResult<T extends GatewayCommandRequest> = T extends {
  op: "request";
}
  ?
      | { status: "execute" }
      | { status: "in_progress" }
      | { status: "completed"; result: unknown; duplicate: true }
  : T extends { op: "complete" }
    ? unknown
    : void;
