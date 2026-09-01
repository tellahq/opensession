/** Rebuild the materialized session-list index from authoritative sources. */

import { getAllSessions } from "../packages/core/opensession-server/src/server/sessions";
import {
  rebuildSessionListIndex,
  sessionListStore,
} from "../packages/core/opensession-server/src/server/session-list-store";

const startedAt = Date.now();
const sessions = getAllSessions("include");
rebuildSessionListIndex(sessions);
const store = sessionListStore();
console.log(`Indexed ${store.count()} sessions in ${Date.now() - startedAt}ms`);
store.close();
