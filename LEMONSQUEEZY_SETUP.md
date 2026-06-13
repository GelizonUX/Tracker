# Trakora — Lemon Squeezy payment setup

This is the "money while you sleep" path: a buyer pays on Lemon Squeezy, gets
their license key automatically (by email **and** on the claim screen), and the
app validates it against your Firebase. No manual steps once it's wired up.

## How the pieces fit

```
Buyer taps "Get a license" in the app
        │
        ▼
Lemon Squeezy checkout  ──pays──►  Lemon Squeezy
        │                               │
        │                emails key      │ fires webhook
        │                to buyer        ▼
        │                        Cloudflare Worker  (lemonsqueezy-worker.js)
        │                          verifies signature
        │                          writes key → Firebase
        ▼                               │
App "claim" screen polls Firebase ◄─────┘  reveals key automatically
App activation gate validates key against Firebase, locks to 2 devices
```

Lemon Squeezy is the cashier and key generator. The Worker is the only thing
allowed to create keys, so buyers can't mint their own. Firebase is where the
app checks keys and counts devices.

## Why a Worker at all?

Lemon Squeezy's license API blocks direct browser calls (CORS), so a single
HTML file can't validate keys on its own. The Worker is ~120 lines, free to run
(no credit card), and doubles as the webhook callback URL you were missing.

## Setup checklist

**1. Lemon Squeezy product**
- Open your product → enable **License keys**.
- Set **Activations** limit to **2** (matches the app's 2-device default).

**2. Deploy the Worker** (gives you the callback URL)
- https://dash.cloudflare.com → Workers & Pages → Create → Worker.
- Name it `trakora-license`. Paste all of `lemonsqueezy-worker.js`, Deploy.
- Copy the `*.workers.dev` URL it shows — that is your callback URL.
- Worker → Settings → Variables:
  - `FIREBASE_URL` (plain) = `https://trakora-30796-default-rtdb.firebaseio.com`
  - `FIREBASE_DB_SECRET` (encrypted) = your Firebase DB secret
    (Firebase → Project settings → Service accounts → Database secrets)
  - `LS_SIGNING_SECRET` (encrypted) = the value you'll set in step 3.

**3. Lemon Squeezy webhook**
- Lemon Squeezy → Settings → Webhooks → **+**.
- Callback URL = your `*.workers.dev` URL.
- Signing secret = any random string; paste the SAME value into the Worker's
  `LS_SIGNING_SECRET`.
- Events: tick **order_created** (and **license_key_created** if listed).
- Save, then use **Send test** and confirm the Worker returns `200`.

**4. Verify**
- A test order should create a record under `/licenses` in Firebase.
- Open `customers.html` — the buyer should appear in the list.

## Already wired in the app

- `business.html` → `PAY.checkoutUrl` points at your Trakora checkout, and
  `GATE.url` points at the `trakora-30796` Firebase project.
- `customers.html` → reads the `trakora-30796` project.

## Firebase security rules (paste in Realtime DB → Rules)

Locks key creation to the Worker (which uses the DB secret) while letting the
app read a key to validate it and stamp its own device slot:

```json
{
  "rules": {
    "licenses": {
      ".read": false,
      "$key": {
        ".read": true,
        ".write": "!data.exists() ? false : newData.child('devices').exists()",
        "devices": { ".write": true }
      }
    },
    "paid": {
      "$hash": { ".read": true, ".write": false }
    }
  }
}
```

> The Worker bypasses these rules because it authenticates with the DB secret,
> so it can still create `/licenses` and `/paid` records. The app can read a
> single key it already knows and add a device slot, but cannot create keys.
