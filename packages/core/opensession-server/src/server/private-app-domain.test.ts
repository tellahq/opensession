import { describe, expect, test } from "bun:test";
import {
  cloudflareZoneCandidates,
  privateAppCaddyRedirectSite,
  privateAppCaddyReloadCommands,
  privateAppCaddySnippet,
  privateAppCaddyUpstream,
  upsertPrivateAppCaddy,
  vercelZoneForDomain,
} from "./private-app-domain";

describe("managed private app domains", () => {
  test("searches Cloudflare zones from the full hostname to the registrable suffix", () => {
    expect(cloudflareZoneCandidates("os.team.example.com")).toEqual([
      "os.team.example.com",
      "team.example.com",
      "example.com",
    ]);
  });

  test("selects the most specific Vercel zone for a private hostname", () => {
    expect(
      vercelZoneForDomain("os.team.example.com", [
        "example.com",
        "team.example.com",
      ]),
    ).toBe("team.example.com");
    expect(vercelZoneForDomain("os.example.net", ["example.com"])).toBeNull();
  });

  test("generates a tailnet-bound Caddy site with managed certificate paths", () => {
    const snippet = privateAppCaddySnippet(
      "os.example.com",
      "100.64.0.10",
      undefined,
      "100.64.0.10:3850",
      "linux",
    );
    expect(snippet).toContain("bind 100.64.0.10");
    expect(snippet).toContain(
      "tls /etc/opensession/tls/os.example.com.crt /etc/opensession/tls/os.example.com.key",
    );
    expect(snippet).toContain("reverse_proxy 100.64.0.10:3850");
    expect(snippet).toContain("http://os.example.com {");
  });

  test("redirects plain HTTP to HTTPS only for tailnet clients", () => {
    const guard =
      "@outside_tailnet not remote_ip 100.64.0.0/10 fd7a:115c:a1e0::/48";
    expect(
      privateAppCaddyRedirectSite("os.example.com", "100.64.0.10", "linux"),
    ).toBe(
      [
        "http://os.example.com {",
        "    # OPENSESSION PRIVATE APP HTTP REDIRECT",
        "    bind 100.64.0.10",
        `    ${guard}`,
        "    route {",
        "        abort @outside_tailnet",
        "        redir https://{host}{uri} permanent",
        "    }",
        "}",
      ].join("\n"),
    );
    const https = privateAppCaddySnippet("os.example.com", "100.64.0.10").split(
      "\n\n",
    )[0];
    expect(https).toContain(`${guard}\n    abort @outside_tailnet\n    tls `);
  });

  test("macOS listens on every interface and relies on the tailnet guard", () => {
    const snippet = privateAppCaddySnippet(
      "os.example.com",
      "100.64.0.10",
      { certificate: "/state/tls/os.crt", key: "/state/tls/os.key" },
      "127.0.0.1:3850",
      "darwin",
    );
    expect(snippet).not.toContain("bind ");
    expect(snippet.match(/abort @outside_tailnet/g)).toHaveLength(2);
    expect(snippet).toContain("tls /state/tls/os.crt /state/tls/os.key");
  });

  test("reloads systemd Caddy on Linux and Homebrew Caddy on macOS", () => {
    const tools = {
      caddy: "/opt/homebrew/bin/caddy",
      caddyfile: "/opt/homebrew/etc/Caddyfile",
      sudo: "/usr/bin/sudo",
      brew: "/opt/homebrew/bin/brew",
    };
    expect(privateAppCaddyReloadCommands("linux", tools)).toEqual([
      ["/usr/bin/sudo", "-n", "systemctl", "reload", "caddy"],
    ]);
    expect(privateAppCaddyReloadCommands("darwin", tools)).toEqual([
      [
        "/opt/homebrew/bin/caddy",
        "reload",
        "--config",
        "/opt/homebrew/etc/Caddyfile",
        "--adapter",
        "caddyfile",
      ],
      ["/opt/homebrew/bin/brew", "services", "restart", "caddy"],
    ]);
    expect(
      privateAppCaddyReloadCommands("darwin", { ...tools, brew: undefined }),
    ).toHaveLength(1);
  });

  test("targets the configured server listener and normalizes wildcard binds", () => {
    expect(privateAppCaddyUpstream("100.64.0.10", 3850)).toBe(
      "100.64.0.10:3850",
    );
    expect(privateAppCaddyUpstream("0.0.0.0", 4000)).toBe("127.0.0.1:4000");
    expect(privateAppCaddyUpstream("::", 4000)).toBe("[::1]:4000");
  });

  test("adds and then updates only the marked private app site", () => {
    const initial = "example.net {\n    respond ok\n}\n";
    const added = upsertPrivateAppCaddy(
      initial,
      "os.example.com",
      "100.64.0.10",
      undefined,
      "linux",
    );
    expect(added).toContain("# BEGIN OPENSESSION PRIVATE APP");
    const updated = upsertPrivateAppCaddy(
      added,
      "new.example.com",
      "100.64.0.20",
      undefined,
      "linux",
    );
    expect(updated).not.toContain("os.example.com {");
    expect(updated).toContain("new.example.com {");
    expect(updated).toContain("bind 100.64.0.20");
    expect(updated.match(/BEGIN OPENSESSION PRIVATE APP/g)).toHaveLength(1);
    expect(updated).not.toContain("http://os.example.com");
    expect(updated.match(/^http:\/\/new\.example\.com \{$/gm)).toHaveLength(1);
    expect(updated).toStartWith(initial);
    expect(
      upsertPrivateAppCaddy(
        updated,
        "new.example.com",
        "100.64.0.20",
        undefined,
        "linux",
      ),
    ).toBe(updated);
  });

  test("adds the HTTP redirect to a site managed before redirects existed", () => {
    const legacy =
      "os.example.com {\n    # BEGIN OPENSESSION PRIVATE APP\n    bind 100.64.0.10\n    reverse_proxy 127.0.0.1:3850\n    # END OPENSESSION PRIVATE APP\n    header X-Kept yes\n}\n";
    const updated = upsertPrivateAppCaddy(
      legacy,
      "os.example.com",
      "100.64.0.10",
      "127.0.0.1:3850",
      "linux",
    );
    expect(updated).toStartWith("https://os.example.com {\n");
    expect(updated).toContain("    header X-Kept yes\n}");
    expect(updated).toContain("http://os.example.com {");
  });

  test("refuses an unmanaged HTTP site next to a managed HTTPS site", () => {
    const legacy =
      "os.example.com {\n    # BEGIN OPENSESSION PRIVATE APP\n    bind 100.64.0.10\n    reverse_proxy 127.0.0.1:3850\n    # END OPENSESSION PRIVATE APP\n}\n\nhttp://os.example.com {\n    redir https://{host}{uri}\n}\n";
    expect(() =>
      upsertPrivateAppCaddy(
        legacy,
        "os.example.com",
        "100.64.0.10",
        undefined,
        "linux",
      ),
    ).toThrow("unmanaged Caddy site");
    // Addresses that only share a prefix are not conflicts.
    expect(
      upsertPrivateAppCaddy(
        legacy.replace("http://os.example.com", "http://os.example.com.au"),
        "os.example.com",
        "100.64.0.10",
        undefined,
        "linux",
      ),
    ).toContain("http://os.example.com.au {");
  });

  test("does not take ownership of an existing unmarked site", () => {
    expect(() =>
      upsertPrivateAppCaddy(
        "os.example.com {\n    reverse_proxy 127.0.0.1:3850\n}\n",
        "os.example.com",
        "100.64.0.10",
      ),
    ).toThrow("unmanaged Caddy site");
    expect(() =>
      upsertPrivateAppCaddy(
        "http://os.example.com {\n    redir https://{host}{uri}\n}\n",
        "os.example.com",
        "100.64.0.10",
      ),
    ).toThrow("unmanaged Caddy site");
  });
});
