#!/bin/sh
# Vercel: exit 0 skips the build; exit 1 builds. Run before dependency install.
# Compare with the last deployment, not HEAD^, so multi-commit pushes are safe.
cd "$(git rev-parse --show-toplevel)" || exit 1
base=${VERCEL_GIT_PREVIOUS_SHA:-}
if [ -z "$base" ] || ! git cat-file -e "$base^{commit}" 2>/dev/null; then
  echo "Build website: no available previous deployment commit."
  exit 1
fi

# The interactive preview imports the production frontend and shared contracts.
# Also include the agent setup guide served at /agent-setup.md.
# Include workspace manifests, lockfiles, patches, and the imported app icons.
git diff --quiet "$base" HEAD -- \
  packages/clients/website \
  docs/setup/agent.md \
  packages/core/opensession-server/src/frontend \
  packages/core/opensession-server/src/shared \
  packages/core/opensession-server/src/simulator-portal/protocol.ts \
  packages/core/opensession-server/src/server/workflow-types.ts \
  packages/core/protocol \
  packages/clients/mac/build/icon-512.png \
  packages/clients/ios/OS1/Assets.xcassets/AppIcon.appiconset/AppIcon-1024.png \
  ':(glob)**/package.json' \
  package.json bun.lock bun.lockb bunfig.toml .npmrc tsconfig.json vercel.json patches
result=$?
if [ "$result" -eq 0 ]; then
  echo "Skip website: no website inputs changed."
  exit 0
fi
# Diff errors must build too, rather than risk skipping a required deployment.
echo "Build website: inputs changed or comparison unavailable."
exit 1
