#!/usr/bin/env node
/* DS Quiz – automatische Tests
 *
 *   node tests/run.mjs            alle Tests (Daten, Bewertung, Browser)
 *   node tests/run.mjs --update   Referenz-Ansichten neu speichern (nach gewollten Änderungen)
 *   node tests/run.mjs --quick    nur Daten + Bewertung, ohne Browser
 *
 * Braucht Node.js >= 22 und Chromium/Chrome (Pfad notfalls per CHROME=/pfad/zu/chrome).
 * Geschützte Inhalte (Skripte, Klausuren) werden mit dem Passwort aus privat/passwort.txt geprüft.
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, mkdtempSync, rmSync } from "node:fs";
import { spawn, execSync } from "node:child_process";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, "../ds-quiz-pwa");
const PRIV = path.resolve(HERE, "../privat");
const SNAP_FILE = path.join(PRIV, "snapshots.json"); // enthält Klausurtext -> nur lokal
const PW = process.env.DSQ_PASS || (existsSync(path.join(PRIV, "passwort.txt")) ? readFileSync(path.join(PRIV, "passwort.txt"), "utf8").trim() : "");
const args = new Set(process.argv.slice(2));
const UPDATE = args.has("--update"), QUICK = args.has("--quick");

/* ---------- Ausgabe ---------- */
let failed = 0, warned = 0;
const ok = (m) => console.log("  \x1b[32m✔\x1b[0m " + m);
const fail = (m) => { failed++; console.log("  \x1b[31m✘ " + m + "\x1b[0m"); };
const warn = (m) => { warned++; console.log("  \x1b[33m! " + m + "\x1b[0m"); };
const head = (m) => console.log("\n\x1b[1m" + m + "\x1b[0m");
const check = (cond, good, bad) => (cond ? ok(good) : fail(bad || good));

/* ---------- App-Daten laden (ohne Browser) ---------- */
const html = readFileSync(path.join(APP, "index.html"), "utf8");
const dataFiles = [...html.matchAll(/<script src="(fach\/[^"]+\/data\.js)"><\/script>/g)].map((m) => m[1]);
const SUBJ = [], TOPICS = [], Q = [], DOCM = {};
for (const f of dataFiles) {
  vm.runInNewContext(readFileSync(path.join(APP, f), "utf8"), {
    registerSubject(m, tp, qs, doc) { SUBJ.push(m); tp.forEach((t) => TOPICS.push({ ...t, subject: m.name })); qs.forEach((q) => Q.push({ ...q, _file: f })); if (doc) DOCM[m.id] = doc; },
  }, { filename: f });
}
const KLAUSUREN = path.join(PRIV, "klausuren.json");
const TESTS = existsSync(KLAUSUREN) ? JSON.parse(readFileSync(KLAUSUREN, "utf8")) : [];

/* Funktionen aus index.html holen (letzte Definition gewinnt, wie im Browser) */
function loadFns(names) {
  const ctx = {}; vm.createContext(ctx); let code = "";
  for (const n of names) {
    const re = new RegExp("function " + n + "\\(", "g"); let m, last = -1;
    while ((m = re.exec(html))) last = m.index;
    if (last < 0) throw new Error("Funktion fehlt in index.html: " + n);
    let i = html.indexOf("{", last), d = 0;
    for (; i < html.length; i++) { if (html[i] === "{") d++; else if (html[i] === "}" && !--d) break; }
    code += html.slice(last, i + 1) + "\n";
  }
  vm.runInContext(code, ctx); return ctx;
}
const F = loadFns(["norm", "normW", "shortMatch", "lev", "nums", "numMatch", "fuzzy", "evalAns", "evalAns2", "lueck", "tPoints"]);

/* =========================================================
   1) Daten & Dateien
   ========================================================= */
