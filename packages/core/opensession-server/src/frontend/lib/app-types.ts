import type { NewSessionCreateDraft } from "../components/NewSession";

export type PendingCreateDraft = NewSessionCreateDraft & {
  startedAt: string;
  user: string;
  originPath: string;
};

export interface AppProps {
  serviceWorker?: boolean;
  initialTeamViewing?: Array<{ user: string; sessionId: string }>;
}
