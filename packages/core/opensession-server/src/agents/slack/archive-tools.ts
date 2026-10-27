/**
 * Archive tools for opensession-sessions: archive or restore one session, or
 * every session of a workspace, through the same server path the sidebar's
 * Archive and Unarchive actions use (session-archive-action.ts).
 *
 * Archiving stops runs and hides work from everyone's sidebar, so
 * sessions-tools.ts registers these only for trusted (isAdmin) contexts.
 */
import { z } from "zod";
import { audit } from "../../server/audit";
import { tool } from "../../server/inprocess-mcp";
import { setSessionArchivedState } from "../../server/session-archive-action";
import {
  findSessionAsync,
  getSessionListSnapshotAsync,
} from "../../server/session-cache";

export interface ArchiveToolContext {
  /** Display name credited in the audit log. */
  createdBy: string;
  /** The session using these tools. */
  currentSessionId?: string;
}

function text(s: string) {
  return { content: [{ type: "text" as const, text: s }] };
}

const archivedArg = z
  .boolean()
  .optional()
  .describe(
    "true (default) archives; false unarchives and restores it to the sidebar.",
  );

export function archiveTools(ctx: ArchiveToolContext): any[] {
  const verb = (archived: boolean) => (archived ? "Archived" : "Unarchived");
  return [
    tool(
      "archive_session",
      "Archive or unarchive one session, exactly like the sidebar's Archive / Unarchive action. Archiving stops a run this server owns and removes the session from the sidebar; unarchiving puts it back.",
      {
        id: z.string().trim().min(1).describe("The session id."),
        archived: archivedArg,
      },
      async (args: { id: string; archived?: boolean }) => {
        const archived = args.archived !== false;
        const session = await findSessionAsync(args.id);
        if (!session) return text(`No session with id \`${args.id}\`.`);
        if (archived && session.id === ctx.currentSessionId)
          return text("This session cannot archive itself.");
        if (!!session.archived === archived)
          return text(
            `Session \`${session.id}\` is already ${archived ? "archived" : "unarchived"}.`,
          );
        const { stoppedRun } = await setSessionArchivedState(session, archived);
        audit({
          msg: archived ? "session_archived" : "session_unarchived",
          session_id: session.id,
          source: "sessions_mcp",
          user: ctx.createdBy,
          source_session_id: ctx.currentSessionId,
        });
        return text(
          `${verb(archived)} \`${session.id}\`${stoppedRun ? " and stopped its run" : ""}.`,
        );
      },
    ),
    tool(
      "archive_workspace",
      "Archive or unarchive every session of a workspace (ws-…), including automation runs and workers the sidebar row hides. Unarchiving brings the workspace back into the sidebar.",
      {
        workspace_id: z
          .string()
          .trim()
          .min(1)
          .describe("Workspace id, e.g. ws-…, as in a /workspace/<id> URL."),
        archived: archivedArg,
      },
      async (args: { workspace_id: string; archived?: boolean }) => {
        const archived = args.archived !== false;
        const id = args.workspace_id;
        const members = (
          await getSessionListSnapshotAsync(archived ? "exclude" : "only")
        ).filter(
          (session) =>
            session.workspaceId === id &&
            !!session.archived !== archived &&
            !(archived && session.id === ctx.currentSessionId),
        );
        if (!members.length)
          return text(
            `Workspace \`${id}\` has no ${archived ? "live" : "archived"} sessions.`,
          );
        const done: string[] = [];
        const failed: string[] = [];
        for (const session of members) {
          try {
            await setSessionArchivedState(session, archived);
            done.push(session.id);
          } catch {
            failed.push(session.id);
          }
        }
        audit({
          msg: archived ? "workspace_archived" : "workspace_unarchived",
          workspace_id: id,
          session_ids: done,
          failed_session_ids: failed,
          source: "sessions_mcp",
          user: ctx.createdBy,
          source_session_id: ctx.currentSessionId,
        });
        const lines = [
          `${verb(archived)} ${done.length} session(s) in workspace \`${id}\`.`,
        ];
        if (done.length) lines.push(done.map((s) => `- \`${s}\``).join("\n"));
        if (failed.length)
          lines.push(`Failed: ${failed.map((s) => `\`${s}\``).join(", ")}`);
        return text(lines.join("\n"));
      },
    ),
  ];
}
