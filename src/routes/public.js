"use strict";
const express = require("express");
const rateLimit = require("express-rate-limit");
const cfg = require("../config");
const { pool, query, tx, audit } = require("../db");
const { sendStkPush } = require("../tinypesa");
const { processVerifiedPayment, remainingStock } = require("../payments");
const U = require("../util");

const router = express.Router();
const limit = (n) =>
  rateLimit({
    windowMs: 60 * 1000,
    limit: n,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many requests. Please wait a moment and try again." },
  });

// ── helpers ────────────────────────────────────────────────────────────────
async function findOrder(orderNumber, accessKey) {
  const { rows } = await query("SELECT * FROM orders WHERE order_number = $1", [String(orderNumber || "").trim().toUpperCase()]);
  const o = rows[0];
  if (!o || !U.safeEqual(U.sha256(accessKey || ""), o.access_key_hash)) throw new U.HttpError(404, "Order not found.");
  return o;
}

async function loadTickets(orderId) {
  const { rows } = await query(
    `SELECT t.ticket_number, t.holder_name, t.status, t.qr_version, tt.name AS type_name, tt.description AS type_desc,
            e.name AS event_name, e.venue, e.event_date::text AS event_date, e.event_time, o.order_number
       FROM tickets t
       JOIN ticket_types tt ON tt.id = t.type_id
       JOIN events e ON e.id = t.event_id
       JOIN orders o ON o.id = t.order_id
      WHERE t.order_id = $1 ORDER BY t.id`,
    [orderId]
  );
  return rows.map((r) => ({
    ticketNumber: r.ticket_number,
    holderName: r.holder_name,
    type: r.type_name,
    typeDesc: r.type_desc || "",
    status: r.status,
    orderNumber: r.order_number,
    event: { name: r.event_name, venue: r.venue, date: r.event_date, time: r.event_time },
    qr: U.qrFor(r.ticket_number, r.qr_version), // this exact string is what the QR code encodes
  }));
}

/** Server-side price: quantity × unit price − promo. `db` is the pool or a tx client. */
async function priceOrder(db, tt, quantity, rawCode) {
  const subtotal = tt.price * quantity;
  const code = String(rawCode || "").trim().toUpperCase().slice(0, 32);
  if (!code) return { subtotal, discount: 0, total: subtotal, promo: null };

  const { rows } = await db.query("SELECT * FROM promo_codes WHERE code = $1", [code]);
  const p = rows[0];
  const bad = (m) => new U.HttpError(400, m);
  if (!p || !p.active) throw bad("That promo code isn't valid.");
  if (p.expires_at && new Date(p.expires_at) < new Date()) throw bad("That promo code has expired.");
  if (p.max_uses != null && p.used_count >= p.max_uses) throw bad("That promo code has been fully used.");
  if (p.event_id != null && String(p.event_id) !== String(tt.event_id)) throw bad("That promo code isn't valid for this event.");

  const discount = Math.min(subtotal, p.kind === "PERCENT" ? Math.floor((subtotal * Math.min(p.value, 100)) / 100) : p.value);
  const total = subtotal - discount;
  if (total < 1) throw bad("That promo code can't bring the total to zero.");
  return { subtotal, discount, total, promo: p.code };
}

async function loadType(db, id, forUpdate = false) {
  const { rows } = await db.query(
    `SELECT tt.*, e.name AS event_name, e.status AS event_status
       FROM ticket_types tt JOIN events e ON e.id = tt.event_id
      WHERE tt.id = $1 ${forUpdate ? "FOR UPDATE OF tt" : ""}`,
    [id]
  );
  const tt = rows[0];
  if (!tt || tt.status !== "ACTIVE" || tt.event_status !== "ACTIVE") throw new U.HttpError(404, "That ticket type isn't available.");
  return tt;
}

function parseQty(v) {
  const q = Number.parseInt(v ?? 1, 10);
  if (!Number.isInteger(q) || q < 1 || q > cfg.maxTicketsPerOrder) throw new U.HttpError(400, `Choose between 1 and ${cfg.maxTicketsPerOrder} tickets.`);
  return q;
}

const displayPhone = (p) => p.replace(/^254(\d{3})(\d{3})(\d{3})$/, "+254 $1 $2 $3");

// ── routes ─────────────────────────────────────────────────────────────────
router.get("/config", (req, res) => {
  res.json({
    supportWhatsapp: cfg.supportWhatsapp || null,
    supportPhone: cfg.supportPhone || null,
    groupLink: cfg.groupLink || null,
    maxTickets: cfg.maxTicketsPerOrder,
    stkCooldownSeconds: cfg.stkCooldownSeconds,
    mock: cfg.mock,
  });
});

