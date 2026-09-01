# Networking: keeping Open Session private

**By default, Open Session has no sign-in gate.** It trusts everyone who can
reach the address it binds to. In that mode, the "user" in the UI is a
self-selected display name in localStorage. It drives attribution and per-user
tool scoping, not access control. Optional GitHub-backed sign-in replaces that
name with a verified team identity, but a private network remains the
recommended boundary.

On a default install, anyone who reaches the app can start sessions that
execute code on your box, read registered repositories, and use your model
subscriptions. Treat the bind address as the security boundary.

## Two separate connections

Open Session has a private app for people and a separate public endpoint for
external services. Configuring one never exposes the other.

| Connection           | Used by                              | Address                                              | Setup                                                             |
| -------------------- | ------------------------------------ | ---------------------------------------------------- | ----------------------------------------------------------------- |
| **Private app**      | Teammates and server administrators  | A private-network or access-controlled HTTPS address | Use Tailscale, an SSH tunnel, or an identity-gated private tunnel |
| **Public callbacks** | GitHub webhooks and remote Sandboxes | A different public HTTPS address                     | Choose Cloudflare Tunnel or Direct HTTPS with Caddy               |

Tailscale keeps teammate and server traffic private. Cloudflare Tunnel can front
the private app only when Cloudflare Access or an equivalent identity policy
protects it. A bare Tunnel hostname is public and must never route directly to
the private app.

### Private app quick reference

|                     |                                                                                                        |
| ------------------- | ------------------------------------------------------------------------------------------------------ |
| Default             | binds `127.0.0.1`, reachable only from the box itself                                                  |
| Sharing with a team | bind a **Tailscale** IP, or keep loopback behind an identity-gated private tunnel                      |
| Occasional access   | leave it on `127.0.0.1`, use an **SSH tunnel**                                                         |
| Never               | expose port 3850 with `HOST=0.0.0.0`, a bare Cloudflare Tunnel, or an unprotected public reverse proxy |

## Tailscale for private access (recommended)

