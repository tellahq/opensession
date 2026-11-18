const fs = require("node:fs");
const path = require("node:path");

// "This Mac" (src/local-server.js) runs the compiled server release from the
// app's resources. OS1_LOCAL_SERVER_RELEASE names an unpacked release folder
// (the one holding the `opensession` executable) to pack. Without it nothing
// is packed and the app never offers the feature, so a build that does not
// carry the server is unchanged.
//
// Copied here rather than listed under extraResources: the release keeps its
// image library under node_modules, and electron-builder leaves every
// node_modules folder out of extraResources whatever the filter says. This
// hook runs before signing, so the executables are signed with the app.
function packLocalServer(release, target) {
  const binary = path.join(release, "opensession");
  if (!fs.existsSync(binary)) {
    throw new Error(
      `OS1_LOCAL_SERVER_RELEASE has no opensession executable: ${release}`,
    );
  }
  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.cpSync(release, target, {
    recursive: true,
    verbatimSymlinks: true,
    // Command shims are links nothing runs, and a release built elsewhere
    // can carry them dangling, which the signing step cannot stat.
    filter: (source) => path.basename(source) !== ".bin",
  });
  fs.chmodSync(path.join(target, "opensession"), 0o755);
}

exports.packLocalServer = packLocalServer;
exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") return;
  const release = process.env.OS1_LOCAL_SERVER_RELEASE;
  if (!release) return;
  const app = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`,
  );
  packLocalServer(release, path.join(app, "Contents", "Resources", "server"));
};
