const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

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
  ]) {
    const output = path.join(outputDir, helper.binary);
    execFileSync(
      "xcrun",
      [
        "swiftc",
        path.join(root, "native", `${helper.name}.swift`),
        "-parse-as-library",
        "-O",
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
