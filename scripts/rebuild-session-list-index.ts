/** Rebuild the materialized session-list index from authoritative sources. */

import { getAllSessions } from "../packages/core/opensession-server/src/server/sessions";
import {
  closeSessionListIndex,
  indexedCount,
  rebuildSessionListIndex,
} from "../packages/core/opensession-server/src/server/session-list-store";

const startedAt = Date.now();
const sessions = getAllSessions("include");
await rebuildSessionListIndex(sessions);
console.log(
  `Indexed ${await indexedCount()} sessions in ${Date.now() - startedAt}ms`,
);
closeSessionListIndex();
