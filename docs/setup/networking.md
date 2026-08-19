# Networking: keeping Open Session private

**Open Session has no built-in authentication.** It trusts everyone who can
reach the address it binds to. The "user" in the UI is a self-selected display
name in localStorage — it drives attribution and per-user tool scoping, not
access control.

That is a deliberate design choice, not an oversight: safety comes from
least-privilege scoping of what *runs* can do, and from only being reachable on
a private network. The second half is your job.

Anyone who reaches it can start sessions that execute code on your box, read
every repository you have registered, and use your model subscriptions. Treat
the bind address as the security boundary.

## The short version

| | |
| --- | --- |
| Default | binds `127.0.0.1` — reachable only from the box itself |
| Sharing with a team | bind a **Tailscale** IP |
| Occasional access | leave it on `127.0.0.1`, use an **SSH tunnel** |
| Never | `HOST=0.0.0.0`, a public port, or a reverse proxy without auth |

## Tailscale (recommended)

[Tailscale](https://tailscale.com) puts your machines on a private WireGuard
network. Devices reach each other; nothing else can. The free tier covers a
small team.

### 1. Install it on the box

**The Open Session installer does this with `--tailscale`** (it is off by
default: the default install binds loopback only). Otherwise
`curl -fsSL https://tailscale.com/install.sh | sh`. Check with `tailscale ip
-4`; if it prints a `100.x` address you are already on a tailnet and can skip
to step 3.

To install it by hand:

```sh
curl -fsSL https://tailscale.com/install.sh | sh
```

### 2. Join your network

```sh
sudo tailscale up
```

It prints a URL — open it and authenticate. On a headless box, use
`sudo tailscale up --ssh` if you also want Tailscale SSH.

This is the step the installer cannot do for you, because it needs your
account. It *can* if you give it an
[auth key](https://tailscale.com/kb/1085/auth-keys) as `TS_AUTHKEY` — see
[install.md](install.md#why-tailscale-is-installed-by-default).

### 3. Find the tailnet address

```sh
tailscale ip -4        # e.g. 100.64.12.34
```

### 4. Bind Open Session to it

If you joined the tailnet *before* onboarding, this is already done — the
wizard offers the tailnet address as the bind default. Otherwise:

```sh
opensession bind
```

That is the whole fix: it rewrites the bind address (and the public base URL,
when it still pointed at the old address) in both `~/.opensession/config.json`
and `~/.opensession.env`, then restarts the service — the bind address is the
one setting a live config re-read cannot apply. `opensession bind <ip>` names
an address explicitly, for boxes that are not on a tailnet.

Then reach it from any device on the tailnet at `http://<tailnet-ip>:3850`.

If you manage the files by hand instead, change `HOST` in
`~/.opensession.env` (it overrides `server.host` in config.json), set
`OPENSESSION_UI_BASE` to match — or links posted into Slack, Linear and notes
will point somewhere unreachable — and restart.

### 5. Install Tailscale on the devices you want to use

Phone, laptop, whatever. They must be on the same tailnet. That is the whole
access-control story — adding a device to the tailnet grants access, removing
it revokes access.

### Nicer URLs and HTTPS

MagicDNS gives the box a stable name, and Tailscale can issue a real
certificate for it:

```sh
sudo tailscale cert <machine>.<tailnet>.ts.net
```

Point a local reverse proxy (Caddy, nginx) at `127.0.0.1:3850` using that
certificate. This is how Tella runs it. Note that a proxy does not add
authentication — it only adds TLS. Reachability is still whatever the proxy
binds to, so bind the proxy to the tailnet address too.

### Verify you are actually private

```sh
# What is Open Session listening on? Should be 127.0.0.1 or a 100.x tailnet IP.
ss -tlnp | grep -E '3850|3848'

# From somewhere off the tailnet (your phone on cellular, a cloud shell):
curl -m 5 http://<public-ip>:3850/    # must fail
```

On a cloud box, also check the firewall — the security group or firewall rules
should not open 3850 or 3848 at all. See [ec2.md](ec2.md#networking).

## A custom domain (os.company.dev)

`http://100.64.12.34:3850` works but is unpleasant to type and impossible to
remember. You can put a real name and a real certificate in front of it without
exposing anything.

The trick is that **a public DNS record may point at a private address.** Anyone
can resolve `os.company.dev` to `100.64.12.34`; only devices on your tailnet can
reach it. Publishing the name costs you nothing, because the name was never the
security boundary — reachability is.

### 1. Point the name at the tailnet address

```sh
tailscale ip -4        # e.g. 100.64.12.34
```

Create an **A record** for `os.company.dev` with that value, at whatever DNS
provider you use. An A record, not a CNAME — you are pointing at an address, and
a CNAME would need something else already resolving to it.

(If you would rather not publish the mapping at all, Tailscale's MagicDNS gives
you `<machine>.<tailnet>.ts.net` for free with no public record. You lose the
custom name and gain slightly more privacy.)

### 2. Get a certificate

Your host is not reachable from the internet, so the usual HTTP-01 ACME
challenge cannot work — Let's Encrypt cannot connect to it. Use **DNS-01**,
which proves control of the domain by writing a TXT record instead.

With [lego](https://go-acme.github.io/lego/) and, say, Cloudflare DNS:

```sh
CLOUDFLARE_DNS_API_TOKEN=... lego \
  --email you@company.dev \
  --dns cloudflare \
  --domains os.company.dev \
  run
```

Most providers have a lego plugin; Caddy and Traefik can also do DNS-01
themselves with the matching plugin, which avoids running lego separately.

Renewal is the part people forget — put it on a timer.

### 3. Terminate TLS in front of the server

Keep Open Session on `127.0.0.1:3850` and let a proxy hold the certificate.
Caddy, bound to the tailnet address:

```caddy
os.company.dev {
    bind 100.64.12.34
    tls /etc/lego/certificates/os.company.dev.crt /etc/lego/certificates/os.company.dev.key
    reverse_proxy 127.0.0.1:3850
}
```

The `bind` line is the important one. Without it Caddy listens on every
interface, which quietly undoes the whole arrangement — the certificate makes it
look secure while the port is open to the world.

**A TLS proxy adds encryption, not authentication.** Anything that can reach the
proxy can use Open Session.

### 4. Tell Open Session its own name

```sh
# ~/.opensession.env
OPENSESSION_UI_BASE=https://os.company.dev
```

Links posted into Slack, Linear and notes are built from this. Get it wrong and
everything works except that every link you share points somewhere unreachable.

The clients (Chrome extension, Electron shell, Swift app) each take a server
address too — see [instance-configuration.md](../instance-configuration.md).

### 5. Check it from outside

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

Turn on real authentication first. `integrations.github` adds GitHub sign-in:
every `/api/*` request and the UI WebSocket require a session cookie, and only
logins listed in `identity.team` can sign in. See
[github.md](github.md#per-user-github-auth-prs-as-the-session-owner).

Even then, prefer keeping the network boundary. Sign-in protects the UI and
API; it is not a reason to put an agent runner on the public internet.

## The webhook server is separate

The webhook server (default port **3848**) is a second HTTP listener for
inbound GitHub, Linear, Plain and Stripe events. If you use those integrations,
*that* port needs to be reachable by the provider — which means it cannot live
on the tailnet alone.

Expose 3848 only, never 3850, and only through something that terminates TLS.
Every webhook route verifies a signature (`GITHUB_WEBHOOK_SECRET`,
`LINEAR_WEBHOOK_SECRET`, `PLAIN_WEBHOOK_SECRET`, `STRIPE_WEBHOOK_SECRET`), so
set those — an unsigned webhook endpoint is an open door into your automations.

If you do not use inbound webhooks, leave 3848 on `127.0.0.1` and forget it
exists.

### Remote-sandbox ingress

Daytona and Modal also need the isolated sandbox callback and workload-identity
routes on the webhook
hostname. They terminate on the isolated listener at `127.0.0.1:3860`; they
must never expose the main UI on 3850:

```caddy
ingress.example.com {
    handle /run-ws/* {
        reverse_proxy 127.0.0.1:3860
    }
    handle /rpc-ws {
        reverse_proxy 127.0.0.1:3860
    }
    handle /ingress-health {
        reverse_proxy 127.0.0.1:3860
    }
    handle /workload-identity/* {
        reverse_proxy 127.0.0.1:3860
    }
    handle {
        reverse_proxy 127.0.0.1:3848
    }
}
```

Workspace → Sandboxes generates this block for the selected origin. The
repository CLI finds the matching host in `/etc/caddy/Caddyfile`, owns a marked
route section inside it (or creates the host), backs up the file, validates,
reloads and publicly verifies it:

```sh
opensession sandbox ingress install https://ingress.example.com
```

On any failure it restores and reloads the complete prior Caddyfile. The same
maintained example lives at `deploy/caddy/sandbox-ingress.caddy.example`.
