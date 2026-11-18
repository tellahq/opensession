#!/usr/bin/env node
// Start the app's own server from a release folder the way the app does, ask
// it a few questions, and stop it. Run against the server inside a packaged,
// signed app, this is the check that the signature lets it execute at all:
//
//   node scripts/smoke-local-server.js "dist/mac-arm64/OS.app/Contents/Resources/server"
//
// Everything it writes goes to a temporary home that is removed afterwards.
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { LocalServer } = require("../src/local-server");

function status(port, host, urlPath) {
  return new Promise((resolve) => {
    const req = http.request(
      { host: "127.0.0.1", port, path: urlPath, headers: { host } },
      (res) => {
        res.resume();
        resolve(res.statusCode);
      },
    );
    req.on("error", () => resolve(0));
    req.end();
  });
}

async function main() {
  const releaseDir = path.resolve(process.argv[2] || "build/vendor/server");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "os1-local-smoke-"));
  // Never the preferred ports: a copy of the app may be running on this
  // machine.
  const server = new LocalServer({
    releaseDir,
    home,
    preferredPorts: { port: 0, kernelPort: 0, ingressPort: 0 },
  });
  const failures = [];
  const expect = (what, ok) => {
    console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
    if (!ok) failures.push(what);
  };
  try {
    expect(`a server release is at ${releaseDir}`, server.available());
    if (!server.available()) return failures;
    const began = Date.now();
    const url = await server.start();
    console.log(`     ready at ${url} after ${Date.now() - began} ms`);
    const { port } = server.ports;
    expect(
      "health answers",
      (await status(port, `127.0.0.1:${port}`, "/api/health")) === 200,
    );
    expect(
      "the app page is served",
      (await status(port, `127.0.0.1:${port}`, "/")) === 200,
    );
    expect(
      "a request for another host name is refused",
      (await status(port, `rebind.example.test:${port}`, "/api/health")) ===
        403,
    );
    const setup = await (await fetch(`${url}api/setup/status`)).json();
    expect(
      "the first repository is under the repos folder",
      setup.repos?.[0]?.path ===
        path.join(home, "OpenSession", "repos", "scratch"),
    );
    expect("the engine is on", setup.engine?.piEnabled === true);
    const pids = server.readPlan().pids || [];
    await server.stop();
    expect(
      "both processes are gone after stop",
      pids.length === 2 &&
        pids.every((pid) => {
          try {
            process.kill(pid, 0);
            return false;
          } catch {
            return true;
          }
        }),
    );
  } catch (error) {
    failures.push(String(error && error.message));
    console.error(`FAIL ${error && error.message}`);
    console.error(server.recentOutput());
  } finally {
    await server.stop().catch(() => {});
    fs.rmSync(home, { recursive: true, force: true });
  }
  return failures;
}

main().then((failures) => process.exit(failures.length ? 1 : 0));
