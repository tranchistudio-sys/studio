# Amazing Studio analytics

## Architecture

The React application calls the business-level API in `src/analytics`. Providers are initialized only for anonymous marketing traffic and only when their environment variable is configured. Internal traffic is excluded before provider initialization.

Server conversions are emitted from persisted business results, not UI clicks. `Schedule` uses `schedule_<booking_id>` and `Purchase` uses `purchase_<payment_id>`. The `analytics_events.event_key` unique index provides idempotency.

## Routes and policy

- Marketing: `/`, `/bo-anh`, `/bang-gia`, `/cho-thue-do`, `/san-pham`, `/y-tuong-chup-anh`, `/lien-he`, `/thiep-cuoi-online`.
- Internal: `/calendar`, `/bookings`, `/payments`, `/customers`, `/staff`, `/cms` and every other `INTERNAL_PREFIXES` route in `App.tsx`.
- Excluded even though publicly reachable: `/login`, public contract signing, public wedding-card guest pages.
- Any authenticated session is excluded, including staff public-preview mode.

## Events

| Business event | Meta | GA4 | Trigger |
| --- | --- | --- | --- |
| page view | `PageView` | `page_view` | one anonymous public SPA navigation |
| content view | `ViewContent` | `view_service` | service, pricing, gallery or rental content |
| contact | `Contact` | `contact` | phone, email, Zalo or Messenger click |
| lead | `Lead` | `generate_lead` | reserved for successful lead creation; current contact form is disabled |
| booking | `Schedule` | `schedule_booking` | persisted attributed booking |
| payment/deposit | `Purchase` | `purchase` | persisted active attributed payment, VND |

Do not fire Lead when a form opens, Schedule when calendar is viewed, or Purchase from a quote/unpaid promise.

## Attribution

The browser captures UTM fields, `fbclid`, `gclid`, landing page and referrer. First touch is immutable; last touch changes only when a new campaign identifier is present. Booking/customer schema supports JSON attribution snapshots so staff actions can be attributed back to the original customer journey.

## Environment

All values are optional and integrations disable cleanly when absent:

```dotenv
VITE_META_PIXEL_ID=
META_PIXEL_ID=
META_CAPI_ACCESS_TOKEN=
META_CAPI_TEST_EVENT_CODE=
META_GRAPH_API_VERSION=v23.0
VITE_GA_MEASUREMENT_ID=
VITE_GTM_ID=
VITE_CLARITY_PROJECT_ID=
VITE_ANALYTICS_DEBUG=false
```

Never expose `META_CAPI_ACCESS_TOKEN` through a `VITE_` variable or commit real secrets.

## Migration and rollback

Apply `lib/db/migrations/0005_analytics_attribution.sql` before deploying code. It adds nullable attribution columns and an independent analytics outbox table. Existing booking/payment data is unchanged.

Rollback application code first. The new columns/table can safely remain unused. If removal is required after backup, drop the analytics index/table and the two nullable attribution columns in a separate reviewed migration.

## Testing

1. Use Meta Events Manager Test Events with `META_CAPI_TEST_EVENT_CODE`.
2. Confirm browser/server events share the documented event ID when both are applicable.
3. Use GA4 DebugView/Realtime for SPA events.
4. Log in as staff and visit `/calendar`; no Meta, GA4, GTM or Clarity script should initialize.
5. Create an attributed test booking/payment twice; the unique event key must prevent a duplicate CAPI conversion.

Production deployment is intentionally outside this change.
