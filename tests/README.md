# Tests für DS Quiz

Ein Befehl prüft, ob nach einer Änderung noch alles funktioniert:

```sh
node tests/run.mjs
```

Dauer etwa 10 Sekunden. Grün = alles in Ordnung, rot = da ist etwas kaputt (mit Erklärung).

**Voraussetzungen:** Node.js 22 oder neuer und Chromium/Chrome.
Wird der Browser nicht gefunden: `CHROME=/pfad/zu/chrome node tests/run.mjs`

## Was geprüft wird

1. **Daten & Dateien:** Alle Fächer sind eingebunden, keine doppelten Frage-IDs, alle Themen existieren,
   Skript-Ausschnitte zeigen auf vorhandene Seiten, jede Datei steht in `sw.js` (sonst offline nicht verfügbar).
2. **Bewertung:** Jede Musterlösung und jede `accept`-Variante wird als richtig erkannt; bekannte
   Grenzfälle (z. B. „15 %“ darf nicht für „5 %“ zählen, „Ton“ nicht für „Beton“) werden richtig bewertet.
3. **Im Browser:** Alle Ansichten werden durchgeklickt und mit `privat/snapshots.json` verglichen (lokal, weil Klausurtext darin steht);
   außerdem Enter-Taste, Teilpunkte in Klausuren, Zoom in den Skripten, Sichern/Laden und Offline-Betrieb.

## Nach gewollten Änderungen

Wenn du absichtlich etwas geändert hast (neue Fragen, andere Texte, neues Design), meldet der
Vergleich mit `privat/snapshots.json` Unterschiede. Prüfe die angezeigten Stellen und speichere dann
den neuen Stand als Referenz:

```sh
node tests/run.mjs --update
```

Nur Daten und Bewertung prüfen (ohne Browser, unter 1 Sekunde): `node tests/run.mjs --quick`

## Tipps für neue Fragen

- Kurze Begriffe (bis 3 Zeichen, z. B. „Ton“, „UV“, „öl“) zählen nur als eigenes Wort oder als Wortanfang.
  Zusammensetzungen mit dem Begriff am Ende („Motoröl“) als eigene Variante eintragen.
- Reine Zahlen (z. B. „5 %“, „0,063“, „1:100“) werden exakt verglichen.
- Neues Fach: Ordner `fach/<name>/` mit `data.js`, `<script>`-Zeile in `index.html` und alle Dateien in `sw.js` eintragen.
  Fehlt etwas, sagt es der Test.
