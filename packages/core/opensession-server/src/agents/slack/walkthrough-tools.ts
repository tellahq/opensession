/**
 * opensession-walkthrough — publish a Cursor-style PR walkthrough for this
 * session: a short demo video + before/after screenshots + a writeup. Stored
 * on the session (rendered inline in the session where it was published, and in
 * the Review tab) and mirrored into the
 * GitHub PR description as a managed section (media as tailnet links there —
 * see src/server/walkthrough.ts for why they can't inline on GitHub).
 *
 * Also carries `comment_on_pr_with_images`: post a PR comment whose
 * screenshots RENDER inline on GitHub — images are staged to durable storage
 * and served from unguessable URLs on the configured public origin, which
 * GitHub's camo proxy can fetch (see src/server/pr-images.ts for the
 * mechanism and the alternatives that don't work).
 *
 * Wired like opensession-preview: interactive runs only (web sessions +
 * Slack), never automations, and only when a sessionId is in scope.
 */

import { createSdkMcpServer, tool } from "../../server/inprocess-mcp";
import { z } from "zod";
import { publishWalkthrough } from "../../server/walkthrough";
import {
  repoIsPrivate,
  spliceImagesIntoMarkdown,
  uploadPrImages,
} from "../../server/pr-images";
import { postPrComment } from "../../server/pr-info";
import { findSession } from "../../server/session-cache";
import { resolvePrTarget } from "../../server/session-repos";
import { REPOS } from "../../server/worktree";
import { configuredServer } from "../../server/config";

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
      "Post a comment on this session's PR (or an explicit PR) with screenshots that RENDER INLINE on GitHub. Images are copied to durable storage and served from unguessable URLs on the configured public media origin. This requires a GitHub-reachable HTTPS origin configured through OPENSESSION_PR_IMAGES_BASE, integrations.media.publicBaseUrl, or server.publicBaseUrl; loopback, private-network, and tailnet URLs will not render. The URLs are capability links: anyone holding one can fetch the image, so don't attach anything that must stay strictly repo-member-only. Place images in the markdown with {{image:1}}, {{image:2}}, … (1-based); images you don't reference are appended at the end.",
      {
        comment: z
          .string()
          .describe(
            "Comment markdown. Optionally position images with {{image:N}} placeholders (1-based).",
          ),
        images: z
          .array(
            z.object({
              path: z
                .string()
                .describe(
                  "Absolute path to the image (png/jpg/jpeg/webp/gif) under /tmp or the current user's home directory.",
                ),
              alt: z
                .string()
                .optional()
                .describe("Alt/caption text for the image."),
            }),
          )
          .min(1)
          .describe("Images to upload and attach."),
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
        images: Array<{ path: string; alt?: string }>;
        repo?: string;
        pr_number?: number;
      }) => {
        try {
          if (args.repo && !REPOS[args.repo])
            return text(
              `Unknown repo "${args.repo}" — known project ids: ${Object.keys(REPOS).join(", ")}.`,
            );
          let ghRepo: string | undefined;
          let selector: string | undefined; // branch name or PR number for gh
          const session = findSession(ctx.sessionId);
          if (args.repo && args.pr_number) {
            // Fully explicit — works even when the session can't be resolved.
            ghRepo = REPOS[args.repo].ghRepo;
            selector = String(args.pr_number);
          } else if (session) {
            const target = resolvePrTarget(session, args.repo || null, null);
            if (!target)
              return text(
                "Couldn't resolve a PR target from this session — pass repo and pr_number explicitly.",
              );
            ghRepo = target.ghRepo;
            selector = args.pr_number ? String(args.pr_number) : target.branch;
          } else {
            return text(
              "Session not found — pass both repo and pr_number so the PR can be targeted explicitly.",
            );
          }
          // Visibility gate (fail-closed): an image capability URL posted on
          // a public repo is a public screenshot — camo caches it for every
          // reader. Refuse rather than publish (PR #78 review P1).
          const isPrivate = await repoIsPrivate(ghRepo);
          if (isPrivate !== true)
            return text(
              isPrivate === false
                ? `Refusing: ${ghRepo} is a PUBLIC repository — posting screenshots there publishes them (GitHub's camo proxy caches the capability URL for every reader). Post the comment without images, or have a human attach them deliberately.`
                : `Refusing: couldn't verify that ${ghRepo} is a private repository — image comments are only posted to confirmed-private repos. Retry, or post the comment without images.`,
            );
          const uploaded = uploadPrImages(args.images);
          const body = spliceImagesIntoMarkdown(args.comment, uploaded);
          const res = await postPrComment(selector, { body }, ghRepo);
          if ("error" in res)
            return text(
              `Posting the comment failed: ${res.error}. The ${uploaded.length} image(s) WERE staged and their URLs can be reused: ${uploaded.map((u) => u.url).join(" ")}`,
            );
          return text(
            `Comment posted${res.url ? `: ${res.url}` : ""} — ${uploaded.length} image(s) attached from ${configuredServer().publicBaseUrl}; they render inline via GitHub's image proxy.`,
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
