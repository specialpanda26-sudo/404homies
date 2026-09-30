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
// Live payments: the webhook secret and staff code must exist, and be long.
if (isProd) {
  const need = ["WEBHOOK_SECRET", "STAFF_TOKEN"].filter((k) => !env[k]);
  if (need.length) {
    console.error("❌  " + need.join(" and ") + " must be set when NODE_ENV=production.");
    process.exit(1);
  }
}
if (env.WEBHOOK_SECRET && env.WEBHOOK_SECRET.length < 16) {
  console.error("❌  WEBHOOK_SECRET must be at least 16 characters.");
  process.exit(1);
}
if (env.STAFF_TOKEN && env.STAFF_TOKEN.length < 12) {
  console.error("❌  STAFF_TOKEN must be at least 12 characters.");
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
  seedDemo: String(env.SEED_DEMO).toLowerCase() === "true", // off unless explicitly enabled
  // Business rules
  maxTicketsPerOrder: 4,
  orderTtlMinutes: 10,       // how long an unpaid order holds stock
  stkCooldownSeconds: 45,    // minimum gap between STK prompts for one order
  maxStkPerOrder: 4,
  maxStkPerPhonePerHour: 3,  // M-Pesa prompts to one number across ALL orders
  maxOpenOrdersPerPhone: 2,  // unpaid orders holding stock, per phone
  maxOpenOrdersPerIp: 6,     // per IP (generous: mobile networks share IPs)
  lowStockThreshold: 20,
};
