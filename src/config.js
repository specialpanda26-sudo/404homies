"use strict";
require("dotenv").config();

const env = process.env;
const isProd = env.NODE_ENV === "production";
const mock = String(env.MOCK_PAYMENTS).toLowerCase() === "true";

if (mock && isProd) {
  console.error("❌  MOCK_PAYMENTS=true is not allowed when NODE_ENV=production.");
  process.exit(1);
}

const required = ["DATABASE_URL", "TICKET_SECRET", "ADMIN_TOKEN"];
if (!mock) required.push("TINYPESA_API_KEY", "TINYPESA_USERNAME");
const missing = required.filter((k) => !env[k]);
if (missing.length) {
  console.error("❌  Missing environment variables: " + missing.join(", "));
  console.error("    See .env.example. On Render: Environment → Environment Variables.");
  process.exit(1);
}
if (env.TICKET_SECRET.length < 24 || env.ADMIN_TOKEN.length < 16) {
  console.error("❌  TICKET_SECRET (24+ chars) and ADMIN_TOKEN (16+ chars) must be long random strings.");
  process.exit(1);
}

module.exports = {
  isProd,
  mock,
  port: Number(env.PORT) || 3000,
  appUrl: (env.APP_URL || "").replace(/\/+$/, ""),
  databaseUrl: env.DATABASE_URL,
  databaseSsl: String(env.DATABASE_SSL).toLowerCase() !== "false",
  tinypesaKey: env.TINYPESA_API_KEY,
  tinypesaUser: env.TINYPESA_USERNAME,
  strictWebhookId: String(env.TINYPESA_STRICT_ID).toLowerCase() !== "false",
  ticketSecret: env.TICKET_SECRET,
  adminToken: env.ADMIN_TOKEN,
  staffToken: env.STAFF_TOKEN || "",
  webhookSecret: env.WEBHOOK_SECRET || "",
  supportWhatsapp: (env.SUPPORT_WHATSAPP || "").replace(/\D/g, ""),
  supportPhone: env.SUPPORT_PHONE || "",
  groupLink: env.WHATSAPP_GROUP || "",
  seedDemo: String(env.SEED_DEMO).toLowerCase() !== "false",
  // Business rules
  maxTicketsPerOrder: 4,
  orderTtlMinutes: 15,       // how long an unpaid order holds stock
  stkCooldownSeconds: 45,    // minimum gap between STK prompts for one order
  maxStkPerOrder: 4,
  lowStockThreshold: 20,
};
