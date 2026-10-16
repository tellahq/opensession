/** Synthetic-only, memory-only test wiring. No live fetch or filesystem. */
import { PERSONAL_CONNECTION_DISCLOSURE } from "./disclosure";
import { generateKeyPairSync } from "node:crypto";
import {
  createPersonalGithubApi,
  type PersonalGithubTransport,
} from "./github-api";
import {
  createPersonalGithubBrokerCore,
  type PersonalBrokerStore,
  type StoredPersonalApp,
} from "./broker-core";
import { createBrokerPersonalGithubEngine } from "./engine";
import { PERSONAL_MANIFEST_OPERATION } from "./manifest";

export function syntheticFixture() {
  let time = 1_800_000_000_000;
  const records = new Map<number, StoredPersonalApp>();
  const lanes = new Map<string, { tail: Promise<void>; size: number }>();
  let failWrite = false;
  let failRevocation = false;
  const revocations: string[] = [];
  const store: PersonalBrokerStore = {
    async read(owner) {
      return structuredClone(records.get(owner) ?? null);
    },
    async compareAndSet(owner, rev, next) {
      if (failWrite) throw new Error("secret must never be shown");
      const current = records.get(owner);
      if ((current?.rev ?? null) !== rev) return false;
      if (next) {
        if (
          [...records.values()].some(
            (r) =>
              r.app.ownerGithubAccountId !== owner &&
              r.app.githubAppId === next.app.githubAppId,
          )
        )
          return false;
        records.set(owner, structuredClone(next));
      } else records.delete(owner);
      return true;
    },
    async withLock<T>(key: string, work: () => Promise<T>): Promise<T> {
      const lane = lanes.get(key) ?? { tail: Promise.resolve(), size: 0 };
      if (lane.size >= 16) throw new Error("Synthetic lane full");
      const previous = lane.tail;
      let release!: () => void;
      lane.tail = new Promise<void>((resolve) => {
        release = resolve;
      });
      lane.size++;
      lanes.set(key, lane);
      await previous;
      try {
        return await work();
      } finally {
        release();
        if (--lane.size === 0) lanes.delete(key);
      }
    },
  };
  const pem = generateKeyPairSync("rsa", { modulusLength: 2048 })
    .privateKey.export({ type: "pkcs8", format: "pem" })
    .toString();
  const calls: { url: string; method: string; body?: string; auth?: string }[] =
    [];
  let handler: PersonalGithubTransport = async () => {
    throw new Error("No synthetic response configured");
  };
  const api = createPersonalGithubApi({
    transport: async (url, init) => {
      calls.push({
        url,
        method: init.method,
        body: init.body,
        auth: init.headers.Authorization,
      });
      if (init.redirect !== "error") throw new Error("Redirect policy missing");
      return handler(url, init);
    },
  });
  const authority = Object.freeze({
    kind: "synthetic" as const,
    description: "Synthetic memory test only",
  });
  const broker = createPersonalGithubBrokerCore({
    store,
    api,
    authority,
    now: () => time,
    revocations: {
      async revoke(ref) {
        revocations.push(`revoke:${ref.ownerGithubAccountId}:${ref.recordId}`);
        if (failRevocation) throw new Error("Revocation not acknowledged");
      },
      async reconcile(ref, installation, ids, revision) {
        revocations.push(
          `reconcile:${ref.ownerGithubAccountId}:${installation}:${ids.join(",")}:${revision}`,
        );
      },
    },
  });
  const admission = {
    admit: (candidate: unknown, candidateBroker: unknown) =>
      candidate === authority && candidateBroker === broker,
  };
  const rawEngine = createBrokerPersonalGithubEngine({
    broker,
    api,
    admission,
    now: () => time,
  });
  const engine = {
    ...rawEngine,
    async beginManifest(
      context: Parameters<typeof rawEngine.beginManifest>[0],
    ) {
      const ack = await rawEngine.acknowledgeDisclosure(context, {
        version: PERSONAL_CONNECTION_DISCLOSURE.version,
        accepted: true,
      });
      return rawEngine.beginManifest(
        context,
        ack.ok ? ack.disclosureReceipt : undefined,
      );
    },
  };
  const context = (owner = 11) => ({
    ownerGithubAccountId: owner,
    origin: "https://os.example.test",
    browserSessionId: `session-${owner}`,
  });
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status });
  const converted = (name: string, owner = 11, appId = owner * 10) => ({
    name,
    id: appId,
    slug: `personal-${owner}`,
    client_id: `client-${appId}`,
    client_secret: `secret-${appId}`,
    pem,
    owner: { id: owner, login: `person-${owner}`, type: "User" },
    events: [],
    public: false,
  });
  async function connect(owner = 11) {
    const began = await engine.beginManifest(context(owner));
    if (!began.ok) throw new Error(began.code);
    handler = async () =>
      json(converted(JSON.parse(began.manifest).name, owner), 201);
    const completed = await engine.completeManifest(context(owner), {
      state: began.state,
      code: `code-${owner}`,
      operation: PERSONAL_MANIFEST_OPERATION,
    });
    if (!completed.ok) throw new Error(completed.code);
    const record = await broker.getApp(owner);
    if (!record) throw new Error("Missing App");
    return { ownerGithubAccountId: owner, recordId: record.app.recordId };
  }
  const install = (owner = 11, id = 101) => ({
    id,
    account: { id: owner, login: `renamed-${owner}`, type: "User" },
    target_type: "User",
    repository_selection: "selected",
    suspended_at: null,
  });
  const repository = (owner = 11, id = 501) => ({
    id,
    name: "private",
    full_name: `renamed-${owner}/private`,
    owner: { id: owner, login: `renamed-${owner}`, type: "User" },
    private: true,
    default_branch: "main",
  });
  function discovery(owner = 11, ids = [501]) {
    handler = async (url, init) => {
      if (url.includes("/app/installations?")) return json([install(owner)]);
      if (url.endsWith("/access_tokens"))
        return json(
          {
            token: "install-secret",
            expires_at: new Date(time + 3600_000).toISOString(),
          },
          201,
        );
      if (url.includes("/installation/repositories?"))
        return json({
          total_count: ids.length,
          repositories: ids.map((id) => repository(owner, id)),
        });
      if (url.endsWith("/installation/token") && init.method === "DELETE")
        return new Response(null, { status: 204 });
      throw new Error("Unexpected synthetic API path");
    };
  }
  return {
    store,
    broker,
    api,
    engine,
    rawEngine,
    admission,
    authority,
    records,
    lanes,
    calls,
    revocations,
    pem,
    context,
    json,
    converted,
    connect,
    discovery,
    install,
    repository,
    now: () => time,
    advance: (ms: number) => {
      time += ms;
    },
    respond: (fn: PersonalGithubTransport) => {
      handler = fn;
    },
    failWrite: (value: boolean) => {
      failWrite = value;
    },
    failRevocation: (value: boolean) => {
      failRevocation = value;
    },
  };
}