head("1. Daten & Dateien");
{
  check(dataFiles.length > 0, `${dataFiles.length} Fächer eingebunden (${dataFiles.join(", ")})`, "keine fach/*/data.js in index.html eingebunden");
  const onDisk = readdirSync(path.join(APP, "fach")).filter((d) => existsSync(path.join(APP, "fach", d, "data.js"))).map((d) => `fach/${d}/data.js`);
  const notLinked = onDisk.filter((f) => !dataFiles.includes(f));
  check(!notLinked.length, "alle Fach-Ordner sind in index.html eingebunden", "nicht in index.html eingebunden: " + notLinked.join(", "));

  const ids = new Set(), topicIds = new Set(TOPICS.map((t) => t.id)), errs = [];
  for (const q of Q) {
    const where = `${q._file}: Frage ${q.id}`;
    if (ids.has(q.id)) errs.push(`${where}: doppelte ID`); ids.add(q.id);
    if (!topicIds.has(q.topic)) errs.push(`${where}: Thema "${q.topic}" existiert nicht`);
    if (!Array.isArray(q.variants) || !q.variants.length || q.variants.some((v) => !String(v).trim())) errs.push(`${where}: "variants" fehlt oder leer`);
    if (!String(q.answer || "").trim()) errs.push(`${where}: "answer" fehlt`);
    if (q.keywords) {
      q.keywords.forEach((k, i) => { if (!k.label || !Array.isArray(k.variants) || !k.variants.length) errs.push(`${where}: Stichwort ${i + 1} unvollständig`); });
      if (q.minMatch && q.minMatch > q.keywords.length) errs.push(`${where}: minMatch (${q.minMatch}) > Anzahl Stichworte (${q.keywords.length})`);
    }
    if (q.mc && q.mc.includes(q.answer)) errs.push(`${where}: richtige Antwort steht auch in "mc" (würde doppelt angezeigt)`);
    for (const s of q.src || []) {
      const [doc, page, x0, y0, x1, y1] = s;
      if (!DOCM[doc]) errs.push(`${where}: Quelle verweist auf unbekanntes Skript "${doc}"`);
      else if (page < 0 || page >= DOCM[doc].pages.length) errs.push(`${where}: Quelle Seite ${page + 1} gibt es nicht`);
      if (!(x0 >= 0 && x1 <= 1 && y0 >= 0 && y1 <= 1 && x0 < x1 && y0 < y1)) errs.push(`${where}: Quellen-Ausschnitt ungültig`);
    }
  }
  for (const t of TESTS) for (const q of t.questions) {
    if (!(q.pts > 0)) errs.push(`Klausur ${t.name} Aufgabe ${q.nr}: Punkte fehlen`);
    if (!q.accept && !q.keywords) errs.push(`Klausur ${t.name} Aufgabe ${q.nr}: weder "accept" noch "keywords"`);
  }
  check(!errs.length, `${Q.length} Fragen, ${TOPICS.length} Themen, ${TESTS.length} Klausur(en) – Struktur in Ordnung`, "Datenfehler:\n      " + errs.join("\n      "));
  for (const t of TESTS) { const sum = t.questions.reduce((a, q) => a + q.pts, 0); if (t.total && t.total !== sum) warn(`Klausur "${t.name}": "total" ist ${t.total}, die Aufgaben ergeben ${sum} Punkte (angezeigt wird ${sum})`); }

  // Service Worker: Dateiliste
  const sw = readFileSync(path.join(APP, "sw.js"), "utf8");
  const FILES = JSON.parse(sw.match(/var FILES=(\[.*?\]);/s)[1]).map((f) => f.replace(/^\.\//, ""));
  const missing = FILES.filter((f) => f && !existsSync(path.join(APP, f)));
  check(!missing.length, "alle Dateien aus sw.js existieren", "in sw.js gelistet, aber nicht vorhanden: " + missing.join(", "));
  const walk = (d) => readdirSync(path.join(APP, d)).flatMap((n) => statSync(path.join(APP, d, n)).isDirectory() ? walk(d + "/" + n) : [d + "/" + n]);
  const needed = [...walk("fach"), ...walk("fonts"), "index.html", "manifest.json", "schutz.json", "klausuren.enc", ...readdirSync(APP).filter((f) => f.endsWith(".png"))].filter((f) => existsSync(path.join(APP, f)));
  const notCached = needed.filter((f) => !FILES.includes(f));
  check(!notCached.length, "alle App-Dateien stehen in sw.js (offline verfügbar)", "fehlen in sw.js FILES (offline nicht verfügbar): " + notCached.join(", "));
  const fontsUsed = [...html.matchAll(/url\((fonts\/[^)]+)\)/g)].map((m) => m[1]);
  const fontsUnused = walk("fonts").filter((f) => !fontsUsed.includes(f));
  check(!fontsUnused.length, "alle Schriftdateien werden benutzt", "ungenutzte Schriftdateien: " + fontsUnused.join(", "));
}

/* =========================================================
   1b) Schutz der Uni-Materialien
   ========================================================= */
head("1b. Schutz (Skripte & Klausuren)");
{
  const gi = existsSync(path.resolve(HERE, "../.gitignore")) ? readFileSync(path.resolve(HERE, "../.gitignore"), "utf8") : "";
  check(/^privat\/?$/m.test(gi), "privat/ steht in .gitignore (Originale werden nie hochgeladen)", "privat/ fehlt in .gitignore!");
  const walkA = (d) => readdirSync(d).flatMap((n) => statSync(path.join(d, n)).isDirectory() ? walkA(path.join(d, n)) : [path.join(d, n)]);
  const appFiles = walkA(APP);
  const plain = appFiles.filter((f) => /\.(jpe?g|webp|pdf)$/i.test(f) || (/\.png$/i.test(f) && f.includes(path.sep + "fach" + path.sep)));
  check(!plain.length, "keine unverschlüsselten Skriptseiten im App-Ordner", "UNVERSCHLÜSSELT im App-Ordner: " + plain.map((f) => path.relative(APP, f)).join(", "));
  check(/var TESTS=\[\];/.test(html), "Klausuren stehen nicht im Klartext in index.html", "index.html enthält Klausurdaten im Klartext");
  if (TESTS.length) {
    const texts = appFiles.filter((f) => /\.(html|js|json|webmanifest)$/.test(f)).map((f) => [f, readFileSync(f, "utf8")]);
    const leaks = [];
    for (const t of TESTS) for (const q of t.questions) for (const [f, c] of texts) if (q.q.length > 25 && c.includes(q.q)) leaks.push(`Aufgabe ${q.nr} in ${path.relative(APP, f)}`);
    check(!leaks.length, "kein Klausurtext in öffentlichen Dateien", "Klausurtext öffentlich lesbar: " + leaks.join(", "));
  } else warn("privat/klausuren.json fehlt – Klausuren nicht geprüft");
  const missingEnc = Object.values(DOCM).flatMap((d) => d.pages).filter((pg) => !existsSync(path.join(APP, pg + ".enc")));
  check(!missingEnc.length, "zu jeder Skriptseite gibt es eine verschlüsselte Datei", "verschlüsselte Datei fehlt: " + missingEnc.map((x) => x + ".enc").join(", ") + " (node tools/verschluesseln.mjs)");
  if (!PW) warn("kein Passwort (privat/passwort.txt oder DSQ_PASS) – Entschlüsselung nicht geprüft");
  else {
    const sch = JSON.parse(readFileSync(path.join(APP, "schutz.json"), "utf8"));
    const sub = globalThis.crypto.subtle, b = (x) => new Uint8Array(Buffer.from(x, "base64"));
    const base = await sub.importKey("raw", new TextEncoder().encode(PW), "PBKDF2", false, ["deriveKey"]);
    const key = await sub.deriveKey({ name: "PBKDF2", salt: b(sch.salt), iterations: sch.iter, hash: "SHA-256" }, base, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
    const dec = async (buf) => { const u = new Uint8Array(buf); return Buffer.from(await sub.decrypt({ name: "AES-GCM", iv: u.slice(0, 12) }, key, u.slice(12))); };
    let pwOk = true; try { await dec(b(sch.check)); } catch { pwOk = false; }
    check(pwOk, "Passwort passt zu schutz.json", "Passwort aus privat/passwort.txt passt nicht zu schutz.json");
    if (pwOk) {
      const bad = [];
      for (const f of appFiles.filter((f) => f.endsWith(".enc"))) {
        let plainBuf; try { plainBuf = await dec(readFileSync(f)); } catch { bad.push(path.relative(APP, f) + " (nicht entschlüsselbar)"); continue; }
        const rel = path.relative(APP, f).slice(0, -4);
        const orig = rel === "klausuren" ? null : path.join(PRIV, rel);
        if (orig && existsSync(orig) && !plainBuf.equals(readFileSync(orig))) bad.push(rel + " (veraltet – node tools/verschluesseln.mjs)");
        if (rel === "klausuren" && TESTS.length && JSON.stringify(JSON.parse(plainBuf.toString("utf8"))) !== JSON.stringify(TESTS)) bad.push("klausuren.enc (veraltet – node tools/verschluesseln.mjs)");
      }
      check(!bad.length, "alle verschlüsselten Dateien lassen sich öffnen und sind aktuell", "Problem: " + bad.join(", "));
    }
  }
}

/* =========================================================
   2) Bewertung
   ========================================================= */
head("2. Antwort-Bewertung");
{
  const all = [...Q, ...TESTS.flatMap((t) => t.questions.map((q) => ({ ...q, id: `${t.name} Nr. ${q.nr}` })))];
  const own = all.filter((q) => (q.accept || q.keywords) && !F.evalAns2(q.answer, q).ok);
  check(!own.length, `jede Musterlösung wird als richtig erkannt (${all.length} Fragen)`, "Musterlösung wird NICHT erkannt: " + own.map((q) => q.id).join(", "));
  const acc = [];
  for (const q of all) for (const a of q.accept || []) if (!F.evalAns2(a, q).ok) acc.push(`${q.id}: "${a}"`);
  check(!acc.length, "jede accept-Variante wird als richtig erkannt", "accept-Variante wird nicht erkannt: " + acc.join(", "));

  const cases = [
    // [Eingabe, Ziel, erwartet]  – bekannte Fallen
    ["15%", "5%", false], ["5 %", "5%", true], ["0,003", "0,002", false], ["0.002 mm", "0,002", true],
    ["1:1000", "1:100", false], ["1:100", "1:100", true], ["0,063", "63", false], ["140 bis 190", "140-190", true],
    ["beton", "ton", false], ["tonboden", "ton", true], ["volumen", "öl", false], ["uv-strahlen", "uv", true],
    ["keine ahnung", "ne", false], ["ac16 bn", "ac", true], ["5cm", "cm", true], ["kreis", "eis", false],
    ["thermoplastisch", "thermoplastisches", true], ["themoplastisch", "thermoplastisch", true],
  ];
  const bad = cases.filter(([i, t, e]) => F.fuzzy(i, t) !== e);
  check(!bad.length, `${cases.length} bekannte Grenzfälle richtig bewertet`, "falsch bewertet: " + bad.map(([i, t, e]) => `"${i}" für "${t}" (erwartet ${e ? "richtig" : "falsch"})`).join(", "));
  check(F.lueck("Splitt (gebrochen) und Kies (rund)") === "Sp____ (geb______) u__ K___ (r___)", "Lückentext korrekt (auch mit Klammer am Ende)", "Lückentext fehlerhaft: " + F.lueck("Splitt (gebrochen) und Kies (rund)"));
  const kq = { pts: 6, keywords: [{}, {}, {}], minMatch: 2 };
  check(F.tPoints(kq, { ok: false, matched: ["a"] }) === 3 && F.tPoints(kq, { ok: true, matched: [] }) === 6 && F.tPoints({ pts: 3, accept: [] }, { ok: false, matched: [] }) === 0,
    "Teilpunkte in Klausuren richtig berechnet", "Teilpunkte falsch berechnet");
}

/* =========================================================
   3) Browser-Tests
   ========================================================= */

function finish() {
  console.log("\n" + (failed ? `\x1b[31m${failed} Test(s) fehlgeschlagen\x1b[0m` : "\x1b[32mAlle Tests bestanden\x1b[0m") + (warned ? `, ${warned} Hinweis(e)` : ""));
  process.exit(failed ? 1 : 0);
}

function findChrome() {
  if (process.env.CHROME) return process.env.CHROME;
  for (const c of ["chromium", "chromium-browser", "google-chrome", "google-chrome-stable", "microsoft-edge"]) {
    try { return execSync(`command -v ${c}`, { stdio: ["ignore", "pipe", "ignore"] }).toString().trim(); } catch {}
  }
  for (const p of ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"]) if (existsSync(p)) return p;
  return null;
}

/* kleiner Webserver für ds-quiz-pwa/ */
function startServer() {
  const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg", ".woff2": "font/woff2" };
  const srv = createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, "http://x").pathname);
    if (p.endsWith("/")) p += "index.html";
    const f = path.join(APP, p);
    if (!f.startsWith(APP) || !existsSync(f) || statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { "Content-Type": types[path.extname(f)] || "application/octet-stream", "Cache-Control": "no-cache" });
    res.end(readFileSync(f));
  });
  return new Promise((r) => srv.listen(0, "127.0.0.1", () => r(srv)));
}

