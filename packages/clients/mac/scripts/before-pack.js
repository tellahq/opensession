const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

// electron-builder's Arch enum: 0 ia32, 1 x64, 2 armv7l, 3 arm64, 4 universal.
// The app only ships arm64 and x64 builds; a universal build would need two
// compiles and a lipo, so it is refused rather than guessed.
function swiftArch(arch) {
  if (arch === 3) return "arm64";
  if (arch === 1) return "x86_64";
  throw new Error(`Unsupported macOS build arch ${arch} for os1-voice-audio`);
}

// "This Mac" (src/local-server.js) runs the compiled server release from the
// app's resources. OS1_LOCAL_SERVER_RELEASE names an unpacked release folder
// (the one holding the `opensession` executable) to pack. Without it the
// folder is packed empty and the app never offers the feature, so a build
// that does not carry the server is unchanged.
function stageLocalServer(root, release) {
  const target = path.join(root, "build", "vendor", "server");
  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(target, { recursive: true });
  if (!release) {
    fs.writeFileSync(
      path.join(target, "NOT-INCLUDED.txt"),
      "This build does not include the local server.\n",
    );
    return false;
  }
  const binary = path.join(release, "opensession");
  if (!fs.existsSync(binary))
    throw new Error(
      `OS1_LOCAL_SERVER_RELEASE has no opensession executable: ${release}`,
    );
  fs.cpSync(release, target, { recursive: true, verbatimSymlinks: true });
  fs.chmodSync(path.join(target, "opensession"), 0o755);
  return true;
}

exports.stageLocalServer = stageLocalServer;
exports.default = async function beforePack(context) {
  if (context.electronPlatformName !== "darwin") return;
  const root = context.packager.projectDir;
  const outputDir = path.join(root, "build", "vendor");
  fs.mkdirSync(outputDir, { recursive: true });
  stageLocalServer(root, process.env.OS1_LOCAL_SERVER_RELEASE || "");
  for (const helper of [
    {
      name: "DictationHelper",
      binary: "os1-dictation",
      frameworks: ["Speech", "AVFoundation"],
    },
    { name: "KeychainHelper", binary: "os-keychain", frameworks: ["Security"] },
    {
      name: "VoiceAudioHelper",
      binary: "os1-voice-audio",
      frameworks: ["AVFoundation", "AudioToolbox", "CoreAudio"],
      // Pin the deployment target to the oldest macOS the app itself runs
      // on, otherwise the helper silently requires the CI machine's macOS
      // and its `#available` fallbacks never matter.
      target: `${swiftArch(context.arch)}-apple-macos12.0`,
    },
  ]) {
    const output = path.join(outputDir, helper.binary);
    execFileSync(
      "xcrun",
      [
        "swiftc",
        path.join(root, "native", `${helper.name}.swift`),
        "-parse-as-library",
        "-O",
        ...(helper.target ? ["-target", helper.target] : []),
        ...helper.frameworks.flatMap((name) => ["-framework", name]),
        "-Xlinker",
        "-sectcreate",
        "-Xlinker",
        "__TEXT",
        "-Xlinker",
        "__info_plist",
        "-Xlinker",
        path.join(root, "native", `${helper.name}-Info.plist`),
        "-o",
        output,
      ],
      { stdio: "inherit" },
    );
    fs.chmodSync(output, 0o755);
  }
};
