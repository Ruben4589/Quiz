#!/usr/bin/env node
/* DS Quiz – Skripte & Klausuren verschlüsseln
 *
 * Die Originale liegen NUR lokal in privat/ (steht in .gitignore, wird nie hochgeladen):
 *   privat/fach/<fach>/<datei>.jpg   ->  ds-quiz-pwa/fach/<fach>/<datei>.jpg.enc
 *   privat/klausuren.json            ->  ds-quiz-pwa/klausuren.enc
 *   privat/passwort.txt              ->  das Passwort (zum Weitergeben an Kommilitonen)
 *
 *   node tools/verschluesseln.mjs                   neue/geänderte Dateien verschlüsseln (gleiches Passwort)
 *   node tools/verschluesseln.mjs --neues-passwort  neues Passwort (zufällig, oder DSQ_PASS=... setzen);
 *                                                   danach muss es auf jedem Gerät neu eingegeben werden
 *
 * Danach immer: node tests/run.mjs  – und dann hochladen (git push).
 * Verfahren: PBKDF2-SHA256 (600.000 Runden) -> AES-256-GCM. Dasselbe entschlüsselt die App im Browser.
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PRIV = path.join(ROOT, "privat"), APP = path.join(ROOT, "ds-quiz-pwa");
const PWFILE = path.join(PRIV, "passwort.txt"), SCHUTZ = path.join(APP, "schutz.json");
const ITER = 600000, CHECK = "ds-quiz-ok", IMG = /\.(jpe?g|png|webp)$/i;
const subtle = globalThis.crypto?.subtle;
if (!subtle) { console.error("Node.js 20 oder neuer nötig."); process.exit(1); }
const NEW = process.argv.includes("--neues-passwort");

const b64 = (u) => Buffer.from(u).toString("base64"), unb64 = (s) => new Uint8Array(Buffer.from(s, "base64"));
async function deriveKey(pw, salt, iter) {
  const base = await subtle.importKey("raw", new TextEncoder().encode(pw), "PBKDF2", false, ["deriveKey"]);
  return subtle.deriveKey({ name: "PBKDF2", salt, iterations: iter, hash: "SHA-256" }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}
async function enc(key, data) { const iv = crypto.getRandomValues(new Uint8Array(12)); const ct = new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv }, key, data)); const out = new Uint8Array(12 + ct.length); out.set(iv); out.set(ct, 12); return out; }
async function dec(key, buf) { const u = new Uint8Array(buf); return new Uint8Array(await subtle.decrypt({ name: "AES-GCM", iv: u.slice(0, 12) }, key, u.slice(12))); }
function randomPassword() { const A = "abcdefghjkmnpqrstuvwxyz23456789", r = crypto.getRandomValues(new Uint8Array(12)); let s = ""; for (let i = 0; i < 12; i++) s += A[r[i] % A.length] + (i % 4 === 3 && i < 11 ? "-" : ""); return s; }
const walk = (d) => existsSync(d) ? readdirSync(d).flatMap((n) => statSync(path.join(d, n)).isDirectory() ? walk(path.join(d, n)) : [path.join(d, n)]) : [];
const rel = (f, base) => path.relative(base, f).split(path.sep).join("/");

/* ---------- Passwort & Schlüssel ---------- */
if (!existsSync(PRIV)) { console.error("Ordner privat/ fehlt – dort müssen die Originale liegen."); process.exit(1); }
let pw = process.env.DSQ_PASS || (existsSync(PWFILE) ? readFileSync(PWFILE, "utf8").trim() : "");
let salt, key;
if (NEW || !existsSync(SCHUTZ)) {
  if (!process.env.DSQ_PASS) pw = randomPassword();
  if (pw.length < 8) { console.error("Passwort zu kurz (mind. 8 Zeichen)."); process.exit(1); }
  salt = crypto.getRandomValues(new Uint8Array(16));
  key = await deriveKey(pw, salt, ITER);
  writeFileSync(SCHUTZ, JSON.stringify({ v: 1, iter: ITER, salt: b64(salt), check: b64(await enc(key, new TextEncoder().encode(CHECK))) }) + "\n");
  writeFileSync(PWFILE, pw + "\n");
  for (const f of walk(APP).filter((f) => f.endsWith(".enc"))) rmSync(f); // alles neu verschlüsseln
  console.log(`Neues Passwort: ${pw}   (gespeichert in privat/passwort.txt)`);
} else {
  if (!pw) { console.error("Kein Passwort: privat/passwort.txt fehlt (oder DSQ_PASS=... setzen)."); process.exit(1); }
  const s = JSON.parse(readFileSync(SCHUTZ, "utf8"));
  salt = unb64(s.salt); key = await deriveKey(pw, salt, s.iter);
  try { await dec(key, unb64(s.check)); } catch { console.error("Das Passwort passt nicht zu ds-quiz-pwa/schutz.json. (Neues Passwort: --neues-passwort)"); process.exit(1); }
}

