"use strict";
const express = require("express");
const rateLimit = require("express-rate-limit");
const cfg = require("../config");
const { query, audit } = require("../db");
const { processVerifiedPayment } = require("../payments");
const U = require("../util");

const router = express.Router();

// Wrong-token attempts are limited hard; successful calls only face the general limiter.
router.use(rateLimit({ windowMs: 60 * 1000, limit: 15, skipSuccessfulRequests: true, requestWasSuccessful: (req, res) => res.statusCode !== 401, standardHeaders: true, legacyHeaders: false, message: { error: "Too many attempts." } }));
router.use(rateLimit({ windowMs: 60 * 1000, limit: 240, standardHeaders: true, legacyHeaders: false, message: { error: "Too many requests." } }));

router.use((req, res, next) => {
  if (!U.safeEqual(req.get("x-admin-token") || "", cfg.adminToken)) return res.status(401).json({ error: "Unauthorized" });
  next();
});

const bad = (m) => new U.HttpError(400, m);
function int(v, min, max, label) {
  const n = Number.parseInt(v, 10);
  if (!Number.isInteger(n) || n < min || n > max) throw bad(`${label} must be a whole number between ${min} and ${max}.`);
  return n;
}
const like = (q) => `%${String(q).replace(/[%_\\]/g, "\\$&").slice(0, 60)}%`;

// ── overview ───────────────────────────────────────────────────────────────
router.get("/stats", U.wrap(async (req, res) => {
  const [o, t, tiers, review] = await Promise.all([
    query(`SELECT COUNT(*)::int AS total,
                  COUNT(*) FILTER (WHERE status='PAID')::int AS paid,
                  COUNT(*) FILTER (WHERE status IN ('PENDING','PAYMENT_PROCESSING'))::int AS pending,
                  COUNT(*) FILTER (WHERE status='FAILED')::int AS failed,
                  COUNT(*) FILTER (WHERE status='EXPIRED')::int AS expired,
                  COUNT(*) FILTER (WHERE status='REFUND_REQUIRED')::int AS refund_required,
                  COALESCE(SUM(total_amount) FILTER (WHERE status='PAID'),0)::int AS revenue,
                  COALESCE(SUM(discount_amount) FILTER (WHERE status='PAID'),0)::int AS discounts
             FROM orders`),
    query(`SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE status='USED')::int AS used,
                  COUNT(*) FILTER (WHERE status='CANCELLED')::int AS cancelled FROM tickets`),
    query(`SELECT tt.id, e.name AS event, tt.name, tt.price, tt.quantity_total, tt.quantity_sold, tt.status,
                  COALESCE((SELECT SUM(o.total_amount) FROM orders o WHERE o.ticket_type_id = tt.id AND o.status='PAID'),0)::int AS revenue
             FROM ticket_types tt JOIN events e ON e.id = tt.event_id ORDER BY e.id, tt.sort_order, tt.price, tt.id`),
    query(`SELECT (SELECT COUNT(*) FROM orders WHERE status='EXPIRED' AND payment_started_at IS NOT NULL)::int AS stuck,
                  (SELECT COUNT(*) FROM orders WHERE status='REFUND_REQUIRED')::int AS refunds,
                  (SELECT COUNT(*) FROM payment_transactions WHERE status='DUPLICATE')::int AS duplicates`),
  ]);
  res.json({ orders: o.rows[0], tickets: t.rows[0], tiers: tiers.rows, review: review.rows[0] });
}));

