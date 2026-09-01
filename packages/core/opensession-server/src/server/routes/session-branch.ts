import { moveSessionToBranch } from "../session-branch";
import type { RouteContext } from "./context";

/** Move a shared-checkout session into its own branch and worktree. */
export async function handleSessionBranchRoutes(
  ctx: RouteContext,
): Promise<Response | undefined> {
  const match = ctx.path.match(/^\/api\/sessions\/(.+)\/move-to-branch$/);
  if (!match || ctx.req.method !== "POST") return undefined;
  try {
    return Response.json(
      await moveSessionToBranch(decodeURIComponent(match[1])),
    );
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Could not move this session to a branch",
      },
      { status: 400 },
    );
  }
}
