import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  setupRequest,
  type SetupGithub,
  type SetupIntegration,
  type SetupRepo,
  type SetupStatus,
} from "../components/setup-shared";
import { BASE_PATH } from "../lib/base";
import { toast } from "../ui/toast";

// GET /api/setup/status, plus the restart choreography every page built on it
// needs: credentials and enable flags are read on boot, so whichever page took
// the edit has to be the one that offers the restart. The Setup wizard and the
// Workspace settings pages that hold the same sections (Repositories, Members,
// Integrations, Identity) share this one controller, so they can't drift on
// what "saved" means or on which of them can bring the change into effect.

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export type RestartState = "idle" | "working" | "failed";

export interface SetupController {
  status: SetupStatus | null;
  /** The first load failed and there is nothing cached to show. */
  failed: boolean;
  refetch: () => Promise<void>;
  restartNeeded: boolean;
  restartState: RestartState;
  /** Mark a boot-time setting as saved so its surface offers a restart. */
  requireRestart: () => void;
  /** Restart the server, then poll until it answers. `post: false` only
   *  polls — the "Check again" path after a timeout. */
  restartServer: (post?: boolean) => Promise<void>;
  /** Fold a saved integration back into the cached status. */
  applyIntegration: (
    updated: SetupIntegration,
    restartRequired: boolean,
  ) => void;
  applyGithub: (updated: SetupGithub, restartRequired: boolean) => void;
  applyRepo: (
    updated: Pick<SetupRepo, "id"> &
      Partial<Pick<SetupRepo, "defaultBranch" | "isolatedWorktrees">>,
  ) => void;
}

export function useSetupStatus(): SetupController {
  const [status, setStatus] = useState<SetupStatus | null>(null);
  const [failed, setFailed] = useState(false);
  const [restartNeeded, setRestartNeeded] = useState(false);
  const [restartState, setRestartState] = useState<RestartState>("idle");
  const statusRef = useRef<SetupStatus | null>(null);
  useLayoutEffect(() => {
    statusRef.current = status;
  });
  // Stable identity: the body only reads refs and calls setters, so the
  // mount effect can list it without ever refiring, and callers outside
  // this hook can invoke the same fetch.
  const refetch = useCallback(async () => {
    await (async () => {
      const body = await setupRequest<SetupStatus>("/api/setup/status");
      setStatus(body);
      setFailed(false);
    })().catch(async () => {
      // A refetch that fails while a status is already on screen keeps the
      // stale one: better a slightly old page than an empty one.
      if (!statusRef.current) setFailed(true);
    });
  }, []);

  useEffect(() => {
    refetch();
  }, [refetch]);

  const applyIntegration = (
    updated: SetupIntegration,
    restartRequired: boolean,
  ) => {
    setStatus((s) =>
      s
        ? {
            ...s,
            integrations: s.integrations.map((i) =>
              i.id === updated.id ? updated : i,
            ),
          }
        : s,
    );
    if (restartRequired) setRestartNeeded(true);
  };

  const applyGithub = (updated: SetupGithub, restartRequired: boolean) => {
    setStatus((s) => (s ? { ...s, github: updated } : s));
    if (restartRequired) setRestartNeeded(true);
  };

  const applyRepo = (
    updated: Pick<SetupRepo, "id"> &
      Partial<Pick<SetupRepo, "defaultBranch" | "isolatedWorktrees">>,
  ) => {
    setStatus((s) =>
      s
        ? {
            ...s,
            repos: s.repos.map((repo) =>
              repo.id === updated.id ? { ...repo, ...updated } : repo,
            ),
          }
        : s,
    );
  };

  const requireRestart = () => setRestartNeeded(true);

  const restartServer = async (post = true) => {
    setRestartState("working");
    if (post) {
      await (async () => {
        const res = await fetch(`${BASE_PATH}/api/setup/restart`, {
          method: "POST",
        });
        // 409 = nothing would revive this process, so it refused. Say so
        // rather than polling a server that was never going to go down.
        if (res.status === 409) {
          const body = await res.json().catch(() => null);
          setRestartState("idle");
          toast(body?.error || "This server can't restart itself.");
          return;
        }
      })().catch(async () => {
        // The connection can drop as the server goes down — that's fine,
        // the health poll below is the real signal.
      });
    }
    const deadline = Date.now() + 30_000;
    await sleep(1000);
    while (Date.now() < deadline) {
      await (async () => {
        const res = await fetch(`${BASE_PATH}/api/health`, {
          cache: "no-store",
        });
        if (res.ok) {
          await refetch();
          setRestartNeeded(false);
          setRestartState("idle");
          toast("Server restarted. Changes applied.");
          return;
        }
      })().catch(async () => {});
      await sleep(1000);
    }
    setRestartState("failed");
  };

  return {
    status,
    failed,
    refetch,
    restartNeeded,
    restartState,
    requireRestart,
    restartServer,
    applyIntegration,
    applyGithub,
    applyRepo,
  };
}
