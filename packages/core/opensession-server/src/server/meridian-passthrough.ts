/**
 * The pure checkpoint state machine from Meridian's current source tree.
 *
 * Meridian publishes declarations for this leaf module but does not include an
 * importable JavaScript subpath in its npm package. `@rynfar/meridian-source`
 * therefore pins the same upstream release commit as the normal package and
 * lets the in-process provider execute the upstream implementation directly.
 * Updating that commit picks up checkpoint fixes without copying them here.
 * The relative path is intentional: Meridian's package export map blocks its
 * private `src/` subpaths, while this repo's private server package is always
 * installed from the workspace root.
 */
export {
  allForwardedCallsResolved,
  coalesceCompleteToolResultContinuation,
  createEarlyStopTracker,
  noteAssistantMessage,
  noteUserContent,
  settledToolCallAssistantUuid,
  shouldEarlyStop,
  type EarlyStopTracker,
} from "../../../../../node_modules/@rynfar/meridian-source/src/proxy/passthroughEarlyStop";
