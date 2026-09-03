/**
 * opensession-walkthrough — publish a Cursor-style PR walkthrough for this
 * session: a short demo video + before/after screenshots + a writeup. Stored
 * on the session (rendered inline in the session where it was published, and in
 * the Review tab) and mirrored into the GitHub PR description as a managed
 * section with repository-scoped GitHub user attachments.
 *
 * Also carries `comment_on_pr_with_images`: upload local images and videos as
 * native GitHub user attachments, then place them in a PR comment. Private-repo
 * media stays private to GitHub readers; no public Open Session media origin or
 * camo-readable capability URL is involved.
 *
 * Wired like opensession-preview: interactive runs only (web sessions +
 * Slack), never automations, and only when a sessionId is in scope.
 */

import { createSdkMcpServer, tool } from "../../server/inprocess-mcp";
import { z } from "zod";
import { publishWalkthrough } from "../../server/walkthrough";
import {
  spliceUserAttachments,
  uploadUserAttachment,
  userAttachmentKind,
  type UploadedUserAttachment,
} from "../../server/gh-attachments";
import { postPrComment } from "../../server/pr-info";
import { findSession } from "../../server/session-cache";
import { resolvePrTarget } from "../../server/session-repos";
import { REPOS } from "../../server/worktree";

export interface WalkthroughToolContext {
  sessionId: string;
  /** Attribution for publishedBy (the run's user). */
  by?: string;
}

function text(s: string) {
  return { content: [{ type: "text" as const, text: s }] };
}

