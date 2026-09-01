/**
 * Linear agent webhook handlers for AgentSession and Issue events.
 */
import { linearEmailToGithubUsername } from "../../server/shared/user-mappings";
import { personaName } from "../../server/config";
import { worktreePathFor } from "../../server/worktree";
import {
  createAgentActivity,
  fetchLinearUser,
  getIssueDetails,
  getIssueStatus,
  issueHasPlan,
  moveToStatus,
  postComment,
  updateAgentSession,
} from "./api";
import type { LinearTokens } from "./oauth";
import { getValidToken } from "./oauth";
import {
  PLANNING_PROMPT,
  IMPLEMENTATION_PROMPT,
  PLANNING_CONTINUATION_PROMPT,
  GREETING_PROMPT,
  MESSAGES,
} from "./prompts";
import {
  activeSessions,
  processedSessions,
  buildParticipantSections,
  createPrWithAttribution,
  createWorktree,
  deleteSessionFile,
  deleteWorktree,
  formatConversationHistory,
  generateBranchName,
  loadSessionInfo,
  opensessionSessionUrl,
  runAgentHeadless,
  saveSessionInfo,
  type ActiveSession,
} from "./session";

// --- Webhook types ---

export interface AgentSessionWebhook {
  action: "created" | "updated" | "ended" | "dismissed" | "prompted";
  type: "AgentSession";
  organizationId: string;
  actor?: { id: string; name: string };
  agentSession: {
    id: string;
    status: string;
    issue: {
      id: string;
      identifier: string;
      title: string;
      description?: string;
      url: string;
    };
    comments?: Array<{ id: string; body: string }>;
  };
  agentActivity?: {
    signal?: string;
    userId?: string;
    content?: { type: string; body: string };
  };
}

export interface IssueWebhook {
  action: "create" | "update" | "remove";
  type: "Issue";
  organizationId: string;
  data: {
    id: string;
    identifier: string;
    title: string;
    description?: string;
    url: string;
    stateId?: string;
    assigneeId?: string;
  };
  updatedFrom?: {
    stateId?: string;
    assigneeId?: string;
  };
}

// In-flight guard for `prompted` webhooks, keyed by issue id. A redelivered or
// concurrent prompt would otherwise spawn a second query() resuming the SAME
// claudeSessionId in the same worktree — corrupting the turn. Parked on
// globalThis so a hot reload doesn't lose in-flight state.
const inFlightPrompts: Set<string> = ((
  globalThis as any
).__linearInFlightPrompts ??= new Set<string>());

// --- Issue status change → auto-implement ---

