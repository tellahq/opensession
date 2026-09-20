import { deferred, deferredExport } from "./deferred";

/*
 * The route panes AppContent mounts, each loaded the first time it is opened
 * instead of at boot. Everything but onboarding shares one chunk (panes.ts):
 * a chunk per pane multiplied the shared chunks the entry preloads (17 became
 * 91), and once a person opens one pane the rest are a click away, so they
 * fetch together and cache once. Onboarding is its own chunk: it is seen once
 * per install and never again.
 */
export const FirstMile = deferred(() =>
  import("./FirstMile").then((m) => m.FirstMile),
);

const panes = () => import("./panes");

export const Analytics = deferredExport(panes, "Analytics");
export const Archived = deferredExport(panes, "Archived");
export const Automations = deferredExport(panes, "Automations");
export const CatchUpDeck = deferredExport(panes, "CatchUpDeck");
export const Databases = deferredExport(panes, "Databases");
export const Feed = deferredExport(panes, "Feed");
export const Goals = deferredExport(panes, "Goals");
export const Issues = deferredExport(panes, "Issues");
export const Prs = deferredExport(panes, "Prs");
export const Reports = deferredExport(panes, "Reports");
export const Reviews = deferredExport(panes, "Reviews");
export const Security = deferredExport(panes, "Security");
export const SupportInbox = deferredExport(panes, "SupportInbox");
export const SupportPreview = deferredExport(panes, "SupportPreview");
export const SupportTinder = deferredExport(panes, "SupportTinder");
export const Tasks = deferredExport(panes, "Tasks");
export const WorkspacePane = deferredExport(panes, "WorkspacePane");
