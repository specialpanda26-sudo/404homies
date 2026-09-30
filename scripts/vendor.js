"use strict";
const fs = require("fs");
const path = require("path");

const FILES = [
  ["qrcode-generator/qrcode.js", "qrcode.min.js"], // global qrcode(), used by app.js
  ["jsqr/dist/jsQR.js", "jsQR.min.js"],            // global jsQR(), used by door.js
];
const out = path.join(__dirname, "..", "public", "vendor");
fs.mkdirSync(out, { recursive: true });

let failed = false;
for (const [from, to] of FILES) {
  try {
    fs.copyFileSync(require.resolve(from), path.join(out, to));
    console.log("vendor: " + to);
  } catch (e) {
    failed = true;
    console.error("vendor: could not copy " + from + " (" + e.message + "). Run npm install first.");
  }
}
if (failed) process.exit(1);
