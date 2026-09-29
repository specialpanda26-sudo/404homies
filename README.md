# 404 Error Pool Party — Ticketing

M-Pesa event ticketing with automatic QR tickets and a door scanner.
Stack: **Node.js + Express** (backend) · **Supabase Postgres** (database) · **TinyPesa** (M-Pesa STK push) · vanilla HTML/CSS/JS (frontend).

---

## v2.3 — free upgrades (no paid services)

- **One-tap ticket link.** Admin → Orders → WhatsApp now sends a link like `https://your-site/?t=<token>` that opens the buyer's tickets directly (no "Find my ticket" typing). The token is signed with `TICKET_SECRET`; nothing extra is stored. If the link fails, the message still explains the manual way.
- **Door search.** On `/door`, staff can search by name, phone (0712… or 254712…), ticket number or order number and tap **Admit** for a guest who lost their QR. Phones are shown as the last 3 digits only.

## v2.2 — bug-fix release

- Buying a second ticket on the same phone no longer wipes the first one; saved tickets are merged, and refreshed from the server (so a reissued QR or a cancelled ticket shows correctly).
- "Find my ticket" is now reachable even when tickets are already saved on the phone (previously a stale/reissued QR could not be replaced).
- A late failure callback for an *older* M-Pesa prompt can no longer mark an order FAILED while a newer prompt is still pending.
- Service worker no longer caches error pages (404/500/429) as the offline copy, and never touches `/admin`, `/door` or `/health`.
- Admin: creating an event with an impossible date (e.g. 2026-13-45) or a ticket type/promo for an unknown event ID now gives a clear error instead of a 500.
- JS/CSS revalidate on every load, so a deploy can't leave phones running old code against the new API.
- `/admin` and `/door` send `X-Robots-Tag: noindex`; added `robots.txt`.
- Rate limits for orders / M-Pesa prompts / ticket lookup raised (many phones share one IP on mobile data).

## v2.1 — bug-fix release

- Admin login and CSV exports fixed (token was not being sent).
- Ticket-type selection on the customer site fixed (id type mismatch).
- Retrying a failed payment now re-checks stock, so events cannot be oversold.
- Door scanner no longer drops a typed code while a scan is in progress.
- Missing files now return 404 instead of the homepage.
- Admin → Orders has a **WhatsApp** button on paid orders: opens your own WhatsApp with a ready message telling the buyer how to open their ticket. It uses a plain wa.me link, so it is free and needs no API.
- Everything runs on free tiers (Render, Supabase, TinyPesa). No SMS or other paid service is used or needed.

## What changed in v2.0

**Site (public/index.html, css/style.css, js/app.js)** — your 404 Error Pool Party design, wired to the real backend.
- Live **countdown** to the event start (Kenya time, UTC+3). Date, venue, tagline and prices all come from the database.
- Steps 2 and 3 stay **locked** until the earlier step is done. Nobody can reach a ticket without a paid order.
- Tickets are **saved on the phone** and reopen after a refresh. **Find my ticket** works with the M-Pesa phone number plus either the M-Pesa code from the SMS or the order number.
- Every ticket has a **real, signed QR code** (scannable) plus a downloadable PNG.
- **18+ / terms checkbox** is required, and the server rejects orders without it.
- Payment failure states: cancelled, wrong PIN, low balance, timed out, expired, sold out while paying. Resend button with cooldown.
- WhatsApp/Facebook **link preview** (title, date, image) is filled in by the server, so it updates when you change the event in admin.
- Add to calendar (.ics), Share with a friend, favicon, terms/refund line in the footer.

**Door scanner** is now its own page at `/door` (not linked from the public site) and needs `STAFF_TOKEN`. It shows ADMIT / ALREADY USED / CANCELLED / INVALID, and a Couple ticket can only be admitted once.

**Admin (`/admin`) → Events tab**: edit event name, tagline, venue, **date and start time**, and each ticket's name, description, **price** and quantity. A new price applies to new orders; orders already started keep the price they began with.

**Fixes:** the admin page used an inline script that the security policy blocks, so it now loads `/js/admin.js`. Max tickets per order is 4. Email is no longer asked for.

---

## Quick start (local)

```bash
# 1. Install
npm install

# 2. Configure
cp .env.example .env
#    Fill in DATABASE_URL, TINYPESA_API_KEY, TINYPESA_USERNAME
#    Generate secrets with:
#    node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# 3. Start (MOCK_PAYMENTS=true skips TinyPesa and auto-confirms after 6 s)
MOCK_PAYMENTS=true npm start

# 4. Open http://localhost:3000
#    Admin:  http://localhost:3000/admin
```

---

## Deploy to Render (free tier)

1. Push to GitHub:
   ```bash
   git init && git add . && git commit -m "init"
   git remote add origin https://github.com/YOUR_USER/YOUR_REPO.git
   git push -u origin main
   ```

