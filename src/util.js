"use strict";
const crypto = require("crypto");
const cfg = require("./config");

/** Kenyan number → 2547XXXXXXXX / 2541XXXXXXXX. Throws on anything else. */
function normalizePhone(raw) {
  const d = String(raw || "").replace(/\D/g, "");
  let n = null;
  if (d.length === 12 && d.startsWith("254")) n = d;
  else if (d.length === 10 && d.startsWith("0")) n = "254" + d.slice(1);
  else if (d.length === 9) n = "254" + d;
  if (!n || !/^254[71]\d{8}$/.test(n)) throw new HttpError(400, "Enter a valid Safaricom number, e.g. 0712 345 678.");
  return n;
}

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"; // no 0/O/1/I
function randomCode(len) {
  let s = "";
  for (let i = 0; i < len; i++) s += ALPHABET[crypto.randomInt(ALPHABET.length)];
  return s;
}
const generateOrderNumber = () => "HG-" + randomCode(10);
const generateTicketNumber = () => "TICKET-" + crypto.randomBytes(4).toString("hex").toUpperCase();
const generateAccessKey = () => crypto.randomBytes(24).toString("hex");
const sha256 = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");

function safeEqual(a, b) {
  const ba = Buffer.from(String(a || ""));
  const bb = Buffer.from(String(b || ""));
  if (ba.length !== bb.length) {
    crypto.timingSafeEqual(ba, ba); // keep timing roughly constant
    return false;
  }
  return crypto.timingSafeEqual(ba, bb);
}

/**
 * Ticket QR payload = "<ticketNumber>.<signature>". The signature is an HMAC of the
 * ticket number + its QR version, so nothing secret is stored in the database and an
 * admin "reissue" (version + 1) instantly kills the old QR.
 */
function qrSignature(ticketNumber, version) {
  return crypto.createHmac("sha256", cfg.ticketSecret).update(`${ticketNumber}:${version}`).digest("hex").slice(0, 24);
}
const qrFor = (ticketNumber, version) => `${ticketNumber}.${qrSignature(ticketNumber, version)}`;

/** → { ticketNumber, signature } | null */
function parseTicketCode(code) {
  const c = String(code || "").trim();
  let m = c.match(/^(TICKET-[0-9A-F]{8})\.([0-9a-f]{24})$/i);
  if (m) return { ticketNumber: m[1].toUpperCase(), signature: m[2].toLowerCase() };
  m = c.match(/^(TICKET-[0-9A-F]{8})$/i);
  if (m) return { ticketNumber: m[1].toUpperCase(), signature: null }; // typed by staff
  return null;
}

/** Best-effort reader for TinyPesa / Daraja-style callback bodies. */
function extractCallback(payload) {
  const body = (payload && (payload.Body || payload)) || {};
  const cb = body.stkCallback || (payload && payload.stkCallback) || body;
  const items = (cb.CallbackMetadata && cb.CallbackMetadata.Item) || [];
  const meta = (name) => {
    const it = Array.isArray(items) ? items.find((i) => i && i.Name === name) : null;
    return it ? it.Value : undefined;
  };
  return {
    resultCode: Number(cb.ResultCode ?? cb.result_code ?? -1),
    resultDesc: String(cb.ResultDesc ?? cb.result_desc ?? "").slice(0, 300),
    tinyPesaId: String(cb.TinyPesaID ?? cb.tiny_pesa_id ?? "") || null,
    externalRef: String(cb.ExternalReference ?? cb.external_reference ?? "") || null,
    amount: cb.Amount ?? cb.amount ?? meta("Amount") ?? null,
    receipt: String(cb.MpesaReceiptNumber ?? cb.mpesa_receipt ?? meta("MpesaReceiptNumber") ?? "") || null,
  };
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const cleanName = (s, max = 80) => String(s || "").replace(/[\u0000-\u001f<>]/g, "").replace(/\s+/g, " ").trim().slice(0, max);

/** CSV cell with spreadsheet-formula protection. */
function csvCell(v) {
  let s = v === null || v === undefined ? "" : v instanceof Date ? v.toISOString() : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
const toCsv = (rows, cols) =>
  [cols.join(","), ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(","))].join("\r\n");

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

module.exports = {
  HttpError, normalizePhone, generateOrderNumber, generateTicketNumber, generateAccessKey, sha256,
  safeEqual, qrFor, qrSignature, parseTicketCode, extractCallback, EMAIL_RE, cleanName, toCsv, wrap,
};