// Live dashboard: polled every few seconds by the admin page.
router.get("/live", U.wrap(async (req, res) => {
  const dayStart = "(date_trunc('day', now() AT TIME ZONE 'Africa/Nairobi') AT TIME ZONE 'Africa/Nairobi')";
  const [win, tiers, promos, recent, door] = await Promise.all([
    query(`SELECT COALESCE(SUM(quantity) FILTER (WHERE paid_at > now() - interval '1 hour'),0)::int AS tickets_1h,
                  COALESCE(SUM(total_amount) FILTER (WHERE paid_at > now() - interval '1 hour'),0)::int AS revenue_1h,
                  COALESCE(SUM(quantity) FILTER (WHERE paid_at >= ${dayStart}),0)::int AS tickets_today,
                  COALESCE(SUM(total_amount) FILTER (WHERE paid_at >= ${dayStart}),0)::int AS revenue_today,
                  COALESCE(SUM(total_amount),0)::int AS revenue_all,
                  COALESCE(SUM(quantity),0)::int AS tickets_all,
                  (SELECT COUNT(*) FROM orders WHERE status IN ('PENDING','PAYMENT_PROCESSING') AND expires_at > now())::int AS pending_now,
                  (SELECT COALESCE(SUM(total_amount),0) FROM orders WHERE status IN ('PENDING','PAYMENT_PROCESSING') AND expires_at > now())::int AS pending_amount
             FROM orders WHERE status = 'PAID'`),
    query(`SELECT tt.id, e.name AS event, tt.name, tt.price, tt.quantity_total, tt.quantity_sold, tt.status, tt.requires_pool,
                  COALESCE((SELECT SUM(o.total_amount) FROM orders o WHERE o.ticket_type_id = tt.id AND o.status='PAID'),0)::int AS revenue
             FROM ticket_types tt JOIN events e ON e.id = tt.event_id WHERE e.status = 'ACTIVE'
            ORDER BY e.id, tt.sort_order, tt.price, tt.id`),
    query(`SELECT p.code, p.kind, p.value, p.max_uses, p.active, p.expires_at,
                  COUNT(o.id) FILTER (WHERE o.status='PAID')::int AS paid_orders,
                  COALESCE(SUM(o.quantity) FILTER (WHERE o.status='PAID'),0)::int AS tickets,
                  COALESCE(SUM(o.discount_amount) FILTER (WHERE o.status='PAID'),0)::int AS discount_given,
                  COALESCE(SUM(o.total_amount) FILTER (WHERE o.status='PAID'),0)::int AS revenue
             FROM promo_codes p LEFT JOIN orders o ON o.promo_code = p.code
            GROUP BY p.id ORDER BY p.active DESC, p.id DESC LIMIT 12`),
    query(`SELECT o.order_number, o.holder_name, o.quantity, o.total_amount, o.promo_code, o.paid_at, tt.name AS type_name
             FROM orders o JOIN ticket_types tt ON tt.id = o.ticket_type_id
            WHERE o.status = 'PAID' ORDER BY o.paid_at DESC NULLS LAST LIMIT 8`),
    query(`SELECT COUNT(*) FILTER (WHERE status IN ('VALID','USED'))::int AS total, COUNT(*) FILTER (WHERE status = 'USED')::int AS used FROM tickets`),
  ]);
  res.set("Cache-Control", "no-store");
  res.json({ now: new Date().toISOString(), sales: win.rows[0], tiers: tiers.rows, promos: promos.rows, recent: recent.rows, door: door.rows[0] });
}));

// Money that may have moved without tickets being issued.
router.get("/review", U.wrap(async (req, res) => {
  const [stuck, refunds, dups, hooks] = await Promise.all([
    query(`SELECT order_number, holder_name, holder_phone, total_amount, payment_started_at, created_at
             FROM orders WHERE status='EXPIRED' AND payment_started_at IS NOT NULL ORDER BY created_at DESC LIMIT 100`),
    query(`SELECT order_number, holder_name, holder_phone, total_amount, mpesa_receipt, paid_at
             FROM orders WHERE status='REFUND_REQUIRED' ORDER BY paid_at DESC LIMIT 100`),
    query(`SELECT o.order_number, o.holder_name, o.holder_phone, p.amount, p.tinypesa_transaction_id, p.created_at
             FROM payment_transactions p JOIN orders o ON o.id = p.order_id
            WHERE p.status='DUPLICATE' ORDER BY p.created_at DESC LIMIT 100`),
    query(`SELECT external_ref, tiny_pesa_id, amount, outcome, error, received_at
             FROM webhook_events WHERE outcome IN ('REJECTED_ID_MISMATCH','AMOUNT_MISMATCH','ERROR')
            ORDER BY received_at DESC LIMIT 50`),
  ]);
  res.json({ stuck: stuck.rows, refunds: refunds.rows, duplicates: dups.rows, webhookProblems: hooks.rows });
}));

