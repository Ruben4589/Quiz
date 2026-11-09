# DS Quiz

Lern-App (PWA) fürs duale Studium – läuft im Browser und als App auf dem Handy, auch offline.
Adresse: https://ruben4589.github.io/Quiz/ds-quiz-pwa/

## Ordner

| Ordner | Inhalt | öffentlich? |
|---|---|---|
| `ds-quiz-pwa/` | die App (wird über GitHub Pages ausgeliefert) | ja |
| `ds-quiz-pwa/fach/<fach>/data.js` | Themen und Fragen eines Fachs | ja |
| `ds-quiz-pwa/fach/<fach>/*.jpg.enc`, `klausuren.enc` | Skriptseiten und Klausuren, **verschlüsselt** | ja, aber unlesbar |
| `privat/` | Originale (Scans, `klausuren.json`), Passwort, Test-Referenz | **nein** – steht in `.gitignore` |
| `tools/verschluesseln.mjs` | verschlüsselt alles aus `privat/` für die App | ja |
| `tests/` | automatische Tests (`node tests/run.mjs`) | ja |

Skripte und Klausuren sind urheberrechtlich geschützte Uni-Materialien. Sie liegen deshalb nur verschlüsselt
im Repo. Die App fragt einmal nach dem Passwort (Reiter „Doku“ oder „Tests“) und merkt es sich auf dem Gerät.

## So änderst du etwas

1. **Fragen:** `ds-quiz-pwa/fach/<fach>/data.js` bearbeiten.
2. **Skriptseiten / Klausuren:** Originale in `privat/fach/<fach>/` bzw. `privat/klausuren.json` ablegen, dann
   `node tools/verschluesseln.mjs` (verschlüsselt neue/geänderte Dateien und aktualisiert `sw.js`).
3. **Prüfen:** `node tests/run.mjs` – alles grün? Dann:
4. **Hochladen:** `git add -A && git commit -m "…" && git push`
   (Nicht über den Web-Upload: dort schützt `.gitignore` nicht davor, aus Versehen `privat/` hochzuladen.)

Neues Passwort: `node tools/verschluesseln.mjs --neues-passwort` (zufällig) oder
`DSQ_PASS="mein passwort" node tools/verschluesseln.mjs --neues-passwort`. Danach muss es auf jedem Gerät neu
eingegeben werden.
