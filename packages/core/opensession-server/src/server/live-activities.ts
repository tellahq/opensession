import { canAccessScope } from "../shared/access-scope";
/**
 * ActivityKit delivery for the native iOS app.
 *
 * Registrations are inert unless APNs credentials are configured. Session
 * transitions are aggregated per authenticated person into one Live Activity,
 * so a burst of workers never floods the Lock Screen with separate cards.
 */
import { chmodSync, existsSync, readFileSync } from "fs";
import { connect } from "node:http2";
import { importPkcs8Pem } from "./codestorage/auth";
import { stateDir } from "./paths";
import { getReads, isUnread } from "./reads";
import { getCachedSessionsAsync } from "./session-cache";
import { onSessionStateChange } from "./session-state-events";
import { writeJsonAtomic } from "./shared/atomic-write";
import { userMatchesAny } from "./shared/user-mappings";
import type { UnifiedSession } from "./types";

const STORE_PATH = `${stateDir("live-activities")}/registrations.json`;
const MAX_VISIBLE_SESSIONS = 3;
const MAX_ACTIVITY_TOKENS = 4;
const TOKEN_PATTERN = /^[a-f0-9]{32,512}$/i;
const REGISTRATION_TTL_MS = 36 * 60 * 60 * 1000;
const LIVE_STATE_TTL_MS = 2 * 60 * 1000;
const APNS_TIMEOUT_MS = 10_000;

export interface LiveActivityItem {
  id: string;
  title: string;
  repo: string;
  startedAt?: number;
}

export interface LiveActivitySnapshot {
  sessions: LiveActivityItem[];
  totalCount: number;
  unreadCount: number;
  updatedAt: number;
}

interface ActivityTokenRecord {
  pushToken: string;
  updatedAt: string;
  lastTimestamp?: number;
}

export interface LiveActivityRegistration {
  deviceId: string;
  user: string;
  login?: string;
  pushToStartToken: string;
  activities: Record<string, ActivityTokenRecord>;
  remoteStarted?: boolean;
  lastStartTimestamp?: number;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
}

interface RegistrationStore {
  devices: LiveActivityRegistration[];
}

interface ApnsConfig {
  keyId: string;
  teamId: string;
  privateKeyPath: string;
  bundleId: string;
  origin: string;
}

const liveState = new Map<
  string,
  { isRunning: boolean; startedAt?: number; expiresAt: number }
>();
let syncTimer: ReturnType<typeof setTimeout> | null = null;
let listenerStarted = false;
let jwtCache: { key: string; issuedAt: number; token: string } | null = null;
let storeQueue: Promise<unknown> = Promise.resolve();
let syncRunning = false;
let syncDirty = false;

