/** ChatGPT subscription account selection and Pi credential seeding. */
import { existsSync, readFileSync } from "fs";
import {
  getCodexAccountById,
  getUsableCodexAccountById,
  pickCodexAccount,
  listCodexAccounts,
  type CodexAccount,
} from "./codex-accounts";
import { userMatchesAny } from "./shared/user-mappings";

function jwtExpMs(jwt: string): number | null {
  try {
    const payload = jwt.split(".")[1];
    if (!payload) return null;
    const claims = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf-8"),
    );
    return typeof claims.exp === "number" ? claims.exp * 1000 : null;
  } catch {
    return null;
  }
}

export function maskOpenaiAccount(account: CodexAccount): string {
  return `${account.name} (${account.id.slice(0, 8)}, ${account.kind})`;
}

export function pickOpenaiAccount(
  model: string,
  ids?: string[],
  sessionKey?: string,
  out?: { reason?: string },
  user?: string,
  pinnedId?: string,
  strict?: boolean,
  exclude?: ReadonlySet<string>,
): CodexAccount | { error: string } {
  const all = listCodexAccounts();
  if (!all.length) {
    return {
      error: "no ChatGPT subscription or API-key accounts are configured",
    };
  }
  const allowedOwner = (account: CodexAccount) =>
    !account.owner || (!!user && userMatchesAny(user, [account.owner]));
  const designated = (id: string) => !ids?.length || ids.includes(id);
  const eligible = (id: string) => !exclude?.has(id);
  if (pinnedId && eligible(pinnedId)) {
    const pinned = getUsableCodexAccountById(pinnedId, model);
    if (pinned && allowedOwner(pinned) && designated(pinnedId)) {
      if (out) out.reason = "pinned";
      return pinned;
    }
    if (strict) {
      const name = getCodexAccountById(pinnedId)?.name || pinnedId;
      return {
        error: `pinned account ${name} is not currently usable (hard pin — not falling back to the pool)`,
      };
    }
  }
  if (ids?.length) {
    for (const id of ids) {
      if (!eligible(id)) continue;
      const account = getUsableCodexAccountById(id, model);
      if (account && allowedOwner(account)) {
        if (out) out.reason = "designated";
        return account;
      }
    }
    return {
      error: `no designated ChatGPT account is usable (${ids.join(", ")})`,
    };
  }
  const picked = pickCodexAccount(
    exclude ? new Set(exclude) : undefined,
    model,
    sessionKey,
    out,
    user,
  );
  return picked || { error: "no usable ChatGPT account is available" };
}

const MANAGED_REFRESH_PLACEHOLDER = "codex-managed-no-refresh";

export interface SeededOpenaiAuth {
  openai: {
    type: "oauth";
    access: string;
    refresh: string;
    expires: number;
    accountId?: string;
  };
}

/** Build the access-token-only credential Pi's in-memory store consumes.
 * Remote sandboxes receive a rotation-proof per-account seed directory rather
 * than the host's CODEX_HOME path. The launcher points this process at that
 * directory with OPENSESSION_OPENAI_SEED_DIR. */
export function buildSeededOpenaiAuth(
  account: CodexAccount,
  seedRoot = process.env.OPENSESSION_OPENAI_SEED_DIR?.trim(),
): { seeded: SeededOpenaiAuth } | { error: string } {
  const srcPath = seedRoot
    ? openaiSeedAuthPath(seedRoot, account.id)
    : `${account.value}/auth.json`;
  if (!existsSync(srcPath)) {
    return {
      error: `ChatGPT account "${account.name}" has no auth.json at ${srcPath}`,
    };
  }
  let src: any;
  try {
    src = JSON.parse(readFileSync(srcPath, "utf-8"));
  } catch (error: any) {
    return { error: `failed to read ${srcPath}: ${error?.message || error}` };
  }
  // Host CODEX_HOME files use tokens.*, while remote sandbox seed files use
  // the already-normalized openai.* shape produced below. Supporting both is
  // what keeps the remote copy rotation-proof without copying refresh tokens.
  const access = src?.openai?.access ?? src?.tokens?.access_token;
  const accountId = src?.openai?.accountId ?? src?.tokens?.account_id;
  if (!access || typeof access !== "string") {
    return { error: `ChatGPT account "${account.name}" has no access token` };
  }
  const expires =
    typeof src?.openai?.expires === "number"
      ? src.openai.expires
      : jwtExpMs(access);
  if (expires !== null && expires <= Date.now()) {
    return {
      error: `ChatGPT account "${account.name}" has an expired access token`,
    };
  }
  return {
    seeded: {
      openai: {
        type: "oauth",
        access,
        refresh: MANAGED_REFRESH_PLACEHOLDER,
        expires: expires ?? Date.now() + 3_600_000,
        ...(accountId ? { accountId } : {}),
      },
    },
  };
}