// ── lists & exports ────────────────────────────────────────────────────────
router.get("/orders", U.wrap(async (req, res) => {
  const params = [];
  const where = [];
  if (req.query.q) { params.push(like(req.query.q)); where.push(`(o.order_number ILIKE $${params.length} OR o.holder_email ILIKE $${params.length} OR o.holder_phone ILIKE $${params.length} OR o.holder_name ILIKE $${params.length})`); }
  if (req.query.status) { params.push(String(req.query.status).toUpperCase()); where.push(`o.status = $${params.length}`); }
  const { rows } = await query(
    `SELECT o.order_number, o.status, o.holder_name, o.holder_email, o.holder_phone, o.quantity, o.total_amount, o.discount_amount,
            o.promo_code, o.mpesa_receipt, o.failure_reason, o.initiate_count, o.created_at, o.paid_at, e.name AS event_name, tt.name AS type_name
       FROM orders o JOIN events e ON e.id = o.event_id JOIN ticket_types tt ON tt.id = o.ticket_type_id
      ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY o.created_at DESC LIMIT 200`,
    params
  );
  res.json(rows.map((r) => (r.status === "PAID" ? { ...r, link: U.linkToken(r.order_number) } : r)));
}));

router.get("/tickets", U.wrap(async (req, res) => {
  const params = [];
  let where = "";
  if (req.query.q) { params.push(like(req.query.q)); where = `WHERE t.ticket_number ILIKE $1 OR t.holder_name ILIKE $1 OR t.holder_phone ILIKE $1 OR o.order_number ILIKE $1`; }
  const { rows } = await query(
    `SELECT t.ticket_number, t.holder_name, t.holder_phone, t.status, t.used_at, t.issued_at, t.qr_version,
            e.name AS event_name, tt.name AS type_name, o.order_number
       FROM tickets t JOIN events e ON e.id = t.event_id JOIN ticket_types tt ON tt.id = t.type_id JOIN orders o ON o.id = t.order_id
      ${where} ORDER BY t.issued_at DESC LIMIT 300`,
    params
  );
  res.json(rows);
}));

function sendCsv(res, name, rows, cols) {
  res.set("Content-Type", "text/csv; charset=utf-8");
  res.set("Content-Disposition", `attachment; filename="${name}"`);
  res.send("\uFEFF" + U.toCsv(rows, cols));
}

router.get("/export/attendees.csv", U.wrap(async (req, res) => {
  const { rows } = await query(
    `SELECT t.ticket_number, t.holder_name, t.holder_phone, t.holder_email, e.name AS event, tt.name AS ticket_type,
            t.status, t.used_at, o.order_number, t.issued_at
       FROM tickets t JOIN events e ON e.id = t.event_id JOIN ticket_types tt ON tt.id = t.type_id JOIN orders o ON o.id = t.order_id
      ORDER BY e.id, t.holder_name`
  );
  sendCsv(res, "attendees.csv", rows, ["ticket_number", "holder_name", "holder_phone", "holder_email", "event", "ticket_type", "status", "used_at", "order_number", "issued_at"]);
}));

