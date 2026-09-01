#!/usr/bin/env node
// Download one provisioning profile from App Store Connect by name.
//
//   node fetch-provisioning-profile.mjs "OS1 Widgets App Store" out.mobileprovision
//
// Reads the same App Store Connect API key the TestFlight upload uses
// (ASC_KEY_ID / ASC_ISSUER_ID / ASC_PRIVATE_KEY), so profiles live in App Store
// Connect and are fetched at build time instead of copied into repository
// secrets that silently drift behind App ID capabilities.
//
// Regenerating a profile that has expired (they last a year, tied to the
// signing certificate) is a POST /v1/profiles away; release CI fetches both
// the app and widget profiles so capabilities cannot drift behind a secret.
import crypto from "node:crypto";
import fs from "node:fs";

const [name, outPath] = process.argv.slice(2);
if (!name || !outPath) {
  console.error(
    "usage: fetch-provisioning-profile.mjs <profile name> <output path>",
  );
  process.exit(2);
}

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

function base64url(input) {
  return Buffer.from(input).toString("base64url");
}

// ES256, as App Store Connect requires. Short-lived: this runs once per build.
function token() {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "ES256", kid: keyId, typ: "JWT" };
  const payload = {
    iss: issuer,
    iat: now,
    exp: now + 600,
    aud: "appstoreconnect-v1",
  };
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
  const signature = crypto.sign("SHA256", Buffer.from(signingInput), {
    key: privateKey,
    dsaEncoding: "ieee-p1363",
  });
  return `${signingInput}.${signature.toString("base64url")}`;
}

const url = new URL("https://api.appstoreconnect.apple.com/v1/profiles");
url.searchParams.set("filter[name]", name);
url.searchParams.set("limit", "1");

const response = await fetch(url, {
  headers: { Authorization: `Bearer ${token()}` },
});
if (!response.ok) {
  console.error(
    `::error::App Store Connect returned ${response.status}: ${await response.text()}`,
  );
  process.exit(1);
}

const { data } = await response.json();
const profile = data?.[0];
if (!profile) {
  console.error(
    `::error::No provisioning profile named "${name}" in App Store Connect`,
  );
  process.exit(1);
}

const { profileState, expirationDate, profileContent } = profile.attributes;
// A profile that expired silently would fail much later, inside codesign,
// with an error that says nothing about why.
if (profileState !== "ACTIVE" || new Date(expirationDate) <= new Date()) {
  console.error(
    `::error::Profile "${name}" is ${profileState}, expires ${expirationDate}`,
  );
  process.exit(1);
}

fs.writeFileSync(outPath, Buffer.from(profileContent, "base64"));
console.log(`Installed "${name}" (expires ${expirationDate}) at ${outPath}`);
