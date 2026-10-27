#!/usr/bin/env node
// Print what App Store Connect did with the latest iOS builds.
//
//   node testflight-status.mjs [bundle id] [count]
//
// The release workflow uploads without waiting for Apple's processing, so a
// green run only means the upload worked. Apple can still mark the build
// invalid afterwards (bad Info.plist keys, missing entitlements, App Intents
// metadata it refuses), and that verdict only shows up here and in email.
// Read-only: uses the same API key as the upload (ASC_KEY_ID /
// ASC_ISSUER_ID / ASC_PRIVATE_KEY).
import crypto from "node:crypto";

const [bundleId = "dev.tella.os1", countArg = "6"] = process.argv.slice(2);
const count = Number(countArg) || 6;

const keyId = required("ASC_KEY_ID");
const issuer = required("ASC_ISSUER_ID");
const privateKey = required("ASC_PRIVATE_KEY");

function required(key) {
  const value = process.env[key];
  if (!value) {
    console.error(`::error::${key} is not set`);
    process.exit(1);
  }
  return value;
}

function token() {
  const now = Math.floor(Date.now() / 1000);
  const b64 = (v) => Buffer.from(JSON.stringify(v)).toString("base64url");
  const input = `${b64({ alg: "ES256", kid: keyId, typ: "JWT" })}.${b64({
    iss: issuer,
    iat: now,
    exp: now + 600,
    aud: "appstoreconnect-v1",
  })}`;
  const signature = crypto.sign("SHA256", Buffer.from(input), {
    key: privateKey,
    dsaEncoding: "ieee-p1363",
  });
  return `${input}.${signature.toString("base64url")}`;
}

async function get(path, params = {}) {
  const url = new URL(`https://api.appstoreconnect.apple.com${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token()}` },
  });
  const body = await response.text();
  if (!response.ok) {
    return { error: `${response.status} ${body.slice(0, 600)}` };
  }
  return JSON.parse(body);
}

const apps = await get("/v1/apps", { "filter[bundleId]": bundleId });
const app = apps.data?.[0];
if (!app) {
  console.error(`::error::No app for ${bundleId}: ${apps.error ?? "empty"}`);
  process.exit(1);
}

console.log(`== Builds (processing state) for ${bundleId}`);
const builds = await get("/v1/builds", {
  "filter[app]": app.id,
  sort: "-uploadedDate",
  limit: String(count),
});
if (builds.error) console.log(`builds: ${builds.error}`);
for (const build of builds.data ?? []) {
  const a = build.attributes;
  console.log(
    `${a.version}  ${a.processingState}  uploaded ${a.uploadedDate}  expired=${a.expired}`,
  );
}

// Build uploads carry Apple's validation errors for builds that never became
// a build at all, which is what an invalid binary looks like.
console.log(`\n== Build uploads (validation results)`);
// The endpoint ignores sort, so read a page and sort here, newest first.
const uploads = await get(`/v1/apps/${app.id}/buildUploads`, { limit: "200" });
if (uploads.error) console.log(`buildUploads: ${uploads.error}`);
const newest = (uploads.data ?? [])
  .sort((a, b) =>
    String(b.attributes?.createdDate).localeCompare(
      String(a.attributes?.createdDate),
    ),
  )
  .slice(0, count);
for (const upload of newest) {
  const a = upload.attributes ?? {};
  console.log(
    `${a.cfBundleVersion ?? "?"}  ${a.platform ?? ""}  created ${a.createdDate ?? "?"}  ${JSON.stringify(a.state ?? a)}`,
  );
}
