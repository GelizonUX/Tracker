/* ──────────────────────────────────────────────────────────────────────────
   Trakora — Lemon Squeezy → Firebase license bridge (Cloudflare Worker)

   What it does
   ------------
   Lemon Squeezy calls this Worker after every paid order. The Worker verifies
   the request is really from Lemon Squeezy (signature check), then writes the
   license key into your Firebase so the app can validate it and the buyer's
   "claim" screen reveals it automatically. Lemon Squeezy also emails the key
   to the buyer on its own — this is the second, automatic delivery path.

   The buyer never sees this Worker. The app talks to Firebase; this Worker is
   the only thing that is allowed to CREATE keys, so a buyer can't mint their own.

   Deploy (no credit card, ~5 min)
   -------------------------------
   1. Create a free account at https://dash.cloudflare.com → Workers & Pages →
      Create → Worker. Name it e.g. "trakora-license". Paste this whole file in
      and Deploy. Your callback URL is the *.workers.dev URL it gives you.
   2. In the Worker → Settings → Variables, add two encrypted secrets:
         LS_SIGNING_SECRET   = the signing secret from your Lemon Squeezy webhook
         FIREBASE_DB_SECRET  = your Firebase Realtime DB secret (Project settings →
                               Service accounts → Database secrets). Leave blank
                               only if your DB rules are fully open (not recommended).
      And one plain variable:
         FIREBASE_URL        = https://trakora-30796-default-rtdb.firebaseio.com
   3. In Lemon Squeezy → Settings → Webhooks → +:
         Callback URL: your *.workers.dev URL
         Signing secret: make one up (any random string) — paste the SAME value
                         into LS_SIGNING_SECRET above
         Events: tick "order_created"  (and "license_key_created" if shown)
   4. In Lemon Squeezy → your product → enable "License keys", set
      "Activations" limit to 2 (matches the app's 2-device default).

   That's it. Test with Lemon Squeezy's "Send test" on the webhook, then check
   your Firebase /licenses node and the Customers page.
   ────────────────────────────────────────────────────────────────────────── */

export default {
  async fetch(request, env) {
    if (request.method === 'GET') {
      return new Response('Trakora license bridge is live.', { status: 200 });
    }
    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 });
    }

    // Read the raw body exactly as sent — needed for an accurate signature check.
    const raw = await request.text();

    // 1) Verify the request really came from Lemon Squeezy.
    const ok = await verifySignature(raw, request.headers.get('X-Signature') || '', env.LS_SIGNING_SECRET);
    if (!ok) {
      return new Response('Invalid signature', { status: 401 });
    }

    let payload;
    try { payload = JSON.parse(raw); } catch (_) {
      return new Response('Bad JSON', { status: 400 });
    }

    const eventName = (payload.meta && payload.meta.event_name) || '';
    const attr = (payload.data && payload.data.attributes) || {};

    // Pull the license details out of whichever event fired.
    const rec = extractLicense(eventName, attr);
    if (!rec || !rec.key || !rec.email) {
      // Nothing to do for this event (e.g. a refund or unrelated event). Ack it.
      return new Response('Ignored: ' + eventName, { status: 200 });
    }

    // 2) Write the license so the app can validate it.
    const base = (env.FIREBASE_URL || '').replace(/\/+$/, '');
    const auth = env.FIREBASE_DB_SECRET ? ('?auth=' + encodeURIComponent(env.FIREBASE_DB_SECRET)) : '';
    const now = new Date().toISOString().slice(0, 10);

    const license = {
      name: rec.name,
      email: rec.email,
      status: 'active',
      deviceLimit: rec.limit || 2,
      issued: now,
      source: 'lemonsqueezy',
      devices: {}
    };

    // /licenses/<KEY>  → the record the activation gate reads & device-stamps.
    const r1 = await fetch(base + '/licenses/' + encodeURIComponent(rec.key) + '.json' + auth, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(license)
    });

    // /paid/<emailhash> → what the buyer's "claim" screen polls to reveal the key.
    const eh = emailHash(rec.email);
    const r2 = await fetch(base + '/paid/' + encodeURIComponent(eh) + '.json' + auth, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: rec.key, name: rec.name, at: now })
    });

    if (!r1.ok || !r2.ok) {
      return new Response('Firebase write failed: ' + r1.status + '/' + r2.status, { status: 502 });
    }
    return new Response('OK ' + rec.key, { status: 200 });
  }
};

/* Lemon Squeezy signs the raw body with HMAC-SHA256 using your signing secret
   and sends it hex-encoded in the X-Signature header. Recompute and compare. */
async function verifySignature(raw, signature, secret) {
  if (!secret || !signature) return false;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const mac = await crypto.subtle.sign('HMAC', key, enc.encode(raw));
  const expected = [...new Uint8Array(mac)].map(b => b.toString(16).padStart(2, '0')).join('');
  // constant-time-ish compare
  if (expected.length !== signature.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  return diff === 0;
}

/* Different webhook events carry the license details in slightly different shapes. */
function extractLicense(eventName, attr) {
  if (eventName === 'license_key_created') {
    return {
      key: attr.key,
      email: attr.user_email,
      name: attr.user_name || (attr.user_email || '').split('@')[0],
      limit: attr.activation_limit || 2
    };
  }
  if (eventName === 'order_created') {
    // Orders don't always include the generated key inline; if present, use it.
    const fi = attr.first_order_item || {};
    return {
      key: attr.license_key || fi.license_key || '',
      email: attr.user_email || (attr.customer && attr.customer.email) || '',
      name: attr.user_name || '',
      limit: 2
    };
  }
  return null;
}

/* These MUST match business.html exactly so /paid/<emailhash> lines up. */
function licHash(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) { h = ((h << 5) + h + s.charCodeAt(i)) >>> 0; }
  return h;
}
function emailHash(email) {
  const e = String(email).trim().toLowerCase();
  return licHash(e).toString(36) + '_' + licHash(e.split('').reverse().join('')).toString(36);
}