/* ---------- Dateien verschlüsseln (unveränderte bleiben unangetastet) ---------- */
let neu = 0, gleich = 0, entfernt = 0;
async function put(plain, target) {
  if (existsSync(target)) { try { if (Buffer.compare(Buffer.from(await dec(key, readFileSync(target))), Buffer.from(plain)) === 0) { gleich++; return; } } catch {} }
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, await enc(key, plain)); neu++;
  console.log("  verschlüsselt: " + rel(target, ROOT));
}
const originals = walk(path.join(PRIV, "fach")).filter((f) => IMG.test(f));
for (const f of originals) await put(readFileSync(f), path.join(APP, rel(f, PRIV)) + ".enc");
const kl = path.join(PRIV, "klausuren.json");
if (existsSync(kl)) { const t = JSON.parse(readFileSync(kl, "utf8")); await put(new TextEncoder().encode(JSON.stringify(t)), path.join(APP, "klausuren.enc")); }

// Aufräumen: Klartext-Kopien im App-Ordner entfernen, verwaiste .enc melden
for (const f of walk(path.join(APP, "fach")).filter((f) => IMG.test(f))) { rmSync(f); entfernt++; console.log("  Klartext entfernt: " + rel(f, ROOT)); }
const wanted = new Set(originals.map((f) => path.join(APP, rel(f, PRIV)) + ".enc"));
for (const f of walk(path.join(APP, "fach")).filter((f) => f.endsWith(".enc") && !wanted.has(f))) console.log("  ! kein Original mehr in privat/ für " + rel(f, ROOT) + " (ggf. löschen)");

/* ---------- sw.js: Dateiliste neu erzeugen, Cache-Version erhöhen ---------- */
const swPath = path.join(APP, "sw.js");
let sw = readFileSync(swPath, "utf8");
const nat = (a, b) => a.localeCompare(b, "de", { numeric: true });
const files = ["./", "./index.html", "./manifest.json",
  ...readdirSync(APP).filter((f) => f.endsWith(".png")).sort(nat),
  ...walk(path.join(APP, "fonts")).map((f) => rel(f, APP)).sort(nat),
  ...walk(path.join(APP, "fach")).map((f) => rel(f, APP)).filter((f) => !f.endsWith("/.DS_Store")).sort(nat),
  "schutz.json", ...(existsSync(path.join(APP, "klausuren.enc")) ? ["klausuren.enc"] : []),
].map((f) => (f.startsWith(".") ? f : "./" + f));
const oldList = sw.match(/var FILES=(\[.*?\]);/s)[1];
const newList = JSON.stringify(files).replace(/","/g, '", "');
if (neu || entfernt || oldList !== newList) {
  sw = sw.replace(/var FILES=\[.*?\];/s, "var FILES=" + newList + ";").replace(/var CACHE='ds-quiz-v(\d+)';/, (m, n) => `var CACHE='ds-quiz-v${+n + 1}';`);
  writeFileSync(swPath, sw);
  console.log("  sw.js aktualisiert (" + sw.match(/ds-quiz-v\d+/)[0] + ", " + files.length + " Dateien)");
}
console.log(`\nFertig: ${neu} neu verschlüsselt, ${gleich} unverändert${entfernt ? `, ${entfernt} Klartext-Dateien aus dem App-Ordner entfernt` : ""}.`);
