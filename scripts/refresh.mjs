// Refreshes the schedule data embedded in index.html from the live kikkfestival.be schedule.
// Usage: node scripts/refresh.mjs [path/to/index.html]
// Needs Playwright with Chromium; uses $HTTPS_PROXY when set. Exits non-zero (and leaves index.html untouched)
// when the scrape looks broken, so a failed run never publishes an empty agenda.
import fs from "fs";
import crypto from "crypto";
import { createRequire } from "module";
import { execSync } from "child_process";

const require = createRequire(import.meta.url);
let pw;
try { pw = require("playwright"); } catch { pw = require(execSync("npm root -g").toString().trim() + "/playwright"); }

const FILE = process.argv[2] || new URL("../index.html", import.meta.url).pathname;
const DAYS = ["2026-10-22", "2026-10-23", "2026-10-24"];
const SITE = "https://kikkfestival.be";

const ENT = {amp:"&",lt:"<",gt:">",quot:'"',apos:"'",nbsp:" ",rsquo:"’",lsquo:"‘",rdquo:"”",ldquo:"“",hellip:"…",ndash:"–",mdash:"—",eacute:"é",egrave:"è",agrave:"à",ccedil:"ç"};
const toText = h => String(h || "")
  .replace(/<\s*br\s*\/?>/gi, "\n")
  .replace(/<\/\s*(p|div|h[1-6]|li|ul|ol|blockquote)\s*>/gi, "\n\n")
  .replace(/<\s*li[^>]*>/gi, "• ")
  .replace(/<[^>]+>/g, "")
  .replace(/&(#x?[0-9a-f]+|\w+);/gi, (m, c) => c[0] === "#" ? String.fromCodePoint(c[1].toLowerCase() === "x" ? parseInt(c.slice(2), 16) : +c.slice(1)) : (ENT[c.toLowerCase()] ?? m))
  .replace(/[ \t ]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();

const browser = await pw.chromium.launch(process.env.HTTPS_PROXY ? {proxy: {server: process.env.HTTPS_PROXY}} : {});
const RAW = {}, IMAGES = {}, records = {};
try {
  for (const day of DAYS) {
    const page = await browser.newPage({viewport: {width: 1280, height: 900}});
    page.on("response", async r => {
      if (!/supabase\.co\/rest\/v1\/(conferences|panels|by_night_events)\?/.test(r.url())) return;
      try { for (const rec of await r.json()) if (rec.slug) records[rec.slug] = rec; } catch {}
    });
    await page.goto(`${SITE}/schedule?day=${day}`, {waitUntil: "networkidle", timeout: 90000});
    await page.waitForTimeout(1500);
    // Talks and panels show by default; parties only appear with the site's "Parties" filter on
    const cards = () => page.$$eval('a[href^="/talks/"],a[href^="/panels/"],a[href^="/parties/"]', as => as.map(a => {
      const tag = a.querySelector(".tag")?.textContent.trim() || "";
      const time = (a.querySelector(".tag + span")?.textContent || "").trim();
      const [s, e = ""] = time.split(/\s*[–-]\s*/);
      const title = a.querySelector("h3")?.textContent.trim() || "";
      const ps = [...a.querySelectorAll("p")].map(p => p.textContent.trim()).filter(Boolean);
      const loc = ps.length ? ps[ps.length - 1] : "";
      const sub = ps.slice(0, -1).join(" | ");
      const img = a.querySelector("img")?.getAttribute("src") || "";
      const clean = t => t.replace(/\s+/g, " ").trim();
      // party subtitles repeat the date and time ("THU 22 OCT · 17:30–20:30 · …"): drop that prefix
      const sub2 = sub === title ? "" : sub.replace(/^[A-Z]{3} \d{1,2} [A-Z]{3} · [\d:–\- ]+ · /, "");
      return {row: [tag, s, e, title, sub2, loc, a.getAttribute("href")].map(clean), img};
    }).filter(x => /^\d{1,2}:\d{2}$/.test(x.row[1]) && x.row[3]));
    RAW[day] = await cards();
    const partiesBtn = page.getByRole("button", {name: "Parties", exact: true});
    if (await partiesBtn.count()) {
      // cards can exist but be hidden (the site renders a mobile copy too), so wait for presence, not visibility;
      // only click again if the filter didn't switch on, as a second click toggles it off
      for (let attempt = 0; attempt < 2; attempt++) {
        if (!/filter-btn-active/.test(await partiesBtn.first().getAttribute("class") || "")) await partiesBtn.first().click();
        const shown = await page.waitForFunction(() => document.querySelector('a[href^="/parties/"]'), null, {timeout: 8000}).then(() => true, () => false);
        if (shown) { await page.waitForTimeout(800); RAW[day].push(...await cards()); break; }
      }
    }
    RAW[day].sort((a, b) => a.row[1].localeCompare(b.row[1]));
    for (const x of RAW[day]) { const m = x.img.match(/\/public\/gallery\/([^?]+)/); if (m) IMAGES[x.row[6]] = m[1]; }
    RAW[day] = RAW[day].map(x => x.row);
    // de-duplicate (the page can render a card twice)
    const seen = new Set(); RAW[day] = RAW[day].filter(r => !seen.has(r[6]) && seen.add(r[6]));
    await page.close();
  }
} finally { await browser.close(); }

const DESCR = {};
for (const day of DAYS) for (const r of RAW[day]) {
  const rec = records[r[6].split("/").pop()];
  if (!rec) continue;
  const t = toText(rec.description_en || rec.description || rec.intro_text_en || rec.intro_text || rec.meta_description_en || rec.meta_description);
  if (t) DESCR[r[6]] = t;
  if (!IMAGES[r[6]]) { const m = String(rec.image_url || "").match(/\/public\/gallery\/([^?]+)/); if (m) IMAGES[r[6]] = m[1]; }
}

// Sanity checks before touching the page
const html = fs.readFileSync(FILE, "utf8");
const prevCount = (html.match(/^\["[^"\n]*","\d{1,2}:\d{2}",/gm) || []).length;
const count = DAYS.reduce((n, d) => n + RAW[d].length, 0);
if (count < 10 || count < prevCount * 0.6) { console.error(`ABORT: scraped ${count} events (page has ${prevCount}); not updating.`); process.exit(2); }
// a festival day that had events and now has none is almost certainly a scrape failure
const prevRaw = html.match(/const RAW = \{[\s\S]*?\n\]\};/)[0];
for (const d of DAYS) {
  const had = (prevRaw.split(`${JSON.stringify(d)}:[`)[1] || "").split("\n]")[0].includes('",');
  if (had && !RAW[d].length) { console.error(`ABORT: ${d} had events before and now has none; not updating.`); process.exit(2); }
}

const J = v => JSON.stringify(v);
const rawJs = "const RAW = {\n" + DAYS.map(d => `${J(d)}:[\n` + RAW[d].map(J).join(",\n") + "\n]").join(",\n") + "};";
const imgJs = "const IMAGES = {\n" + Object.keys(IMAGES).sort().map(k => `${J(k)}:${J(IMAGES[k])}`).join(",\n") + "\n};";
const descJs = "const DESCR = {\n" + Object.keys(DESCR).sort().map(k => `${J(k)}:${J(DESCR[k])}`).join(",\n") + "\n};";
if (/<\/script/i.test(rawJs + imgJs + descJs)) { console.error("ABORT: unexpected </script in data"); process.exit(3); }

const hash = crypto.createHash("sha256").update(rawJs + imgJs + descJs).digest("hex").slice(0, 12);
const stamp = new Intl.DateTimeFormat("sv-SE", {timeZone: "Europe/Brussels", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit"}).format(new Date());

const replaceBlock = (src, re, val, name) => { if (!re.test(src)) { console.error(`ABORT: ${name} block not found`); process.exit(4); } return src.replace(re, () => val); };
let out = html;
out = replaceBlock(out, /const RAW = \{[\s\S]*?\n\]\};/, rawJs, "RAW");
out = replaceBlock(out, /const IMAGES = \{[\s\S]*?\n\};/, imgJs, "IMAGES");
out = replaceBlock(out, /const DESCR = \{[\s\S]*?\n\};/, descJs, "DESCR");
out = replaceBlock(out, /const SNAPSHOT = "[^"]*";/, `const SNAPSHOT = "${stamp}";`, "SNAPSHOT");
out = replaceBlock(out, /const DATA_HASH = "[^"]*";/, `const DATA_HASH = "${hash}";`, "DATA_HASH");

const prevHash = (html.match(/const DATA_HASH = "([^"]*)"/) || [])[1];
fs.writeFileSync(FILE, out);
fs.writeFileSync(new URL("version.json", new URL(".", "file://" + FILE)), JSON.stringify({snapshot: stamp, hash}) + "\n");
console.log(JSON.stringify({events: count, perDay: Object.fromEntries(DAYS.map(d => [d, RAW[d].length])), images: Object.keys(IMAGES).length, descriptions: Object.keys(DESCR).length, snapshot: stamp, hash, scheduleChanged: hash !== prevHash}));