function withStoreLock<T>(work: () => Promise<T> | T): Promise<T> {
  const run = storeQueue.then(work, work);
  storeQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function readStore(): RegistrationStore {
  try {
    if (existsSync(STORE_PATH)) {
      const parsed = JSON.parse(readFileSync(STORE_PATH, "utf8"));
      if (Array.isArray(parsed?.devices)) {
        const now = Date.now();
        const before = JSON.stringify(parsed.devices);
        parsed.devices = parsed.devices
          .filter((device: LiveActivityRegistration) => {
            const updated = Date.parse(device?.updatedAt);
            const expires = device?.expiresAt
              ? Date.parse(device.expiresAt)
              : updated + REGISTRATION_TTL_MS;
            return Number.isFinite(expires) && expires > now;
          })
          .map((device: LiveActivityRegistration) => {
            const activities =
              device.activities && typeof device.activities === "object"
                ? device.activities
                : {};
            device.activities = Object.fromEntries(
              Object.entries(activities)
                .sort(
                  ([, left], [, right]) =>
                    Date.parse(right.updatedAt) - Date.parse(left.updatedAt),
                )
                .slice(0, MAX_ACTIVITY_TOKENS),
            );
            return device;
          });
        if (JSON.stringify(parsed.devices) !== before) writeStore(parsed);
        return parsed;
      }
    }
  } catch (error) {
    console.error("[live-activities] failed to read registrations:", error);
  }
  return { devices: [] };
}

function writeStore(store: RegistrationStore): void {
  writeJsonAtomic(STORE_PATH, store);
  chmodSync(STORE_PATH, 0o600);
}

function cleanText(value: unknown, maximum: number): string {
  return typeof value === "string" ? value.trim().slice(0, maximum) : "";
}

function validToken(value: unknown): value is string {
  return typeof value === "string" && TOKEN_PATTERN.test(value);
}

function ownsSession(
  registration: Pick<LiveActivityRegistration, "user" | "login">,
  session: UnifiedSession,
): boolean {
  const allowed = [registration.user, registration.login].filter(
    (value): value is string => !!value,
  );
  if (registration.login && session.createdByLogin) {
    return (
      registration.login.toLowerCase() === session.createdByLogin.toLowerCase()
    );
  }
  return [session.createdBy, session.startedBy, session.createdByLogin]
    .filter((value): value is string => !!value)
    .some((owner) => userMatchesAny(owner, allowed));
}

export function liveActivityRegistrationMatches(
  registration: Pick<LiveActivityRegistration, "user" | "login">,
  identity: { user: string; login?: string },
): boolean {
  if (registration.login || identity.login) {
    return !!(
      registration.login &&
      identity.login &&
      registration.login.toLowerCase() === identity.login.toLowerCase()
    );
  }
  return userMatchesAny(identity.user, [registration.user]);
}

export function liveActivitySnapshot(
  registration: Pick<LiveActivityRegistration, "user" | "login">,
  sessions: UnifiedSession[],
  now = Date.now(),
  reads = getReads(registration.user),
): LiveActivitySnapshot {
  const active = sessions
    .filter((session) => {
      // Push audiences remain shared-only, even for the private owner.
      if (!canAccessScope(session.accessScope)) return false;
      const observed = liveState.get(session.id);
      if (observed && observed.expiresAt <= now) liveState.delete(session.id);
      const running =
        observed && observed.expiresAt > now
          ? observed.isRunning
          : session.isRunning;
      return (
        running &&
        !session.archived &&
        !session.automation &&
        !session.desk &&
        ownsSession(registration, session)
      );
    })
    .sort((left, right) => {
      const byActivity =
        Date.parse(right.lastActivity) - Date.parse(left.lastActivity);
      return Number.isFinite(byActivity) && byActivity !== 0
        ? byActivity
        : left.id.localeCompare(right.id);
    });
  return {
    sessions: active.slice(0, MAX_VISIBLE_SESSIONS).map((session) => {
      const observed = liveState.get(session.id)?.startedAt;
      const stored = session.runStartedAt
        ? Date.parse(session.runStartedAt)
        : NaN;
      const startedAt =
        observed ?? (Number.isFinite(stored) ? stored : undefined);
      return {
        id: session.id,
        title: cleanText(session.title || session.id, 80),
        repo: cleanText(session.repo || "opensession", 40),
        ...(startedAt ? { startedAt: startedAt / 1000 } : {}),
      };
    }),
    totalCount: active.length,
    unreadCount: sessions.filter(
      (session) =>
        canAccessScope(session.accessScope) &&
        !session.archived &&
        !session.automation &&
        !session.desk &&
        !session.spawnedBy &&
        ownsSession(registration, session) &&
        isUnread(session.lastActivity, reads[session.id]),
    ).length,
    updatedAt: now / 1000,
  };
}

export async function registerLiveActivityDevice(input: {
  deviceId: unknown;
  user: string;
  login?: string;
  pushToStartToken: unknown;
}): Promise<{ ok: true } | { error: string }> {
  const deviceId = cleanText(input.deviceId, 100);
  const pushToStartToken = input.pushToStartToken;
  if (!deviceId) return { error: "deviceId required" };
  if (!input.user) return { error: "authenticated user required" };
  if (!validToken(pushToStartToken))
    return { error: "invalid push-to-start token" };

  let retired: LiveActivityRegistration | undefined;
  const result = await withStoreLock(() => {
    const store = readStore();
    const previous = store.devices.find(
      (device) => device.deviceId === deviceId,
    );
    const sameOwner =
      !previous ||
      liveActivityRegistrationMatches(previous, {
        user: input.user,
        login: input.login,
      });
    const provesDevice = previous?.pushToStartToken === pushToStartToken;
    if (previous && !sameOwner && !provesDevice) {
      return { error: "device belongs to another user" } as const;
    }
    if (previous && !sameOwner) retired = structuredClone(previous);
    const now = new Date();
    const next: LiveActivityRegistration = {
      deviceId,
      user: input.user,
      ...(input.login ? { login: input.login } : {}),
      pushToStartToken,
      activities: sameOwner ? previous?.activities || {} : {},
      remoteStarted: sameOwner ? previous?.remoteStarted : false,
      createdAt: sameOwner
        ? previous?.createdAt || now.toISOString()
        : now.toISOString(),
      updatedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + REGISTRATION_TTL_MS).toISOString(),
    };
    store.devices = store.devices.filter(
      (device) => device.deviceId !== deviceId,
    );
    store.devices.push(next);
    writeStore(store);
    return { ok: true } as const;
  });
  if (retired) void endRegistrationActivities(retired);
  scheduleLiveActivitySync();
  return result;
}