router.get("/export/orders.csv", U.wrap(async (req, res) => {
  const { rows } = await query(
    `SELECT o.order_number, o.status, o.holder_name, o.holder_phone, o.holder_email, e.name AS event, tt.name AS ticket_type,
            o.quantity, o.subtotal_amount, o.discount_amount, o.total_amount, o.promo_code, o.mpesa_receipt, o.created_at, o.paid_at
       FROM orders o JOIN events e ON e.id = o.event_id JOIN ticket_types tt ON tt.id = o.ticket_type_id ORDER BY o.created_at`
  );
  sendCsv(res, "orders.csv", rows, ["order_number", "status", "holder_name", "holder_phone", "holder_email", "event", "ticket_type", "quantity", "subtotal_amount", "discount_amount", "total_amount", "promo_code", "mpesa_receipt", "created_at", "paid_at"]);
}));

router.get("/audit", U.wrap(async (req, res) => {
  const { rows } = await query("SELECT action, resource_type, resource_id, metadata, ip_address, created_at FROM audit_logs ORDER BY id DESC LIMIT $1", [int(req.query.limit || 100, 1, 500, "limit")]);
  res.json(rows);
}));

// ── fixing money problems ──────────────────────────────────────────────────
// Use after you've SEEN the payment (M-Pesa SMS / TinyPesa dashboard) but no ticket was issued.
router.post("/orders/:orderNumber/confirm", U.wrap(async (req, res) => {
  const receipt = String(req.body?.receipt || "").trim().toUpperCase();
  if (!/^[A-Z0-9]{8,12}$/.test(receipt)) throw bad("Enter the M-Pesa confirmation code (e.g. SGH7K2L9QX).");
  const orderNumber = String(req.params.orderNumber).toUpperCase();
  const { rows } = await query("SELECT total_amount, status FROM orders WHERE order_number = $1", [orderNumber]);
  if (!rows[0]) throw new U.HttpError(404, "Order not found.");
  if (rows[0].status === "PAID") throw new U.HttpError(409, "Already paid.");
  const dupe = await query("SELECT 1 FROM orders WHERE mpesa_receipt = $1 AND status IN ('PAID','REFUND_REQUIRED') LIMIT 1", [receipt]);
  if (dupe.rowCount) throw new U.HttpError(409, "That M-Pesa code was already used for another order.");
  const r = await processVerifiedPayment({
    orderNumber, transactionId: null, amount: rows[0].total_amount, receipt, source: "MANUAL",
    payload: { manual: true, receipt }, note: String(req.body?.note || "").slice(0, 200),
  });
  await audit("MANUAL_CONFIRM", "order", orderNumber, { receipt, outcome: r.outcome }, req.ip);
  res.json(r);
}));

router.post("/tickets/:ticketNumber/reissue", U.wrap(async (req, res) => {
  const { rows } = await query("UPDATE tickets SET qr_version = qr_version + 1 WHERE ticket_number = $1 RETURNING ticket_number, qr_version", [String(req.params.ticketNumber).toUpperCase()]);
  if (!rows[0]) throw new U.HttpError(404, "Ticket not found.");
  await audit("TICKET_REISSUED", "ticket", rows[0].ticket_number, { version: rows[0].qr_version }, req.ip);
  res.json({ ticketNumber: rows[0].ticket_number, qr: U.qrFor(rows[0].ticket_number, rows[0].qr_version), note: "The old QR no longer works. The customer can re-open the ticket with 'Find my ticket'." });
}));

router.post("/tickets/:ticketNumber/status", U.wrap(async (req, res) => {
  const s = String(req.body?.status || "").toUpperCase();
  if (!["VALID", "USED", "CANCELLED"].includes(s)) throw bad("Status must be VALID, USED or CANCELLED.");
  const { rows } = await query(
    "UPDATE tickets SET status = $2::text, used_at = CASE WHEN $2::text = 'USED' THEN COALESCE(used_at, now()) ELSE NULL END WHERE ticket_number = $1 RETURNING ticket_number, status",
    [String(req.params.ticketNumber).toUpperCase(), s]
  );
  if (!rows[0]) throw new U.HttpError(404, "Ticket not found.");
  await audit("TICKET_STATUS", "ticket", rows[0].ticket_number, { status: s }, req.ip);
  res.json(rows[0]);
}));

