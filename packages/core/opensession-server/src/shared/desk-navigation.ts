import { z } from "zod";

// Only catalog IDs, never URLs, paths, query strings, or fragments.
export const deskShowTargetSchema = z
  .object({
    kind: z.enum(["session", "workspace"]),
    id: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
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
      liveSessionId: z.string().min(1).max(256),
      token: z.string().uuid(),
    })
    .strict(),
  z
    .object({
      action: z.literal("ack"),
      liveSessionId: z.string().min(1).max(256),
      token: z.string().uuid(),
      commandId: z.string().uuid(),
      shown: z.boolean(),
    })
    .strict(),
]);
export type DeskNavigationRequest = z.infer<typeof deskNavigationRequestSchema>;

export const deskNavigationPollSchema = z.object({
  command: deskNavigationCommandSchema.nullable(),
});
