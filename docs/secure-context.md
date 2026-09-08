# Secure-context browser APIs

Every browser API this app uses or plans to use, and whether it exists over plain
HTTP on a LAN address.

This list exists because the same failure has now happened twice. `crypto.randomUUID`
is secure-context only, so logging anything from a phone over `http://192.168.x.x`
threw (D18). `BarcodeDetector` and `getUserMedia` are secure-context only, so Phase 3's
flagship feature would have been untestable on the one device it is designed for.
Both would have shipped fine and failed only during the testing meant to catch them,
because **production is HTTPS and localhost counts as secure**. A LAN IP does not.

> A context is secure if the origin is `https:`, or `localhost` / `127.0.0.1` / `::1`.
> **`http://192.168.x.x` is not secure**, and that is precisely how a phone reaches a
> development machine.

## Development is HTTPS

`pnpm dev:certs` writes `infra/certs/dev-{cert,key}.pem` with mkcert, covering
localhost and every LAN address on the machine. `vite.config.ts` picks them up
automatically and falls back to http with a warning when they are absent, so a fresh
clone still runs.

Two one-time steps that a script deliberately does not do for you:

- `mkcert -install` on the machine — it writes to the system trust store and raises a
  consent dialog that a person has to click;
- install `rootCA.pem` on the phone, or skip all of it and use `pnpm dev:tunnel`,
  which gives a publicly-trusted HTTPS URL and needs nothing on the device.

## The audit

| API | Secure context? | Used | Notes |
|---|---|---|---|
| `crypto.randomUUID` | **Yes** | now, everywhere | D18. Wrapped in `lib/uuid.ts`, which falls back to `getRandomValues`. |
| `crypto.getRandomValues` | No | now | The reason that fallback works. |
| `crypto.subtle` | **Yes** | no | Nothing needs it; note it before anything does. |
| `BarcodeDetector` | **Yes** | phase 3 | Also Chromium-only. ZXing fallback covers the rest — but ZXing needs the camera, so it is *also* gated. |
| `getUserMedia` | **Yes** | phase 3 | The camera. No fallback exists: without a secure context there is no scanning at all, by any library. |
| `navigator.mediaDevices` | **Yes** | phase 3 | The whole object is undefined, not just the method. Feature-detect the object. |
| `Notification` | **Yes** | not planned | If a reminder is ever added, this is the constraint. |
| `serviceWorker` | **Yes** | **phase 6** | The offline queue and the installable PWA both depend on it. Phase 6 is untestable on a phone without HTTPS; this is the third instance and it is now handled in advance. |
| `Cache` / `CacheStorage` | **Yes** | phase 6 | Same. |
| `navigator.storage.persist` | **Yes** | phase 6 | Asking to keep the Dexie queue through storage pressure. |
| `Web Share` | **Yes** | not planned | Noted for phase 7 export. |
| `Geolocation` | **Yes** | not planned | Never wanted. |
| `IndexedDB` (Dexie) | No | phase 6 | Works over http — but everything around it in phase 6 does not. |
| `localStorage` | No | no | Not used; sessions are httpOnly cookies. |
| `fetch` | No | now | Fine. |
| `matchMedia`, `MutationObserver`, `ResizeObserver` | No | now | Fine. |
| `Intl.*` | No | now | Fine. |
| `structuredClone` | No | no | Fine if ever needed. |

## The rule

**Before adding any browser API, check this table, and add the row if it is missing.**
The cost of getting it wrong is not a broken build — it is a feature that works
perfectly on the developer's laptop and does not exist on the device the product is
for.