export async function handleIssueUpdate(
  webhook: IssueWebhook,
  tokens: LinearTokens,
): Promise<Response> {
  const { data: issue, organizationId, updatedFrom } = webhook;

  if (webhook.action !== "update") {
    return Response.json({ ok: true });
  }

  if (!updatedFrom?.stateId) {
    return Response.json({ ok: true });
  }

  const accessToken = await getValidToken(organizationId, tokens);
  if (!accessToken) {
    return Response.json({ error: "Not authorized" }, { status: 401 });
  }

  const details = await getIssueDetails(accessToken, issue.id);
  console.log(
    `[linear] Issue ${issue.identifier} status changed to: ${details.status}`,
  );

  if (details.status.toLowerCase() !== "in progress") {
    return Response.json({ ok: true });
  }

  // Check for existing session
  let existingSession: ActiveSession | undefined;
  for (const [, session] of activeSessions) {
    if (
      session.issueIdentifier === issue.identifier ||
      session.issueId === issue.id
    ) {
      existingSession = session;
      break;
    }
  }

  if (!existingSession) {
    const branch = generateBranchName(details.title, issue.identifier);
    const diskSession = await loadSessionInfo(branch);
    if (diskSession?.claudeSessionId) {
      existingSession = {
        ...diskSession,
        branch,
        accessToken,
        issueTitle: details.title,
        issueIdentifier: issue.identifier,
        issueId: issue.id,
        issueDescription: details.description,
        issueUrl: details.url,
        teamId: details.teamId,
        planningConversation: [],
        // The ticket is in progress, so direction was given long ago; only a
        // pending implementation confirmation survives the hydrate.
        phase:
          diskSession.phase === "awaiting_implementation"
            ? "awaiting_implementation"
            : "working",
        issueCreator: diskSession.issueCreator || details.creator || null,
      };
      if (diskSession.linearSessionId) {
        activeSessions.set(diskSession.linearSessionId, existingSession);
      }
    }
  }

  if (!existingSession) {
    return Response.json({ ok: true });
  }

  const hasPlan = await issueHasPlan(accessToken, issue.id);
  if (!hasPlan) {
    return Response.json({ ok: true });
  }

  console.log(
    `[linear] Auto-implementing ${issue.identifier} - has plan and moved to In Progress`,
  );

  if (existingSession.claudeSessionId) {
    existingSession.phase = "working";

    const { participantsSection, coAuthorInstruction } =
      buildParticipantSections(
        existingSession.participants || [],
        existingSession.lastActiveUser || null,
      );
    const implementationPrompt = IMPLEMENTATION_PROMPT.replaceAll(
      "$ISSUE_ID",
      issue.identifier,
    )
      .replaceAll("$ISSUE_URL", details.url)
      .replaceAll("$ISSUE_TITLE", details.title)
      .replaceAll("$ISSUE_DESCRIPTION", details.description)
      .replaceAll("$PARTICIPANTS_SECTION", participantsSection)
      .replaceAll("$CO_AUTHOR_INSTRUCTION", coAuthorInstruction);

    (async () => {
      try {
        if (existingSession!.linearSessionId) {
          await createAgentActivity(
            accessToken,
            existingSession!.linearSessionId,
            {
              type: "thought",
              body: `Auto-starting implementation (ticket moved to In Progress)`,
            },
          );
        }

        const { result, claudeSessionId } = await runAgentHeadless(
          existingSession!.worktreeDir,
          implementationPrompt,
          existingSession!.linearSessionId,
          accessToken,
          existingSession!.claudeSessionId || undefined,
          existingSession!,
        );

        existingSession!.claudeSessionId = claudeSessionId;

        await saveSessionInfo(existingSession!.branch, {
          claudeSessionId,
          issueIdentifier: issue.identifier,
          issueTitle: details.title,
          worktreeDir: existingSession!.worktreeDir,
          linearSessionId: existingSession!.linearSessionId,
          phase: existingSession!.phase,
          issueId: existingSession!.issueId,
          issueUrl: existingSession!.issueUrl,
          participants: existingSession!.participants,
          lastActiveUser: existingSession!.lastActiveUser,
          issueCreator: existingSession!.issueCreator,
          model: existingSession!.model,
        });

        if (
          result?.includes("IMPLEMENTATION_COMPLETE") &&
          existingSession!.linearSessionId
        ) {
          const creatorGithub = linearEmailToGithubUsername(
            existingSession!.issueCreator?.email || null,
          );
          const prUrl = await createPrWithAttribution(
            existingSession!.worktreeDir,
            issue.identifier,
            details.url,
            details.title,
            existingSession!.participants || [],
            creatorGithub,
          );

          await createAgentActivity(
            accessToken,
            existingSession!.linearSessionId,
            {
              type: "response",
              body: prUrl
                ? `Implementation complete! PR: ${prUrl}`
                : "Implementation complete! PR creation may have failed - please check manually.",
            },
          );
        }
      } catch (e) {
        console.error(
          `[linear] Error auto-implementing ${issue.identifier}:`,
          e,
        );
      }
    })();
  }

  return Response.json({ ok: true, autoImplementing: true });
}

// --- Agent session webhook ---