// ── gallery photos ─────────────────────────────────────────────────────────
const MAX_PHOTOS = 20;
router.get("/gallery", U.wrap(async (req, res) => {
  const { rows } = await query("SELECT id, alt, octet_length(data)::int AS bytes FROM gallery_photos ORDER BY sort_order, id");
  res.json(rows);
}));

// The browser shrinks each photo to a ~1000px JPEG before sending it as the raw request body.
router.post("/gallery", express.raw({ type: "image/jpeg", limit: "900kb" }), U.wrap(async (req, res) => {
  const buf = req.body;
  if (!Buffer.isBuffer(buf) || buf.length < 1000) throw bad("Choose a JPG or PNG photo.");
  if (buf[0] !== 0xff || buf[1] !== 0xd8 || buf[2] !== 0xff) throw bad("That file isn't a valid photo.");
  const n = (await query("SELECT COUNT(*)::int AS c FROM gallery_photos")).rows[0].c;
  if (n >= MAX_PHOTOS) throw bad(`The gallery is full (${MAX_PHOTOS} photos max). Delete one first.`);
  const alt = U.cleanName(String(req.query.alt || ""), 80) || null;
  const { rows } = await query(
    "INSERT INTO gallery_photos (data, alt, sort_order) VALUES ($1,$2,(SELECT COALESCE(MAX(sort_order),0)+1 FROM gallery_photos)) RETURNING id",
    [buf, alt]
  );
  await audit("PHOTO_ADDED", "photo", rows[0].id, { bytes: buf.length }, req.ip);
  res.json({ id: rows[0].id });
}));

router.post("/gallery/reorder", U.wrap(async (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map((x) => Number.parseInt(x, 10)) : [];
  if (!ids.length || ids.length > 100 || ids.some((n) => !Number.isInteger(n) || n < 1) || new Set(ids).size !== ids.length) throw bad("Send the photo ids in the order you want.");
  await query("UPDATE gallery_photos t SET sort_order = x.ord::int FROM unnest($1::bigint[]) WITH ORDINALITY AS x(id, ord) WHERE t.id = x.id", [ids]);
  res.json({ ok: true });
}));

router.post("/gallery/:id/delete", U.wrap(async (req, res) => {
  const id = int(req.params.id, 1, 2147483647, "id");
  const { rowCount } = await query("DELETE FROM gallery_photos WHERE id = $1", [id]);
  if (!rowCount) throw new U.HttpError(404, "Photo not found.");
  await audit("PHOTO_DELETED", "photo", id, {}, req.ip);
  res.json({ ok: true });
}));

// ── promo codes ────────────────────────────────────────────────────────────
router.get("/promos", U.wrap(async (req, res) => {
  const { rows } = await query("SELECT id, code, kind, value, max_uses, used_count, event_id, active, expires_at FROM promo_codes ORDER BY id DESC");
  res.json(rows);
}));

router.post("/promos", U.wrap(async (req, res) => {
  const b = req.body || {};
  const code = String(b.code || "").trim().toUpperCase();
  if (!/^[A-Z0-9_-]{3,32}$/.test(code)) throw bad("Code must be 3–32 letters, numbers, - or _.");
  const kind = String(b.kind || "").toUpperCase();
  if (!["PERCENT", "FIXED"].includes(kind)) throw bad("Type must be PERCENT or FIXED.");
  const value = int(b.value, 1, kind === "PERCENT" ? 100 : 1000000, "Value");
  const maxUses = b.maxUses === "" || b.maxUses == null ? null : int(b.maxUses, 1, 1000000, "Max uses");
  const eventId = b.eventId === "" || b.eventId == null ? null : int(b.eventId, 1, 2147483647, "Event");
  const expiresAt = b.expiresAt ? new Date(b.expiresAt) : null;
  if (expiresAt && Number.isNaN(expiresAt.getTime())) throw bad("Invalid expiry date.");
  try {
    const { rows } = await query(
      "INSERT INTO promo_codes (code, kind, value, max_uses, event_id, expires_at) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *",
      [code, kind, value, maxUses, eventId, expiresAt]
    );
    await audit("PROMO_CREATED", "promo", code, { kind, value }, req.ip);
    res.json(rows[0]);
  } catch (e) {
    if (e.code === "23505") throw new U.HttpError(409, "That code already exists.");
    if (e.code === "23503") throw new U.HttpError(404, "No event with that ID.");
    throw e;
  }
}));

