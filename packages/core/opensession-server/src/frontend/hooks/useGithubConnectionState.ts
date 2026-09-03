import { useEffect, useEffectEvent, useState } from "react";
import { z } from "zod";
import type { Route } from "../lib/app-route";
import { BASE_PATH } from "../lib/base";

export type GithubConnectionState =
  | "loading"
  | "connected"
  | "disconnected"
  | "unknown";

const githubConnectionResponseSchema = z.object({
  accounts: z.array(z.object({}).passthrough()).optional(),
});

/**
 * Whether this person has a GitHub account available to sessions. The
 * connections endpoint already scopes `accounts` to the current person in
 * multi-user mode and returns the sole shared account in local mode.
 */
export function useGithubConnectionState(
  refreshKey: Route["view"],
): GithubConnectionState {
  const [state, setState] = useState<GithubConnectionState>("loading");

  const refresh = useEffectEvent(async () => {
    await (async () => {
      const response = await fetch(`${BASE_PATH}/api/connections/github`);
      if (!response.ok)
        throw new Error(`GitHub connection check failed: ${response.status}`);
      const body = githubConnectionResponseSchema.parse(await response.json());
      setState(body.accounts?.length ? "connected" : "disconnected");
    })().catch(async () => {
      // Do not lock an existing local setup out of session creation when an
      // older server or a transient request failure cannot answer the check.
      setState("unknown");
    });
  });

  useEffect(() => {
    void refresh();
  }, [refreshKey]);

  return state;
}
