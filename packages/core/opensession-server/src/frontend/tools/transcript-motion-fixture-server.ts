#!/usr/bin/env bun
/** Build and serve only the network-free transcript fixture for browser CI. */
import { join } from "node:path";
import { activeFrontendDist, compileAssets } from "../../server/frontend-build";

const meta = await compileAssets();
const dist = activeFrontendDist();
const port = Number(process.env.PORT ?? 4899);
const stylexSheet = `<link rel="stylesheet" href="/${meta.sxName}">`;
const index = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="/${meta.cssName}">${stylexSheet}</head>
<body><div id="root"></div><script type="module" src="/${meta.entryName}"></script></body></html>`;

const server = Bun.serve({
  hostname: "127.0.0.1",
  port,
  async fetch(request) {
    const pathname = new URL(request.url).pathname;
    if (
      pathname === "/" ||
      pathname.startsWith("/__fixtures/transcript-motion")
    )
      return new Response(index, { headers: { "content-type": "text/html" } });
    const file = Bun.file(join(dist, pathname));
    return (await file.exists())
      ? new Response(file)
      : new Response("Not found", { status: 404 });
  },
});
console.log(`Transcript motion fixture ready on ${server.url.origin}`);
