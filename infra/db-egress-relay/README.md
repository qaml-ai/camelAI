# Database egress relay (SOCKS5 behind the sandbox-host tunnel)

Gives Cloudflare-hosted db-query sandbox containers a **static egress IP** for
customer database traffic without opening any inbound port on the Azure VM.

```text
DbQueryContainer (Cloudflare)
  └─ cloudflared access tcp ──WSS/443──▶ Cloudflare edge (Access service-token check)
        └─ existing cloudflared tunnel (VM dials out; NSG stays deny-all-inbound)
              └─ gost SOCKS5 on 127.0.0.1:1080 (this directory)
                    └─ TCP to the customer database, egressing from the VM's
                       static public IP (SANDBOX_OUTBOUND_IP, 20.46.233.68 prod)
```

The Cloudflare-side consumer is `workers/main/src/db-query-service.ts` +
`workers/main/db-query-sandbox-assets/`; the end-to-end design doc is
`docs/db-egress-relay.md`.

## Deploy on the sandbox host VM

1. Copy this directory to the VM (e.g. `/opt/chiridion/db-egress-relay`).
2. `cp gost.yaml.example gost.yaml && chmod 600 gost.yaml`, replace the
   `REPLACE_ME` username/password with strong random values.
3. `docker compose up -d` (VM already runs Docker).
4. Smoke-test locally on the VM — must succeed to a public host and be
   refused to an internal one:

   ```bash
   curl -x socks5h://USER:PASS@127.0.0.1:1080 https://example.com -sSo /dev/null -w '%{http_code}\n'   # 200
   curl -x socks5h://USER:PASS@127.0.0.1:1080 http://169.254.169.254/ -sS -m 5; echo "exit=$?"          # refused
   ```

## Cloudflare configuration (one-time per environment)

1. **Tunnel public hostname** — on the VM's existing tunnel, add
   `db-relay.<env-domain>` (e.g. `db-relay.camelai.dev`, staging equivalent)
   with service `tcp://localhost:1080`.
2. **Access application** — create a self-hosted Access app for that hostname,
   create a **service token**, and give the app a single policy: Service Auth →
   allow that token. No identity-based policies; nothing else may reach it.
3. **Worker secrets/vars** (main worker, per environment):
   - `DB_EGRESS_RELAY_HOSTNAME` (var) — the hostname from step 1.
   - `DB_EGRESS_RELAY_ACCESS_CLIENT_ID` / `DB_EGRESS_RELAY_ACCESS_CLIENT_SECRET`
     (secrets) — the service token from step 2.
   - `DB_EGRESS_RELAY_SOCKS_USERNAME` / `DB_EGRESS_RELAY_SOCKS_PASSWORD`
     (secrets) — the credentials from `gost.yaml`.

The admin smoke route `POST /api/admin/db-query-sandbox/query` exercises the
whole chain (see `docs/db-egress-relay.md`).

## Security notes

- **Destination filtering** (the `deny-internal` bypass in `gost.yaml`) is the
  VM-side SSRF guard: CONNECT targets are customer-supplied data, and the relay
  sits inside the Azure VNet, so loopback/private/link-local/IMDS ranges are
  refused. The in-container runner enforces the same list *and* resolves
  hostnames itself, sending only vetted IP literals — keep
  `workers/main/db-query-sandbox-assets/runner/db-query-runner.mjs` and `gost.yaml` in
  sync.
- **Three auth layers** end to end: the Access service token (gates the
  hostname at the Cloudflare edge), SOCKS username/password (gates this
  server), and the loopback-only bind (nothing on the network can reach 1080
  directly).
- The relay is a byte pipe: database TLS (`sslmode=require` etc.) passes
  through end-to-end and terminates at the customer database.