export async function registerLiveActivityToken(input: {
  deviceId: unknown;
  activityId: unknown;
  pushToken: unknown;
  user: string;
  login?: string;
}): Promise<{ ok: true } | { error: string }> {
  const deviceId = cleanText(input.deviceId, 100);
  const activityId = cleanText(input.activityId, 200);
  const pushToken = input.pushToken;
  if (!deviceId || !activityId)
    return { error: "deviceId and activityId required" };
  if (!validToken(pushToken)) return { error: "invalid activity push token" };
  const result = await withStoreLock(() => {
    const store = readStore();
    const device = store.devices.find(
      (candidate) => candidate.deviceId === deviceId,
    );
    if (!device) return { error: "device is not registered" } as const;
    if (
      !liveActivityRegistrationMatches(device, {
        user: input.user,
        login: input.login,
      })
    ) {
      return { error: "device belongs to another user" } as const;
    }
    const now = new Date();
    const previous = device.activities[activityId];
    device.activities[activityId] = {
      pushToken,
      updatedAt: now.toISOString(),
      ...(previous?.pushToken === pushToken && previous.lastTimestamp
        ? { lastTimestamp: previous.lastTimestamp }
        : {}),
    };
    device.activities = Object.fromEntries(
      Object.entries(device.activities)
        .sort(
          ([, left], [, right]) =>
            Date.parse(right.updatedAt) - Date.parse(left.updatedAt),
        )
        .slice(0, MAX_ACTIVITY_TOKENS),
    );
    device.remoteStarted = true;
    device.updatedAt = now.toISOString();
    device.expiresAt = new Date(
      now.getTime() + REGISTRATION_TTL_MS,
    ).toISOString();
    writeStore(store);
    return { ok: true } as const;
  });
  scheduleLiveActivitySync();
  return result;
}

export async function unregisterLiveActivityDevice(
  deviceId: string,
  user: string,
  login?: string,
): Promise<{ ok: true } | { error: string }> {
  let retired: LiveActivityRegistration | undefined;
  const result = await withStoreLock(() => {
    const store = readStore();
    const device = store.devices.find(
      (candidate) => candidate.deviceId === deviceId,
    );
    if (device && !liveActivityRegistrationMatches(device, { user, login })) {
      return { error: "device belongs to another user" } as const;
    }
    if (device) retired = structuredClone(device);
    store.devices = store.devices.filter(
      (candidate) => candidate.deviceId !== deviceId,
    );
    writeStore(store);
    return { ok: true } as const;
  });
  if (retired) void endRegistrationActivities(retired);
  return result;
}

function apnsConfig(): ApnsConfig | null {
  const keyId = process.env.OPENSESSION_APNS_KEY_ID?.trim();
  const teamId = process.env.OPENSESSION_APNS_TEAM_ID?.trim();
  const privateKeyPath = process.env.OPENSESSION_APNS_PRIVATE_KEY_PATH?.trim();
  if (!keyId || !teamId || !privateKeyPath || !existsSync(privateKeyPath))
    return null;
  return {
    keyId,
    teamId,
    privateKeyPath,
    bundleId: process.env.OPENSESSION_APNS_BUNDLE_ID?.trim() || "dev.tella.os1",
    origin:
      process.env.OPENSESSION_APNS_ENV === "sandbox"
        ? "https://api.sandbox.push.apple.com"
        : "https://api.push.apple.com",
  };
}

