import type { NewSessionPrefill } from "./new-session-link";
import type { PortalTarget } from "./portals";
import type { ReviewQueueItem } from "./review-queue";
import type { SettingsSectionKey } from "./settings-sections";
import type {
  FeedDescriptor,
  FeedItem,
  SupportThread,
  UnifiedSession,
} from "./types";

export type NavigationNewSessionMode = "share" | "stack" | "ask";

export interface NavigationMorphOrigin {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface NavigationReportTarget {
  automationId: string;
  reportId: string;
}

export interface NavigationActions {
  goBack(): void;
  openNextChat(): void;

  openPrs(): void;
  openFeed(): void;
  openSettings(section?: SettingsSectionKey): void;
  openTasks(): void;
  openAutomation(name: string): void;
  openPrItem(item: ReviewQueueItem): Promise<void>;
  openPlain(): void;
  openSupportTinder(): void;
  openReports(target?: NavigationReportTarget): void;
  openAnalytics(): void;
  openArchived(): void;
  openCatchUp(): void;

  openSession(id: string, created?: UnifiedSession | null): void;
  openWorkspace(id: string, preferredSessionId?: string): void;
  openSessionReview(session: UnifiedSession): void;
  openTicket(ticket: SupportThread): Promise<void>;
  openFeedItem(feed: FeedDescriptor, item: FeedItem): Promise<void>;
  openPr(repo: string, branch: string): void;

  openNewWorkspace(): void;
  openNewSessionInRepo(repo: string): void;
  openDraft(): void;
  openNewSessionInWorkspace(
    mode: NavigationNewSessionMode,
    origin?: NavigationMorphOrigin,
  ): Promise<void>;
  duplicateSession(): Promise<void>;
  startNewChat(session: UnifiedSession, prompt: string): void;
  openPrefilledSession(prefill: NewSessionPrefill): void;

  openReview(): void;
  openStaging(): void;
  openPreview(): void;
  openPortal(target: PortalTarget): void;
  openAssets(): void;
  openTerminal(): void;
  openCurrentWorkspace(): void;
}
