import { afterEach, describe, expect, test } from "bun:test";
import {
  storeAppendUserLineEarly,
  transcriptLineUser,
} from "./transcript-persistence";
import { setTranscriptForwarder } from "./transcript-forward";

afterEach(() => setTranscriptForwarder(undefined));

describe("detached transcript forwarding", () => {
  test("intercepts early and standing-context writes before the store opens", async () => {
    const batches: Array<{
      engineSessionId: string;
      lines: Record<string, unknown>[];
    }> = [];
    setTranscriptForwarder((engineSessionId, lines) => {
      batches.push({ engineSessionId, lines });
    });

    const line = transcriptLineUser("hello", "prompt-1");
    await storeAppendUserLineEarly("os-session", line);

    expect(batches).toEqual([{ engineSessionId: "os-session", lines: [line] }]);
  });
});
