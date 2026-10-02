"use strict";
/* Referral program.
 *   Every customer gets one code (tied to their phone). Friends type it at checkout.
 *   Only PAID orders count. Pool-party-only add-ons and free reward tickets are ignored.
 *   Rewards are cumulative milestones (change TIERS to change the rules; the site and admin panel follow):
 *     5 single tickets  + 1 couple ticket  → 1 free ticket
 *     10 single tickets + 2 couple tickets → 2 free tickets
 *   A ticket type counts as a "couple" when its name contains the word "couple". */
const U = require("./util");

const TIERS = [
  { singles: 5, couples: 1, free: 1 },
  { singles: 10, couples: 2, free: 2 },
];
const CODE_RE = /^[A-Z0-9-]{3,24}$/;
const clean = (v) => String(v || "").trim().toUpperCase().replace(/\s+/g, "").slice(0, 24);

/** Counts for one code, or for every code when `code` is null. Rows: { code, singles, couples, people, issued } */
const COUNTS_SQL = `
  SELECT r.code,
         COALESCE(SUM(o.quantity) FILTER (WHERE tt.id IS NOT NULL AND tt.name NOT ILIKE '%couple%'), 0)::int AS singles,
         COALESCE(SUM(o.quantity) FILTER (WHERE tt.id IS NOT NULL AND tt.name ILIKE '%couple%'), 0)::int AS couples,
         COUNT(DISTINCT o.holder_phone) FILTER (WHERE tt.id IS NOT NULL)::int AS people,
         (SELECT COUNT(*)::int FROM orders c WHERE c.reward_code = r.code AND c.status = 'PAID') AS issued,
         (SELECT COALESCE(array_agg(c.order_number ORDER BY c.id), '{}') FROM orders c WHERE c.reward_code = r.code AND c.status = 'PAID') AS reward_orders
    FROM referral_codes r
    LEFT JOIN orders o ON o.referral_code = r.code AND o.status = 'PAID' AND o.is_comp = FALSE
    LEFT JOIN ticket_types tt ON tt.id = o.ticket_type_id AND tt.requires_pool = FALSE
   WHERE ($1::text IS NULL OR r.code = $1)
   GROUP BY r.id`;

/** Turns raw counts into what the progress bar needs. */
function shape(c) {
  const hit = (t) => c.singles >= t.singles && c.couples >= t.couples;
  const earned = TIERS.filter(hit).reduce((m, t) => Math.max(m, t.free), 0);
  const next = TIERS.find((t) => !hit(t)) || null;
  const target = next || TIERS[TIERS.length - 1];
  const done = Math.min(c.singles, target.singles) + Math.min(c.couples, target.couples);
  return {
    singles: c.singles, couples: c.couples, people: c.people,
    tiers: TIERS.map((t) => ({ ...t, reached: hit(t) })),
    earned, issued: c.issued, available: Math.max(0, earned - c.issued),
    next, target,
    pct: next ? Math.round((100 * done) / (target.singles + target.couples)) : 100,
    rewardOrders: c.reward_orders || [],
  };
}

async function progress(db, code) {
  const { rows } = await db.query(COUNTS_SQL, [code]);
  return rows[0] ? shape(rows[0]) : null;
}
async function progressAll(db) {
  const { rows } = await db.query(COUNTS_SQL, [null]);
  return new Map(rows.map((r) => [r.code, shape(r)]));
}

function makeCode(name) {
  const first = String(name || "").toUpperCase().split(/\s+/)[0].replace(/[^A-Z]/g, "").slice(0, 6) || "HG";
  return `${first}-${U.randomCode(4)}`;
}

/** The customer's code, created the first time they have a paid order. */
async function getOrCreate(db, phone, name) {
  let r = await db.query("SELECT * FROM referral_codes WHERE phone = $1", [phone]);
  if (r.rows[0]) return r.rows[0];
  for (let i = 0; i < 6; i++) {
    const ins = await db.query("INSERT INTO referral_codes (code, phone, holder_name) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING RETURNING *", [makeCode(name), phone, name]);
    if (ins.rows[0]) return ins.rows[0];
    r = await db.query("SELECT * FROM referral_codes WHERE phone = $1", [phone]); // another request created it first
    if (r.rows[0]) return r.rows[0];
  }
  throw new Error("could not create a referral code");
}

module.exports = { TIERS, CODE_RE, clean, shape, progress, progressAll, getOrCreate };