async function apnsJwt(config: ApnsConfig): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const key = `${config.keyId}:${config.teamId}:${config.privateKeyPath}`;
  if (jwtCache?.key === key && now - jwtCache.issuedAt < 50 * 60) {
    return jwtCache.token;
  }
  const imported = await importPkcs8Pem(
    readFileSync(config.privateKeyPath, "utf8"),
  );
  if (imported.alg !== "ES256")
    throw new Error("APNs key must be an ES256 private key");
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  const signingInput = `${encode({ alg: "ES256", kid: config.keyId })}.${encode({ iss: config.teamId, iat: now })}`;
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    imported.key,
    new TextEncoder().encode(signingInput),
  );
  const token = `${signingInput}.${Buffer.from(signature).toString("base64url")}`;
  jwtCache = { key, issuedAt: now, token };
  return token;
}

export function activityPushPayload(
  event: "start" | "update" | "end",
  snapshot: LiveActivitySnapshot,
  deviceId?: string,
  now = Date.now(),
): Record<string, unknown> {
  const aps: Record<string, unknown> = {
    timestamp: Math.floor(now / 1000),
    event,
    "content-state": snapshot,
    "stale-date": Math.floor(now / 1000) + 10 * 60,
  };
  if (event === "start") {
    aps["attributes-type"] = "ActiveSessionsAttributes";
    aps.attributes = { deviceId };
    aps.alert = {
      title: "OS1",
      body:
        snapshot.totalCount === 1
          ? "A session is active"
          : snapshot.totalCount > 1
            ? `${snapshot.totalCount} sessions are active`
            : snapshot.unreadCount === 1
              ? "A session is ready to review"
              : `${snapshot.unreadCount} sessions are ready to review`,
    };
  }
  if (event === "end") aps["dismissal-date"] = Math.floor(now / 1000) + 30;
  return { aps };
}

async function sendApnsOnce(
  config: ApnsConfig,
  pushToken: string,
  payload: Record<string, unknown>,
): Promise<{ status: number; reason?: string }> {
  const authorization = await apnsJwt(config);
  return await new Promise((resolve, reject) => {
    const client = connect(config.origin);
    let status = 0;
    let responseBody = "";
    const request = client.request({
      ":method": "POST",
      ":path": `/3/device/${pushToken}`,
      authorization: `bearer ${authorization}`,
      "apns-topic": `${config.bundleId}.push-type.liveactivity`,
      "apns-push-type": "liveactivity",
      "apns-priority": "10",
      "apns-expiration": `${Math.floor(Date.now() / 1000) + 10 * 60}`,
      "apns-collapse-id": `os1-live-${Bun.hash(pushToken).toString(16)}`,
    });
    let settled = false;
    const finish = (result: { status: number; reason?: string } | Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      client.close();
      if (result instanceof Error) reject(result);
      else resolve(result);
    };
    const timeout = setTimeout(() => {
      request.close();
      client.destroy();
      finish(new Error("APNs request timed out"));
    }, APNS_TIMEOUT_MS);
    client.on("error", finish);
    request.setEncoding("utf8");
    request.on("response", (headers) => {
      status = Number(headers[":status"] || 0);
    });
    request.on("data", (chunk) => {
      responseBody += chunk;
    });
    request.on("error", (error) => {
      finish(error);
    });
    request.on("end", () => {
      let reason: string | undefined;
      try {
        reason = JSON.parse(responseBody)?.reason;
      } catch {}
      finish({ status, reason });
    });
    request.end(JSON.stringify(payload));
  });
}

async function sendApns(
  config: ApnsConfig,
  pushToken: string,
  payload: Record<string, unknown>,
): Promise<{ status: number; reason?: string }> {
  let result = await sendApnsOnce(config, pushToken, payload);
  if (
    result.status === 403 &&
    ["ExpiredProviderToken", "InvalidProviderToken"].includes(
      result.reason || "",
    )
  ) {
    jwtCache = null;
    result = await sendApnsOnce(config, pushToken, payload);
  }
  return result;
}

function rejectsToken(result: { status: number; reason?: string }): boolean {
  return (
    result.status === 410 ||
    (result.status === 400 &&
      ["BadDeviceToken", "DeviceTokenNotForTopic", "Unregistered"].includes(
        result.reason || "",
      ))
  );
}

