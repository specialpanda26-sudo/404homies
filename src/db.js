"use strict";
const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");
const cfg = require("./config");

const pool = new Pool({
  connectionString: cfg.databaseUrl,
  ssl: cfg.databaseSsl ? { rejectUnauthorized: false } : false,
  max: 8,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});
pool.on("error", (err) => console.error("Postgres pool error:", err.message));

const query = (text, params) => pool.query(text, params);

/** Run fn(client) inside a transaction. Rolls back on any throw. */
async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch { /* ignore */ }
    throw err;
  } finally {
    client.release();
  }
}

async function migrate() {
  const sql = fs.readFileSync(path.join(__dirname, "..", "db", "schema.sql"), "utf8");
  await pool.query(sql);
}

async function seedDemo() {
  if (!cfg.seedDemo) return;
  const { rows } = await query("SELECT COUNT(*)::int AS c FROM events");
  if (rows[0].c > 0) return;
  await tx(async (c) => {
    const ev = await c.query(
      `INSERT INTO events (name, description, venue, event_date, event_time)
       VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      ["404 Error Pool Party", "Hosted by 404homies", "The Lagoon Resort & Spa, Kirinyaga", "2026-10-03", "21:00"]
    );
    const id = ev.rows[0].id;
    await c.query(
      `INSERT INTO ticket_types (event_id, name, description, price, quantity_total) VALUES
       ($1,'Single','1 person · free drinks',500,200),
       ($1,'Couple','2 people · free drinks',880,100)`,
      [id]
    );
  });
  console.log("✅  Demo event seeded.");
}

async function audit(action, resourceType, resourceId, metadata, ip, client) {
  try {
    await (client || pool).query(
      `INSERT INTO audit_logs (action, resource_type, resource_id, metadata, ip_address)
       VALUES ($1,$2,$3,$4,$5)`,
      [action, resourceType, String(resourceId ?? ""), JSON.stringify(metadata || {}), ip || ""]
    );
  } catch (err) {
    console.error("audit failed:", err.message);
  }
}

module.exports = { pool, query, tx, migrate, seedDemo, audit };