2. Create a **Web Service** on Render pointing at the repo.
   - Environment: `Node`
   - Build command: `npm install`
   - Start command: `npm start`

3. Add environment variables (Render → Environment → Environment Variables):
   ```
   DATABASE_URL      postgresql://...  ← Supabase Session pooler string
   TINYPESA_API_KEY  your key
   TINYPESA_USERNAME your link slug
   TICKET_SECRET     <random 32-char hex>
   ADMIN_TOKEN       <random 32-char hex>
   STAFF_TOKEN       <random 24-char hex>   (door-staff login)
   WEBHOOK_SECRET    <random 24-char hex>   (makes webhook URL unguessable)
   APP_URL           https://your-app.onrender.com
   WHATSAPP_GROUP    https://chat.whatsapp.com/...   (optional)
   NODE_ENV          production
   ```

4. TinyPesa webhook URL:
   ```
   https://your-app.onrender.com/api/payments/tinypesa/webhook/<WEBHOOK_SECRET>
   ```
   Paste this in the TinyPesa dashboard → Links → IPNs.

5. Uptime pinger: point UptimeRobot (or similar) at
   ```
   https://your-app.onrender.com/health
   ```
   Every 5 minutes is enough to keep the service awake.

---

## Supabase setup

1. Create a project at supabase.com.
2. Go to **Connect → Session pooler** and copy the connection string.  
   Replace `[YOUR-PASSWORD]` in it with your database password.  
   Use **Session** (port 5432), not Transaction mode.
3. Set it as `DATABASE_URL` on Render.
4. Tables and Row Level Security are created automatically on first boot.

---

## File layout

```
server.js              Express entrypoint
src/
  config.js            Env-var validation and constants
  db.js                Postgres pool, migrations, seeding, audit helper
  util.js              Phone normalisation, QR signing, CSV, error class
  tinypesa.js          STK push call
  payments.js          processVerifiedPayment() — the single path to PAID
  jobs.js              Expiry job (runs every 60 s)
  routes/
    public.js          Customer-facing API (/api/events, /api/orders, …)
    webhook.js         /api/payments/tinypesa/webhook (TinyPesa callback)
    staff.js           /api/staff/check + /admit (door scanner)
    admin.js           /api/admin/* (stats, exports, promos, manual confirm)
db/
  schema.sql           Idempotent Postgres schema (run on every boot)
public/
  index.html           Customer site (%%TITLE%% etc. are filled in by server.js for link previews)
  door.html            Door scanner (staff code needed), open /door
  admin.html           Admin dashboard
  js/app.js            Customer-site logic
  js/door.js           Door-scanner logic
  js/admin.js          Admin logic
  css/style.css        Shared styles
  assets/              bg.jpg, logo.jpg, PWA icons
  sw.js                Service worker (offline shell)
  manifest.webmanifest PWA manifest
```

---

## Ticket design

The ticket card is rendered in two places in `public/js/app.js`:

| Function | Purpose |
|---|---|
| `ticketHTML(t)` | HTML card shown in-page (step 3, "Your Ticket") |
| `ticketPng(t)` | Canvas PNG for the "Download" button |

Both functions accept the same ticket object. Replace them when your ticket skeleton is ready, keeping the same function signatures and the same call to `drawQR(canvas, t.qr)`.

---

## Security notes

- **Prices are server-side only** — the client never sends an amount.
- **QR codes are HMAC-signed** — a leaked screenshot or forwarded QR is invalidated by reissuing the ticket (Admin → Manual confirm tab).
- **Webhook is validated** against the `TinyPesaID` we received when we sent the STK push. Set `TINYPESA_STRICT_ID=false` if TinyPesa changes field names and webhooks start failing.
- **Supabase RLS** blocks the public REST API; your server bypasses it as the DB owner.
- **Rate limits** reset on server restart (in-memory). For high-traffic events upgrade to Redis or a Supabase rate-limit table.

---

## Adding the ticket skeleton

When you have a design:

1. Update `ticketHTML(t)` in `public/js/app.js` — returns an HTML string.
2. Update `ticketPng(t)` in the same file — draws on a `<canvas>` and returns it.
3. If you add new CSS, add it to `public/css/style.css` under `/* TICKET SKELETON */`.

The ticket object shape:
```js
{
  ticketNumber: "TICKET-AB12CD34",
  holderName:   "Jane Muthoni",
  type:         "General Admission",
  status:       "VALID",           // or "USED" / "CANCELLED"
  orderNumber:  "HG-X7Z2PZ697S",
  event: {
    name:   "Lakeview House Party",
    venue:  "Lakeview Estate, House 12",
    date:   "2026-10-03",          // YYYY-MM-DD
    time:   "21:00"
  },
  qr: "TICKET-AB12CD34.a1b2c3d4e5f6a1b2c3d4e5f6" // the exact string to encode in the QR
}
```
