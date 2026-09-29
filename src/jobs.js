"use strict";
const { query, audit } = require("./db");

async function expireOrders() {
  const { rows } = await query(
    `UPDATE orders SET status = 'EXPIRED'
      WHERE status IN ('PENDING','PAYMENT_PROCESSING','FAILED') AND expires_at < now()
      RETURNING order_number, payment_started_at`
  );
  const stuck = rows.filter((r) => r.payment_started_at);
  if (rows.length) console.log(`⏱  Expired ${rows.length} unpaid order(s)` + (stuck.length ? ` — ${stuck.length} had a payment prompt sent (see Admin → Review)` : ""));
  if (stuck.length) await audit("ORDERS_EXPIRED_AFTER_PROMPT", "job", "expire", { orders: stuck.map((r) => r.order_number) });
}

function start() {
  const run = () => expireOrders().catch((e) => console.error("expire job failed:", e.message));
  run();
  return setInterval(run, 60 * 1000).unref();
}

module.exports = { start, expireOrders };
