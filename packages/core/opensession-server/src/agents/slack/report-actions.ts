import { configuredServer } from "../../server/config";
import { startReportSessions } from "../../server/report-sessions";
import { getReport } from "../../server/reports";
import { resolveSlackUser, updateSlackBlocks } from "./slack-api";

const globalState = globalThis as typeof globalThis & {
  __reportFixActionsSeen?: Set<string>;
};
const seen = (globalState.__reportFixActionsSeen ??= new Set<string>());

function withoutFixAction(blocks: any[]): any[] {
  return blocks
    .filter((block) => block.block_id !== "report-fix-status")
    .map((block) =>
      block.type === "actions"
        ? {
            ...block,
            elements: (block.elements || []).filter(
              (element: any) => element.action_id !== "report-fix-all",
            ),
          }
        : block,
    )
    .filter((block) => block.type !== "actions" || block.elements.length > 0);
}

function withStatus(blocks: any[], text: string): any[] {
  return [
    ...withoutFixAction(blocks),
    {
      type: "context",
      block_id: "report-fix-status",
      elements: [{ type: "mrkdwn", text }],
    },
  ];
}

/** Start every task carried by a report from its Slack notification button. */
export async function handleReportFixAction(
  payload: any,
  value: string,
): Promise<void> {
  const channel = payload.channel?.id;
  const messageTs = payload.message?.ts;
  if (!channel || !messageTs) return;

  let ids: { automationId?: string; reportId?: string };
  try {
    ids = JSON.parse(value || "{}");
  } catch {
    ids = {};
  }
  if (!ids.automationId || !ids.reportId) return;
  const report = getReport(ids.automationId, ids.reportId);
  if (!report?.tasks?.length) {
    await updateSlackBlocks(
      channel,
      messageTs,
      "This report has no fixes to start",
      withStatus(
        payload.message?.blocks || [],
        "This report has no fixes to start.",
      ),
    );
    return;
  }

  const key = `${ids.automationId}/${ids.reportId}`;
  if (seen.has(key)) return;
  seen.add(key);
  const count = report.tasks.length;
  await updateSlackBlocks(
    channel,
    messageTs,
    `Starting ${count} ${count === 1 ? "fix" : "fixes"}`,
    withStatus(
      payload.message?.blocks || [],
      `⏳ Starting ${count} ${count === 1 ? "fix" : "fixes"}…`,
    ),
  );

  setImmediate(async () => {
    try {
      const slackUserId = payload.user?.id;
      const user = slackUserId
        ? (await resolveSlackUser(slackUserId)).name
        : undefined;
      const sessions = await startReportSessions({
        automationId: ids.automationId!,
        reportId: ids.reportId!,
        user,
      });
      const started = sessions.filter((session) => session.id);
      const failed = sessions.length - started.length;
      const base = configuredServer().publicBaseUrl.replace(/\/+$/, "");
      const links = started
        .map(
          (session, index) =>
            `<${base}/session/${encodeURIComponent(session.id!)}|Fix ${index + 1}>`,
        )
        .join(" · ");
      const status = started.length
        ? `✓ Started ${started.length} ${started.length === 1 ? "fix" : "fixes"}${failed ? ` · ${failed} failed` : ""}${links ? ` · ${links}` : ""}`
        : `Could not start the fixes. ${sessions[0]?.error || "Try again from the report."}`;
      await updateSlackBlocks(
        channel,
        messageTs,
        status.replace(/<[^|]+\|([^>]+)>/g, "$1"),
        withStatus(payload.message?.blocks || [], status),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await updateSlackBlocks(
        channel,
        messageTs,
        `Could not start the fixes: ${message}`,
        withStatus(
          payload.message?.blocks || [],
          `Could not start the fixes. ${message}`,
        ),
      ).catch(() => {});
    }
  });
}
