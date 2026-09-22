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
  publishAuthStatus({ required, authenticated: true, admin: true });
  return renderToStaticMarkup(<TeamSection onChanged={() => {}} />);
}

test("GitHub sign-in keeps explicit member admission beside the invite link", () => {
  const markup = renderTeam(true);
  expect(markup).toContain("Add member</span></button>");
  expect(markup).toContain("Copy invite link</span></button>");
  expect(markup).toContain("Add each teammate with their GitHub login");
  expect(markup).toContain("Only listed GitHub accounts can sign in.");
  expect(markup).not.toContain("Teammates are added when they sign in");
});

test("local identity mode still allows name-only members without an invite link", () => {
  const markup = renderTeam(false);
  expect(markup).toContain("Add member</span></button>");
  expect(markup).toContain("Only a name is required.");
  expect(markup).not.toContain("Copy invite link</span></button>");
});
