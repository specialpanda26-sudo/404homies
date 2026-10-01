"use strict";
/* "Tap to verify you're human" gate. Stateless signed tokens (HMAC with TICKET_SECRET):
 *   1. GET /api/verify/challenge   → signed challenge stamped with the time it was issued
 *   2. the browser waits ~5 s (animated box), then POST /api/verify/pass
 *   3. the server only accepts it if >= 4 s have passed, and each challenge works once
 *   4. the pass (valid 20 min, max 12 orders) is required to create an order
 * It makes bots slow and costly; it is a speed bump, not a replacement for a service like Cloudflare Turnstile. */
const crypto = require("crypto");
const cfg = require("./config");
const U = require("./util");

const MIN_WAIT_MS = 4000, MAX_AGE_MS = 5 * 60 * 1000, PASS_TTL_MS = 20 * 60 * 1000, PASS_MAX_ORDERS = 12;
const mac = (s) => crypto.createHmac("sha256", cfg.ticketSecret).update("human:" + s).digest("hex").slice(0, 24);
const seen = new Map(); // challenge id → expiry (single use); pass id → { exp, n }
setInterval(() => { const now = Date.now(); for (const [k, v] of seen) if ((v.exp || v) < now) seen.delete(k); }, 60000).unref();

const fail = (m) => new U.HttpError(400, m || "Verification failed. Please tap the box again.");

function challenge() {
  const id = crypto.randomBytes(8).toString("hex"), t = Date.now();
  return `${id}.${t}.${mac(`c:${id}.${t}`)}`;
}

function redeem(ch) {
  const m = /^([a-f0-9]{16})\.(\d{13})\.([a-f0-9]{24})$/.exec(String(ch || ""));
  if (!m || !U.safeEqual(mac(`c:${m[1]}.${m[2]}`), m[3])) throw fail();
  const age = Date.now() - Number(m[2]);
  if (age < MIN_WAIT_MS) throw fail("Please wait for the check to finish.");
  if (age > MAX_AGE_MS || seen.has("c" + m[1])) throw fail("That check expired. Please tap the box again.");
  seen.set("c" + m[1], Date.now() + MAX_AGE_MS);
  const id = crypto.randomBytes(8).toString("hex"), exp = Date.now() + PASS_TTL_MS;
  return { pass: `${id}.${exp}.${mac(`p:${id}.${exp}`)}`, expiresInMs: PASS_TTL_MS };
}

/** Express middleware: blocks the request unless a valid pass is sent in the X-Verify header. */
function requirePass(req, res, next) {
  if (!cfg.humanCheck) return next();
  const m = /^([a-f0-9]{16})\.(\d{13})\.([a-f0-9]{24})$/.exec(String(req.get("X-Verify") || ""));
  const bad = () => next(new U.HttpError(403, "Please tap the box to verify you're human."));
  if (!m || !U.safeEqual(mac(`p:${m[1]}.${m[2]}`), m[3]) || Number(m[2]) < Date.now()) return bad();
  const rec = seen.get("p" + m[1]) || { exp: Number(m[2]), n: 0 };
  if (rec.n >= PASS_MAX_ORDERS) return bad();
  rec.n++; seen.set("p" + m[1], rec);
  next();
}

module.exports = { challenge, redeem, requirePass, MIN_WAIT_MS };