router.get("/events", limit(120), U.wrap(async (req, res) => {
  const ev = await query(
    `SELECT id, name, description, venue, event_date::text AS event_date, event_time
       FROM events WHERE status = 'ACTIVE' ORDER BY event_date, id`
  );
  const ids = ev.rows.map((e) => e.id);
  const types = ids.length
    ? await query(
        `SELECT tt.id, tt.event_id, tt.name, tt.description, tt.price,
                GREATEST(0, tt.quantity_total - tt.quantity_sold - COALESCE((
                  SELECT SUM(o.quantity) FROM orders o
                   WHERE o.ticket_type_id = tt.id AND o.status IN ('PENDING','PAYMENT_PROCESSING') AND o.expires_at > now()
                ), 0))::int AS remaining
           FROM ticket_types tt
          WHERE tt.status = 'ACTIVE' AND tt.event_id = ANY($1::bigint[]) ORDER BY tt.price`,
        [ids]
      )
    : { rows: [] };
  res.set("Cache-Control", "no-store");
  res.json(
    ev.rows.map((e) => ({
      ...e,
      ticketTypes: types.rows
        .filter((t) => t.event_id === e.id)
        .map((t) => ({ ...t, soldOut: t.remaining === 0, lowStock: t.remaining > 0 && t.remaining <= cfg.lowStockThreshold })),
    }))
  );
}));

router.post("/promo/check", limit(20), U.wrap(async (req, res) => {
  const tt = await loadType(pool, Number.parseInt(req.body?.ticketTypeId, 10));
  const qty = parseQty(req.body?.quantity);
  if (!String(req.body?.code || "").trim()) throw new U.HttpError(400, "Enter a promo code.");
  const p = await priceOrder(pool, tt, qty, req.body.code);
  res.json({ code: p.promo, subtotal: p.subtotal, discount: p.discount, total: p.total });
}));

