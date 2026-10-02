"use strict";
/* Fingerprint / Face ID sign-in (WebAuthn "platform authenticators"), dependency-free.
 * The phone does the fingerprint or face check itself (Face ID / face unlock opens the camera on its own).
 * The server only ever sees a public key and a signature, never a fingerprint or a face. */
const crypto = require("crypto");
const cfg = require("./config");
const U = require("./util");

const b64u = (buf) => Buffer.from(buf).toString("base64url");
const unb64u = (s) => Buffer.from(String(s || ""), "base64url");
const sha256 = (b) => crypto.createHash("sha256").update(b).digest();
const bad = (m) => new U.HttpError(400, m);

/* ── minimal CBOR reader (enough for attestation objects and COSE keys) ─────────────── */
function cbor(buf, off = 0, depth = 0) {
  if (depth > 8 || off >= buf.length) throw new Error("bad cbor");
  const ib = buf[off++], major = ib >> 5, info = ib & 31;
  const len = () => {
    if (info < 24) return info;
    if (info === 24) return buf[off++];
    if (info === 25) { const v = buf.readUInt16BE(off); off += 2; return v; }
    if (info === 26) { const v = buf.readUInt32BE(off); off += 4; return v; }
    if (info === 27) { const v = Number(buf.readBigUInt64BE(off)); off += 8; return v; }
    throw new Error("unsupported cbor");
  };
  if (major === 7) {
    if (info === 20) return [false, off];
    if (info === 21) return [true, off];
    if (info === 22 || info === 23) return [null, off];
    if (info === 25) return [0, off + 2];
    if (info === 26) return [buf.readFloatBE(off), off + 4];
    if (info === 27) return [buf.readDoubleBE(off), off + 8];
    throw new Error("unsupported cbor");
  }
  const n = len();
  if (major === 0) return [n, off];
  if (major === 1) return [-1 - n, off];
  if (major === 2 || major === 3) {
    if (off + n > buf.length) throw new Error("bad cbor");
    const s = buf.subarray(off, off + n);
    return [major === 2 ? Buffer.from(s) : s.toString("utf8"), off + n];
  }
  if (major === 4) {
    const arr = [];
    for (let i = 0; i < n; i++) { const [v, o] = cbor(buf, off, depth + 1); arr.push(v); off = o; }
    return [arr, off];
  }
  if (major === 5) {
    const m = new Map();
    for (let i = 0; i < n; i++) {
      const [k, o1] = cbor(buf, off, depth + 1); const [v, o2] = cbor(buf, o1, depth + 1);
      m.set(k, v); off = o2;
    }
    return [m, off];
  }
  throw new Error("unsupported cbor");
}

/* ── challenges: signed, expire in 5 minutes, usable once ──────────────────────────── */
const mac = (s) => crypto.createHmac("sha256", cfg.ticketSecret).update("webauthn:" + s).digest("hex").slice(0, 32);
const spent = new Map();
setInterval(() => { const now = Date.now(); for (const [k, exp] of spent) if (exp < now) spent.delete(k); }, 60000).unref();

/** Returns the challenge as a base64url string (the browser turns it back into bytes). `purpose` ties it to one use. */
function makeChallenge(purpose) {
  const body = `${crypto.randomBytes(16).toString("hex")}.${Date.now() + 5 * 60 * 1000}`;
  return b64u(Buffer.from(`${body}.${mac(`${purpose}:${body}`)}`));
}
function takeChallenge(ch, purpose) {
  const m = /^([a-f0-9]{32})\.(\d{13})\.([a-f0-9]{32})$/.exec(unb64u(ch).toString("utf8"));
  if (!m || !U.safeEqual(mac(`${purpose}:${m[1]}.${m[2]}`), m[3])) throw bad("This sign-in expired. Please try again.");
  if (Number(m[2]) < Date.now() || spent.has(m[1])) throw bad("This sign-in expired. Please try again.");
  spent.set(m[1], Number(m[2]));
}

/** Where is the browser talking to us? WebAuthn keys are tied to this exact site. */
function site(req) {
  const host = String(req.get("host") || "");
  return { origin: `${req.protocol}://${host}`, rpId: host.replace(/:\d+$/, "") };
}

function checkClientData(cred, type, purpose, origin) {
  let cd;
  try { cd = JSON.parse(unb64u(cred.response.clientDataJSON).toString("utf8")); } catch { throw bad("Sign-in data was not readable."); }
  if (cd.type !== type) throw bad("Wrong sign-in type.");
  if (cd.origin !== origin) throw bad("This sign-in was made on a different website.");
  takeChallenge(cd.challenge, purpose);
  return sha256(unb64u(cred.response.clientDataJSON));
}

