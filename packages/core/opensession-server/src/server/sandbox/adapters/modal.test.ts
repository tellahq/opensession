import { describe, expect, test } from "bun:test";
import { resolveRequestedSandboxGpu, sandboxGpu } from "../config";
import {
  modalCredentials,
  modalMachineShape,
  modalSandboxId,
  modalSettings,
} from "./modal";

describe("Modal machine shape", () => {
  test("a plain session gets the project size, Medium by default", () => {
    expect(modalMachineShape(undefined)).toEqual({ cpu: 4, memoryMiB: 16_384 });
    expect(modalMachineShape({ cpu: 2, memoryMb: 8192 })).toEqual({
      cpu: 2,
      memoryMiB: 8192,
    });
  });

  test("a GPU session never drops below 8 CPU and 32 GB", () => {
    expect(modalMachineShape({ cpu: 2, memoryMb: 8192, gpu: "T4" })).toEqual({
      cpu: 8,
      memoryMiB: 32_768,
      gpu: "T4",
    });
    expect(modalMachineShape({ cpu: 16, memoryMb: 65_536, gpu: "l4" })).toEqual(
      { cpu: 16, memoryMiB: 65_536, gpu: "L4" },
    );
  });

  test("an unknown GPU is dropped rather than requested", () => {
    expect(modalMachineShape({ gpu: "H100" })).toEqual({
      cpu: 4,
      memoryMiB: 16_384,
    });
  });
});

describe("GPU requests", () => {
  test("names normalize and unknown ones are rejected", () => {
    expect(sandboxGpu(" t4 ")).toBe("T4");
    expect(sandboxGpu("A100")).toBeUndefined();
    expect(sandboxGpu(4)).toBeUndefined();
  });

  test("a GPU needs a Modal Sandbox", () => {
    expect(resolveRequestedSandboxGpu(undefined, "box")).toEqual({ ok: true });
    expect(resolveRequestedSandboxGpu("L4", "modal")).toEqual({
      ok: true,
      gpu: "L4",
    });
    expect(resolveRequestedSandboxGpu("L4", "box").ok).toBe(false);
    expect(resolveRequestedSandboxGpu("L4", undefined).ok).toBe(false);
    expect(resolveRequestedSandboxGpu("V100", "modal").ok).toBe(false);
  });
});

describe("Modal credentials and ids", () => {
  test("the secret pairs with the token id setting, or carries both", () => {
    expect(modalCredentials("as-secret1", "ak-id1")).toEqual({
      tokenId: "ak-id1",
      tokenSecret: "as-secret1",
    });
    expect(modalCredentials("ak-id2:as-secret2", undefined)).toEqual({
      tokenId: "ak-id2",
      tokenSecret: "as-secret2",
    });
    expect(modalCredentials("as-secret3", undefined)).toBeNull();
    expect(modalCredentials("", "ak-id")).toBeNull();
  });

  test("settings default the app and trim blanks", () => {
    expect(modalSettings({ tokenId: " ak-x ", region: "" })).toEqual({
      app: "opensession-sandboxes",
      tokenId: "ak-x",
    });
  });

  test("ids are stable per session", () => {
    expect(modalSandboxId("abc")).toBe(modalSandboxId("abc"));
    expect(modalSandboxId("abc").startsWith("md-")).toBe(true);
  });
});