function nextPushTimestamp(previous?: number): number {
  return Math.max(Math.floor(Date.now() / 1000), (previous || 0) + 1);
}

async function endRegistrationActivities(
  registration: LiveActivityRegistration,
): Promise<void> {
  const config = apnsConfig();
  if (!config) return;
  const snapshot: LiveActivitySnapshot = {
    sessions: [],
    totalCount: 0,
    unreadCount: 0,
    updatedAt: Date.now() / 1000,
  };
  for (const activity of Object.values(registration.activities)) {
    try {
      const timestamp = nextPushTimestamp(activity.lastTimestamp);
      await sendApns(
        config,
        activity.pushToken,
        activityPushPayload("end", snapshot, undefined, timestamp * 1000),
      );
    } catch (error) {
      console.error("[live-activities] unregister dismissal failed:", error);
    }
  }
}

interface DeviceSyncResult {
  deviceId: string;
  user: string;
  login?: string;
  pushToStartToken: string;
  removeDevice?: boolean;
  remoteStarted?: boolean;
  recoverIfNoActivities?: boolean;
  removeActivities: Array<{ activityId: string; pushToken: string }>;
  activityTimestamps: Array<{
    activityId: string;
    pushToken: string;
    timestamp: number;
  }>;
  lastStartTimestamp?: number;
}

async function syncDevice(
  config: ApnsConfig,
  device: LiveActivityRegistration,
  sessions: UnifiedSession[],
): Promise<DeviceSyncResult> {
  const snapshot = liveActivitySnapshot(device, sessions);
  const outcome: DeviceSyncResult = {
    deviceId: device.deviceId,
    user: device.user,
    login: device.login,
    pushToStartToken: device.pushToStartToken,
    removeActivities: [],
    activityTimestamps: [],
  };
  const deliver = async (
    token: string,
    payload: Record<string, unknown>,
    label: string,
  ): Promise<{ status: number; reason?: string } | null> => {
    try {
      return await sendApns(config, token, payload);
    } catch (error) {
      console.error(`[live-activities] ${label} delivery failed:`, error);
      return null;
    }
  };
  if (snapshot.totalCount > 0 || snapshot.unreadCount > 0) {
    const activities = Object.entries(device.activities);
    if (activities.length === 0 && !device.remoteStarted) {
      const timestamp = nextPushTimestamp(device.lastStartTimestamp);
      const result = await deliver(
        device.pushToStartToken,
        activityPushPayload(
          "start",
          snapshot,
          device.deviceId,
          timestamp * 1000,
        ),
        "push-to-start",
      );
      if (!result) return outcome;
      if (result.status === 200) {
        outcome.remoteStarted = true;
        outcome.lastStartTimestamp = timestamp;
      } else if (rejectsToken(result)) {
        outcome.removeDevice = true;
        return outcome;
      } else {
        console.error(
          `[live-activities] push-to-start failed: ${result.status} ${result.reason || ""}`,
        );
      }
    }
    for (const [activityId, activity] of activities) {
      const timestamp = nextPushTimestamp(activity.lastTimestamp);
      const result = await deliver(
        activity.pushToken,
        activityPushPayload("update", snapshot, undefined, timestamp * 1000),
        "update",
      );
      if (!result) continue;
      if (rejectsToken(result)) {
        outcome.removeActivities.push({
          activityId,
          pushToken: activity.pushToken,
        });
        outcome.recoverIfNoActivities = true;
      } else if (result.status !== 200) {
        console.error(
          `[live-activities] update failed: ${result.status} ${result.reason || ""}`,
        );
      } else {
        outcome.activityTimestamps.push({
          activityId,
          pushToken: activity.pushToken,
          timestamp,
        });
      }
    }
  } else {
    for (const [activityId, activity] of Object.entries(device.activities)) {
      const timestamp = nextPushTimestamp(activity.lastTimestamp);
      const result = await deliver(
        activity.pushToken,
        activityPushPayload("end", snapshot, undefined, timestamp * 1000),
        "end",
      );
      if (!result) continue;
      if (result.status === 200 || rejectsToken(result)) {
        outcome.removeActivities.push({
          activityId,
          pushToken: activity.pushToken,
        });
      }
    }
    if (Object.keys(device.activities).length > 0) {
      outcome.remoteStarted = false;
    }
  }
  return outcome;
}

