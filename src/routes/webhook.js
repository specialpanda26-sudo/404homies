"use strict";
const express = require("express");
const cfg = require("../config");
const { query } = require("../db");
const { processVerifiedPayment } = require("../payments");
const U = require("../util");

const router = express.Router();

/**
 * TinyPesa posts payment results here. There is no signature, so a payment is only
 * accepted when ALL of these hold:
 *   1. the URL secret matches (if WEBHOOK_SECRET is set)
 *   2. ExternalReference is one of our order numbers
 *   3. TinyPesaID is a request id WE received when we sent that order's STK push
 *      (never shown to the browser)            → can be relaxed with TINYPESA_STRICT_ID=false
 *   4. Amount equals the order total stored in our database
 * Then everything else (idempotency, stock, tickets) happens in one DB transaction.
 */
async function handle(req, res) {
  let outcome = "IGNORED";
  let error = null;
  let parsed = {};
  let rawBody = "";
  try {
    rawBody = Buffer.isBuffer(req.body) ? req.body.toString("utf8") : JSON.stringify(req.body || {});
    let payload;
    try { payload = JSON.parse(rawBody); } catch { payload = {}; }
    parsed = U.extractCallback(payload);
    const { resultCode, resultDesc, tinyPesaId, externalRef, amount, receipt } = parsed;

    if (!externalRef) { outcome = "NO_REFERENCE"; return res.status(200).json({ received: true }); }

    const { rows } = await query("SELECT * FROM orders WHERE order_number = $1", [externalRef.toUpperCase()]);
    const order = rows[0];
    if (!order) { outcome = "UNKNOWN_ORDER"; return res.status(200).json({ received: true }); }

    if (cfg.strictWebhookId) {
      const known = tinyPesaId && (await query(
        "SELECT 1 FROM payment_transactions WHERE order_id = $1 AND tinypesa_request_id = $2 AND status = 'INITIATED' LIMIT 1",
        [order.id, tinyPesaId]
      )).rowCount;
      if (!known) {
        outcome = "REJECTED_ID_MISMATCH";
        error = `TinyPesaID ${tinyPesaId || "(none)"} was not issued for ${order.order_number}`;
        console.warn("Webhook rejected:", error);
        return res.status(200).json({ received: true });
      }
    }

    if (resultCode !== 0) {
      // A late failure for an OLDER prompt (customer hit Resend) must not fail an order whose newer prompt is still live.
      if (tinyPesaId && order.tinypesa_request_id && tinyPesaId !== order.tinypesa_request_id) {
        outcome = "STALE_FAILURE_IGNORED";
        return res.status(200).json({ received: true });
      }
      // Only an unpaid order can be failed; a forged/late failure never touches a paid one.
      const r = await query(
        `UPDATE orders SET status = 'FAILED', failure_code = $2, failure_reason = $3
          WHERE id = $1 AND status IN ('PENDING','PAYMENT_PROCESSING')`,
        [order.id, resultCode, resultDesc]
      );
      outcome = r.rowCount ? "MARKED_FAILED" : "FAILURE_IGNORED";
      return res.status(200).json({ received: true });
    }

    const result = await processVerifiedPayment({
      orderNumber: order.order_number, transactionId: tinyPesaId, amount, payload, receipt, source: "WEBHOOK",
    });
    outcome = result.outcome;
    if (outcome === "AMOUNT_MISMATCH") error = `expected ${order.total_amount}, got ${amount}`;
    if (outcome === "ISSUED") console.log(`✅ Payment confirmed: ${order.order_number} — ${result.tickets.length} ticket(s)`);
    return res.status(200).json({ received: true });
  } catch (err) {
    outcome = "ERROR";
    error = err.message;
    console.error("Webhook processing error:", err.message);
    // 500 lets TinyPesa retry; processing is idempotent so a retry is safe.
    return res.status(500).json({ received: false });
  } finally {
    query(
      `INSERT INTO webhook_events (tiny_pesa_id, external_ref, result_code, amount, payload, outcome, error)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [parsed.tinyPesaId || null, parsed.externalRef || null, Number.isFinite(parsed.resultCode) ? parsed.resultCode : null,
       Number.isFinite(Number(parsed.amount)) ? Number(parsed.amount) : null, rawBody.slice(0, 8000), outcome, error]
    ).catch((e) => console.error("webhook log failed:", e.message));
  }
}

const secretMatches = (given) => !cfg.webhookSecret || U.safeEqual(given, cfg.webhookSecret);

// With WEBHOOK_SECRET set, ONLY /webhook/<secret> is accepted. Otherwise the plain path works.
router.post("/webhook/:secret", (req, res) => {
  if (!cfg.webhookSecret || !secretMatches(req.params.secret)) return res.status(404).json({ error: "Not found" });
  return handle(req, res);
});
router.post("/webhook", (req, res) => {
  if (cfg.webhookSecret) return res.status(404).json({ error: "Not found" });
  return handle(req, res);
});

module.exports = router;
