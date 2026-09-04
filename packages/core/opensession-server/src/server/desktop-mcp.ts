/** Interactive Sandbox desktop MCP: the agent sees and drives the same screen
 *  the person watches in the session's Desktop tab. Sandboxed sessions only. */
import { z } from "zod";
import { createSdkMcpServer, tool } from "./inprocess-mcp";
import type { SandboxDesktopControl } from "./sandbox/provider";

export interface DesktopMcpContext {
  sessionId: string;
  /** Wakes the Sandbox when needed. Null when the session has no desktop. */
  control: () => Promise<SandboxDesktopControl | null>;
}

/** Longest screenshot edge sent to the model unless the caller asks. */
export const DESKTOP_SCREENSHOT_MAX_EDGE = 1280;

/** Shrink a desktop so its longest edge fits the model-friendly bound. */
export function desktopScreenshotScale(
  width: number,
  height: number,
  maxEdge = DESKTOP_SCREENSHOT_MAX_EDGE,
): number {
  const edge = Math.max(width, height);
  if (!edge || edge <= maxEdge) return 1;
  return Math.round((maxEdge / edge) * 100) / 100;
}

function text(value: string) {
  return { content: [{ type: "text" as const, text: value }] };
}

function failure(cause: unknown, fallback: string) {
  const message = cause instanceof Error ? cause.message : String(cause);
  return text(`${fallback}: ${message}`);
}

const NO_DESKTOP =
  "This session has no Sandbox desktop. Only sandboxed sessions on Box or Daytona can be driven this way.";

const point = {
  x: z.number().describe("Desktop pixel from the left edge"),
  y: z.number().describe("Desktop pixel from the top edge"),
};
const button = z.enum(["left", "middle", "right"]).optional();

export function createDesktopMcpServer(ctx: DesktopMcpContext) {
  const withControl = async <T>(
    fallback: string,
    run: (control: SandboxDesktopControl) => Promise<T>,
  ): Promise<T | ReturnType<typeof text>> => {
    let control: SandboxDesktopControl | null;
    try {
      control = await ctx.control();
    } catch (cause) {
      return failure(cause, "The Sandbox desktop is unavailable");
    }
    if (!control) return text(NO_DESKTOP);
    try {
      return await run(control);
    } catch (cause) {
      return failure(cause, fallback);
    }
  };

  return createSdkMcpServer({
    name: "opensession-desktop",
    version: "1.0.0",
    tools: [
      tool(
        "screenshot",
        "Capture the Sandbox desktop. Coordinates for every other desktop tool are pixels of the full desktop, whose size the result states; the image itself may be scaled down. Take one before acting and after anything that should have changed the screen.",
        {
          scale: z
            .number()
            .gt(0)
            .max(1)
            .optional()
            .describe("Shrink factor for the image. Default fits 1280px."),
          format: z
            .enum(["png", "jpeg"])
            .optional()
            .describe("Default jpeg; png for pixel-exact detail."),
        },
        async ({ scale, format }) =>
          withControl("Screenshot failed", async (control) => {
            const size = scale ? null : await control.display();
            const shot = await control.screenshot({
              scale: scale ?? desktopScreenshotScale(size!.width, size!.height),
              format: format ?? "jpeg",
            });
            const applied =
              scale ?? desktopScreenshotScale(shot.width, shot.height);
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Desktop ${shot.width}x${shot.height}${applied === 1 ? "" : `, image scaled to ${applied} of that; give coordinates in desktop pixels`}.`,
                },
                {
                  type: "image" as const,
                  data: shot.data,
                  mimeType: shot.mimeType,
                },
              ],
            };
          }),
      ),
      tool(
        "click",
        "Click at a desktop pixel. Double-click with double: true.",
        { ...point, button, double: z.boolean().optional() },
        async ({ x, y, button: which, double }) =>
          withControl("Click failed", async (control) => {
            await control.click(x, y, { button: which, double });
            return text(
              `${double ? "Double-clicked" : "Clicked"} ${which ?? "left"} at (${Math.round(x)}, ${Math.round(y)}).`,
            );
          }),
      ),
      tool(
        "move",
        "Move the pointer without clicking, for hover states.",
        point,
        async ({ x, y }) =>
          withControl("Move failed", async (control) => {
            await control.move(x, y);
            return text(`Pointer at (${Math.round(x)}, ${Math.round(y)}).`);
          }),
      ),
      tool(
        "drag",
        "Press at one point, move to another, release.",
        {
          fromX: z.number(),
          fromY: z.number(),
          toX: z.number(),
          toY: z.number(),
          button,
        },
        async ({ fromX, fromY, toX, toY, button: which }) =>
          withControl("Drag failed", async (control) => {
            await control.drag(
              { x: fromX, y: fromY },
              { x: toX, y: toY },
              { button: which },
            );
            return text(
              `Dragged from (${Math.round(fromX)}, ${Math.round(fromY)}) to (${Math.round(toX)}, ${Math.round(toY)}).`,
            );
          }),
      ),
      tool(
        "scroll",
        "Scroll the wheel over a point. amount is wheel clicks, default 3.",
        {
          ...point,
          direction: z.enum(["up", "down"]),
          amount: z.number().int().min(1).max(50).optional(),
        },
        async ({ x, y, direction, amount }) =>
          withControl("Scroll failed", async (control) => {
            await control.scroll(x, y, direction, amount);
            return text(
              `Scrolled ${direction} ${amount ?? 3} at (${Math.round(x)}, ${Math.round(y)}).`,
            );
          }),
      ),
      tool(
        "type",
        "Type literal text into whatever has keyboard focus. Click a field first. Use key for Enter, Tab and shortcuts.",
        { text: z.string().max(10_000) },
        async ({ text: value }) =>
          withControl("Typing failed", async (control) => {
            await control.type(value);
            return text(`Typed ${value.length} characters.`);
          }),
      ),
      tool(
        "key",
        "Press one key or chord: Return, Escape, Tab, ctrl+l, ctrl+shift+t, alt+F4, cmd+a (cmd maps to the super key on Linux).",
        { chord: z.string().min(1).max(64) },
        async ({ chord }) =>
          withControl("Key press failed", async (control) => {
            await control.key(chord);
            return text(`Pressed ${chord}.`);
          }),
      ),
      tool(
        "windows",
        "List the desktop size and visible windows with their positions, so you can find an app or bring one to the front by clicking it.",
        {},
        async () =>
          withControl("Listing windows failed", async (control) => {
            const [size, windows] = await Promise.all([
              control.display(),
              control.windows(),
            ]);
            const lines = windows.map(
              (w) =>
                `${w.active ? "* " : "  "}${w.title || "(untitled)"} at (${w.x}, ${w.y}) ${w.width}x${w.height}`,
            );
            return text(
              `Desktop ${size.width}x${size.height}. ${windows.length} visible window${windows.length === 1 ? "" : "s"}${lines.length ? ":\n" + lines.join("\n") : "."}`,
            );
          }),
      ),
    ],
  });
}
