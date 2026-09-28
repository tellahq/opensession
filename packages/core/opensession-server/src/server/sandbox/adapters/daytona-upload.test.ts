import { afterEach, describe, expect, test } from "bun:test";
import {
  DAYTONA_UPLOAD_URL_TTL_SECONDS,
  uploadDaytonaFile,
} from "./daytona-upload";
import {
  FIXTURE_SANDBOX_ID,
  FIXTURE_SIGNING_KEY,
  startUploadFixture,
  type UploadFixture,
} from "./daytona-upload-fixture";

/** Synthetic uploaded credential that must never appear in an error. */
const SECRET = "opensession-test-secret-7f3a";
const SIGNED_URL =
  "https://toolbox.example.test/sbx/files/upload-v2?path=%2Ftmp%2Fx&expires=1&signature=v1_secret";
const signedTarget = { uploadUrl: async () => SIGNED_URL };

async function failure(upload: Promise<void>): Promise<Error> {
  const error = await upload.then(
    () => undefined,
    (e: Error) => e,
  );
  if (!error) throw new Error("expected the upload to fail");
  return error;
}

/** Everything an error exposes to a caller or a log line. */
function expectNoLeak(error: Error, needles: string[]): void {
  expect(error.cause).toBeUndefined();
  const surface = [
    error.message,
    error.stack ?? "",
    String(error),
    JSON.stringify(error, Object.getOwnPropertyNames(error)),
    Bun.inspect(error),
  ].join("\n");
  for (const needle of needles) expect(surface).not.toContain(needle);
}

let fixture: UploadFixture | undefined;
afterEach(() => {
  fixture?.close();
  fixture = undefined;
});

describe("uploadDaytonaFile", () => {
  test("posts native multipart data to the SDK's signed upload URL", async () => {
    fixture = startUploadFixture();
    await uploadDaytonaFile(
      fixture.sandbox,
      "/home/daytona/.opensession/run.json",
      '{"ok":"é"}',
    );
    expect(fixture.uploads).toHaveLength(1);
    const [upload] = fixture.uploads;
    expect(upload).toMatchObject({
      method: "POST",
      pathname: `/toolbox/${FIXTURE_SANDBOX_ID}/files/upload-v2`,
      path: "/home/daytona/.opensession/run.json",
      signatureValid: true,
      fields: ["file"],
      fileName: "run.json",
    });
    expect(Buffer.from(upload!.bytes).toString("utf-8")).toBe('{"ok":"é"}');
    expect(upload!.expiresInSeconds).toBeGreaterThan(0);
    expect(upload!.expiresInSeconds).toBeLessThanOrEqual(
      DAYTONA_UPLOAD_URL_TTL_SECONDS,
    );
  });

  test("keeps binary content byte for byte", async () => {
    fixture = startUploadFixture();
    const bytes = new Uint8Array(256).map((_, i) => i);
    await uploadDaytonaFile(fixture.sandbox, "/tmp/blob.bin", bytes);
    expect(fixture.uploads[0]!.bytes).toEqual(bytes);
  });

  test("passes paths with spaces and relative paths through unchanged", async () => {
    fixture = startUploadFixture();
    await uploadDaytonaFile(fixture.sandbox, "/tmp/a dir/x&y=1.txt", "a");
    await uploadDaytonaFile(fixture.sandbox, "work/notes.txt", "b");
    expect(fixture.uploads.map((upload) => upload.path)).toEqual([
      "/tmp/a dir/x&y=1.txt",
      "work/notes.txt",
    ]);
    expect(fixture.uploads.every((upload) => upload.signatureValid)).toBe(true);
  });

  test("an HTTP error names only the status, even when the body echoes secrets", async () => {
    fixture = startUploadFixture();
    const url = await fixture.sandbox.uploadUrl("/tmp/creds");
    fixture.failNext(
      403,
      `denied ${url} ${SECRET} signing-key=${FIXTURE_SIGNING_KEY}`,
    );
    const error = await failure(
      uploadDaytonaFile(fixture.sandbox, "/tmp/creds", SECRET),
    );
    expect(error.message).toBe("Daytona upload to /tmp/creds failed: HTTP 403");
    expectNoLeak(error, [SECRET, url, "signature=", FIXTURE_SIGNING_KEY]);
  });

  test("never reads the response body, on success or failure", async () => {
    for (const status of [200, 500]) {
      let cancelled = false;
      let pulls = 0;
      // An endless body echoing the secret: buffering it would never finish.
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          pulls++;
          controller.enqueue(
            new TextEncoder().encode(`${SECRET}${SIGNED_URL}`),
          );
        },
        cancel() {
          cancelled = true;
        },
      });
      const result = await uploadDaytonaFile(signedTarget, "/tmp/x", SECRET, {
        fetch: async () => new Response(body, { status }),
      }).then(
        () => undefined,
        (e: Error) => e,
      );
      if (status === 200) expect(result).toBeUndefined();
      else {
        expect(result?.message).toBe(
          "Daytona upload to /tmp/x failed: HTTP 500",
        );
        expectNoLeak(result!, [SECRET, SIGNED_URL, "signature="]);
      }
      expect(cancelled).toBe(true);
      // Only the stream's initial high-water-mark pull, never a drain.
      expect(pulls).toBeLessThanOrEqual(1);
    }
  });

  test("a transport error hides its message and still refuses redirects", async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const error = await failure(
      uploadDaytonaFile(signedTarget, "/tmp/x", SECRET, {
        fetch: async (url, init) => {
          seen = { url, init };
          throw new Error(`Unable to connect: ${url} body=${SECRET}`, {
            cause: new Error(SECRET),
          });
        },
      }),
    );
    expect(seen?.init.redirect).toBe("error");
    expect(seen?.init.method).toBe("POST");
    expect(error.message).toBe(
      "Daytona upload to /tmp/x failed: request failed",
    );
    expectNoLeak(error, [SECRET, SIGNED_URL, "signature="]);
  });

  test("a timeout is reported without the transport message", async () => {
    const error = await failure(
      uploadDaytonaFile(signedTarget, "/tmp/x", SECRET, {
        timeoutMs: 20,
        fetch: (url, init) =>
          new Promise((_, reject) =>
            init.signal!.addEventListener("abort", () =>
              reject(new Error(`aborted ${url} ${SECRET}`)),
            ),
          ),
      }),
    );
    expect(error.message).toBe("Daytona upload to /tmp/x failed: timed out");
    expectNoLeak(error, [SECRET, SIGNED_URL, "signature="]);
  });

  test("a signing failure hides key material", async () => {
    const error = await failure(
      uploadDaytonaFile(
        {
          uploadUrl: async () => {
            throw new Error(
              `signing key ${FIXTURE_SIGNING_KEY} ${SIGNED_URL}`,
              {
                cause: new Error(SECRET),
              },
            );
          },
        },
        "/tmp/x",
        SECRET,
      ),
    );
    expect(error.message).toBe(
      "Daytona upload to /tmp/x failed: could not sign URL",
    );
    expectNoLeak(error, [
      SECRET,
      SIGNED_URL,
      FIXTURE_SIGNING_KEY,
      "signature=",
    ]);
  });
});
