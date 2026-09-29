/**
 * Hidden Gem Ticketing — Express server
 * M-Pesa (TinyPesa) payments → automatic QR tickets → door scanner.
 * Data lives in Supabase Postgres, so it survives Render restarts.
 */
"use strict";
const path = require("path");
const express = require("express");
const helmet = require("helmet");
const cfg = require("./src/config");
const db = require("./src/db");
const jobs = require("./src/jobs");
const { HttpError } = require("./src/util");

const app = express();
app.set("trust proxy", 1); // Render sits behind one proxy → correct client IPs for rate limits
app.disable("x-powered-by");

app.use(
  helmet({
    crossOriginEmbedderPolicy: false,
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "https://cdnjs.cloudflare.com", "https://cdn.jsdelivr.net"], // QR generator (cdnjs) + fallback QR scanner (jsdelivr)
        scriptSrcAttr: ["'none'"],
        styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
        fontSrc: ["'self'", "https://fonts.gstatic.com", "data:"],
        frameSrc: ["https://maps.google.com", "https://www.google.com"], // venue map embed
        imgSrc: ["'self'", "data:", "blob:"],
        mediaSrc: ["'self'", "blob:"],
        connectSrc: ["'self'"],
        workerSrc: ["'self'"],
        manifestSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        upgradeInsecureRequests: cfg.isProd ? [] : null,
      },
    },
  })
);

// ── health check for the uptime pinger ────────────────────────────────────
app.get("/health", async (req, res) => {
  res.set("Cache-Control", "no-store");
  try {
    await db.query("SELECT 1");
    res.json({ ok: true, db: true, uptime: Math.round(process.uptime()) });
  } catch (err) {
    console.error("health: db check failed:", err.message);
    res.status(503).json({ ok: false, db: false });
  }
});

// TinyPesa webhook needs the raw body; everything else is JSON.
app.use("/api/payments/tinypesa/webhook", express.raw({ type: "*/*", limit: "100kb" }));
app.use(express.json({ limit: "20kb" }));

app.use("/api/payments/tinypesa", require("./src/routes/webhook"));
app.use("/api/staff", require("./src/routes/staff"));
app.use("/api/admin", require("./src/routes/admin"));
app.use("/api", require("./src/routes/public"));
app.use("/api", (req, res) => res.status(404).json({ error: "Not found" }));

// ── static frontend ───────────────────────────────────────────────────────
const PUBLIC = path.join(__dirname, "public");
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const INDEX_HTML = require("fs").readFileSync(path.join(PUBLIC, "index.html"), "utf8");
let evCache = { at: 0, ev: null };

/** WhatsApp/Facebook link previews don't run JavaScript, so title/date/image are filled in here on the server. */
async function renderIndex(req) {
  if (Date.now() - evCache.at > 60000) {
    try {
      const { rows } = await db.query(
        "SELECT name, description, venue, event_date::text AS d, event_time AS t FROM events WHERE status = 'ACTIVE' ORDER BY event_date, id LIMIT 1"
      );
      evCache = { at: Date.now(), ev: rows[0] || null };
    } catch { evCache.at = Date.now(); }
  }
  const ev = evCache.ev;
  const origin = cfg.appUrl || `${req.protocol}://${req.get("host")}`;
  let title = "Tickets";
  let desc = "Buy your ticket with M-Pesa and get an instant QR ticket.";
  if (ev) {
    const day = new Date(ev.d + "T12:00:00Z").toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
    title = `${ev.name} — Tickets`;
    const [hh, mm] = ev.t.split(":").map(Number);
    const time = `${hh % 12 || 12}${mm ? ":" + String(mm).padStart(2, "0") : ""} ${hh >= 12 ? "PM" : "AM"}`;
    desc = `${day} · ${time} · ${ev.venue}. Pay with M-Pesa, get your QR ticket instantly.`;
  }
  const o = esc(origin), t = esc(title), d = esc(desc); // function replacers: a '$&' or '$$' in an event name must stay literal
  return INDEX_HTML.replace(/%%ORIGIN%%/g, () => o).replace(/%%TITLE%%/g, () => t).replace(/%%DESC%%/g, () => d);
}

app.use(
  express.static(PUBLIC, {
    index: false,
    maxAge: "1h",
    setHeaders(res, file) {
      if (/\.(html|webmanifest)$/.test(file) || file.endsWith("sw.js")) res.setHeader("Cache-Control", "no-cache");
    },
  })
);
app.get("/admin", (req, res) => res.sendFile(path.join(PUBLIC, "admin.html")));
app.get("/door", (req, res) => res.sendFile(path.join(PUBLIC, "door.html"))); // staff-only scanner, not linked from the public site
app.get("*", async (req, res, next) => {
  if (/\.[a-z0-9]{1,8}$/i.test(req.path)) return res.status(404).type("text").send("Not found"); // missing file, not an app route
  try {
    res.set("Cache-Control", "no-cache").type("html").send(await renderIndex(req));
  } catch (err) { next(err); }
});

// ── errors ────────────────────────────────────────────────────────────────
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
  if (err.type === "entity.parse.failed" || err.type === "entity.too.large") return res.status(400).json({ error: "Bad request." });
  console.error(`${req.method} ${req.path} →`, err.message);
  res.status(500).json({ error: "Something went wrong on our side. Please try again." });
});

// ── boot ──────────────────────────────────────────────────────────────────
(async () => {
  try {
    await db.migrate();
    await db.seedDemo();
  } catch (err) {
    console.error("❌  Database setup failed:", err.message);
    console.error("    Check DATABASE_URL (use the Supabase Session pooler string) and that the password is right.");
    process.exit(1);
  }
  const timer = jobs.start();
  const server = app.listen(cfg.port, () => {
    console.log(`\n🎟  Hidden Gem Ticketing on port ${cfg.port}${cfg.mock ? "  ⚠️  MOCK PAYMENTS ON" : ""}`);
    console.log(`   Health:  ${cfg.appUrl || "http://localhost:" + cfg.port}/health`);
    console.log(`   Admin:   ${cfg.appUrl || "http://localhost:" + cfg.port}/admin`);
    console.log(`   Webhook: ${cfg.appUrl || "http://localhost:" + cfg.port}/api/payments/tinypesa/webhook${cfg.webhookSecret ? "/<WEBHOOK_SECRET>" : ""}\n`);
  });
  const stop = () => {
    clearInterval(timer);
    server.close(() => db.pool.end().finally(() => process.exit(0)));
    setTimeout(() => process.exit(0), 8000).unref();
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
})();
