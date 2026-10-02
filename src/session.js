"use strict";
/* Sessions issued after a successful fingerprint / Face ID.
 * Token = "<credentialId>.<scope>.<expiry>.<signature>", signed with TICKET_SECRET and sent in the X-Session header.
 * It only works while that device is still enrolled: revoking a device in Admin → Security locks it out within seconds. */
const crypto = require("crypto");
const cfg = require("./config");
const { query } = require("./db");
const U = require("./util");

const TTL = { admin: 8 * 3600 * 1000, door: 12 * 3600 * 1000 };
const sig = (s) => crypto.createHmac("sha256", cfg.ticketSecret).update("session:" + s).digest("hex").slice(0, 32);

function issue(credentialId, scope) {
  const exp = Date.now() + TTL[scope];
  const body = `${credentialId}.${scope}.${exp}`;
  return { token: `${body}.${sig(body)}`, expiresInMs: TTL[scope] };
}

const alive = new Map(); // credential id → checked-at (so a busy scanner doesn't hit the database every request)
setInterval(() => { const n = Date.now(); for (const [k, t] of alive) if (n - t > 60000) alive.delete(k); }, 60000).unref();

/** need = "admin" (admin panel) or "door" (scanner; admin sessions work there too). */
async function verify(token, need) {
  const m = /^(\d{1,18})\.(admin|door)\.(\d{13})\.([a-f0-9]{32})$/.exec(String(token || ""));
  if (!m || !U.safeEqual(sig(`${m[1]}.${m[2]}.${m[3]}`), m[4]) || Number(m[3]) < Date.now()) return false;
  if (need === "admin" && m[2] !== "admin") return false;
  const key = `${m[1]}:${m[2]}`;
  if (alive.has(key) && Date.now() - alive.get(key) < 15000) return true;
  const { rows } = await query("SELECT scope FROM webauthn_credentials WHERE id = $1", [m[1]]);
  if (!rows[0] || (m[2] === "admin" && rows[0].scope !== "admin")) return false;
  alive.set(key, Date.now());
  return true;
}
const forget = () => alive.clear();

module.exports = { issue, verify, forget };
