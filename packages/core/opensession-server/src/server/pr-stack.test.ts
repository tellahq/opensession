import { describe, expect, test } from "bun:test";
import { parseStackResponse, unmergedLayersBelow } from "./pr-stack";

/** A GraphQL response for a three-layer stack, viewed from `number`. */
function response(
  number: number,
  layers: Array<{
    number: number;
    position: number;
    state?: string;
    isDraft?: boolean;
  }>,
) {
  const entry = layers.find((l) => l.number === number)!;
  return {
    data: {
      repository: {
        pullRequest: {
          stackEntry: {
            position: entry.position,
            stack: {
              number: 7,
              size: layers.length,
              baseRefName: "main",
              entries: {
                nodes: layers.map((l) => ({
                  position: l.position,
                  pullRequest: {
                    number: l.number,
                    title: `Layer ${l.position}`,
                    url: `https://github.com/o/r/pull/${l.number}`,
                    state: l.state || "OPEN",
                    isDraft: !!l.isDraft,
                    headRefName: `branch-${l.position}`,
                    baseRefName:
                      l.position === 1 ? "main" : `branch-${l.position - 1}`,
                  },
                })),
              },
            },
          },
        },
      },
    },
  };
}

const THREE = [
  { number: 41, position: 1 },
  { number: 42, position: 2 },
  { number: 43, position: 3 },
];

describe("parseStackResponse", () => {
  test("orders layers trunk-first and marks the viewed PR", () => {
    // Deliberately out of order on the wire — GitHub makes no ordering promise.
    const stack = parseStackResponse(
      response(42, [THREE[2], THREE[0], THREE[1]]),
      42,
    );
    expect(stack?.layers.map((l) => l.number)).toEqual([41, 42, 43]);
    expect(stack?.position).toBe(2);
    expect(stack?.size).toBe(3);
    expect(stack?.baseRefName).toBe("main");
    expect(stack?.layers.filter((l) => l.current).map((l) => l.number)).toEqual(
      [42],
    );
  });

  test("a PR in no stack reads as null, not an error", () => {
    expect(
      parseStackResponse(
        { data: { repository: { pullRequest: { stackEntry: null } } } },
        42,
      ),
    ).toBeNull();
  });

  test("a GraphQL error payload reads as null", () => {
    expect(
      parseStackResponse({ errors: [{ message: "Something went wrong" }] }, 42),
    ).toBeNull();
  });

  test("falls back to the layer's own position when the entry has none", () => {
    const raw: any = response(43, THREE);
    delete raw.data.repository.pullRequest.stackEntry.position;
    // Position 0 would put this PR below every layer and silently disable the
    // merge guard, so it must resolve from the layer list instead.
    expect(parseStackResponse(raw, 43)?.position).toBe(3);
  });
});

describe("unmergedLayersBelow", () => {
  test("reports only open layers underneath", () => {
    const stack = parseStackResponse(
      response(43, [
        { number: 41, position: 1, state: "MERGED" },
        { number: 42, position: 2 },
        { number: 43, position: 3 },
      ]),
      43,
    )!;
    expect(unmergedLayersBelow(stack).map((l) => l.number)).toEqual([42]);
  });

  test("the bottom layer is never blocked", () => {
    const stack = parseStackResponse(response(41, THREE), 41)!;
    expect(unmergedLayersBelow(stack)).toEqual([]);
  });

  test("a closed layer below doesn't block — it will never land", () => {
    const stack = parseStackResponse(
      response(42, [
        { number: 41, position: 1, state: "CLOSED" },
        { number: 42, position: 2 },
      ]),
      42,
    )!;
    expect(unmergedLayersBelow(stack)).toEqual([]);
  });
});