const OPENAI_FAST_MODE_MODELS = new Set([
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
]);

/** ChatGPT subscription models whose backend accepts the priority service tier. */
export function supportsOpenaiFastMode(model?: string): boolean {
  if (!model) return false;
  const id = model.replace(/^pi\/openai\//, "").replace(/^openai\//, "");
  return OPENAI_FAST_MODE_MODELS.has(id);
}

/** Make Pi's final ChatGPT Codex payload use the priority service tier. */
export function enableOpenaiFastMode<TModel>(agent: {
  onPayload?: (payload: unknown, model: TModel) => unknown | Promise<unknown>;
}): void {
  const baseOnPayload = agent.onPayload;
  agent.onPayload = async (payload, model) => {
    const transformed = await baseOnPayload?.(payload, model);
    const finalPayload = transformed ?? payload;
    if (
      !finalPayload ||
      typeof finalPayload !== "object" ||
      Array.isArray(finalPayload)
    ) {
      return finalPayload;
    }
    return { ...finalPayload, service_tier: "priority" };
  };
}

export function openaiSeedAuthPath(
  seedRoot: string,
  accountId: string,
): string {
  return `${seedRoot}/${accountId}/auth.json`;
}

/** Build the least-privilege credential slice uploaded to a remote sandbox.
 * API-key accounts keep their key because Pi can use it through the standard
 * OpenAI provider. Home accounts replace their host CODEX_HOME with an inert
 * guest value and receive a separate access-token-only OAuth seed. */
export function buildOpenaiRemoteSeedUpload(
  accounts: CodexAccount[],
  restrictIds?: string[],
  user?: string,
): {
  accounts: CodexAccount[];
  seeds: Array<{ accountId: string; content: string }>;
  skipped: Array<{ account: CodexAccount; reason: string }>;
} {
  const allowedOwner = (account: CodexAccount) =>
    !account.owner || (!!user && userMatchesAny(user, [account.owner]));
  const eligible = (
    restrictIds?.length
      ? restrictIds
          .map((id) => accounts.find((account) => account.id === id))
          .filter((account): account is CodexAccount => !!account)
      : accounts
  ).filter(allowedOwner);
  const selected: CodexAccount[] = [];
  const seeds: Array<{ accountId: string; content: string }> = [];
  const skipped: Array<{ account: CodexAccount; reason: string }> = [];
  for (const account of eligible) {
    // Construct the guest record field by field. The account store is loaded
    // from JSON, so spreading it here would let an unknown future host field
    // silently cross the remote trust boundary.
    const projected: CodexAccount = {
      id: account.id,
      name: account.name,
      kind: account.kind,
      value:
        account.kind === "api_key" ? account.value : "opensession-remote-seed",
      ...(account.owner ? { owner: account.owner } : {}),
      createdAt: account.createdAt,
    };
    if (account.kind === "api_key") {
      selected.push(projected);
      continue;
    }
    const built = buildSeededOpenaiAuth(account);
    if ("error" in built) {
      skipped.push({ account, reason: built.error });
      continue;
    }
    selected.push(projected);
    seeds.push({
      accountId: account.id,
      content: JSON.stringify(built.seeded),
    });
  }
  return { accounts: selected, seeds, skipped };
}
