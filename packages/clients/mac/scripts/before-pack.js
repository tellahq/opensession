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

exports.default = async function beforePack(context) {
  if (context.electronPlatformName !== "darwin") return;
  const root = context.packager.projectDir;
  const outputDir = path.join(root, "build", "vendor");
  fs.mkdirSync(outputDir, { recursive: true });
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
