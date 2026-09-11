import { z } from "zod";

const coordinate = z.number().finite().min(0).max(1);
export const viewerInputSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("tap"), x: coordinate, y: coordinate }).strict(),
  z
    .object({
      type: z.literal("swipe"),
      x: coordinate,
      y: coordinate,
      endX: coordinate,
      endY: coordinate,
      duration: z.number().finite().min(0.05).max(2),
    })
    .strict(),
  z
    .object({ type: z.literal("text"), text: z.string().min(1).max(1_000) })
    .strict(),
  z.object({ type: z.literal("home") }).strict(),
  z
    .object({
      type: z.literal("key"),
      key: z.enum([
        "Enter",
        "Backspace",
        "Tab",
        "Escape",
        "ArrowUp",
        "ArrowDown",
        "ArrowLeft",
        "ArrowRight",
      ]),
    })
    .strict(),
]);
export type ViewerInput = z.infer<typeof viewerInputSchema>;

export const viewerStateSchema = z.discriminatedUnion("phase", [
  z.object({ phase: z.literal("starting") }),
  z.object({
    phase: z.literal("ready"),
    deviceName: z.string(),
    width: z.number().positive(),
    height: z.number().positive(),
  }),
  z.object({ phase: z.literal("error"), message: z.string() }),
]);
export type ViewerState = z.infer<typeof viewerStateSchema>;
export const viewerMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("state"), state: viewerStateSchema }),
  z.object({ type: z.literal("input-error"), message: z.string() }),
]);

export const simulatorKeyCodes = {
  Enter: 40,
  Backspace: 42,
  Tab: 43,
  Escape: 41,
  ArrowRight: 79,
  ArrowLeft: 80,
  ArrowDown: 81,
  ArrowUp: 82,
} satisfies Record<Extract<ViewerInput, { type: "key" }>["key"], number>;