[Tailscale](https://tailscale.com) puts your machines on a private WireGuard
network. Authorized tailnet devices can reach one another without opening a
public port. The free tier covers a small team.

### 1. Install it on the box

For a fresh Open Session install on Linux, install Tailscale together with
Caddy and the lego certificate helper. The latter two prepare the box for the
private HTTPS and friendly-domain options below:

```sh
curl -fsSL https://raw.githubusercontent.com/tellahq/opensession/main/install.sh | bash -s -- --tailscale --caddy
```

The Open Session installer only installs Tailscale automatically when
passwordless `sudo` is available. If it reports that `sudo` is needed, or if
Open Session is already installed, add Tailscale directly. You do not need to
reinstall Open Session:

```sh
curl -fsSL https://tailscale.com/install.sh | sh
```

On macOS, use the [Tailscale download page](https://tailscale.com/download/mac).
Check with `tailscale ip -4`; if it prints a `100.x` address, you are already on
a tailnet and can skip to step 3.

### 2. Join your network

```sh
sudo tailscale up
```

It prints a URL — open it and authenticate. On a headless box, use
`sudo tailscale up --ssh` if you also want Tailscale SSH.

This is the step the installer cannot do without your account. For an
unattended fresh install, it can join with a Tailscale [auth
key](https://tailscale.com/kb/1085/auth-keys):

```sh
curl -fsSL https://raw.githubusercontent.com/tellahq/opensession/main/install.sh | TS_AUTHKEY=tskey-auth-... bash -s -- --tailscale --caddy
```

The environment variable belongs before `bash`, not before `curl`, so the
installer receives it. See [Install with Tailscale](install.md#install-with-tailscale).

### 3. Disable key expiry for the server

Tailscale node keys expire by default, which can disconnect an unattended
server until someone signs in again. In the [Tailscale admin
console](https://login.tailscale.com/admin/machines), open **Machines**, find
the Open Session server, open its **…** menu, and choose **Disable key
expiry**.

Do this for the trusted server, not automatically for every device. Disabling
expiry means a stolen server identity remains valid until you revoke it. See
[Tailscale's key expiry documentation](https://tailscale.com/kb/1028/key-expiry).

### 4. Find the tailnet address

```sh
tailscale ip -4        # e.g. 100.64.12.34
```

### 5. Bind Open Session to it

If you joined the tailnet before **interactive** onboarding (`--advanced` or
`opensession onboard`), the wizard offers the tailnet address as its bind
default. The normal non-interactive installer still chooses `127.0.0.1` even
when Tailscale is already connected. To change either kind of install:

```sh
opensession bind
```

That changes `server.host` in `~/.opensession/config.json` and restarts an
installed service, because a live config re-read cannot move the listening
socket. When the host changes, it also replaces an existing `HOST` entry in
`~/.opensession.env`. The configured app origin and an existing
`OPENSESSION_UI_BASE` entry follow only while the configured origin still
points at the old bind address. `opensession bind <ip>` names an address
explicitly, including `127.0.0.1` when moving back behind a local proxy.

Then reach it from any device on the tailnet at
`http://<tailnet-ip>:<port>` (`3850` by default; `PORT` overrides
`server.port`).

If you manage the files by hand instead, change `HOST` in
`~/.opensession.env` (it overrides `server.host` in config.json), set
`OPENSESSION_UI_BASE` to match — or links posted into Slack, Linear and notes
will point somewhere unreachable — and restart.

### 6. Install Tailscale on the devices you want to use

Phone, laptop, whatever. They must be able to reach the server through the
same tailnet. Tailscale ACLs and grants still apply; with the default permissive
policy, adding a device grants access and removing it revokes access.

### Nicer URLs and HTTPS

MagicDNS gives the box a stable name, and Tailscale can issue a certificate
for that exact `*.ts.net` name after HTTPS certificates are enabled for the
tailnet:

```sh
sudo tailscale cert <machine>.<tailnet>.ts.net
```

To proxy to `127.0.0.1:3850`, first move Open Session back to loopback with
`opensession bind 127.0.0.1`; otherwise point the proxy at the tailnet address
where Open Session is actually listening. Configure the proxy with the
certificate files and bind the proxy itself to the tailnet address. A proxy
adds TLS, not authentication.

### Verify you are actually private

```sh
# Linux: 3850 should use loopback or a 100.x IP; 3860 defaults to loopback.
ss -tlnp | grep -E '3850|3860'

# macOS equivalent:
lsof -nP -iTCP -sTCP:LISTEN | grep -E ':(3850|3860)\b'

# From somewhere off the tailnet (your phone on cellular, a cloud shell):
curl -m 5 http://<public-ip>:3850/    # must fail
```

On a cloud box, also check the firewall — the security group or firewall rules
should not open 3850 or 3860 directly. Cloudflare Tunnel or Caddy terminates
TLS in front of loopback 3860. See [ec2.md](ec2.md#networking).

## An optional friendly private domain (os.company.dev)

`http://100.64.12.34:3850` works but is unpleasant to type and impossible to
remember. You can put a real name and a real certificate in front of it without
exposing the app.

The trick is that **a public DNS record may point at a private address.** Anyone
can resolve `os.company.dev` to `100.64.12.34`; only devices on your tailnet can
reach it. The name is not the security boundary. Private network reachability is.

### Managed setup with Cloudflare or Vercel DNS

This built-in friendly-domain flow uses Tailscale as its private network.
Cloudflare and Vercel authorize DNS-01 certificate issuance; they do not expose
or carry app traffic. For a private Cloudflare Tunnel, keep Open Session on
loopback and protect the Tunnel application with Cloudflare Access instead.

Open **Settings → Domains and ingress → Private app**, choose the DNS provider,
and provide:

1. A domain managed by Cloudflare or Vercel, such as `os.company.dev`.
2. An email address for Let’s Encrypt expiry notices.
3. A DNS API token scoped to the zone. Cloudflare needs **Zone:DNS Edit** and
   **Zone:Zone Read**. Vercel needs access to the team that owns the domain.

Then click **Set up private domain**. Open Session:

- creates or updates a DNS-only A record pointing to the server's Tailscale IP;
- requests a Let's Encrypt certificate using DNS-01;
- stores the certificate and private key with restricted filesystem permissions;
- adds a Caddy site bound only to the Tailscale address;
- verifies the HTTPS address; and
- checks renewal daily, reloading Caddy when the certificate changes.

The DNS token is stored at `~/.opensession/private-app-dns.json` with mode 0600.
It is used only for the selected domain's DNS record and ACME challenge, is never
returned by the API, and should be restricted to that one Cloudflare zone.

Install the required tools before setup if they are not already present:

```sh
curl -fsSL https://raw.githubusercontent.com/tellahq/opensession/main/install.sh \
  | bash -s -- --caddy --no-onboard
```

### Externally managed certificate

Expand **Use an externally managed certificate** only when existing
infrastructure already issues and renews the certificate. Open Session shows the
DNS record, certificate paths, and generated Caddy site, but does not take over
certificate ownership.

Your host is not reachable from the internet, so HTTP-01 cannot work. Use
**DNS-01**, which proves control of the domain by writing a temporary TXT record.
Most DNS providers are supported by [lego](https://go-acme.github.io/lego/).
Store the resulting files at:

```text
/etc/opensession/tls/os.company.dev.crt
/etc/opensession/tls/os.company.dev.key
```

Keep Open Session on `127.0.0.1:3850` and bind Caddy only to the Tailscale
address:

```caddy
os.company.dev {
    bind 100.64.12.34
    tls /etc/opensession/tls/os.company.dev.crt /etc/opensession/tls/os.company.dev.key
    reverse_proxy 127.0.0.1:3850
}
```

The `bind` line is essential. Without it Caddy may listen on every interface,
quietly undoing the private-network boundary. A TLS proxy adds encryption, not
authentication.

After verifying the address, save it in the Advanced flow. Open Session updates
`server.publicBaseUrl` and `OPENSESSION_UI_BASE`; restart once to update links
generated by the server.

### Verify it from outside

```sh
# on the tailnet
curl -I https://os.company.dev

# off the tailnet — must fail to connect, NOT return 401
curl -m 5 -I https://os.company.dev
```

A connection timeout is the correct result. A `401` would mean the port is open
to the internet and only a login stands in the way, which is a different and
much weaker position.

## SSH tunnel

If you are the only user and only need occasional access, skip Tailscale:

```sh
ssh -L 3850:127.0.0.1:3850 user@box
# then open http://127.0.0.1:3850 locally
```

Nothing is exposed; the tunnel exists only while the SSH session does.

## If you must expose it more widely

Turn on real authentication first. Set
`integrations.github.userPrAuth: true`, enable Device Flow on the GitHub App,
and configure its client ID and client secret. The private app API and UI
WebSocket then require a session cookie or bearer token, apart from explicit
health, update-feed, Runner and broker routes. Only
GitHub logins mapped by `identity.team[].github` can sign in. See
[github.md](github.md#per-user-github-auth-prs-as-the-session-owner).

Even then, prefer keeping the network boundary. Sign-in protects the UI and
API; it is not a reason to put an agent runner on the public internet.

## Public ingress is separate

By default, Open Session binds one fail-closed public gateway on
`127.0.0.1:3860`. It serves exact registered webhook and OAuth routes, remote
Sandbox WebSockets, and workload identity. Unknown methods and paths return a
bodyless 404. The private app on 3850 is not part of this listener and must not
be routed through the public origin. Upgrade and workload-token exchange
attempts are limited to 30 per client IP per minute.

Choose exactly one way to publish that callback listener:

| Method                      | Address     | Inbound ports | Best when                                                   |
| --------------------------- | ----------- | ------------- | ----------------------------------------------------------- |
| **Cloudflare Tunnel**       | Your domain | None          | Your DNS is on Cloudflare and you do not want to open ports |
| **Direct HTTPS with Caddy** | Your domain | 80 and 443    | You use any DNS provider and can expose the server directly |

Each registered route keeps its own authentication. Provider webhooks verify
their configured signatures, including `GITHUB_WEBHOOK_SECRET`,
`SLACK_SIGNING_SECRET`, `LINEAR_WEBHOOK_SECRET`, `PLAIN_WEBHOOK_SECRET`,
`STRIPE_WEBHOOK_SECRET`, and `integrations.codestorage.webhookSecret`. Other
public routes use OAuth state, path secrets, or short-lived tokens as
appropriate. Routes that require credentials reject missing credentials;
`/ingress-health` is intentionally public.

Configure the canonical origin in **Settings → Domains and ingress → Public callbacks** or directly. It
must be a public HTTPS origin on a hostname different from the private app,
with no path, credentials, or custom port:

```json
{
  "server": {
    "publicBaseUrl": "https://sessions.tailnet.example.com"
  },
  "ingress": {
    "publicBaseUrl": "https://ingress.example.com",
    "exposure": "custom"
  }
}
```

`OPENSESSION_INGRESS_BASE` overrides the configured ingress URL. Setup guides,
webhook URLs, remote Sandbox callbacks, and the workload-identity issuer all
use this origin. Session links and authenticated app callbacks continue to use
the independent private app origin.

### Cloudflare Tunnel

Install `cloudflared` and create a named tunnel, then enter its UUID,
connector token and public URL in Settings. Open Session stores the token in a
`0600` state file without returning it through the API, runs `cloudflared` with
that token file, and restarts the connector if it exits. Point the public
hostname at the tunnel and set its only service to:

```text
http://127.0.0.1:3860
```

The required DNS record is:

```text
CNAME ingress.example.com <tunnel-id>.cfargotunnel.com
```

Only the ingress gateway belongs in the tunnel. Never add port 3850 unless you
have separately decided to make the authenticated app public.

### Direct HTTPS with Caddy

Install Caddy, point the hostname's A/AAAA records at the server's **public**
address, and allow inbound TCP 80 and 443. Then choose Direct HTTPS with Caddy in
**Settings → Domains and ingress → Public callbacks**. Managed setup requires passwordless `sudo` for the service user. It
backs up and updates `/etc/caddy/Caddyfile`, validates the complete file, and
reloads Caddy; validation, install, reload, or config-save failures restore the
prior file. DNS may still be propagating afterward, so health remains
**Waiting for DNS** rather than rolling back a valid listener.

If Open Session cannot discover a NATed server's public address, set
`OPENSESSION_PUBLIC_IPV4` or `OPENSESSION_PUBLIC_IPV6` in
`~/.opensession.env` and restart. `OPENSESSION_CADDYFILE` overrides the managed
Caddyfile path. The application, not Caddy, owns the exact public route
allowlist:

```caddy
ingress.example.com {
    # BEGIN OPENSESSION SANDBOX INGRESS
    handle {
        reverse_proxy 127.0.0.1:3860
    }
    # END OPENSESSION SANDBOX INGRESS
}
```

See the maintained
[`deploy/caddy/sandbox-ingress.caddy.example`](../../deploy/caddy/sandbox-ingress.caddy.example).
