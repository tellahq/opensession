/**
 * Ordered HTTP route handler chain. Handlers are grouped by domain; a handler
 * returns undefined to fall through. Order across modules is free because the
 * path families are disjoint — order WITHIN a family (e.g. /todos/search
 * before /todos/:id) is preserved inside its module. The WebSocket upgrade,
 * run-ws upgrades, SPA fallback and 404 stay in opensession.ts's fetch tail.
 */

import type { RouteHandler } from "./context";
import { handleAuthRoutes } from "./auth";
import { handleMediaRoutes } from "./media";
import { handleStaticAssetsRoutes } from "./static-assets";
import { handlePlainRoutes } from "./plain";
import { handleFeedsRoutes } from "./feeds";
import { handleSlackChannelRoutes } from "./slack-channels";
import { handleSlackComposeRoutes } from "./slack-compose";
import { handleSystemRoutes } from "./system";
import { handleSessionAssetsRoutes } from "./session-assets";
import { handleSessionNotesRoutes } from "./session-notes";
import { handleSessionContextRoutes } from "./session-context";
import { handleEffectiveConfigRoutes } from "./effective-config";
import { handleMentionsRoutes } from "./mentions";
import { handleMentionPaletteRoutes } from "./mention-palette";
import { handleSandboxRoutes } from "./sandbox";
import { handleSandboxesRoutes } from "./sandboxes";
import { handleSessionsRoutes } from "./sessions";
import { handleShippedChangeRoutes } from "./shipped-changes";
import { handlePrRoutes } from "./pr";
import { handleSessionGitRoutes } from "./session-git";
import { handleSessionBranchRoutes } from "./session-branch";
import { handlePreviewRoutes } from "./preview";
import { handleWorkspaceRoutes } from "./workspace";
import { handleAutomationsRoutes } from "./automations";
import { handleHumanAsksRoutes } from "./human-asks";
import { handleKeychainRoutes } from "./keychain";
import { handleDeployRoutes } from "./deploys";
import { handlePeopleRoutes } from "./people";
import { handleMemoryRoutes } from "./memory";
import { handlePrefsRoutes } from "./prefs";
import { handleProfileRoutes } from "./profile";
import { handleSecurityRoutes } from "./security";
import { handleGoalsRoutes } from "./goals";
import { handleConnectionsRoutes } from "./connections";
import { handleAccountsRoutes } from "./accounts";
import { handleModelsRoutes } from "./models";
import { handleRunnersRoutes } from "./runners";
import { handlePapercutsRoutes } from "./papercuts";
import { handleLibraryRoutes } from "./library";
import { handleTodosRoutes } from "./todos";
import { handleDeskVoiceRoutes } from "./desk-voice";
import { handleWorkflowsRoutes } from "./workflows";
import { handleReportsRoutes } from "./reports";
import { handleAnalyticsRoutes } from "./analytics";
import { handleSearchRoutes } from "./search";
import { handleSetupRoutes } from "./setup";
import { handleOs1UpdateRoutes } from "./os1-update";
import { handleInstanceSettingsRoutes } from "./instance-settings";
import { handleLiveActivityRoutes } from "./live-activities";
import { handleIngressRoutes } from "./ingress";

export type { RouteContext, RouteHandler } from "./context";

export const routeHandlers: RouteHandler[] = [
  // First: the sign-in endpoints are exempt from the auth gate (which runs
  // before dispatch in opensession.ts) and must never be shadowed.
  handleAuthRoutes,
  handleMediaRoutes,
  handleStaticAssetsRoutes,
  handlePlainRoutes,
  handleFeedsRoutes,
  handleSlackChannelRoutes,
  handleSlackComposeRoutes,
  handleSystemRoutes,
  handleOs1UpdateRoutes,
  handleLiveActivityRoutes,
  handleIngressRoutes,
  // Before the generic session routes: /api/sessions/:id/assets* and
  // /api/sessions/:id/notes are inside their path family and must not be
  // swallowed by broader matches.
  handleSessionAssetsRoutes,
  handleSessionNotesRoutes,
  handleSessionContextRoutes,
  handleEffectiveConfigRoutes,
  handleMentionsRoutes,
  handleMentionPaletteRoutes,
  handleSandboxesRoutes,
  handleSandboxRoutes,
  handleShippedChangeRoutes,
  handleSessionsRoutes,
  handlePrRoutes,
  handleSessionGitRoutes,
  handleSessionBranchRoutes,
  handlePreviewRoutes,
  handleWorkspaceRoutes,
  handleAutomationsRoutes,
  handleHumanAsksRoutes,
  handleKeychainRoutes,
  handleDeployRoutes,
  handlePeopleRoutes,
  handleMemoryRoutes,
  handlePrefsRoutes,
  handleProfileRoutes,
  handleSecurityRoutes,
  handleGoalsRoutes,
  handleConnectionsRoutes,
  handleAccountsRoutes,
  handleModelsRoutes,
  handleRunnersRoutes,
  handlePapercutsRoutes,
  handleLibraryRoutes,
  handleTodosRoutes,
  handleDeskVoiceRoutes,
  handleWorkflowsRoutes,
  handleReportsRoutes,
  handleAnalyticsRoutes,
  handleSearchRoutes,
  handleSetupRoutes,
  handleInstanceSettingsRoutes,
];