export function createWalkthroughMcpServer(ctx: WalkthroughToolContext) {
  const tools = [
    tool(
      "publish_walkthrough",
      "Publish a walkthrough of this session's change: a demo video, before/after screenshots, and a short writeup. Publish one for ANY change a human can see, including small visual tweaks. The video is optional, so an after screenshot (better: a before/after pair) is enough for a static visual change, and a recording is for interactions and flows. Capture screenshots at Retina or device-native resolution rather than enlarging a low-resolution image. It renders inline in the session and Review tab, and is mirrored into the GitHub PR description. Record the media first using the repository's own preview/capture workflow and pass absolute file paths; files are copied to durable storage without resizing, so temp paths are fine. Summary: 2-6 sentences of markdown describing what changed and how it was verified.",
      {
        summary: z
          .string()
          .describe(
            "Markdown writeup: what changed, root cause (for fixes), how it was verified. Shown under the video and in the PR body.",
          ),
        video: z
          .string()
          .optional()
          .describe(
            "Absolute path to a short screen-recording demoing the change AFTER the fix (mp4/webm/mov).",
          ),
        video_title: z
          .string()
          .optional()
          .describe(
            'Short human title for the video, e.g. "Model picker alignment — after".',
          ),
        shots: z
          .array(
            z.object({
              before: z
                .string()
                .optional()
                .describe(
                  "Absolute path to the BEFORE screenshot (png/jpg/webp/gif).",
                ),
              after: z
                .string()
                .optional()
                .describe("Absolute path to the AFTER screenshot."),
              caption: z
                .string()
                .optional()
                .describe("What this pair shows, one short phrase."),
            }),
          )
          .optional()
          .describe(
            "Before/after screenshot pairs (either side may be omitted).",
          ),
      },
      async (args: {
        summary: string;
        video?: string;
        video_title?: string;
        shots?: Array<{ before?: string; after?: string; caption?: string }>;
      }) => {
        try {
          const { walkthrough, pr } = await publishWalkthrough(
            ctx.sessionId,
            {
              summary: args.summary,
              video: args.video,
              videoTitle: args.video_title,
              shots: args.shots,
            },
            ctx.by,
          );
          const parts = [
            `Walkthrough published — it now shows inline in the session and in this session's Review tab (${walkthrough.video ? "video, " : ""}${walkthrough.shots?.length ? `${walkthrough.shots.length} before/after pair(s), ` : ""}writeup).`,
          ];
          if (pr.mirrored)
            parts.push(`Mirrored into the PR description: ${pr.url}`);
          else
            parts.push(
              `Not yet on a PR (${pr.reason}). Call publish_walkthrough again after opening the PR and it will be spliced into the description.`,
            );
          return text(parts.join(" "));
        } catch (e: any) {
          return text(`publish_walkthrough failed: ${e?.message || String(e)}`);
        }
      },
    ),
    tool(
      "comment_on_pr_with_images",
      "Post a comment on this session's PR (or an explicit PR) with images or videos that render inline on GitHub. Files become repository-scoped GitHub user attachments, so private-repo media stays private and no public Open Session media origin is required. Place files with {{media:1}}, {{media:2}}, and so on. Put video placeholders on their own line so GitHub renders a player. Unreferenced files are appended in order. The old images input and {{image:N}} placeholders remain accepted for existing callers.",
      {
        comment: z
          .string()
          .describe(
            "Comment markdown. Optionally position files with {{media:N}} placeholders (1-based).",
          ),
        media: z
          .array(
            z.object({
              path: z
                .string()
                .describe(
                  "Absolute path under /tmp or the current user's home directory. Supported: png, jpg, jpeg, gif, webp, svg, mp4, mov, webm.",
                ),
              alt: z
                .string()
                .optional()
                .describe("Alt text for an image. Videos do not use alt text."),
            }),
          )
          .min(1)
          .max(50)
          .optional()
          .describe(
            "Images and videos to upload and attach, in display order.",
          ),
        images: z
          .array(
            z.object({
              path: z.string(),
              alt: z.string().optional(),
            }),
          )
          .min(1)
          .max(50)
          .optional()
          .describe(
            "Deprecated image-only input retained for compatibility. Use media for new calls.",
          ),
        repo: z
          .string()
          .optional()
          .describe(
            "Registered project id when the PR isn't on the session's primary repo; attached and linked repos resolve too.",
          ),
        pr_number: z
          .number()
          .optional()
          .describe(
            "Explicit PR number in that repo. Defaults to the open PR on the session's branch.",
          ),
      },
      async (args: {
        comment: string;
        media?: Array<{ path: string; alt?: string }>;
        images?: Array<{ path: string; alt?: string }>;
        repo?: string;
        pr_number?: number;
      }) => {
        try {
          if (args.repo && !REPOS[args.repo])
            return text(
              `Unknown repo "${args.repo}". Known project ids: ${Object.keys(REPOS).join(", ")}.`,
            );
          let ghRepo: string | undefined;
          let selector: string | undefined;
          const session = findSession(ctx.sessionId);
          if (args.repo && args.pr_number) {
            // Fully explicit, so this works even when the session is gone.
            ghRepo = REPOS[args.repo].ghRepo;
            selector = String(args.pr_number);
          } else if (session) {
            const target = resolvePrTarget(session, args.repo || null, null);
            if (!target)
              return text(
                "Couldn't resolve a PR target from this session. Pass repo and pr_number explicitly.",
              );
            ghRepo = target.ghRepo;
            selector = args.pr_number ? String(args.pr_number) : target.branch;
          } else {
            return text(
              "Session not found. Pass both repo and pr_number so the PR can be targeted explicitly.",
            );
          }

          const items = [...(args.media || []), ...(args.images || [])];
          if (items.length === 0)
            return text("Pass at least one image or video in media.");
          if (items.length > 50)
            return text("A comment can attach at most 50 files.");

          const home = process.env.HOME || "";
          const uploaded: UploadedUserAttachment[] = [];
          for (const item of items) {
            const path = item.path.trim();
            const allowedPath =
              path.startsWith("/tmp/") ||
              (!!home && path.startsWith(`${home}/`));
            if (!allowedPath || path.includes(".."))
              return text(
                `Refusing media path outside /tmp or ${home || "the service home"}: ${path}`,
              );
            const kind = userAttachmentKind(path);
            if (!kind)
              return text(
                `Unsupported media type: ${path}. Use png, jpg, jpeg, gif, webp, svg, mp4, mov, or webm.`,
              );
            if (kind === "video" && item.alt?.trim())
              return text(`Video attachments do not support alt text: ${path}`);
            const url = await uploadUserAttachment(ghRepo, path);
            if (!url)
              return text(
                `Uploading ${path} to GitHub failed. No comment was posted. Any earlier files from this call are cached and will be reused on retry.`,
              );
            uploaded.push({ path, url, kind, alt: item.alt });
          }

          const body = spliceUserAttachments(args.comment, uploaded);
          const res = await postPrComment(selector, { body }, ghRepo);
          if ("error" in res)
            return text(
              `Posting the comment failed: ${res.error}. The ${uploaded.length} GitHub attachment(s) are cached and will be reused on retry.`,
            );
          return text(
            `Comment posted${res.url ? `: ${res.url}` : ""}. ${uploaded.length} file(s) are stored as native GitHub user attachments.`,
          );
        } catch (e: any) {
          return text(
            `comment_on_pr_with_images failed: ${e?.message || String(e)}`,
          );
        }
      },
    ),
  ];

  return createSdkMcpServer({
    name: "opensession-walkthrough",
    version: "1.0.0",
    tools,
  });
}