async function syncLiveActivitiesOnce(): Promise<void> {
  const config = apnsConfig();
  if (!config) return;
  const devices = await withStoreLock(() => readStore().devices);
  if (devices.length === 0) return;
  const sessions = await getCachedSessionsAsync();
  const outcomes: DeviceSyncResult[] = [];
  for (const device of devices) {
    try {
      outcomes.push(await syncDevice(config, device, sessions));
    } catch (error) {
      console.error(
        `[live-activities] delivery failed for ${device.deviceId}:`,
        error,
      );
    }
  }

  await withStoreLock(() => {
    const store = readStore();
    let changed = false;
    for (const outcome of outcomes) {
      const device = store.devices.find(
        (candidate) => candidate.deviceId === outcome.deviceId,
      );
      if (
        !device ||
        !liveActivityRegistrationMatches(device, {
          user: outcome.user,
          login: outcome.login,
        })
      ) {
        continue;
      }
      let deviceChanged = false;
      if (
        outcome.removeDevice &&
        device.pushToStartToken === outcome.pushToStartToken
      ) {
        store.devices = store.devices.filter(
          (candidate) => candidate.deviceId !== outcome.deviceId,
        );
        changed = true;
        continue;
      }
      for (const removal of outcome.removeActivities) {
        if (
          device.activities[removal.activityId]?.pushToken === removal.pushToken
        ) {
          delete device.activities[removal.activityId];
          changed = true;
          deviceChanged = true;
        }
      }
      for (const update of outcome.activityTimestamps) {
        const activity = device.activities[update.activityId];
        if (
          activity?.pushToken === update.pushToken &&
          activity.lastTimestamp !== update.timestamp
        ) {
          activity.lastTimestamp = update.timestamp;
          changed = true;
          deviceChanged = true;
        }
      }
      if (
        outcome.lastStartTimestamp !== undefined &&
        device.pushToStartToken === outcome.pushToStartToken &&
        device.lastStartTimestamp !== outcome.lastStartTimestamp
      ) {
        device.lastStartTimestamp = outcome.lastStartTimestamp;
        changed = true;
        deviceChanged = true;
      }
      if (
        outcome.remoteStarted !== undefined &&
        device.pushToStartToken === outcome.pushToStartToken &&
        device.remoteStarted !== outcome.remoteStarted
      ) {
        device.remoteStarted = outcome.remoteStarted;
        changed = true;
        deviceChanged = true;
      }
      if (
        outcome.recoverIfNoActivities &&
        Object.keys(device.activities).length === 0 &&
        device.remoteStarted
      ) {
        device.remoteStarted = false;
        changed = true;
        deviceChanged = true;
      }
      if (deviceChanged) device.updatedAt = new Date().toISOString();
    }
    if (changed) writeStore(store);
  });
}

async function drainLiveActivitySync(): Promise<void> {
  if (syncRunning) return;
  syncRunning = true;
  try {
    while (syncDirty) {
      syncDirty = false;
      await syncLiveActivitiesOnce();
    }
  } finally {
    syncRunning = false;
    if (syncDirty) void drainLiveActivitySync();
  }
}

export function scheduleLiveActivitySync(): void {
  syncDirty = true;
  if (syncRunning) return;
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = setTimeout(() => {
    syncTimer = null;
    void drainLiveActivitySync();
  }, 300);
  syncTimer.unref?.();
}

export function startLiveActivitySync(): void {
  if (listenerStarted) return;
  listenerStarted = true;
  onSessionStateChange((event) => {
    const previous = liveState.get(event.sessionId);
    if (event.isRunning) {
      liveState.set(event.sessionId, {
        isRunning: true,
        startedAt: previous?.startedAt || event.at,
        expiresAt: event.at + LIVE_STATE_TTL_MS,
      });
    } else {
      liveState.set(event.sessionId, {
        isRunning: false,
        expiresAt: event.at + 60_000,
      });
      setTimeout(() => liveState.delete(event.sessionId), 60_000).unref?.();
    }
    scheduleLiveActivitySync();
  });
  setInterval(scheduleLiveActivitySync, 5 * 60_000).unref?.();
  scheduleLiveActivitySync();
}
