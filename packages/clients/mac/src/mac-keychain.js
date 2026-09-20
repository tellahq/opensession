const { execFile } = require("node:child_process");
const { access } = require("node:fs/promises");
const { constants } = require("node:fs");
const { homedir } = require("node:os");
const path = require("node:path");
const { lookup } = require("node:dns/promises");
const { BlockList, isIP } = require("node:net");
const https = require("node:https");

const forbidden = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 3],
])
  forbidden.addSubnet(address, prefix, "ipv4");
const globalIPv6 = new BlockList();
globalIPv6.addSubnet("2000::", 3, "ipv6");

function publicAddress(address) {
  const family = isIP(address);
  return family === 4
    ? !forbidden.check(address, "ipv4")
    : family === 6 && globalIPv6.check(address, "ipv6");
}

function printable(value, max) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= max &&
    !/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/.test(value)
  );
}

// Revalidate server-supplied intent inside the native boundary. The renderer
// never supplies executable paths, arguments, headers, secrets, or callbacks.
function validateIntent(value) {
  if (
    !value ||
    typeof value !== "object" ||
    Object.keys(value).some(
      (k) =>
        ![
          "account",
          "service",
          "purpose",
          "url",
          "method",
          "injection",
          "body",
        ].includes(k),
    ) ||
    !printable(value.account, 300) ||
    !printable(value.service, 300) ||
    !printable(value.purpose, 240) ||
    !printable(value.url, 500) ||
    !["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"].includes(value.method) ||
    !["bearer", "x-api-key"].includes(value.injection) ||
    (value.body !== undefined &&
      (typeof value.body !== "string" || value.body.length > 512)) ||
    (value.body && ["GET", "HEAD"].includes(value.method))
  )
    throw new Error("Invalid request");
  const url = new URL(value.url);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hash ||
    (url.port && url.port !== "443") ||
    isIP(url.hostname.replace(/^\[|\]$/g, "")) ||
    !url.hostname.includes(".") ||
    url.hostname.endsWith(".local") ||
    url.hostname.endsWith(".localhost")
  )
    throw new Error("Invalid destination");
  // Freeze a detached copy. Approval and execution use this exact snapshot.
  return Object.freeze({ ...value, url: url.href });
}

async function findHelper() {
  if (process.platform !== "darwin" || !process.resourcesPath) {
    throw new Error("Keychain access requires the packaged Mac app.");
  }
  const binary = path.join(process.resourcesPath, "os-keychain");
  await access(binary, constants.X_OK);
  return binary;
}

async function readPassword(
  intent,
  { findBinary = findHelper, execute = execFile } = {},
) {
  const binary = await findBinary();
  return new Promise((resolve, reject) => {
    execute(
      binary,
      [intent.service, intent.account],
      {
        timeout: 120_000,
        maxBuffer: 16 * 1024,
        encoding: "utf8",
        cwd: homedir(),
        env: { HOME: homedir(), PATH: "/usr/bin:/bin", LANG: "en_US.UTF-8" },
        // Use our signed helper, not /usr/bin/security or a shell. No inherited
        // DYLD_* injection, credentials, startup files, or raw-value arguments.
      },
      (error, stdout) => {
        if (
          error ||
          typeof stdout !== "string" ||
          !stdout ||
          /[\r\n\x00]/.test(stdout)
        ) {
          // execFile errors contain stdout/stderr. Never forward the error object.
          reject(new Error("Keychain access failed or was denied."));
        } else resolve(stdout);
      },
    );
  });
}

// No Electron cookies, redirect following, ambient proxy, response body,
// response headers, or textual network error can reach the model. Pin the DNS
// lookup to a public address so an approved hostname cannot rebind to the LAN.
function sendRequest(
  intent,
  secret,
  { resolveHost = lookup, request = https.request } = {},
) {
  return new Promise((resolve, reject) => {
    const headers =
      intent.injection === "bearer"
        ? { Authorization: `Bearer ${secret}` }
        : { "x-api-key": secret };
    if (intent.body !== undefined) headers["Content-Type"] = "application/json";
    const req = request(
      new URL(intent.url),
      {
        method: intent.method,
        headers,
        agent: false,
        signal: AbortSignal.timeout(30_000),
        lookup: (host, _options, callback) => {
          resolveHost(host, { all: true }).then(
            (addresses) => {
              if (
                !addresses.length ||
                addresses.some((r) => !publicAddress(r.address))
              ) {
                callback(new Error("Destination unavailable"));
              } else if (_options.all) callback(null, addresses);
              else callback(null, addresses[0].address, addresses[0].family);
            },
            () => callback(new Error("Destination unavailable")),
          );
        },
      },
      (res) => {
        const status = res.statusCode;
        res.destroy(); // Do not even collect response bytes or headers.
        if (Number.isInteger(status) && status >= 100 && status <= 599)
          resolve(status);
        else reject(new Error("Request failed"));
      },
    );
    req.on("error", () => reject(new Error("Request failed")));
    req.end(intent.body);
  });
}

async function executeIntent(
  intent,
  { read = readPassword, send = sendRequest } = {},
) {
  try {
    const checked = validateIntent(intent);
    const secret = await read(checked);
    const httpStatus = await send(checked, secret);
    // Project explicitly rather than spreading any subprocess/network result.
    return Number.isInteger(httpStatus) &&
      httpStatus >= 100 &&
      httpStatus <= 599
      ? { status: "completed", httpStatus }
      : { status: "failed" };
  } catch {
    return { status: "failed" };
  }
}

module.exports = {
  validateIntent,
  publicAddress,
  readPassword,
  sendRequest,
  executeIntent,
};
