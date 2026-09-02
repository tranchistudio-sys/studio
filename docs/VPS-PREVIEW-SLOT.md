# Fixed VPS Preview slot

The owner-controlled Preview uses one URL, one Compose project, and one private
database: `preview.tranchistudio.com`, `/opt/amazing-studio-preview`,
`amazing-preview`, and `amazing-studio-preview-postgres`.

Production under `/opt/amazing-studio` is never referenced. The workflow carries
no production database or integration secrets. An internal Docker network and
the application Preview guards block outbound production integrations.

## One-time OWNER setup after merge approval

1. Add GitHub Environment `preview` and secret `VPS_PREVIEW_DB_PASSWORD`.
   Use at least 24 URL-safe characters (`A-Z`, `a-z`, `0-9`, `_`, `-`).
2. Add preview-only `PREVIEW_SESSION_SECRET`, `PREVIEW_BASIC_AUTH_PASS`, and
   `PREVIEW_LOGIN_PASSWORD`; do not reuse production values.
3. Stage the verified empty staging-template dump at
   `/opt/amazing-studio-preview/bootstrap/tenant-template-staging.dump` with
   SHA-256 `a984718b0fb723f48063dccac8dce2e6b80bd642e2345924ec0cab3272af0919`.
4. Run **Deploy fixed VPS Preview** with `DEPLOY_PREVIEW`.
5. Install `deploy/preview/nginx-preview.conf` as a separate Nginx site.
6. Add `preview.tranchistudio.com A 160.250.128.162`, then obtain Preview TLS.

Do not change `tranchistudio.com`, MX records, production upstreams, or the
production Compose project. Failed Preview boot/health/disk checks restore only
`amazing-studio-preview:rollback`; current and one rollback image are retained.
