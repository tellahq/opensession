import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const saved = process.env.OPENSESSION_STATE_DIR;
process.env.OPENSESSION_STATE_DIR = mkdtempSync(
  join(tmpdir(), "upload-routes-"),
);
const { handleUploadRoutes } = await import("./uploads");
if (saved === undefined) delete process.env.OPENSESSION_STATE_DIR;
else process.env.OPENSESSION_STATE_DIR = saved;

// Behind the gateway proxy the handler sees the internal backend URL while
// the browser's Origin is the public host. That is a same-origin request.
test("accepts a browser upload whose Origin differs from the backend URL", async () => {
  const url = new URL("http://127.0.0.1:39421/api/uploads");
  const req = new Request(url, {
    method: "POST",
    headers: {
      origin: "https://opensession.example.test",
      "sec-fetch-site": "same-origin",
      "content-type": "application/json",
    },
    body: JSON.stringify({ name: "capture.har", size: 20 * 1024 * 1024 }),
  });
  const res = await handleUploadRoutes({
    req,
    url,
    path: url.pathname,
    publicPrefix: "",
  });
  expect(res?.status).toBe(200);
  expect((await res!.json()).chunks).toBe(2);
});