router.post("/promos/:id/toggle", U.wrap(async (req, res) => {
  const { rows } = await query("UPDATE promo_codes SET active = NOT active WHERE id = $1 RETURNING id, code, active", [int(req.params.id, 1, 2147483647, "id")]);
  if (!rows[0]) throw new U.HttpError(404, "Promo not found.");
  res.json(rows[0]);
}));

// ── events & ticket types ──────────────────────────────────────────────────
router.get("/events", U.wrap(async (req, res) => {
  const ev = await query("SELECT id, name, description, venue, event_date::text AS event_date, event_time, status FROM events ORDER BY event_date DESC, id DESC");
  const tt = await query("SELECT id, event_id, name, description, price, quantity_total, quantity_sold, status, requires_pool, sort_order FROM ticket_types ORDER BY sort_order, price, id");
  res.json(ev.rows.map((e) => ({ ...e, ticketTypes: tt.rows.filter((t) => t.event_id === e.id) })));
}));

router.post("/events", U.wrap(async (req, res) => {
  const b = req.body || {};
  const name = U.cleanName(b.name, 120);
  const venue = U.cleanName(b.venue, 160);
  if (!name || !venue) throw bad("Name and venue are required.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(b.date || "")) || Number.isNaN(new Date(b.date + "T00:00:00Z").getTime())) throw bad("Date must look like 2026-10-03.");
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(b.time || ""))) throw bad("Time must look like 21:00.");
  const { rows } = await query(
    "INSERT INTO events (name, description, venue, event_date, event_time) VALUES ($1,$2,$3,$4,$5) RETURNING id",
    [name, U.cleanName(b.description, 300) || null, venue, b.date, b.time]
  );
  await audit("EVENT_CREATED", "event", rows[0].id, { name }, req.ip);
  res.json(rows[0]);
}));

// Edit an existing event: name, tagline, venue, date, start time. Send only the fields you want to change.
router.post("/events/:id/update", U.wrap(async (req, res) => {
  const id = int(req.params.id, 1, 2147483647, "id");
  const b = req.body || {};
  const sets = [];
  const vals = [id];
  const add = (col, v) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };
  if (b.name != null) { const v = U.cleanName(b.name, 120); if (!v) throw bad("Name can't be empty."); add("name", v); }
  if (b.venue != null) { const v = U.cleanName(b.venue, 160); if (!v) throw bad("Venue can't be empty."); add("venue", v); }
  if (b.description != null) add("description", U.cleanName(b.description, 300) || null);
  if (b.date != null) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(b.date)) || Number.isNaN(new Date(b.date + "T00:00:00Z").getTime())) throw bad("Date must look like 2026-10-03.");
    add("event_date", b.date);
  }
  if (b.time != null) {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(b.time))) throw bad("Time must look like 21:00.");
    add("event_time", b.time);
  }
  if (!sets.length) throw bad("Nothing to update.");
  const { rows } = await query(`UPDATE events SET ${sets.join(", ")} WHERE id = $1 RETURNING id`, vals);
  if (!rows[0]) throw new U.HttpError(404, "Event not found.");
  await audit("EVENT_UPDATED", "event", id, b, req.ip);
  res.json({ ok: true });
}));

