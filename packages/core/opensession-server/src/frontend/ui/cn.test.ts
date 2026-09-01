import { describe, expect, test } from "bun:test";
import {
  cn,
  mergeStylexClassName,
  mergeStylexOverrideClassName,
  mergeStylexProps,
} from "./cn";

describe("StyleX class composition", () => {
  test("keeps semantic or residual classes beside compiled StyleX classes", () => {
    const props = mergeStylexProps(
      ["semantic-hook", false, "data-[open]:block"],
      { color: "x-stylex-color", $$css: true } as never,
    );
    expect(props.className).toBe(
      "semantic-hook data-[open]:block x-stylex-color",
    );
  });

  test("keeps ordinary responsive class maps opaque", () => {
    const responsive = mergeStylexClassName(
      "semantic-hook",
      { width: "x-stylex-width-base", $$css: true } as never,
      { width: "x-stylex-width-phone", $$css: true } as never,
    );
    expect(cn(responsive)).toBe("semantic-hook x-stylex-width-phone");
  });

  test("custom-component caller styles override primitive defaults", () => {
    const caller = mergeStylexOverrideClassName("caller-hook", {
      marginTop: "x-stylex-mt-0",
      $$css: true,
    } as never);
    const props = mergeStylexProps(cn("primitive-hook", caller), {
      marginTop: "x-stylex-mt-default",
      $$css: true,
    } as never);
    expect(props.className).toBe("primitive-hook caller-hook x-stylex-mt-0");
  });
});
