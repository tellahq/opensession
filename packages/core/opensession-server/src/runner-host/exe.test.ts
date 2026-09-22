import { afterEach, expect, test } from "bun:test";
import {
  isCompiledBinary,
  runnerHostArgv,
  simulatorPortalArgv,
  transcriptSearchWorkerArgv,
} from "./exe";

const execPath = process.execPath;
afterEach(() => {
  Object.defineProperty(process, "execPath", { value: execPath });
});
function pretendCompiled(path = "/opt/acme/opensession") {
  Object.defineProperty(process, "execPath", {
    value: path,
    configurable: true,
    writable: true,
  });
}

test("source mode runs the simulator Portal entry under bun", () => {
  expect(isCompiledBinary()).toBe(false);
  expect(simulatorPortalArgv("/usr/local/bin/bun", "/src/main.ts")).toEqual([
    "/usr/local/bin/bun",
    "/src/main.ts",
  ]);
});

test("compiled mode re-execs the binary with the simulator-portal subcommand", () => {
  pretendCompiled();
  expect(isCompiledBinary()).toBe(true);
  expect(simulatorPortalArgv("/usr/local/bin/bun", "/src/main.ts")).toEqual([
    "/opt/acme/opensession",
    "simulator-portal",
  ]);
  expect(runnerHostArgv("bun", "/src/host.ts", "/spec.json")).toEqual([
    "/opt/acme/opensession",
    "runner-host",
    "/spec.json",
  ]);
  expect(transcriptSearchWorkerArgv("bun", "/src/worker.ts")).toEqual([
    "/opt/acme/opensession",
    "transcript-search-worker",
  ]);
  pretendCompiled("/opt/acme/opensession-0.4.67-darwin-arm64");
  expect(isCompiledBinary()).toBe(true);
  pretendCompiled("/opt/homebrew/bin/bun");
  expect(isCompiledBinary()).toBe(false);
});
