# Enterprise deployment: NGINX + ngrok (Defectra / SiteSureLabs)

This guide keeps **your existing JWT / role-based login** as the only application identity layer. NGINX and ngrok add **network**, **TLS**, **edge authentication**, and **abuse controls**—not a second user database.

## Architecture (target)

```
Staff browser ──TLS──► ngrok edge (auth, stable hostname, optional IP policies)
                          │
                          ▼ HTTP (loopback only)
                   NGINX 127.0.0.1:8080  — rate limits, headers, body size, path filtering
                          │
            ┌─────────────┴─────────────┐
            ▼                           ▼
    Static: frontend/dist         API: uvicorn 127.0.0.1:8010
```

**Never** expose `8010`, MongoDB, or Vite `5173` publicly. **Tunnel only** `127.0.0.1:8080` (NGINX).

## 1. Application checklist

| Item | Action |
|------|--------|
| Bind API | `uvicorn main:app --host 127.0.0.1 --port 8010` (no `0.0.0.0` on internet-facing hosts) |
| CORS | Set `CORS_ORIGINS` in `.env` to your **exact** public origin (ngrok URL or company domain), comma-separated if multiple. **Do not use `*` in production.** |
| JWT | Strong `JWT_SECRET`, reasonable `JWT_EXPIRY_HOURS`; rotate on compromise |
| Debug | No `print` of tokens; no `debug=True` in production; `uvicorn` without `--reload` |
| MongoDB | Bind to `127.0.0.1` or private VPC; auth + TLS to cluster |
| vLLM / LLM | Keep on private network; reference via env URL |

## 2. NGINX

1. Copy `deploy/nginx/http-context-snippet.conf` into the **`http { }`** block of `nginx.conf` (rate limit zones must live here once).
2. Edit paths in `deploy/nginx/defectra.conf`: replace `/opt/defectra` with your install root (three places: `root`, `include`).
3. Include the site file from `http { }`:

   ```nginx
   include /opt/defectra/deploy/nginx/defectra.conf;
   ```

4. Test and reload:

   ```bash
   sudo nginx -t && sudo nginx -s reload
   ```

### Headers and behavior

- **HSTS** is emitted when `X-Forwarded-Proto: https` (set by ngrok). Internal hop can stay HTTP.
- **CSP** is baseline-safe for this app; tighten `script-src` / `connect-src` if you add analytics or CDNs.
- **Uploads**: `client_max_body_size` aligns with `DEFECT_UPLOAD_MAX_MB`; keep NGINX ≥ app limit.
- **SSE / streaming**: `/api/chat/` and `/api/assistant/` use `proxy_buffering off` and long timeouts (10 min).

### Admin IP allowlist (optional)

Uncomment the `/api/admin/` `location` in `defectra.conf` and set corporate/VPN CIDRs. This **adds** a network gate; **JWT + `require_admin` in FastAPI remain authoritative** for authorization.

## 3. ngrok

1. Create account, install agent, `ngrok config add-authtoken ...`.
2. Prefer a **reserved domain** (paid) for stable URLs and simpler `CORS_ORIGINS`.
3. Start a tunnel **only** to NGINX:

   ```bash
   ngrok http http://127.0.0.1:8080 --oauth=google --oauth-allow-domain=yourcompany.com
   ```

…or use `deploy/ngrok.example.yml` with **OAuth / SSO** or **basic auth** as a belt-and-suspenders **before** your app login (not a replacement for app RBAC).

4. Set backend `.env`:

   ```env
   CORS_ORIGINS=https://your-subdomain.ngrok.app
   ```

5. Redeploy/restart uvicorn so CORS picks up the new origin.

### Session / forwarding stability

- Use **one** public hostname in `CORS_ORIGINS` and in bookmarks; avoid chained random subdomains.
- If you terminate TLS only at ngrok, keep `X-Forwarded-Proto` trust inside NGINX (`proxy-params.conf`).

## 4. Firewall (host)

**Linux (iptables/nftables example intent):** default deny inbound; allow only loopback for app ports; ngrok agent uses **outbound** HTTPS—allow egress to ngrok.

**Windows Defender Firewall:**

- Block **inbound** on `8010`, `5173`, `27017` (MongoDB) from public profiles.
- Do **not** publish rules that “allow ngrok” on app ports—ngrok connects **outbound** to ngrok cloud; locally it connects to `127.0.0.1:8080`.

## 5. Performance

- uvicorn: use `--workers` (CPU-bound) + recycle; or run behind `gunicorn` + uvicorn workers for Linux.
- NGINX: enable gzip for `text/*` if not already global; static assets are cache-friendly from `dist`.
- Keep **large inspection timeouts** on `/api/` paths that call slow models (already extended for chat).

## 6. Logging and monitoring

- **NGINX access logs**: avoid logging `Authorization` headers (default `combined` does not); scrub query strings if you add secrets to URLs (don’t).
- **Application**: log user id / request id, not JWTs or passwords.
- Health: `/api/health` for synthetic checks (optional IP restriction in NGINX).

## 7. Common vulnerabilities to avoid

- Exposing MongoDB or Redis to `0.0.0.0`
- CORS `*` with credentials or API keys in browser
- Tunneling **directly** to FastAPI, bypassing NGINX limits
- Storing `JWT_SECRET` or `NGROK_AUTHTOKEN` in git
- Leaving default admin password in production
- Trusting `X-Forwarded-For` from untrusted hops (ngrok alone is OK; chain only trusted proxies)

## 8. WebSockets

This codebase uses **HTTP streaming (SSE-style)** for chat/assistant, not WebSockets. If you add WebSockets later, add `Upgrade`/`Connection` headers and a dedicated `location` in NGINX.

## Files in this repo

| File | Purpose |
|------|---------|
| `deploy/nginx/http-context-snippet.conf` | `limit_req_zone` + real IP map — paste into `http {}` |
| `deploy/nginx/defectra.conf` | Site server on `127.0.0.1:8080` |
| `deploy/nginx/proxy-params.conf` | Trusted proxy headers |
| `deploy/ngrok.example.yml` | Agent YAML sketch |
| `.env.example` | `CORS_ORIGINS` documentation |

---

**Authentication model:** End users and admins still authenticate via **your existing** login → JWT → `require_admin` for `/api/admin/*`. Edge auth on ngrok is **defense in depth**, not a second user system.
