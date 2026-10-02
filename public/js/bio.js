/* Fingerprint / Face ID for /admin and /door.
 * This asks the phone to run its OWN unlock: a fingerprint reader shows the fingerprint prompt, and a phone with
 * Face ID / face unlock opens the front camera itself. The website never sees the camera feed, a fingerprint or a face;
 * it only receives a signed "yes, the owner unlocked this phone". Needs https (or localhost). */
window.Bio = (function () {
  'use strict';
  const toBuf = (s) => { s = String(s).replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '='; const b = atob(s), u = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return u.buffer; };
  const toStr = (buf) => { const u = new Uint8Array(buf); let s = ''; for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };

  async function post(path, body, headers) {
    const r = await fetch(path, { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {}), body: JSON.stringify(body || {}) });
    let d = {}; try { d = await r.json(); } catch (e) { /* empty */ }
    if (!r.ok) { const er = new Error(d.error || 'Request failed (' + r.status + ')'); er.status = r.status; throw er; }
    return d;
  }

  /** true when this phone/computer has a fingerprint, Face ID, face unlock, Windows Hello or a screen-lock PIN to use. */
  async function supported() {
    try {
      if (!window.PublicKeyCredential || !window.isSecureContext) return false;
      return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
    } catch (e) { return false; }
  }

  /** Turn the browser's refusal into something a person can act on. */
  function friendly(e) {
    if (e && e.name === 'NotAllowedError') return 'Cancelled, or not accepted. Try again with your fingerprint. (On Samsung phones, face recognition is not allowed for websites, so use the fingerprint or the phone PIN.)';
    if (e && e.name === 'InvalidStateError') return 'This phone is already enrolled.';
    if (e && e.name === 'NotSupportedError') return 'This phone has no fingerprint or Face ID set up. Turn one on in the phone settings first.';
    if (e && e.name === 'SecurityError') return 'Fingerprint / Face ID only works on the secure https address of the site.';
    return (e && e.message) || 'Something went wrong.';
  }

  const create = (o) => ({
    publicKey: {
      challenge: toBuf(o.challenge), rp: o.rp,
      user: { id: toBuf(o.user.id), name: o.user.name, displayName: o.user.displayName },
      pubKeyCredParams: o.pubKeyCredParams, authenticatorSelection: o.authenticatorSelection, attestation: 'none', timeout: o.timeout,
    },
  });
  const packCreated = (c) => ({
    id: c.id,
    response: {
      clientDataJSON: toStr(c.response.clientDataJSON), attestationObject: toStr(c.response.attestationObject),
      transports: c.response.getTransports ? c.response.getTransports() : [],
    },
  });

  /** Sign in. scope = 'admin' | 'door'. Resolves { token, label, expiresInMs }. */
  async function login(scope) {
    const o = await post('/api/auth/login/options', { scope });
    let c;
    try {
      c = await navigator.credentials.get({ publicKey: {
        challenge: toBuf(o.challenge), rpId: o.rpId, timeout: o.timeout, userVerification: 'required',
        allowCredentials: o.allowCredentials.map((a) => ({ type: 'public-key', id: toBuf(a.id), transports: a.transports })),
      } });
    } catch (e) { throw new Error(friendly(e)); }
    if (!c) throw new Error('Cancelled.');
    return post('/api/auth/login/verify', { scope, credential: {
      id: c.id, response: { clientDataJSON: toStr(c.response.clientDataJSON), authenticatorData: toStr(c.response.authenticatorData), signature: toStr(c.response.signature) },
    } });
  }

  /** Enroll this device from the admin panel. headers = the admin auth header. */
  async function enrollAdmin(label, scope, headers) {
    const o = await post('/api/admin/biometric/register/options', { label, scope }, headers);
    let c;
    try { c = await navigator.credentials.create(create(o)); } catch (e) { throw new Error(friendly(e)); }
    if (!c) throw new Error('Cancelled.');
    return post('/api/admin/biometric/register/verify', { label, scope, credential: packCreated(c) }, headers);
  }

  /** Enroll a staff phone from the one-time link. Resolves a door session. */
  async function enrollInvite(token) {
    const o = await post('/api/auth/invite/options', { token });
    let c;
    try { c = await navigator.credentials.create(create(o)); } catch (e) { throw new Error(friendly(e)); }
    if (!c) throw new Error('Cancelled.');
    return post('/api/auth/invite/verify', { token, credential: packCreated(c) });
  }

  return { supported, login, enrollAdmin, enrollInvite };
})();
