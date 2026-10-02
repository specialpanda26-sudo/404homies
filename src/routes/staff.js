"use strict";
const express = require("express");
const rateLimit = require("express-rate-limit");
const cfg = require("../config");
const { query, audit } = require("../db");
const U = require("../util");
const Sess = require("../session");

const router = express.Router();
router.use(rateLimit({ windowMs: 60 * 1000, limit: 240, standardHeaders: true, legacyHeaders: false, message: { error: "Too many requests." } }));

// Door staff sign in with STAFF_TOKEN (or the admin token), or with a fingerprint / Face ID session (X-Session).
router.use(U.wrap(async (req, res, next) => {
  const t = req.get("x-staff-token") || "";
  if ((cfg.staffToken && U.safeEqual(t, cfg.staffToken)) || U.safeEqual(t, cfg.adminToken)) return next();
  if (req.get("x-session") && (await Sess.verify(req.get("x-session"), "door"))) return next();
  res.status(401).json({ error: req.get("x-session") ? "Session ended." : "Wrong staff code." });
}));

const SELECT = `SELECT t.id, t.ticket_number, t.holder_name, t.holder_phone, t.status, t.used_at, t.qr_version,
                       tt.name AS type_name, tt.description AS type_desc, e.name AS event_name, o.order_number
                  FROM tickets t JOIN ticket_types tt ON tt.id = t.type_id
                  JOIN events e ON e.id = t.event_id JOIN orders o ON o.id = t.order_id`;

async function resolve(code) {
  const p = U.parseTicketCode(code);
  if (!p) return { error: "Not a valid ticket for this event." };
  const { rows } = await query(`${SELECT} WHERE t.ticket_number = $1`, [p.ticketNumber]);
  const t = rows[0];
  if (!t) return { error: "Ticket not found." };
  // A scanned QR must carry a valid signature. Staff typing the ticket number may skip it.
  if (p.signature && !U.safeEqual(U.qrSignature(t.ticket_number, t.qr_version), p.signature)) {
    return { error: "Invalid or replaced QR code." };
  }
  return { ticket: t, typed: !p.signature };
}

const shape = (t) => ({
  ticketNumber: t.ticket_number, holder: t.holder_name, type: t.type_name, typeDesc: t.type_desc || "", event: t.event_name,
  orderNumber: t.order_number, status: t.status, usedAt: t.used_at,
});

router.get("/summary", U.wrap(async (req, res) => {
  const { rows } = await query(
    `SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE status = 'USED')::int AS admitted,
            COUNT(*) FILTER (WHERE status = 'CANCELLED')::int AS cancelled FROM tickets`
  );
  res.json(rows[0]);
}));

// Find a guest who lost their QR: name, phone (0712… or 254712…), ticket number or order number.
router.get("/search", U.wrap(async (req, res) => {
  const raw = String(req.query.q || "").trim().slice(0, 60);
  if (raw.length < 3) return res.json([]);
  const esc = (s) => s.replace(/[%_\\]/g, "\\$&");
  const digits = raw.replace(/\D/g, "");
  const phone = digits.length >= 4 ? (digits.startsWith("0") ? "254" + digits.slice(1) : digits) : null;
  const params = [`%${esc(raw)}%`];
  let phoneClause = "";
  if (phone) { params.push(`%${esc(phone)}%`); phoneClause = " OR t.holder_phone LIKE $2"; }
  const { rows } = await query(
    `${SELECT}
      WHERE t.holder_name ILIKE $1 OR t.ticket_number ILIKE $1 OR o.order_number ILIKE $1${phoneClause}
      ORDER BY t.holder_name LIMIT 12`,
    params
  );
  res.json(rows.map((t) => ({ ...shape(t), phoneTail: String(t.holder_phone || "").slice(-3) })));
}));

// Look, don't touch.
router.post("/check", U.wrap(async (req, res) => {
  const r = await resolve(req.body?.code);
  if (r.error) return res.json({ result: "INVALID", reason: r.error });
  const t = r.ticket;
  res.json({ result: t.status === "VALID" ? "VALID" : t.status === "USED" ? "ALREADY_USED" : "CANCELLED", ...shape(t) });
}));

// Admit: the UPDATE only succeeds for a VALID ticket, so two scanners can never both admit it.
router.post("/admit", U.wrap(async (req, res) => {
  const r = await resolve(req.body?.code);
  if (r.error) return res.json({ result: "INVALID", reason: r.error });
  const t = r.ticket;
  if (t.status === "CANCELLED") return res.json({ result: "CANCELLED", ...shape(t) });
  const upd = await query("UPDATE tickets SET status = 'USED', used_at = now() WHERE id = $1 AND status = 'VALID' RETURNING used_at", [t.id]);
  if (!upd.rowCount) {
    const cur = (await query("SELECT used_at FROM tickets WHERE id = $1", [t.id])).rows[0];
    return res.json({ result: "ALREADY_USED", ...shape({ ...t, status: "USED", used_at: cur?.used_at }) });
  }
  await audit("TICKET_USED", "ticket", t.ticket_number, { typed: r.typed }, req.ip);
  res.json({ result: "ADMIT", ...shape({ ...t, status: "USED", used_at: upd.rows[0].used_at }) });
}));

module.exports = router;
