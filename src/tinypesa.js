"use strict";
const cfg = require("./config");

/**
 * Trigger an M-Pesa STK push through TinyPesa.
 * Auth: `Apikey` header + `?username=` (link slug). The callback URL is configured
 * in the TinyPesa dashboard (Links → IPNs), not in this request.
 * Returns { ok, requestId, body, status }.
 */
async function sendStkPush(amount, msisdn, accountNo) {
  const url = `https://api.tinypesa.com/api/v1/express/initialize/?username=${encodeURIComponent(cfg.tinypesaUser)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json", Apikey: cfg.tinypesaKey },
    body: JSON.stringify({ amount, msisdn, account_no: accountNo }),
    signal: AbortSignal.timeout(20000),
  });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { raw: text.slice(0, 500) }; }
  return {
    ok: res.status === 200 && !!body.success,
    requestId: body.request_id != null ? String(body.request_id) : null,
    status: res.status,
    body,
  };
}

module.exports = { sendStkPush };
