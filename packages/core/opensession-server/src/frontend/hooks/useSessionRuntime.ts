import { useReducer } from "react";
import {
  initialSessionRuntimeState,
  sessionRuntimeReducer,
  type SessionRuntimeSeed,
} from "../lib/session-runtime";

export function useSessionRuntime(seed: SessionRuntimeSeed) {
  return useReducer(sessionRuntimeReducer, seed, initialSessionRuntimeState);
}
