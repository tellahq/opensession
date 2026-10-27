/**
 * The Modal base image's build steps. Dependency-free so the project
 * snapshot signature (remote-repo-template.ts) can hash them without loading
 * the adapter.
 */
import { createHash } from "crypto";

/**
 * The base image every Modal Sandbox starts from (before a project
 * snapshot): the base runtime's workspace tools, a native build toolchain,
 * Rust through rustup under /home/ubuntu (proxies linked into
 * /usr/local/bin, so any command with HOME=/home/ubuntu finds them), and
 * the GL dispatch and Vulkan loader libraries. Modal mounts the NVIDIA
 * driver and its Vulkan manifest into GPU containers; without libglvnd the
 * driver cannot start and Vulkan falls back to the CPU (llvmpipe).
 *
 * Project snapshots record a hash of these commands
 * (remote-repo-template.ts), so changing them retires every snapshot built
 * on the previous image.
 */
export const MODAL_BASE_IMAGE_COMMANDS: readonly string[] = [
  "ENV DEBIAN_FRONTEND=noninteractive",
  "RUN apt-get update -qq && apt-get install -y -qq --no-install-recommends " +
    "ca-certificates git curl unzip xz-utils zip ripgrep coreutils sed jq sudo " +
    "python3 build-essential pkg-config cmake ninja-build clang lld " +
    // What a GitHub-hosted Ubuntu runner ships and native crates assume:
    // openssl-sys needs the headers, x264 builds need nasm.
    "libssl-dev nasm " +
    "direnv lsof procps less openssh-client " +
    "libvulkan1 vulkan-tools libglvnd0 libgl1 libglx0 libegl1 libxext6 libx11-6 " +
    "&& rm -rf /var/lib/apt/lists/*",
  "RUN mkdir -p /home/ubuntu && " +
    "HOME=/home/ubuntu sh -c 'curl -fsSL https://sh.rustup.rs | sh -s -- -y --no-modify-path --profile minimal --component rustfmt,clippy' && " +
    'for f in /home/ubuntu/.cargo/bin/*; do ln -sf "$f" /usr/local/bin/; done',
];

/** Changes whenever the base image's commands do. */
export const MODAL_BASE_IMAGE_REVISION = createHash("sha256")
  .update(MODAL_BASE_IMAGE_COMMANDS.join("\n"))
  .digest("hex")
  .slice(0, 16);
