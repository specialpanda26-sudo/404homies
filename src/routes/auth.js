"use strict";
const express = require("express");
const rateLimit = require("express-rate-limit");
const { query, audit } = require("../db");
const W = require("../webauthn");
const S = require("../session");
const U = require("../util");

const router = express.Router();
router.use(rateLimit({ windowMs: 60 * 1000, limit: 40, standardHeaders: true, legacyHeaders: false, message: { error: "Too many attempts. Wait a minute and try again." } }));
router.use((req, res, next) => { res.set("Cache-Control", "no-store"); next(); });

const scopeOf = (v) => (v === "door" ? "door" : "admin");

// Step 1 of signing in: which enrolled devices may unlock this page, plus a fresh challenge.
router.post("/login/options", U.wrap(async (req, res) => {
  const scope = scopeOf(req.body?.scope);
  const { rows } = await query("SELECT cred_id, transports FROM webauthn_credentials WHERE scope = ANY($1::text[])", [scope === "door" ? ["door", "admin"] : ["admin"]]);
  if (!rows.length) throw new U.HttpError(404, "No fingerprint or Face ID is enrolled yet. Sign in with the code, then add one in Admin → Security.");
  res.json({
    challenge: W.makeChallenge("auth:" + scope),
    rpId: W.site(req).rpId,
    timeout: 60000,
    userVerification: "required",
    allowCredentials: rows.map((r) => ({ type: "public-key", id: r.cred_id, transports: r.transports ? r.transports.split(",") : undefined })),
  });
}));

// Step 2: the phone signed the challenge after a fingerprint / face check.
router.post("/login/verify", U.wrap(async (req, res) => {
  const scope = scopeOf(req.body?.scope);
  const cred = req.body?.credential;
  const credId = String(cred?.id || "");
  const { rows } = await query("SELECT * FROM webauthn_credentials WHERE cred_id = $1", [credId]);
  const row = rows[0];
  if (!row || (scope === "admin" && row.scope !== "admin")) throw new U.HttpError(401, "This phone isn't enrolled for that page.");
  const { origin, rpId } = W.site(req);
  const counter = W.finishAuthentication({ credential: cred, row, purpose: "auth:" + scope, origin, rpId });
  await query("UPDATE webauthn_credentials SET counter = $2, last_used_at = now() WHERE id = $1", [row.id, counter]);
  await audit("BIOMETRIC_LOGIN", "credential", row.id, { scope, label: row.label }, req.ip);
  const s = S.issue(row.id, scope);
  res.json({ token: s.token, expiresInMs: s.expiresInMs, scope, label: row.label });
}));

// ── enrolling a staff phone from a one-time link made in Admin → Security ───────────
async function findInvite(token) {
  const hash = U.sha256(String(token || "").trim());
  const { rows } = await query("SELECT * FROM webauthn_invites WHERE token_hash = $1", [hash]);
  const inv = rows[0];
  if (!inv || inv.used_at || new Date(inv.expires_at) < new Date()) throw new U.HttpError(410, "This enrollment link has expired or was already used. Ask the admin for a new one.");
  return { inv, hash };
}

router.post("/invite/options", U.wrap(async (req, res) => {
  const { inv, hash } = await findInvite(req.body?.token);
  const opts = W.creationOptions({ rpId: W.site(req).rpId, label: inv.label, purpose: "inv:" + hash.slice(0, 16) });
  res.json({ ...opts, label: inv.label });
}));

router.post("/invite/verify", U.wrap(async (req, res) => {
  const { inv, hash } = await findInvite(req.body?.token);
  const { origin, rpId } = W.site(req);
  const k = W.finishRegistration({ credential: req.body?.credential, purpose: "inv:" + hash.slice(0, 16), origin, rpId });
  const claim = await query("UPDATE webauthn_invites SET used_at = now() WHERE id = $1 AND used_at IS NULL RETURNING id", [inv.id]);
  if (!claim.rowCount) throw new U.HttpError(410, "This enrollment link was already used.");
  let row;
  try {
    ({ rows: [row] } = await query(
      `INSERT INTO webauthn_credentials (cred_id, public_key, alg, counter, label, scope, transports, last_used_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7, now()) RETURNING id`,
      [k.credId, k.publicKey, k.alg, k.counter, inv.label, inv.scope, k.transports]
    ));
  } catch (e) {
    if (e.code === "23505") throw new U.HttpError(409, "This phone is already enrolled.");
    throw e;
  }
  await audit("BIOMETRIC_ENROLLED", "credential", row.id, { label: inv.label, scope: inv.scope, via: "invite" }, req.ip);
  const s = S.issue(row.id, "door"); // an enrollment link signs the person into the page they opened it on: the scanner
  res.json({ ok: true, token: s.token, expiresInMs: s.expiresInMs, scope: "door", label: inv.label });
}));

module.exports = router;
