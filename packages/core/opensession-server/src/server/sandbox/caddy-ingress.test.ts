import { describe, expect, test } from "bun:test";
import {
  caddyIngressSnippet,
  upsertCaddyIngress,
  ingressHostsFromCaddy,
} from "./caddy-ingress";

describe("public Caddy ingress", () => {
  test("routes the whole fail-closed gateway through one local port", () => {
    const snippet = caddyIngressSnippet("https://hooks.example.com");
    expect(snippet).toContain("hooks.example.com {");
    expect(snippet).toContain("reverse_proxy 127.0.0.1:3860");
    expect(snippet).not.toContain("3848");
    expect(snippet).not.toContain("3850");
  });

  test("discovers a host already routing to the unified gateway", () => {
    expect(
      ingressHostsFromCaddy({
        apps: {
          http: {
            servers: {
              ingress: {
                routes: [
                  {
                    match: [{ host: ["hooks.example.com"] }],
                    handle: [
                      {
                        handler: "reverse_proxy",
                        upstreams: [{ dial: "127.0.0.1:3860" }],
                      },
                    ],
                  },
                ],
              },
            },
          },
        },
      }),
    ).toEqual(["hooks.example.com"]);
  });

  test("replaces the retired webhook fallback and old path routes", () => {
    const source = `hooks.example.com {
    handle /run-ws/* { reverse_proxy localhost:3860 }
    handle /rpc-ws { reverse_proxy localhost:3860 }
    handle { reverse_proxy localhost:3848 }
}
`;
    const installed = upsertCaddyIngress(source, "https://hooks.example.com");
    expect(installed).toContain("# BEGIN OPENSESSION SANDBOX INGRESS");
    expect(installed.match(/127\.0\.0\.1:3860/g)).toHaveLength(1);
    expect(installed).not.toContain("3848");
    expect(upsertCaddyIngress(installed, "https://hooks.example.com")).toBe(
      installed,
    );
  });

  test("creates a dedicated, interface-bound host without exposing the private app", () => {
    const installed = upsertCaddyIngress(
      "admin.example.com {\n    bind 100.64.0.10\n    reverse_proxy 127.0.0.1:3850\n}\n",
      "https://hooks.example.com",
      "172.31.21.26",
    );
    expect(installed).toContain("hooks.example.com {");
    expect(installed).toContain("bind 172.31.21.26");
    expect(installed).toContain("reverse_proxy 127.0.0.1:3860");
    expect(installed.match(/3850/g)).toHaveLength(1);
    expect(
      upsertCaddyIngress(
        installed,
        "https://hooks.example.com",
        "172.31.21.26",
      ),
    ).toBe(installed);
  });

  test("refuses duplicate target site blocks", () => {
    expect(() =>
      upsertCaddyIngress(
        "hooks.example.com { respond ok }\nhooks.example.com { respond ok }\n",
        "https://hooks.example.com",
      ),
    ).toThrow("more than once");
  });
});