router.post("/events/:id/status", U.wrap(async (req, res) => {
  const s = String(req.body?.status || "").toUpperCase();
  if (!["ACTIVE", "HIDDEN"].includes(s)) throw bad("Status must be ACTIVE or HIDDEN.");
  const { rows } = await query("UPDATE events SET status = $2 WHERE id = $1 RETURNING id, status", [int(req.params.id, 1, 2147483647, "id"), s]);
  if (!rows[0]) throw new U.HttpError(404, "Event not found.");
  res.json(rows[0]);
}));

router.post("/ticket-types", U.wrap(async (req, res) => {
  const b = req.body || {};
  const name = U.cleanName(b.name, 80);
  if (!name) throw bad("Name is required.");
  let rows;
  try {
    ({ rows } = await query(
      "INSERT INTO ticket_types (event_id, name, description, price, quantity_total) VALUES ($1,$2,$3,$4,$5) RETURNING id",
      [int(b.eventId, 1, 2147483647, "Event"), name, U.cleanName(b.description, 160) || null, int(b.price, 1, 1000000, "Price"), int(b.quantity, 0, 1000000, "Quantity")]
    ));
  } catch (e) {
    if (e.code === "23503") throw new U.HttpError(404, "No event with that ID. Check the ID shown next to the event name.");
    throw e;
  }
  await audit("TYPE_CREATED", "ticket_type", rows[0].id, { name }, req.ip);
  res.json(rows[0]);
}));

// Drag-to-reorder: send the ticket ids in the order they should appear on the site (top to bottom).
router.post("/ticket-types/reorder", U.wrap(async (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map((x) => Number.parseInt(x, 10)) : [];
  if (!ids.length || ids.length > 100 || ids.some((n) => !Number.isInteger(n) || n < 1) || new Set(ids).size !== ids.length) throw bad("Send the ticket ids in the order you want.");
  await query(
    `UPDATE ticket_types t SET sort_order = x.ord::int
       FROM unnest($1::bigint[]) WITH ORDINALITY AS x(id, ord) WHERE t.id = x.id`,
    [ids]
  );
  await audit("TYPES_REORDERED", "ticket_type", ids.join(","), { ids }, req.ip);
  res.json({ ok: true });
}));

router.post("/ticket-types/:id/update", U.wrap(async (req, res) => {
  const id = int(req.params.id, 1, 2147483647, "id");
  const b = req.body || {};
  const { rows: cur } = await query("SELECT quantity_sold FROM ticket_types WHERE id = $1", [id]);
  if (!cur[0]) throw new U.HttpError(404, "Ticket type not found.");
  const sets = [];
  const vals = [id];
  if (b.price != null) { vals.push(int(b.price, 1, 1000000, "Price")); sets.push(`price = $${vals.length}`); }
  if (b.quantityTotal != null) {
    const q = int(b.quantityTotal, 0, 1000000, "Quantity");
    if (q < cur[0].quantity_sold) throw bad(`${cur[0].quantity_sold} already sold — quantity can't go below that.`);
    vals.push(q); sets.push(`quantity_total = $${vals.length}`);
  }
  if (b.name != null) {
    const n = U.cleanName(b.name, 80);
    if (!n) throw bad("Name can't be empty.");
    vals.push(n); sets.push(`name = $${vals.length}`);
  }
  if (b.description != null) { vals.push(U.cleanName(b.description, 160) || null); sets.push(`description = $${vals.length}`); }
  if (b.status != null) {
    const s = String(b.status).toUpperCase();
    if (!["ACTIVE", "HIDDEN"].includes(s)) throw bad("Status must be ACTIVE or HIDDEN.");
    vals.push(s); sets.push(`status = $${vals.length}`);
  }
  if (b.requiresPool != null) { vals.push(b.requiresPool === true || b.requiresPool === "true"); sets.push(`requires_pool = $${vals.length}`); }
  if (!sets.length) throw bad("Nothing to update.");
  await query(`UPDATE ticket_types SET ${sets.join(", ")} WHERE id = $1`, vals);
  await audit("TYPE_UPDATED", "ticket_type", id, b, req.ip);
  res.json({ ok: true });
}));

module.exports = router;
