import { afterEach, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { TeamSection } from "./SetupTeam";
import { publishAuthStatus } from "./UserPicker";

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");

afterEach(() => {
  publishAuthStatus({ required: false, authenticated: false });
  if (originalWindow)
    Object.defineProperty(globalThis, "window", originalWindow);
  else Reflect.deleteProperty(globalThis, "window");
});

function renderTeam(required: boolean): string {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: new EventTarget(),
  });
  publishAuthStatus({ required, authenticated: true });
  return renderToStaticMarkup(<TeamSection onChanged={() => {}} />);
}

test("GitHub sign-in describes automatic enrollment and optional roster editing", () => {
  const markup = renderTeam(true);
  expect(markup).toContain("Add member</span></button>");
  expect(markup).toContain("Copy invite link</span></button>");
  expect(markup).toContain(
    "Anyone who can reach this server can join by signing in with GitHub.",
  );
  expect(markup).toContain("Every member can manage the workspace.");
  expect(markup).not.toContain("Only listed GitHub accounts can sign in.");
});

test("local identity mode still allows name-only members without an invite link", () => {
  const markup = renderTeam(false);
  expect(markup).toContain("Add member</span></button>");
  expect(markup).toContain("Only a name is required.");
  expect(markup).not.toContain("Copy invite link</span></button>");
});
