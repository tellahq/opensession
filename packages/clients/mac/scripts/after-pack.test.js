const { afterEach, beforeEach, expect, test } = require("bun:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const afterPack = require("./after-pack");

let base;
let release;
let previous;

function context() {
  return {
    electronPlatformName: "darwin",
    appOutDir: path.join(base, "out"),
    packager: { appInfo: { productFilename: "Acme" } },
  };
}

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "os1-after-pack-"));
  release = path.join(base, "release");
  fs.mkdirSync(path.join(release, "node_modules", "sharp", "lib"), {
    recursive: true,
  });
  fs.writeFileSync(path.join(release, "opensession"), "binary", {
    mode: 0o644,
  });
  fs.writeFileSync(path.join(release, "quickjs.wasm"), "wasm");
  fs.writeFileSync(
    path.join(release, "node_modules", "sharp", "lib", "sharp.node"),
    "native",
  );
  fs.mkdirSync(path.join(base, "out", "Acme.app", "Contents", "Resources"), {
    recursive: true,
  });
  previous = process.env.OS1_LOCAL_SERVER_RELEASE;
});

afterEach(() => {
  if (previous === undefined) delete process.env.OS1_LOCAL_SERVER_RELEASE;
  else process.env.OS1_LOCAL_SERVER_RELEASE = previous;
  fs.rmSync(base, { recursive: true, force: true });
});

const server = () =>
  path.join(base, "out", "Acme.app", "Contents", "Resources", "server");

test("packs nothing unless the build was given a server", async () => {
  delete process.env.OS1_LOCAL_SERVER_RELEASE;
  await afterPack.default(context());
  expect(fs.existsSync(server())).toBe(false);
});

test("packs the whole release, node_modules included, and marks it executable", async () => {
  process.env.OS1_LOCAL_SERVER_RELEASE = release;
  await afterPack.default(context());
  expect(fs.readFileSync(path.join(server(), "quickjs.wasm"), "utf8")).toBe(
    "wasm",
  );
  expect(
    fs.existsSync(
      path.join(server(), "node_modules", "sharp", "lib", "sharp.node"),
    ),
  ).toBe(true);
  expect(fs.statSync(path.join(server(), "opensession")).mode & 0o111).toBe(
    0o111,
  );
});

test("fails the build when the named folder is not a server release", async () => {
  process.env.OS1_LOCAL_SERVER_RELEASE = path.join(base, "missing");
  await expect(afterPack.default(context())).rejects.toThrow(
    /no opensession executable/,
  );
});

test("leaves other platforms alone", async () => {
  process.env.OS1_LOCAL_SERVER_RELEASE = release;
  await afterPack.default({ ...context(), electronPlatformName: "win32" });
  expect(fs.existsSync(server())).toBe(false);
});
