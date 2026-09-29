"use strict";
const { tx, audit } = require("./db");
const { generateTicketNumber } = require("./util");

/** Tickets still free to sell for a type: total − sold − live reservations. */
async function remainingStock(c, typeId, excludeOrderId = null) {
  const { rows } = await c.query(
    `SELECT tt.quantity_total - tt.quantity_sold - COALESCE((
        SELECT SUM(o.quantity) FROM orders o
        WHERE o.ticket_type_id = tt.id
          AND o.status IN ('PENDING','PAYMENT_PROCESSING')
          AND o.expires_at > now()
          AND ($2::bigint IS NULL OR o.id <> $2)
      ), 0)::int AS remaining
     FROM ticket_types tt WHERE tt.id = $1`,
    [typeId, excludeOrderId]
  );
  return rows[0] ? Number(rows[0].remaining) : 0;
}

/**
 * The single place where an order becomes PAID and tickets get created.
 * Safe to call repeatedly (webhook retries, admin re-confirm): everything happens
 * in one transaction under a row lock on the order.
 *
 * Returns { outcome, tickets? } where outcome is one of:
 *  ISSUED | ALREADY_PAID | DUPLICATE_PAYMENT | AMOUNT_MISMATCH | NO_STOCK | UNKNOWN_ORDER
 */
async function processVerifiedPayment({ orderNumber, transactionId, amount, payload, receipt = null, source = "WEBHOOK", note = null }) {
  return tx(async (c) => {
    const { rows } = await c.query("SELECT * FROM orders WHERE order_number = $1 FOR UPDATE", [orderNumber]);
    const order = rows[0];
    if (!order) return { outcome: "UNKNOWN_ORDER" };

    const raw = JSON.stringify(payload || {});

    // Already settled → a second confirmation is either a webhook retry (same id) or a double payment.
    if (order.status === "PAID" || order.status === "REFUND_REQUIRED") {
      const sameTx = transactionId && transactionId === order.tinypesa_transaction_id;
      if (transactionId && !sameTx) {
        const ins = await c.query(
          `INSERT INTO payment_transactions
             (order_id, tinypesa_request_id, tinypesa_transaction_id, amount, phone, status, raw_webhook, processed_at)
           VALUES ($1,$2,$3,$4,$5,'DUPLICATE',$6, now())
           ON CONFLICT DO NOTHING RETURNING id`,
          [order.id, transactionId, transactionId, Number(amount), order.holder_phone, raw]
        );
        if (ins.rowCount) {
          await audit("DUPLICATE_PAYMENT", "order", orderNumber, { transactionId, amount }, "", c);
          return { outcome: "DUPLICATE_PAYMENT" };
        }
      }
      return { outcome: "ALREADY_PAID" };
    }

    if (Number(amount) !== Number(order.total_amount)) {
      await audit("AMOUNT_MISMATCH", "order", orderNumber, { expected: order.total_amount, received: amount, source }, "", c);
      return { outcome: "AMOUNT_MISMATCH" };
    }

    const txId = transactionId || `MANUAL-${orderNumber}`;

    // Orders that were still holding stock are guaranteed a seat. Lapsed ones (FAILED/EXPIRED
    // → customer paid late) only get tickets if stock is still there; otherwise flag a refund.
    const holdsStock = ["PENDING", "PAYMENT_PROCESSING"].includes(order.status) && new Date(order.expires_at) > new Date();
    if (!holdsStock) {
      const { rows: r2 } = await c.query("SELECT id FROM ticket_types WHERE id = $1 FOR UPDATE", [order.ticket_type_id]);
      if (!r2.length) return { outcome: "UNKNOWN_ORDER" };
      const remaining = await remainingStock(c, order.ticket_type_id, order.id);
      if (remaining < order.quantity) {
        await c.query(
          `UPDATE orders SET status='REFUND_REQUIRED', paid_at=now(), tinypesa_transaction_id=$2, mpesa_receipt=$3 WHERE id=$1`,
          [order.id, txId, receipt]
        );
        await c.query(
          `INSERT INTO payment_transactions
             (order_id, tinypesa_request_id, tinypesa_transaction_id, amount, phone, status, raw_webhook, processed_at)
           VALUES ($1,$2,$3,$4,$5,'PAID',$6, now()) ON CONFLICT DO NOTHING`,
          [order.id, transactionId, txId, Number(amount), order.holder_phone, raw]
        );
        await audit("PAID_NO_STOCK", "order", orderNumber, { txId, amount }, "", c);
        return { outcome: "NO_STOCK" };
      }
    }

    await c.query(
      `UPDATE orders
         SET status='PAID', paid_at=now(), tinypesa_transaction_id=$2, mpesa_receipt=$3,
             failure_code=NULL, failure_reason=NULL
       WHERE id=$1`,
      [order.id, txId, receipt]
    );
    await c.query(
      `INSERT INTO payment_transactions
         (order_id, tinypesa_request_id, tinypesa_transaction_id, amount, phone, status, raw_webhook, processed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7, now()) ON CONFLICT DO NOTHING`,
      [order.id, transactionId, txId, Number(amount), order.holder_phone, source === "MANUAL" ? "MANUAL" : "PAID", raw]
    );

    const names = Array.isArray(order.attendee_names) ? order.attendee_names : [];
    const tickets = [];
    for (let i = 0; i < order.quantity; i++) {
      const ticketNumber = generateTicketNumber();
      await c.query(
        `INSERT INTO tickets (ticket_number, order_id, event_id, type_id, holder_name, holder_email, holder_phone)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [ticketNumber, order.id, order.event_id, order.ticket_type_id, names[i] || order.holder_name, order.holder_email, order.holder_phone]
      );
      tickets.push(ticketNumber);
    }
    await c.query("UPDATE ticket_types SET quantity_sold = quantity_sold + $2 WHERE id = $1", [order.ticket_type_id, order.quantity]);
    if (order.promo_code) await c.query("UPDATE promo_codes SET used_count = used_count + 1 WHERE code = $1", [order.promo_code]);

    await audit("PAYMENT_CONFIRMED", "order", orderNumber, { txId, amount, source, note, tickets: tickets.length }, "", c);
    return { outcome: "ISSUED", tickets };
  });
}

module.exports = { processVerifiedPayment, remainingStock };
