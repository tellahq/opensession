import { describe, expect, test } from "bun:test";

const source = (path: string) => Bun.file(`${import.meta.dir}/${path}`).text();

describe("PR contract ownership", () => {
  test("keeps provider-neutral contracts out of host implementations", async () => {
    const [contract, info, host, stack, codeStorage] = await Promise.all([
      source("pr-contract.ts"),
      source("pr-info.ts"),
      source("pr-host.ts"),
      source("pr-stack.ts"),
      source("codestorage/pr-host.ts"),
    ]);

    const infoContracts = [
      "MergeMethod",
      "MutationPrMeta",
      "PrCheck",
      "PrComment",
      "PrCommentInput",
      "PrCommit",
      "PrCommitNote",
      "PrDetails",
      "PrDiffData",
      "PrFile",
      "PrReviewComment",
      "PrReviewEvent",
      "PrReviewInput",
      "PrReviewer",
      "PrStaging",
    ];
    for (const name of infoContracts) {
      expect(contract).toMatch(
        new RegExp(`export (?:interface|type) ${name}\\b`),
      );
      expect(info).not.toMatch(
        new RegExp(`export (?:interface|type) ${name}\\b`),
      );
    }
    for (const name of ["PrStack", "PrStackLayer"])
      expect(stack).not.toMatch(new RegExp(`export interface ${name}\\b`));
    expect(host).not.toMatch(/export interface PrHostCapabilities\b/);

    expect(info).toContain('from "./pr-contract"');
    expect(info).not.toContain('from "./pr-host"');
    expect(host).toContain('from "./pr-contract"');
    expect(stack).toContain('from "./pr-contract"');
    expect(codeStorage).toContain('from "../pr-contract"');
    expect(codeStorage).not.toContain('from "../pr-info"');
    expect(contract).not.toMatch(/from "\.\/pr-(?:info|host|stack)"/);
  });

  test("preserves the legacy type export paths", async () => {
    const [info, host, stack] = await Promise.all([
      source("pr-info.ts"),
      source("pr-host.ts"),
      source("pr-stack.ts"),
    ]);

    expect(info).toMatch(
      /export type \{[\s\S]*PrDetails[\s\S]*\} from "\.\/pr-contract"/,
    );
    expect(host).toContain(
      'export type { PrHostCapabilities } from "./pr-contract"',
    );
    expect(stack).toContain(
      'export type { PrStack, PrStackLayer } from "./pr-contract"',
    );
  });
});
