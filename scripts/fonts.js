"use strict";
// Optional: self-host the Google Fonts so the site loads faster and works offline.
// Run once on a computer with internet:  npm run fonts   (then redeploy). Safe to re-run.
const fs = require("fs");
const path = require("path");
const pub = path.join(__dirname, "..", "public");
const API = "https://fonts.googleapis.com/css2?family=UnifrakturCook:wght@700&family=Great+Vibes&family=Noto+Serif:wght@600;700&family=Roboto:wght@400;500;700&display=swap";
(async () => {
  // A modern User-Agent makes Google return woff2 files.
  const css = await (await fetch(API, { headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120 Safari/537.36" } })).text();
  fs.mkdirSync(path.join(pub, "fonts"), { recursive: true });
  const urls = [...new Set([...css.matchAll(/url\((https:[^)]+)\)/g)].map((m) => m[1]))];
  let out = css;
  for (const [i, u] of urls.entries()) {
    const name = `f${i}.woff2`;
    fs.writeFileSync(path.join(pub, "fonts", name), Buffer.from(await (await fetch(u)).arrayBuffer()));
    out = out.split(u).join("/fonts/" + name);
  }
  fs.writeFileSync(path.join(pub, "css", "fonts.css"), out);
  const idx = path.join(pub, "index.html");
  let h = fs.readFileSync(idx, "utf8");
  h = h.replace(/<link rel="preconnect"[^\n]*\n<link href="https:\/\/fonts\.googleapis\.com[^\n]*\n/, '<link rel="stylesheet" href="/css/fonts.css">\n');
  fs.writeFileSync(idx, h);
  console.log(`fonts: saved ${urls.length} files and switched index.html to /css/fonts.css`);
})().catch((e) => { console.error("fonts failed:", e.message); process.exit(1); });
