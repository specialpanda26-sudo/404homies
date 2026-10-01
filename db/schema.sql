-- Hidden Gem Ticketing — Postgres schema (Supabase).
-- Idempotent: safe to run on every boot.

CREATE TABLE IF NOT EXISTS events (
  id          BIGSERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT,
  venue       TEXT NOT NULL,
  event_date  DATE NOT NULL,
  event_time  TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'ACTIVE',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ticket_types (
  id             BIGSERIAL PRIMARY KEY,
  event_id       BIGINT NOT NULL REFERENCES events(id),
  name           TEXT NOT NULL,
  description    TEXT,
  price          INTEGER NOT NULL CHECK (price > 0),
  quantity_total INTEGER NOT NULL CHECK (quantity_total >= 0),
  quantity_sold  INTEGER NOT NULL DEFAULT 0 CHECK (quantity_sold >= 0),
  status         TEXT NOT NULL DEFAULT 'ACTIVE',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS promo_codes (
  id         BIGSERIAL PRIMARY KEY,
  code       TEXT NOT NULL UNIQUE,
  kind       TEXT NOT NULL CHECK (kind IN ('PERCENT', 'FIXED')),
  value      INTEGER NOT NULL CHECK (value > 0),
  max_uses   INTEGER,
  used_count INTEGER NOT NULL DEFAULT 0,
  event_id   BIGINT REFERENCES events(id),
  active     BOOLEAN NOT NULL DEFAULT TRUE,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Order status: PENDING → PAYMENT_PROCESSING → PAID
--               FAILED (can retry) | EXPIRED | REFUND_REQUIRED (paid after stock ran out)
CREATE TABLE IF NOT EXISTS orders (
  id                      BIGSERIAL PRIMARY KEY,
  order_number            TEXT NOT NULL UNIQUE,
  access_key_hash         TEXT NOT NULL,
  holder_name             TEXT NOT NULL,
  holder_email            TEXT NOT NULL,
  holder_phone            TEXT NOT NULL,
  event_id                BIGINT NOT NULL REFERENCES events(id),
  ticket_type_id          BIGINT NOT NULL REFERENCES ticket_types(id),
  quantity                INTEGER NOT NULL CHECK (quantity BETWEEN 1 AND 10),
  unit_price              INTEGER NOT NULL,
  subtotal_amount         INTEGER NOT NULL,
  discount_amount         INTEGER NOT NULL DEFAULT 0,
  total_amount            INTEGER NOT NULL CHECK (total_amount > 0),
  promo_code              TEXT,
  attendee_names          JSONB NOT NULL DEFAULT '[]'::jsonb,
  currency                TEXT NOT NULL DEFAULT 'KES',
  status                  TEXT NOT NULL DEFAULT 'PENDING',
  failure_code            INTEGER,
  failure_reason          TEXT,
  tinypesa_request_id     TEXT,
  tinypesa_transaction_id TEXT,
  mpesa_receipt           TEXT,
  initiate_count          INTEGER NOT NULL DEFAULT 0,
  last_initiated_at       TIMESTAMPTZ,
  payment_started_at      TIMESTAMPTZ,
  expires_at              TIMESTAMPTZ NOT NULL,
  paid_at                 TIMESTAMPTZ,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS orders_status_idx ON orders(status, expires_at);
CREATE INDEX IF NOT EXISTS orders_type_idx   ON orders(ticket_type_id, status);
CREATE INDEX IF NOT EXISTS orders_phone_idx  ON orders(holder_phone);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS created_ip TEXT;
CREATE INDEX IF NOT EXISTS orders_ip_idx     ON orders(created_ip, status);

CREATE TABLE IF NOT EXISTS tickets (
  id            BIGSERIAL PRIMARY KEY,
  ticket_number TEXT NOT NULL UNIQUE,
  order_id      BIGINT NOT NULL REFERENCES orders(id),
  event_id      BIGINT NOT NULL REFERENCES events(id),
  type_id       BIGINT NOT NULL REFERENCES ticket_types(id),
  holder_name   TEXT NOT NULL,
  holder_email  TEXT NOT NULL,
  holder_phone  TEXT NOT NULL,
  qr_version    INTEGER NOT NULL DEFAULT 1,
  status        TEXT NOT NULL DEFAULT 'VALID' CHECK (status IN ('VALID', 'USED', 'CANCELLED')),
  issued_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  used_at       TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS tickets_order_idx ON tickets(order_id);

-- One row per STK request we send, plus a row per payment confirmation.
CREATE TABLE IF NOT EXISTS payment_transactions (
  id                      BIGSERIAL PRIMARY KEY,
  order_id                BIGINT NOT NULL REFERENCES orders(id),
  tinypesa_request_id     TEXT,
  tinypesa_transaction_id TEXT,
  amount                  INTEGER,
  phone                   TEXT,
  status                  TEXT NOT NULL DEFAULT 'INITIATED', -- INITIATED | PAID | DUPLICATE | MANUAL
  raw_response            TEXT,
  raw_webhook             TEXT,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at            TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS payment_tx_txid_uniq
  ON payment_transactions(tinypesa_transaction_id) WHERE tinypesa_transaction_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS payment_tx_req_idx ON payment_transactions(order_id, tinypesa_request_id);
CREATE INDEX IF NOT EXISTS payment_tx_phone_idx ON payment_transactions(phone, created_at);

CREATE TABLE IF NOT EXISTS webhook_events (
  id           BIGSERIAL PRIMARY KEY,
  tiny_pesa_id TEXT,
  external_ref TEXT,
  result_code  INTEGER,
  amount       INTEGER,
  payload      TEXT,
  outcome      TEXT,
  error        TEXT,
  received_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id            BIGSERIAL PRIMARY KEY,
  action        TEXT NOT NULL,
  resource_type TEXT,
  resource_id   TEXT,
  metadata      JSONB,
  ip_address    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- v2.5: admin-controlled ticket order, and "pool ticket required" tickets (the after party).
ALTER TABLE ticket_types ADD COLUMN IF NOT EXISTS sort_order INTEGER NOT NULL DEFAULT 0;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'ticket_types' AND column_name = 'requires_pool') THEN
    ALTER TABLE ticket_types ADD COLUMN requires_pool BOOLEAN NOT NULL DEFAULT FALSE;
    -- one-time: any existing "after party" ticket becomes pool-ticket-only. After this, the admin controls it.
    UPDATE ticket_types SET requires_pool = TRUE WHERE name ILIKE '%after%party%';
  END IF;
END $$;

-- v2.6: photos uploaded from the admin panel. Stored in the database (Render's disk is wiped on every deploy).
CREATE TABLE IF NOT EXISTS gallery_photos (
  id         BIGSERIAL PRIMARY KEY,
  data       BYTEA NOT NULL,
  alt        TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE gallery_photos ENABLE ROW LEVEL SECURITY;

-- Supabase exposes every table in the public schema through a REST API
-- using the public "anon" key. Turning on Row Level Security with NO policies
-- blocks that route completely. This server connects with the database
-- owner role, which bypasses RLS, so the app itself keeps working.
ALTER TABLE events               ENABLE ROW LEVEL SECURITY;
ALTER TABLE ticket_types         ENABLE ROW LEVEL SECURITY;
ALTER TABLE promo_codes          ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders               ENABLE ROW LEVEL SECURITY;
ALTER TABLE tickets              ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_events       ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs           ENABLE ROW LEVEL SECURITY;