function checkAuthData(ad, rpId) {
  if (ad.length < 37) throw bad("Sign-in data was not readable.");
  if (!crypto.timingSafeEqual(ad.subarray(0, 32), sha256(Buffer.from(rpId)))) throw bad("This sign-in was made for a different website.");
  const flags = ad[32];
  if (!(flags & 0x01)) throw bad("Touch the sensor to continue.");
  if (!(flags & 0x04)) throw bad("Fingerprint or Face ID was not confirmed on the phone.");
  return { flags, counter: ad.readUInt32BE(33) };
}

function coseToKey(cose) {
  if (!(cose instanceof Map)) throw bad("Unsupported key.");
  const kty = cose.get(1), alg = cose.get(3);
  let jwk;
  if (kty === 2 && alg === -7 && cose.get(-1) === 1) jwk = { kty: "EC", crv: "P-256", x: b64u(cose.get(-2)), y: b64u(cose.get(-3)) };
  else if (kty === 3 && alg === -257) jwk = { kty: "RSA", n: b64u(cose.get(-1)), e: b64u(cose.get(-2)) };
  else throw bad("This phone uses a key type we don't support.");
  const key = crypto.createPublicKey({ key: jwk, format: "jwk" });
  return { alg, publicKey: key.export({ type: "spki", format: "der" }).toString("base64") };
}

/** Options for enrolling: ask for the phone's OWN fingerprint / face lock, and require it. */
function creationOptions({ rpId, label, purpose }) {
  return {
    challenge: makeChallenge(purpose),
    rp: { name: "404homies", id: rpId },
    user: { id: b64u(crypto.randomBytes(16)), name: label, displayName: label },
    pubKeyCredParams: [{ type: "public-key", alg: -7 }, { type: "public-key", alg: -257 }],
    authenticatorSelection: { authenticatorAttachment: "platform", userVerification: "required", residentKey: "preferred" },
    attestation: "none",
    timeout: 60000,
  };
}

/** → { credId, publicKey, alg, counter, transports } */
function finishRegistration({ credential, purpose, origin, rpId }) {
  if (!credential || !credential.response) throw bad("Sign-in data was missing.");
  checkClientData(credential, "webauthn.create", purpose, origin);
  let att;
  try { att = cbor(unb64u(credential.response.attestationObject))[0]; } catch { throw bad("Sign-in data was not readable."); }
  const ad = att instanceof Map ? att.get("authData") : null;
  if (!Buffer.isBuffer(ad)) throw bad("Sign-in data was not readable.");
  const { flags, counter } = checkAuthData(ad, rpId);
  if (!(flags & 0x40) || ad.length < 55) throw bad("No key came back from the phone.");
  const idLen = ad.readUInt16BE(53);
  const credId = ad.subarray(55, 55 + idLen);
  let cose;
  try { cose = cbor(ad, 55 + idLen)[0]; } catch { throw bad("Sign-in data was not readable."); }
  const k = coseToKey(cose);
  const tr = Array.isArray(credential.response.transports) ? credential.response.transports.filter((t) => /^[a-z-]{2,12}$/.test(t)).join(",") : "";
  return { credId: b64u(credId), publicKey: k.publicKey, alg: k.alg, counter, transports: tr };
}

/** `row` = the stored credential. Returns the new signature counter. */
function finishAuthentication({ credential, row, purpose, origin, rpId }) {
  if (!credential || !credential.response) throw bad("Sign-in data was missing.");
  const cdHash = checkClientData(credential, "webauthn.get", purpose, origin);
  const ad = unb64u(credential.response.authenticatorData);
  const { counter } = checkAuthData(ad, rpId);
  const key = crypto.createPublicKey({ key: Buffer.from(row.public_key, "base64"), format: "der", type: "spki" });
  const ok = crypto.verify("sha256", Buffer.concat([ad, cdHash]), key, unb64u(credential.response.signature));
  if (!ok) throw new U.HttpError(401, "Fingerprint or Face ID did not match.");
  const old = Number(row.counter);
  if ((counter || old) && counter <= old) throw new U.HttpError(401, "This device looks cloned. Enroll it again.");
  return counter;
}

module.exports = { b64u, unb64u, site, makeChallenge, creationOptions, finishRegistration, finishAuthentication, cbor };
