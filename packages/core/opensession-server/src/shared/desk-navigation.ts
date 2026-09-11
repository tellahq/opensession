import { z } from "zod";

/** The tabs Desk may foreground once it lands: the transcript (`chat`) or one
 * of the workspace panes the app router already addresses. Panes that spawn
 * something (terminal, desktop, preview) are deliberately not reachable. */
export const DESK_SHOW_TABS = [
  "chat",
  "review",
  "conversation",
  "video",
] as const;
export type DeskShowTab = (typeof DESK_SHOW_TABS)[number];

// Only catalog IDs and a fixed tab name, never URLs, paths, query strings, or
// fragments.
export const deskShowTargetSchema = z
  .object({
    kind: z.enum(["session", "workspace"]),
    id: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
    tab: z.enum(DESK_SHOW_TABS).optional(),
  })
  .strict();
export type DeskShowTarget = z.infer<typeof deskShowTargetSchema>;

export const deskNavigationCommandSchema = z.object({
  id: z.string().uuid(),
  target: deskShowTargetSchema,
  expiresAt: z.number().finite(),
});
export type DeskNavigationCommand = z.infer<typeof deskNavigationCommandSchema>;

export const deskNavigationRequestSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("poll"),
      connectionId: z.string().min(1).max(256),
      token: z.string().uuid(),
    })
    .strict(),
  z
    .object({
      action: z.literal("ack"),
      connectionId: z.string().min(1).max(256),
      token: z.string().uuid(),
      commandId: z.string().uuid(),
      shown: z.boolean(),
    })
    .strict(),
]);
export type DeskNavigationRequest = z.infer<typeof deskNavigationRequestSchema>;

export const deskNavigationPollSchema = z.object({
  command: deskNavigationCommandSchema.nullable(),
  finished: z.boolean().optional(),
});

export const deskNavigationConnectionSchema = z.object({
  connectionId: z.string().uuid(),
  token: z.string().uuid(),
});
export const deskNavigationConnectSchema = z
  .object({ sessionId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/) })
  .strict();
export const deskNavigationBindSchema = deskNavigationConnectionSchema
  .extend({ requestId: z.string().uuid() })
  .strict();

export type DeskNavigationConnection = z.infer<
  typeof deskNavigationConnectionSchema
>;
export type DeskNavigationBinding = z.infer<typeof deskNavigationBindSchema>;
export type DeskNavigationConnect = z.infer<typeof deskNavigationConnectSchema>;