/* minimaler Chrome-DevTools-Client */
async function launch(chrome) {
  const profile = mkdtempSync(path.join(tmpdir(), "dsquiz-test-"));
  const proc = spawn(chrome, ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
  const wsUrl = await new Promise((res, rej) => {
    let buf = ""; const t = setTimeout(() => rej(new Error("Chrome startet nicht")), 15000);
    proc.stderr.on("data", (d) => { buf += d; const m = buf.match(/DevTools listening on (ws:\/\/\S+)/); if (m) { clearTimeout(t); res(m[1]); } });
  });
  const ws = new WebSocket(wsUrl); await new Promise((r) => ws.addEventListener("open", r));
  let id = 0; const pending = new Map(), listeners = [];
  ws.addEventListener("message", (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } else listeners.forEach((l) => l(m)); });
  const send = (method, params = {}, sessionId) => new Promise((r, j) => { const i = ++id; pending.set(i, (m) => (m.error ? j(new Error(method + ": " + m.error.message)) : r(m.result))); ws.send(JSON.stringify({ id: i, method, params, sessionId })); });
  async function newPage(prelude) {
    const { targetId } = await send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
    const errors = [];
    listeners.push((m) => { if (m.sessionId === sessionId && m.method === "Runtime.exceptionThrown") errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text); });
    const s = (method, params) => send(method, params, sessionId);
    await s("Runtime.enable"); await s("Page.enable");
    await s("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    if (prelude) await s("Page.addScriptToEvaluateOnNewDocument", { source: prelude });
    const ev = async (expr) => { const r = await s("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r.result.value; };
    const go = async (url) => { await s("Page.navigate", { url }); for (let i = 0; i < 50; i++) { await sleep(100); try { if (await ev(`document.readyState==="complete"&&!!window.S`)) break; } catch {} } await sleep(200); };
    return { s, ev, go, errors };
  }
  const close = () => { try { ws.close(); } catch {} proc.kill(); setTimeout(() => { try { rmSync(profile, { recursive: true, force: true }); } catch {} }, 500); };
  return { newPage, close };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function browserTests() {
  head("3. Im Browser");
  if (typeof WebSocket === "undefined") { warn("Node.js ist zu alt (>= 22 nötig) – Browser-Tests übersprungen"); return; }
  const chrome = findChrome();
  if (!chrome) { warn("Chromium/Chrome nicht gefunden (CHROME=/pfad setzen) – Browser-Tests übersprungen"); return; }
  const srv = await startServer();
  const url = `http://127.0.0.1:${srv.address().port}/index.html`;
  const br = await launch(chrome);
  try {
    await snapshotTest(br, url);
    await flowTests(br, url);
    await offlineTest(br, url, srv);
  } finally { br.close(); srv.close(); }
}

/* --- 3a) alle Ansichten durchklicken, mit Referenz vergleichen --- */
const DETERMINISTIC = `(function(){var s=12345;Math.random=function(){s=(s*1103515245+12345)%2147483648;return s/2147483648};
var RD=Date,FIX=new RD(2026,10,9,10,0,0).getTime();function D(){var a=arguments;return a.length?new (Function.prototype.bind.apply(RD,[null].concat([].slice.call(a))))():new RD(FIX)}
D.prototype=RD.prototype;D.now=function(){return FIX};D.UTC=RD.UTC;D.parse=RD.parse;window.Date=D})();try{localStorage.clear()}catch(e){}`;

async function snapshotTest(br, url) {
  const p = await br.newPage(DETERMINISTIC);
  await p.go(url);
  const snaps = [];
  const snap = async (label) => { await sleep(20); snaps.push({ label, html: (await p.ev(`document.getElementById("app").innerHTML+"|lb:"+document.getElementById("lb").className+"|"+document.getElementById("lb-pg").textContent`)).replace(/ src="blob:[^"]*"/g, "") }); };
  // gesperrt -> falsches Passwort -> entsperren
  await p.ev(`setTab('doc');1`); await snap("Skripte gesperrt");
  await p.ev(`S.tab='tests';S.tMode='select';render();1`); await snap("Klausuren gesperrt");
  await p.ev(`unlock("falsches-passwort")`); await snap("falsches Passwort");
  if (PW) { const okUnlock = await p.ev(`unlock(${JSON.stringify(PW)})`); check(okUnlock === true, "Entsperren mit dem Passwort klappt (Klausuren geladen)", "Entsperren fehlgeschlagen"); }
  await p.ev(`setTab('home');1`);
  const steps = [
    ["Startseite", ``], ["Modus Auswahl", `setQM('mc')`], ["Modus Karten", `setQM('card')`], ["Modus Eintippen", `setQM('text')`],
    ["Themen", `pickTopics()`], ["Themen: keine", `setAreaTopics(false)`], ["Themen: alle", `setAreaTopics(true)`], ["Themen: 5 Fragen", `S.qSize=5;render()`],
    ["Quiz Frage 1", `startQuiz(5)`], ["Quiz richtig", `S.input=S.qs[S.cur].answer;doConfirm()`], ["Quiz Frage 2", `doNext()`],
    ["Hilfe 1", `hintStep()`], ["Hilfe 2", `hintStep()`], ["richtig mit Lösung", `S.input=S.qs[S.cur].answer;doConfirm()`],
    ["Quiz falsch", `doNext();S.input="xyz quatsch";doConfirm()`], ["abgeschrieben", `S.retypeInput=retypeTarget(S.qs[S.cur]);retypeChk()`],
    ["Das war richtig", `doNext();S.input="falsch falsch";doConfirm();markCorrect()`],
    ["Wiederholungsrunde", `doNext();S.input="nein";doConfirm();S.retypeDone=true;doNext()`],
    ["Ergebnis", `while(S.mode==="quiz"){S.input=S.qs[S.cur].answer;doConfirm();if(S.retypeMode)S.retypeDone=true;doNext()}`],
    ["Auswahl-Quiz", `go('modesel');setQM('mc');quickStart()`], ["Auswahl gewählt", `selectMC(2)`], ["Auswahl geprüft", `doConfirm()`],
    ["Startseite mit Weitermachen", `doNext();quitQuiz()`], ["Weitermachen", `resumeSes()`],
    ["Karte vorne", `go('modesel');setQM('card');quickStart()`], ["Karte hinten", `cardFlip()`], ["Karte 2", `cardRate(true)`],
    ["Schule", `setTab('schule')`], ["Klausuren", `S.tab='tests';S.tMode='select';render()`], ["Klausur Aufgabe 1", `startTest(0)`],
    ["Klausur richtig", `S.tInput=S.tTest.questions[0].answer;tConfirm()`], ["Klausur falsch", `tNext();S.tInput="quatsch";tConfirm()`],
    ["Klausur Ergebnis", `tNext();while(S.tMode==="running"){S.tInput=S.tTest.questions[S.tCur].answer.split(" ")[0];tConfirm();tNext()}`],
    ["Skripte", `setTab('doc')`], ["Skript", `showDoc(SUBJECTS[0].id)`], ["Skript-Seite groß", `openDoc(SUBJECTS[0].id,1)`], ["zurück", `goBack();goBack()`],
    ["Profil", `setTab('profile')`], ["Aussehen", `setTab('shop')`], ["Farbe Lila", `setLook('theme','lila')`], ["Semester 2", `goBack();setSem('home',1)`],
    ["Start Semester 2", `setTab('home')`], ["Archiv auf", `toggleArch('old')`], ["Zurückgesetzt", `setSem('home',-1);setTab('profile');resetAll()`],
  ];
  for (const [label, code] of steps) { if (code) await p.ev(code + ";1"); await snap(label); }
  check(!p.errors.length, `${steps.length} Ansichten ohne JavaScript-Fehler`, "JavaScript-Fehler: " + p.errors.join(" | "));

  if (UPDATE || !existsSync(SNAP_FILE)) {
    writeFileSync(SNAP_FILE, JSON.stringify(snaps, null, 1));
    warn(`Referenz-Ansichten ${UPDATE ? "aktualisiert" : "neu angelegt"} (${path.relative(process.cwd(), SNAP_FILE)})`);
    return;
  }
  const ref = JSON.parse(readFileSync(SNAP_FILE, "utf8"));
  const diffs = [];
  for (let i = 0; i < Math.max(ref.length, snaps.length); i++) {
    const a = ref[i], b = snaps[i];
    if (!a || !b || a.label !== b.label) { diffs.push(`Schritt ${i + 1}: Ablauf geändert (${a?.label} / ${b?.label})`); break; }
    if (a.html !== b.html) { let k = 0; while (a.html[k] === b.html[k]) k++; diffs.push(`"${a.label}":\n        vorher: …${a.html.slice(Math.max(0, k - 60), k + 100)}\n        jetzt:  …${b.html.slice(Math.max(0, k - 60), k + 100)}`); }
  }
  check(!diffs.length, `alle ${snaps.length} Ansichten wie in der Referenz`,
    `${diffs.length} Ansicht(en) anders als die Referenz. Falls gewollt: node tests/run.mjs --update\n      ` + diffs.slice(0, 5).join("\n      "));
}

/* --- 3b) Abläufe --- */
async function flowTests(br, url) {
  const p = await br.newPage();
  await p.go(url);
  if (PW) await p.ev(`unlock(${JSON.stringify(PW)})`);
  await p.s("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  const key = async (k) => { await p.s("Input.dispatchKeyEvent", { type: "rawKeyDown", key: k, code: k, windowsVirtualKeyCode: 13 }); await p.s("Input.dispatchKeyEvent", { type: "char", key: k, text: "\r" }); await p.s("Input.dispatchKeyEvent", { type: "keyUp", key: k, code: k, windowsVirtualKeyCode: 13 }); await sleep(120); };
  const type = (t) => p.s("Input.insertText", { text: t });

  check(await p.ev(`!!document.querySelector('.hb')`), "App startet und zeigt die Startseite", "Startseite wird nicht angezeigt");

  // Enter: erst Rückmeldung, dann nächste Frage
  await p.ev(`localStorage.clear();setTab('home');setQM('text');quickStart();1`); await sleep(100);
  await type(await p.ev(`S.qs[0].answer`)); await key("Enter");
  const e1 = await p.ev(`JSON.stringify([S.cur,S.confirmed])`); await key("Enter");
  const e2 = await p.ev(`JSON.stringify([S.cur,S.confirmed])`);
  check(e1 === "[0,true]" && e2 === "[1,false]", "Enter: erst Rückmeldung, dann nächste Frage", `Enter-Ablauf falsch (${e1} → ${e2})`);

  // Klausur: Teilpunkte
  const tp = await p.ev(`(function(){quitQuiz();startTest(0);var qs=S.tTest.questions;for(var i=0;i<qs.length;i++){var q=qs[i];if(q.keywords&&(q.minMatch||q.keywords.length)>=2){S.tCur=i;S.tInput=q.keywords[0].variants[0];tConfirm();var a=S.tAnswers[S.tAnswers.length-1];return JSON.stringify({e:a.earned,p:a.pts,t:document.querySelector('.fh').textContent})}}return "null"})()`);
  const tpo = JSON.parse(tp);
  if (!tpo) warn("keine Klausuraufgabe mit mehreren Stichworten – Teilpunkte nicht im Browser geprüft");
  else check(tpo.e > 0 && tpo.e < tpo.p && /Teilweise/.test(tpo.t), `Klausur: Teilpunkte (${tpo.e} von ${tpo.p} P.)`, "Teilpunkte werden nicht vergeben: " + tp);

  // Skript-Zoom
  await p.ev(`S.tMode='select';setTab('doc');openDoc(SUBJECTS[0].id,0);1`);
  let imgW = 0; for (let i = 0; i < 40 && !imgW; i++) { await sleep(100); imgW = await p.ev(`lbImg()&&lbImg().naturalWidth||0`); }
  check(imgW > 0, `Skriptseite wird im Browser entschlüsselt und angezeigt (${imgW} px breit)`, "Skriptseite wird nicht angezeigt (Entschlüsselung?)");
  const tap = async (x, y) => { await p.s("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] }); await p.s("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] }); };
  await tap(150, 350); await sleep(60); await tap(150, 350); await sleep(350);
  const z1 = await p.ev(`lbZ.s`);
  await tap(150, 350); await sleep(60); await tap(150, 350); await sleep(350);
  const z2 = await p.ev(`lbZ.s`);
  await p.s("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: 150, y: 400, id: 1 }, { x: 250, y: 400, id: 2 }] });
  for (let i = 1; i <= 5; i++) await p.s("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: 150 - i * 20, y: 400, id: 1 }, { x: 250 + i * 20, y: 400, id: 2 }] });
  await p.s("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] }); await sleep(100);
  const z3 = await p.ev(`lbZ.s`);
  await p.ev(`lbResetZoom(false);1`);
  await p.s("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: 300, y: 400 }] });
  for (let i = 1; i <= 6; i++) await p.s("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: 300 - i * 40, y: 400 }] });
  await p.s("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] }); await sleep(400);
  const pg = await p.ev(`lbPage`);
  check(z1 > 2 && z2 === 1 && z3 > 2 && pg === 1, "Skript-Ansicht: Doppeltippen, Zwei-Finger-Zoom und Blättern funktionieren", `Zoom/Blättern fehlerhaft (Doppeltippen ${z1}, zurück ${z2}, Pinch ${z3}, Seite ${pg})`);
  await p.ev(`closeLB();1`);

  // Sicherung exportieren + laden
  await p.ev(`setTab('home');setQM('text');quickStart();S.input="falsch";doConfirm();1`);
  const before = await p.ev(`JSON.stringify([localStorage.getItem('ds-w'),localStorage.getItem('ds-h'),localStorage.getItem('ds-s')])`);
  const exp = await p.ev(`new Promise(function(res){var oc=URL.createObjectURL;URL.createObjectURL=function(b){b.text().then(res);URL.createObjectURL=oc;return oc.call(URL,b)};exportProgress()})`);
  await p.ev(`localStorage.clear();window.confirm=function(){return true};importProgress(new File([${JSON.stringify(exp)}],"s.json"));1`);
  await sleep(1500);
  const after = await p.ev(`JSON.stringify([localStorage.getItem('ds-w'),localStorage.getItem('ds-h'),localStorage.getItem('ds-s')])`);
  check(before === after, "Fortschritt sichern und wieder laden ergibt denselben Stand", "Sicherung/Laden verändert die Daten");
  check(!p.errors.length, "Abläufe ohne JavaScript-Fehler", "JavaScript-Fehler: " + p.errors.join(" | "));
}

/* --- 3c) offline --- */
async function offlineTest(br, url, srv) {
  const p = await br.newPage();
  await p.go(url);
  if (PW) await p.ev(`unlock(${JSON.stringify(PW)})`); // einmal online entsperren, Schlüssel bleibt auf dem Gerät
  // "ready" kommt erst, wenn der Service Worker installiert (alles vorab gecacht) und aktiv ist
  const active = await p.ev(`Promise.race([navigator.serviceWorker.ready.then(function(r){return !!r.active}),new Promise(function(r){setTimeout(function(){r(false)},10000)})])`);
  await sleep(300);
  srv.closeAllConnections?.(); await new Promise((r) => srv.close(r));
  await p.s("Page.reload"); await sleep(1500);
  const okOffline = await p.ev(`!!document.querySelector('.hb')`).catch(() => false);
  check(active && okOffline, "funktioniert offline (Service Worker)", `offline nicht verfügbar (Service Worker aktiv: ${active})`);
  if (PW) {
    const w = await p.ev(`new Promise(function(res){setTimeout(function(){encURL(DOCM[SUBJECTS[0].id].pages[2]).then(function(u){var i=new Image();i.onload=function(){res(i.naturalWidth)};i.onerror=function(){res(0)};i.src=u}).catch(function(){res(0)})},800)})`);
    check(w > 0, "Skripte auch offline lesbar (entschlüsselt aus dem Cache)", "Skripte offline nicht lesbar");
  }
}

/* ---------- Start ---------- */
if (QUICK) finish();
else await browserTests().catch((e) => { fail("Browser-Tests abgebrochen: " + e.message); }).then(finish);
