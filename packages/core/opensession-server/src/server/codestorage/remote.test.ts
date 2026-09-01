import { describe, expect, it } from "bun:test";
import { csRepoClaimFromPath, parseCsRemote } from "./remote";

describe("parseCsRemote", () => {
  it("parses a plain remote", () => {
    expect(parseCsRemote("https://acme.code.storage/team/widget.git")).toEqual({
      org: "acme",
      repoId: "team/widget",
    });
  });

  it("parses an ephemeral remote to the base repo with ephemeral: true", () => {
    expect(
      parseCsRemote("https://acme.code.storage/team/widget+ephemeral.git"),
    ).toEqual({
      org: "acme",
      repoId: "team/widget",
      ephemeral: true,
    });
  });

  it("parses an ephemeral remote without .git", () => {
    expect(parseCsRemote("https://acme.code.storage/widget+ephemeral")).toEqual(
      {
        org: "acme",
        repoId: "widget",
        ephemeral: true,
      },
    );
  });

  it("parses an ephemeral remote with embedded credentials", () => {
    expect(
      parseCsRemote("https://t:jwt@acme.code.storage/widget+ephemeral.git"),
    ).toEqual({
      org: "acme",
      repoId: "widget",
      ephemeral: true,
    });
  });

  it("rejects a bare +ephemeral path (no repo id left)", () => {
    expect(
      parseCsRemote("https://acme.code.storage/+ephemeral.git"),
    ).toBeNull();
  });

  it("rejects non-code.storage URLs", () => {
    expect(parseCsRemote("https://github.com/owner/repo.git")).toBeNull();
    expect(parseCsRemote("https://api.acme.code.storage/repo.git")).toBeNull();
  });
});

describe("csRepoClaimFromPath", () => {
  it("derives the bare repo claim from a plain request path", () => {
    expect(csRepoClaimFromPath("/team/widget.git")).toBe("team/widget");
  });

  it("strips a +ephemeral ref-namespace suffix", () => {
    expect(csRepoClaimFromPath("/team/widget+ephemeral.git")).toBe(
      "team/widget",
    );
    expect(csRepoClaimFromPath("widget+ephemeral")).toBe("widget");
  });
});