export async function handleAgentSession(
  webhook: AgentSessionWebhook,
  tokens: LinearTokens,
): Promise<Response> {
  const { agentSession, organizationId, action } = webhook;

  // Stop signal
  if (action === "prompted" && webhook.agentActivity?.signal === "stop") {
    console.log(
      `[linear] Stop signal for issue: ${agentSession.issue.identifier}`,
    );
    const session = activeSessions.get(agentSession.id);
    if (session) {
      if (session.abortController) {
        session.abortController.abort();
        session.abortController = undefined;
      }
    }
    return Response.json({ ok: true });
  }

  // Prompted — user sends message
  if (action === "prompted" && webhook.agentActivity?.content?.body) {
    const prompt = webhook.agentActivity.content.body;
    console.log(`[linear] Prompt from Linear: ${prompt.substring(0, 50)}...`);

    let session = activeSessions.get(agentSession.id);

    // Recover from disk
    if (!session) {
      const branch = await generateBranchName(
        agentSession.issue.title,
        agentSession.issue.identifier,
      );
      const diskSession = await loadSessionInfo(branch);
      if (diskSession) {
        console.log(
          `[linear] Recovered session from disk for branch: ${branch}`,
        );
        // Older sessions may predate external links — idempotent by url
        getValidToken(organizationId, tokens)
          .then((t) => {
            if (t) {
              updateAgentSession(t, agentSession.id, {
                addedExternalUrls: [
                  {
                    url: opensessionSessionUrl(branch),
                    label: `Open in ${personaName()}`,
                  },
                ],
              }).catch(() => {});
            }
          })
          .catch(() => {});
        session = {
          ...diskSession,
          branch,
          accessToken: "",
          issueTitle: agentSession.issue.title,
          issueId: agentSession.issue.id,
          issueDescription: agentSession.issue.description || "",
          issueUrl: agentSession.issue.url,
          teamId: "",
          linearSessionId: agentSession.id,
          planningConversation: [],
        };
        activeSessions.set(agentSession.id, session);
      }
    }

    if (session) {
      if (!session.participants) session.participants = [];

      const accessToken = await getValidToken(organizationId, tokens);
      if (accessToken) {
        session.accessToken = accessToken;

        if (!session.teamId) {
          const { teamId } = await getIssueStatus(accessToken, session.issueId);
          session.teamId = teamId;
        }

        // Track participant
        const promptUserId = webhook.agentActivity?.userId;
        if (promptUserId) {
          const existingIdx = session.participants.findIndex(
            (p) => p.id === promptUserId,
          );
          if (existingIdx === -1) {
            const userParticipant = await fetchLinearUser(
              accessToken,
              promptUserId,
            );
            if (userParticipant) {
              session.participants.push(userParticipant);
              session.lastActiveUser = userParticipant;
            }
          } else {
            session.lastActiveUser = session.participants[existingIdx];
          }
        }

        let effectivePrompt = prompt;

        // Initial direction routing
        if (session.phase === "awaiting_direction") {
          const lowerPrompt = prompt.toLowerCase().trim();

          if (lowerPrompt.includes("plan")) {
            session.phase = "planning";
            effectivePrompt = PLANNING_PROMPT.replaceAll(
              "$ISSUE_ID",
              session.issueIdentifier,
            )
              .replaceAll("$ISSUE_URL", session.issueUrl)
              .replaceAll("$ISSUE_TITLE", session.issueTitle)
              .replaceAll(
                "$ISSUE_DESCRIPTION",
                session.issueDescription || "(No description)",
              );

            await createAgentActivity(accessToken, agentSession.id, {
              type: "thought",
              body: "Starting planning interview...",
            });
          } else if (lowerPrompt.includes("implement")) {
            session.phase = "working";
            await moveToStatus(
              accessToken,
              session.issueId,
              session.teamId,
              "In Progress",
            );

            const { participantsSection, coAuthorInstruction } =
              buildParticipantSections(
                session.participants || [],
                session.lastActiveUser || null,
              );
            effectivePrompt = IMPLEMENTATION_PROMPT.replaceAll(
              "$ISSUE_ID",
              session.issueIdentifier,
            )
              .replaceAll("$ISSUE_URL", session.issueUrl)
              .replaceAll("$ISSUE_TITLE", session.issueTitle)
              .replaceAll(
                "$ISSUE_DESCRIPTION",
                session.issueDescription || "(No description)",
              )
              .replaceAll("$PARTICIPANTS_SECTION", participantsSection)
              .replaceAll("$CO_AUTHOR_INSTRUCTION", coAuthorInstruction);

            await createAgentActivity(accessToken, agentSession.id, {
              type: "thought",
              body: MESSAGES.implementationStarted,
            });
          } else {
            session.phase = "working";
            effectivePrompt = `You are ${personaName()}, working on Linear ticket ${session.issueIdentifier} (${session.issueUrl}).

**Title:** ${session.issueTitle}
**Description:** ${session.issueDescription}

The user said: "${prompt}"

Help with whatever they're asking. You have a worktree ready at ${session.worktreeDir}.`;
          }
        }

        // Implementation confirmation
        else if (session.phase === "awaiting_implementation") {
          session.phase = "working";
          const { participantsSection, coAuthorInstruction } =
            buildParticipantSections(
              session.participants || [],
              session.lastActiveUser || null,
            );
          effectivePrompt = IMPLEMENTATION_PROMPT.replaceAll(
            "$ISSUE_ID",
            session.issueIdentifier,
          )
            .replaceAll("$ISSUE_URL", session.issueUrl)
            .replaceAll("$ISSUE_TITLE", session.issueTitle)
            .replaceAll("$ISSUE_DESCRIPTION", session.issueDescription)
            .replaceAll("$PARTICIPANTS_SECTION", participantsSection)
            .replaceAll("$CO_AUTHOR_INSTRUCTION", coAuthorInstruction);

          await moveToStatus(
            accessToken,
            session.issueId,
            session.teamId,
            "In Progress",
          );
          await createAgentActivity(accessToken, agentSession.id, {
            type: "thought",
            body: MESSAGES.implementationStarted,
          });
        }

        // Planning continuation
        if (
          session.phase === "planning" &&
          session.planningConversation.length > 0
        ) {
          session.planningConversation.push({
            role: "user",
            content: prompt,
            timestamp: new Date().toISOString(),
          });
          effectivePrompt = PLANNING_CONTINUATION_PROMPT.replaceAll(
            "$ISSUE_ID",
            session.issueIdentifier,
          )
            .replaceAll(
              "$CONVERSATION_HISTORY",
              formatConversationHistory(
                session.planningConversation.slice(0, -1),
              ),
            )
            .replaceAll("$LATEST_RESPONSE", prompt);
        }

        // Run Claude in background — at most one run per issue. Check-and-set
        // is synchronous, so two concurrent/redelivered prompts can't both
        // start a query() resuming the same claudeSessionId in this worktree.
        const s = session;
        const issueId = agentSession.issue.id;
        if (inFlightPrompts.has(issueId)) {
          console.log(
            `[linear] Refusing concurrent prompt for ${s.issueIdentifier} — a run is already in flight`,
          );
          await createAgentActivity(accessToken, agentSession.id, {
            type: "response",
            body: "I'm still working on the previous message for this issue — I can only run one turn at a time. Please wait for it to finish (or send a stop signal), then prompt me again.",
          }).catch(() => {});
          return Response.json({ ok: true, busy: true });
        }
        inFlightPrompts.add(issueId);
        (async () => {
          try {
            const { result, claudeSessionId } = await runAgentHeadless(
              s.worktreeDir,
              effectivePrompt,
              agentSession.id,
              accessToken,
              s.claudeSessionId || undefined,
              s,
            );

            s.claudeSessionId = claudeSessionId;

            await saveSessionInfo(s.branch, {
              claudeSessionId,
              issueIdentifier: s.issueIdentifier,
              issueTitle: s.issueTitle,
              worktreeDir: s.worktreeDir,
              linearSessionId: s.linearSessionId,
              phase: s.phase,
              issueId: s.issueId,
              issueUrl: s.issueUrl,
              participants: s.participants,
              lastActiveUser: s.lastActiveUser,
              issueCreator: s.issueCreator,
              model: s.model,
            });

            if (result) {
              if (
                result.includes("PLANNING_COMPLETE") &&
                s.phase === "planning"
              ) {
                const planMatch = result.split("PLANNING_COMPLETE")[0].trim();
                if (planMatch) {
                  await postComment(
                    accessToken,
                    s.issueId,
                    `# Implementation Plan\n\n${planMatch}`,
                  );
                }

                await moveToStatus(accessToken, s.issueId, s.teamId, "Ready");
                s.planningConversation = [];
                s.phase = "awaiting_implementation";

                await saveSessionInfo(s.branch, {
                  claudeSessionId: s.claudeSessionId,
                  issueIdentifier: s.issueIdentifier,
                  issueTitle: s.issueTitle,
                  worktreeDir: s.worktreeDir,
                  linearSessionId: s.linearSessionId,
                  phase: s.phase,
                  issueId: s.issueId,
                  issueUrl: s.issueUrl,
                  participants: s.participants,
                  lastActiveUser: s.lastActiveUser,
                  issueCreator: s.issueCreator,
                  model: s.model,
                });

                await createAgentActivity(accessToken, agentSession.id, {
                  type: "elicitation",
                  body: `${MESSAGES.planningComplete}\n\nReply when you're ready and I'll start implementing.`,
                });
              } else if (result.includes("IMPLEMENTATION_COMPLETE")) {
                const creatorGithub = linearEmailToGithubUsername(
                  s.issueCreator?.email || null,
                );
                const prUrl = await createPrWithAttribution(
                  s.worktreeDir,
                  s.issueIdentifier,
                  s.issueUrl,
                  s.issueTitle,
                  s.participants || [],
                  creatorGithub,
                );

                await createAgentActivity(accessToken, agentSession.id, {
                  type: "response",
                  body: prUrl
                    ? `Implementation complete! PR: ${prUrl}`
                    : "Implementation complete! PR creation may have failed - please check manually.",
                });
              } else {
                if (s.phase === "planning") {
                  s.planningConversation.push({
                    role: "agent",
                    content: result,
                    timestamp: new Date().toISOString(),
                  });
                }
                // Planning-interview turns are questions by design → elicitation
                // (Linear prompts the user to answer); runner failures → error.
                const type =
                  s.phase === "planning"
                    ? "elicitation"
                    : result.startsWith("Error:")
                      ? "error"
                      : "response";
                await createAgentActivity(accessToken, agentSession.id, {
                  type,
                  body: result,
                });
              }
            }
          } catch (e) {
            console.error(`[linear] Error running Claude for prompt:`, e);
            await createAgentActivity(accessToken, agentSession.id, {
              type: "error",
              body: `${e}`,
            });
          } finally {
            inFlightPrompts.delete(issueId);
          }
        })();
      }
    } else {
      console.log(`[linear] No active session found for ${agentSession.id}`);
    }
    return Response.json({ ok: true });
  }

  // Dismissed/ended — cleanup
  if (action === "dismissed" || action === "ended") {
    console.log(
      `[linear] Session ${action} for issue: ${agentSession.issue.identifier}`,
    );
    const branch = await generateBranchName(
      agentSession.issue.title,
      agentSession.issue.identifier,
    );
    try {
      deleteWorktree(branch);
      deleteSessionFile(branch);
      activeSessions.delete(agentSession.id);
    } catch (e) {
      console.log(`[linear] Could not delete worktree ${branch}: ${e}`);
    }
    return Response.json({ ok: true });
  }

  // Created — new session
  if (action !== "created") {
    return Response.json({ ok: true });
  }

  const sessionId = agentSession.id;
  if (processedSessions.has(sessionId)) {
    return Response.json({ ok: true, skipped: true });
  }
  processedSessions.add(sessionId);
  setTimeout(() => processedSessions.delete(sessionId), 5 * 60 * 1000);

  const accessToken = await getValidToken(organizationId, tokens);
  if (!accessToken) {
    return Response.json({ error: "Not authorized" }, { status: 401 });
  }

  const { issue } = agentSession;
  console.log(
    `[linear] New session for issue: ${issue.identifier} - ${issue.title}`,
  );

  await createAgentActivity(accessToken, agentSession.id, {
    type: "thought",
    body: MESSAGES.starting,
  });

  const { teamId } = await getIssueStatus(accessToken, issue.id);
  const issueDetails = await getIssueDetails(accessToken, issue.id);

  const branch = await generateBranchName(issue.title, issue.identifier);
  const worktreeDir = worktreePathFor(branch);

  const session: ActiveSession = {
    branch,
    claudeSessionId: null,
    accessToken,
    issueTitle: issue.title,
    issueIdentifier: issue.identifier,
    issueId: issue.id,
    issueDescription: issue.description || "",
    issueUrl: issue.url,
    teamId,
    worktreeDir,
    linearSessionId: agentSession.id,
    phase: "awaiting_direction",
    planningConversation: [],
    participants: [],
    lastActiveUser: null,
    issueCreator: issueDetails.creator,
  };
  activeSessions.set(agentSession.id, session);

  (async () => {
    try {
      await createWorktree(
        branch,
        issue.identifier,
        issue.title,
        issue.description || "",
        issue.url,
      );

      await saveSessionInfo(branch, {
        claudeSessionId: null,
        issueIdentifier: issue.identifier,
        issueTitle: issue.title,
        worktreeDir,
        linearSessionId: agentSession.id,
        phase: session.phase,
        issueId: issue.id,
        issueUrl: issue.url,
        participants: session.participants,
        lastActiveUser: session.lastActiveUser,
        issueCreator: session.issueCreator,
        model: session.model,
      });

      // Link the Linear session to the web UI session viewer
      updateAgentSession(accessToken, agentSession.id, {
        addedExternalUrls: [
          {
            url: opensessionSessionUrl(branch),
            label: `Open in ${personaName()}`,
          },
        ],
      }).catch(() => {});

      const greeting = GREETING_PROMPT.replaceAll(
        "$ISSUE_ID",
        issue.identifier,
      ).replaceAll("$ISSUE_TITLE", issue.title);

      // The greeting asks for direction (plan/implement/other) → elicitation
      await createAgentActivity(accessToken, agentSession.id, {
        type: "elicitation",
        body: greeting,
      });
    } catch (e) {
      console.error(`[linear] Error in session creation:`, e);
      await createAgentActivity(accessToken, agentSession.id, {
        type: "error",
        body: `${MESSAGES.error} Failed to initialize: ${e}`,
      });
    }
  })();

  return Response.json({ ok: true, branch });
}