router.post("/orders", limit(40), U.wrap(async (req, res) => {
  const b = req.body || {};
  const name = U.cleanName(b.name);
  const email = String(b.email || "").trim().toLowerCase().slice(0, 120);
  if (name.length < 2) throw new U.HttpError(400, "Enter your full name.");
  if (email && !U.EMAIL_RE.test(email)) throw new U.HttpError(400, "That email address doesn't look right.");
  if (b.agreed !== true) throw new U.HttpError(400, "Please confirm you're 18+ and agree to the terms.");
  const phone = U.normalizePhone(b.phone);
  const quantity = parseQty(b.quantity);
  const typeId = Number.parseInt(b.ticketTypeId, 10);
  if (!Number.isInteger(typeId)) throw new U.HttpError(400, "Choose a ticket type.");
  const attendees = Array.isArray(b.attendees)
    ? Array.from({ length: quantity }, (_, i) => U.cleanName(b.attendees[i] || "", 60))
    : Array.from({ length: quantity }, () => "");

  const accessKey = U.generateAccessKey();
  const orderNumber = U.generateOrderNumber();
  const expiresAt = new Date(Date.now() + cfg.orderTtlMinutes * 60 * 1000);

  const summary = await tx(async (c) => {
    const tt = await loadType(c, typeId, true); // row lock → concurrent buyers queue up here
    const remaining = await remainingStock(c, tt.id);
    if (remaining < quantity) {
      throw new U.HttpError(409, remaining > 0 ? `Only ${remaining} ${tt.name} ticket${remaining === 1 ? "" : "s"} left.` : `${tt.name} is sold out.`);
    }
    const price = await priceOrder(c, tt, quantity, b.promoCode);
    await c.query(
      `INSERT INTO orders (order_number, access_key_hash, holder_name, holder_email, holder_phone, event_id, ticket_type_id,
                           quantity, unit_price, subtotal_amount, discount_amount, total_amount, promo_code, attendee_names, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [orderNumber, U.sha256(accessKey), name, email, phone, tt.event_id, tt.id, quantity, tt.price,
       price.subtotal, price.discount, price.total, price.promo, JSON.stringify(attendees), expiresAt]
    );
    return { event: tt.event_name, ticketType: tt.name, unitPrice: tt.price, ...price };
  });

  await audit("ORDER_CREATED", "order", orderNumber, { total: summary.total, quantity }, req.ip);
  res.json({
    orderNumber,
    accessKey, // shown once; the browser keeps it to poll status and fetch tickets
    event: summary.event,
    ticketType: summary.ticketType,
    quantity,
    unitPrice: summary.unitPrice,
    subtotal: summary.subtotal,
    discount: summary.discount,
    totalAmount: summary.total,
    currency: "KES",
    expiresAt: expiresAt.toISOString(),
    phone: displayPhone(phone),
  });
}));

router.post("/payments/tinypesa/initiate", limit(40), U.wrap(async (req, res) => {
  const order = await findOrder(req.body?.orderNumber, req.body?.accessKey);

  if (order.status === "PAID" || order.status === "REFUND_REQUIRED") throw new U.HttpError(409, "This order is already paid.");
  if (order.status === "EXPIRED" || new Date(order.expires_at) < new Date()) {
    await query("UPDATE orders SET status = 'EXPIRED' WHERE id = $1 AND status <> 'PAID'", [order.id]);
    throw new U.HttpError(410, "This order expired and your tickets were released. Please start again.");
  }
  if (!["PENDING", "FAILED", "PAYMENT_PROCESSING"].includes(order.status)) throw new U.HttpError(409, "This order can't be paid right now.");
  if (order.initiate_count >= cfg.maxStkPerOrder) {
    throw new U.HttpError(429, "Too many prompts for this order. If money left your M-Pesa, use 'Find my ticket'. Otherwise start a new order.");
  }

  // Atomic claim: blocks double-taps and enforces the resend cooldown in one statement.
  // A FAILED order has released its stock, so retrying it must re-check availability under the
  // ticket-type row lock. Otherwise the retry could push the event past its capacity.
  const claimSql =
    `UPDATE orders
        SET status = 'PAYMENT_PROCESSING',
            last_initiated_at = now(),
            initiate_count = initiate_count + 1,
            payment_started_at = COALESCE(payment_started_at, now()),
            expires_at = GREATEST(expires_at, now() + interval '6 minutes'),
            failure_code = NULL, failure_reason = NULL
      WHERE id = $1
        AND status IN ('PENDING','FAILED','PAYMENT_PROCESSING')
        AND (last_initiated_at IS NULL OR last_initiated_at < now() - make_interval(secs => $2))
      RETURNING id`;
  const claimParams = [order.id, cfg.stkCooldownSeconds];
  let claim;
  if (order.status === "FAILED") {
    claim = await tx(async (c) => {
      await c.query("SELECT id FROM ticket_types WHERE id = $1 FOR UPDATE", [order.ticket_type_id]);
      const remaining = await remainingStock(c, order.ticket_type_id, order.id);
      if (remaining < order.quantity) return null;
      return c.query(claimSql, claimParams);
    });
    if (claim === null) {
      await query("UPDATE orders SET status = 'EXPIRED' WHERE id = $1 AND status = 'FAILED'", [order.id]);
      throw new U.HttpError(409, "Those tickets sold out while your payment was failing. No money was taken. Please start a new order.");
    }
  } else {
    claim = await query(claimSql, claimParams);
  }
  if (!claim.rowCount) {
    const wait = Math.max(1, cfg.stkCooldownSeconds - Math.floor((Date.now() - new Date(order.last_initiated_at).getTime()) / 1000));
    res.set("Retry-After", String(wait));
    throw new U.HttpError(429, `A prompt was just sent. You can resend in ${wait}s.`);
  }

  const revert = () =>
    query(
      `UPDATE orders SET status = $2, last_initiated_at = $3, payment_started_at = $4, initiate_count = GREATEST(initiate_count - 1, 0)
        WHERE id = $1 AND status = 'PAYMENT_PROCESSING'`,
      [order.id, order.status, order.last_initiated_at, order.payment_started_at]
    );

  let requestId;
  let raw;
  try {
    if (cfg.mock) {
      requestId = "MOCK-" + Date.now();
      raw = { mock: true };
      setTimeout(() => {
        processVerifiedPayment({ orderNumber: order.order_number, transactionId: "MOCKTX-" + Date.now(), amount: order.total_amount, payload: { mock: true }, receipt: "MOCK" })
          .catch((e) => console.error("mock payment failed:", e.message));
      }, 6000);
    } else {
      const r = await sendStkPush(order.total_amount, order.holder_phone, order.order_number);
      raw = r.body;
      if (!r.ok || !r.requestId) {
        console.error("TinyPesa initiate failed:", r.status, JSON.stringify(r.body).slice(0, 300));
        await revert();
        throw new U.HttpError(502, "We couldn't reach M-Pesa. No money was taken. Please try again.");
      }
      requestId = r.requestId;
    }
  } catch (err) {
    if (err instanceof U.HttpError) throw err;
    console.error("TinyPesa request error:", err.message);
    await revert();
    throw new U.HttpError(502, "We couldn't reach M-Pesa. No money was taken. Please try again.");
  }

  await query("UPDATE orders SET tinypesa_request_id = $2 WHERE id = $1", [order.id, requestId]);
  await query(
    `INSERT INTO payment_transactions (order_id, tinypesa_request_id, amount, phone, status, raw_response)
     VALUES ($1,$2,$3,$4,'INITIATED',$5)`,
    [order.id, requestId, order.total_amount, order.holder_phone, JSON.stringify(raw)]
  );
  await audit("PAYMENT_INITIATED", "order", order.order_number, { requestId, attempt: order.initiate_count + 1 }, req.ip);

  res.json({
    success: true, // "prompt sent" only — the ticket appears once the payment is confirmed
    orderNumber: order.order_number,
    totalAmount: order.total_amount,
    currency: "KES",
    phone: displayPhone(order.holder_phone),
    cooldownSeconds: cfg.stkCooldownSeconds,
    promptsSent: order.initiate_count + 1,
    message: "M-Pesa prompt sent. Enter your PIN on your phone.",
  });
}));

router.get("/orders/:orderNumber/status", limit(120), U.wrap(async (req, res) => {
  const o = await findOrder(req.params.orderNumber, req.get("x-access-key"));
  let status = o.status;
  if (["PENDING", "PAYMENT_PROCESSING", "FAILED"].includes(status) && new Date(o.expires_at) < new Date()) {
    await query("UPDATE orders SET status = 'EXPIRED' WHERE id = $1 AND status IN ('PENDING','PAYMENT_PROCESSING','FAILED')", [o.id]);
    status = "EXPIRED";
  }
  const sinceLast = o.last_initiated_at ? Math.floor((Date.now() - new Date(o.last_initiated_at).getTime()) / 1000) : null;
  const out = {
    orderNumber: o.order_number,
    status,
    totalAmount: o.total_amount,
    currency: o.currency,
    secondsLeft: Math.max(0, Math.floor((new Date(o.expires_at).getTime() - Date.now()) / 1000)),
    promptsSent: o.initiate_count,
    canResendIn: sinceLast === null ? 0 : Math.max(0, cfg.stkCooldownSeconds - sinceLast),
    failureCode: o.failure_code,
    failureReason: o.failure_reason,
  };
  if (status === "PAID") out.tickets = await loadTickets(o.id);
  res.set("Cache-Control", "no-store");
  res.json(out);
}));

// "Find my ticket": phone used at checkout + EITHER the order number OR the M-Pesa confirmation code from the SMS.
router.post("/tickets/lookup", limit(20), U.wrap(async (req, res) => {
  const notFound = new U.HttpError(404, "We couldn't find a paid order with those details.");
  let phone;
  try { phone = U.normalizePhone(req.body?.phone); } catch { throw notFound; }
  const code = String(req.body?.code || req.body?.orderNumber || "").trim().toUpperCase().replace(/\s+/g, "");
  if (code.length < 6) throw notFound;
  const { rows } = await query(
    "SELECT * FROM orders WHERE holder_phone = $2 AND status = 'PAID' AND (order_number = $1 OR mpesa_receipt = $1) ORDER BY paid_at DESC LIMIT 1",
    [code, phone]
  );
  const o = rows[0];
  if (!o) throw notFound;
  res.set("Cache-Control", "no-store");
  res.json({ orderNumber: o.order_number, tickets: await loadTickets(o.id) });
}));

// One-tap link sent from Admin → Orders → WhatsApp. The signed token proves the admin issued it.
router.get("/tickets/link/:token", limit(30), U.wrap(async (req, res) => {
  const orderNumber = U.parseLinkToken(req.params.token);
  const notFound = new U.HttpError(404, "This ticket link isn't valid. Use \u201cFind my ticket\u201d instead.");
  if (!orderNumber) throw notFound;
  const { rows } = await query("SELECT id FROM orders WHERE order_number = $1 AND status = 'PAID'", [orderNumber]);
  if (!rows[0]) throw notFound;
  res.set("Cache-Control", "no-store");
  res.json({ orderNumber, tickets: await loadTickets(rows[0].id) });
}));

// Read-only, no personal data. (Door staff use /api/staff/* instead.)
router.get("/tickets/verify/:code", limit(60), U.wrap(async (req, res) => {
  const p = U.parseTicketCode(req.params.code);
  if (!p || !p.signature) return res.json({ valid: false, reason: "Scan the ticket's QR code." });
  const { rows } = await query("SELECT status, qr_version FROM tickets WHERE ticket_number = $1", [p.ticketNumber]);
  const t = rows[0];
  if (!t || !U.safeEqual(U.qrSignature(p.ticketNumber, t.qr_version), p.signature)) return res.json({ valid: false, reason: "Ticket not found." });
  res.json({ valid: t.status === "VALID", status: t.status });
}));

module.exports = router;
