#!/usr/bin/env node
// Write the update feed a release publishes beside its zip (src/update-feed.js):
//
//   node scripts/write-update-feed.js <owner/repo> <tag> <out file>
const fs = require("node:fs");
const { releaseFeed } = require("../src/update-feed");

const [repo, tag, out] = process.argv.slice(2);
if (!repo || !tag || !out) {
  console.error("usage: write-update-feed.js <owner/repo> <tag> <out file>");
  process.exit(2);
}
fs.writeFileSync(out, JSON.stringify(releaseFeed({ repo, tag }), null, 2) + "\n");
console.log(`wrote ${out}`);
