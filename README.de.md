# capturepack

[English](README.md) · [한국어](README.ko.md) · [日本語](README.ja.md) · [中文](README.zh.md) · [Español](README.es.md) · [Français](README.fr.md) · **Deutsch** · [Português](README.pt.md) · [Русский](README.ru.md)

[![Release](https://img.shields.io/github/v/release/r2cuerdame/capturepack?color=7c5cff&label=release)](https://github.com/r2cuerdame/capturepack/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/r2cuerdame/capturepack/total?color=7c5cff)](https://github.com/r2cuerdame/capturepack/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![Sponsor](https://img.shields.io/badge/%E2%99%A5_Sponsor-ea4aaa)](https://github.com/sponsors/r2cuerdame)

## Den Fehler zurückspulen. Den Moment markieren. Der KI den Zustand geben.

**CapturePack macht aus einem laufenden Replay — standardmäßig 30 Sekunden —
strukturierte Belege für Menschen und KI.**

Drücke den Hotkey, nachdem etwas schiefgegangen ist, und spule zu dem Bild zurück,
in dem es passiert ist. Umrahme, was kaputtging, schreibe dazu, was du meintest,
und speichere. Das Pack trägt das Replay, die über die Zeit aufgezeichnete Fenster-
und Steuerelementgeometrie des Desktops und deine Anmerkungen — statt einer KI zu
überlassen, alles aus Pixeln zu erschließen.

**Object Pick ist eine Standbild-Funktion.** Nimm einen Screenshot auf, und du
kannst das echte Steuerelement unter dem Mauszeiger anklicken: CapturePack
speichert Name, Rolle, AutomationId und Prozess, im Browser dazu die ganze
sichtbare Seite. Ein Replay kann dasselbe nicht ehrlich anbieten — siehe
[warum](#warum-die-objektauswahl-zum-standbild-gehört) —, deshalb bekommt ein
Video die Rahmen, die du selbst zeichnest.

Das gespeicherte Pack entspricht dem, was aufgenommen wurde: Ein Video-Pack
vereint Replay, Bilder, Anmerkungen, Objektkontext und eine Ereignis-Zeitleiste;
ein Bild-Pack enthält das ausdrücklich aufgenommene Standbild, Anmerkungen und
Objektkontext. Ein Doppelklick auf `viewer.html` zeigt beide Sorten offline an —
ohne CapturePack zu installieren und ohne Server zu starten. Es bleibt ein
lokaler, offener Ordner, der ohne KI, Konto und Cloud-Dienst funktioniert.

🌐 **[capturepack.dev](https://capturepack.dev)** · [Herunterladen](https://github.com/r2cuerdame/capturepack/releases/latest)

Aktuelle öffentliche Windows-Version: **CapturePack 0.5.0**. Verlauf erstellt
eine geprüfte **Share Copy** (`.share.zip`), deren einzige Medien geprüfte
annotierte PNG-Standbilder sind; eine erzeugte README, ein Offline-Viewer und ein
minimales Inventar begleiten sie. Originale, sämtliche Videos und strukturierter
Kontext werden ausgeschlossen. Das vollständige ZIP (`.zip`) enthält weiterhin
die Originale.

<p align="center">
  <a href="https://capturepack.dev/">
    <img src="https://raw.githubusercontent.com/r2cuerdame/capturepack/main/site/assets/motion/de/capturepack-time-machine-poster.webp" alt="CapturePack startet rechts bei JETZT, bewegt den Abspielkopf nach links zu vor 5 Sekunden, umrahmt dort den Fehler, der vom Bildschirm längst verschwunden ist, und exportiert strukturierte Belege für KI." width="760">
  </a>
</p>

Achte auf die Richtung: Der Abspielkopf startet **rechts bei JETZT** und wandert
**nach links zu vor 5 Sekunden** — dorthin, wo der Fehler, der vom Bildschirm
längst verschwunden ist, noch da ist und markiert werden kann. Dieselben Belege
werden als strukturierte Daten für KI gespeichert.

## Der Ablauf

1. **Zurückspulen** — bei eingeschalteter Live-Aufnahme (Standard) nach dem Fehler
   `Ctrl+Alt+C` drücken und dann im eingefrorenen Replay zu dem Bild scrubben, in
   dem die Oberfläche falsch war. Die Replay-Länge ist von 1–60 Sekunden
   einstellbar.
2. **Markieren** — mit der rechten Maustaste einen Rahmen über das Kaputte ziehen
   und dazuschreiben, was du meintest. Der Rahmen hat eine Lebensdauer: Er
   erscheint und verschwindet mit dem Moment, den er erklärt.
3. **Oder das Standbild aufnehmen und das Objekt wählen** — den Bild-Hotkey
   drücken; Object Pick hebt das echte Steuerelement unter dem Mauszeiger hervor.
   Ein Klick speichert barrierefreien Namen, Steuerelementtyp, AutomationId,
   Prozess und beobachtete Grenzen; fehlen Daten zum Steuerelement, bleibt das
   Fenster der Rückfall. Im Browser behält das Pack außerdem die Seite selbst:
   jedes Element, das du sehen konntest, mit Rolle, Rechteck und Text. Eingaben,
   Passwortfelder und alles Verborgene werden bewusst verweigert, und die
   Nutzdaten führen auf, was ausgelassen wurde — damit ein Leser weiß, dass ein
   leer wirkendes Formular eine Schwärzung ist.
4. **Strukturierten Kontext übergeben** — den Ordner für andere Entwickler
   speichern, ihn in ChatGPT, Claude, Codex, Cursor oder Gemini legen oder ihn
   von einer verbundenen KI über den integrierten, schreibgeschützten MCP-Server
   lesen lassen.

### Warum die Objektauswahl zum Standbild gehört

Nicht weil sich eine Auswahl im Replay nicht lohnen würde, sondern weil sie dort
nur zur *Hälfte* möglich ist.

Fenstergeometrie ist billig: CapturePack tastet sie rund hundertmal pro Sekunde
ab und kann deshalb zu jedem Bild sagen, welches Fenster wo war. Die
**Steuerelemente** eines Fensters zu durchlaufen ist nicht billig — ein Durchlauf
der Chromium-Fenster auf einem normalen Schreibtisch kostet 326 ms gegenüber
13,9 ms für alles andere zusammen —, deshalb hält sich der Tracker, der während
einer Aufnahme läuft, an ein CPU-Budget von 3 % und lässt sie aus. Das Ergebnis
war eine Funktion, die den Button im Browser genau im Moment der Aufnahme anbot
und eine Sekunde davor oder danach nur noch das Browserfenster — ohne dass am
Bildschirm zu erkennen gewesen wäre, was man gerade vor sich hatte.

Ein Standbild kennt diese Spaltung nicht. Es ist ein einziger Augenblick, der
vollständige Durchlauf läuft an ihm, und jedes Steuerelement auf dem Desktop
steht zur Wahl. Dorthin geht also die Präzision.

Ein Video *zeichnet* weiterhin auf, was da war — Fenster- und
Steuerelementgeometrie über die Zeit landen in der Kontext-Zeitleiste des Packs,
damit eine KI sie lesen kann. Was es nicht mehr tut, ist dich einzuladen, darauf
zu klicken.

### Quellen des Objektkontexts

- **Windows UI Automation (integriert):** barrierefreier Name des Steuerelements,
  semantischer Typ, AutomationId, Prozess-/Fensteridentität und beobachtete
  Grenzen, sofern die Anwendung sie preisgibt.
- **Chrome DOM (optionale Vorschau-Erweiterung):** Selektor, Rolle, Text und URL
  des Elements, das du ausdrücklich wählst — auf das CapturePack-Symbol in der
  Symbolleiste klicken, dann auf das Element. Das funktioniert auch in iframes,
  liest die Seite nur für diese eine Auswahl und streamt kein DOM. Unter
  Einstellungen › Plugins › Chrome DOM steht, was die Auswahl zuletzt getan hat —
  eine Auswahl, die nicht ankommt, sagt also warum.
  **Einmal auf das CapturePack-Symbol klicken und dem Browser die Erlaubnis
  geben.** Danach drückst du in Chrome nichts mehr: Dein gewohnter
  Aufnahme-Hotkey bringt die sichtbare Seite mit. Die einmalige Erlaubnis ist
  nötig, weil Chrome nie einen globalen Hotkey sieht — es gibt eine Seite nur
  dann an eine Erweiterung weiter, wenn innerhalb von Chrome geklickt wurde oder
  wenn der Benutzer die Erweiterung erlaubt hat. Bis zur Erlaubnis wird nichts
  vorgehalten (die Installation zeigt keine Berechtigungswarnung), und
  `chrome://extensions` nimmt sie jederzeit zurück. Ein ohne Erlaubnis
  geschriebenes Pack trägt einfach keine Seite — und sagt das auch.
- **HWND-Fenster als Rückfall:** Ist kein untergeordnetes Steuerelement
  verfügbar, speichert CapturePack weiterhin das echte Fenster und seine
  beobachtete Geometrie, statt ein Steuerelement zu erfinden.

### Nur ein Bild benötigt?

`Ctrl+Alt+S` öffnet die Bereichsaufnahme. Standard ist das Ziehen eines Bereichs;
die Schaltfläche **Gesamten Bildschirm aufnehmen** oben nimmt ausdrücklich den
kompletten virtuellen Desktop auf — alle Monitore in einem Bild. Das Ergebnis
öffnet sich im selben Kontext-Editor mit nativen 100 % (oder der nächstmöglichen
Stufe bei einem außergewöhnlich großen Desktop) und lässt sich verschieben; das
Pack ist aber als Bild deklariert und enthält keine Replay-Datei. Ein
Bereichs-Pack speichert nur die ausgewählten Pixel plus Metadaten zur Lage des
Ausschnitts — es behält kein verstecktes Vollbild und keinen zweiten Monitor.

## Warum

- **Screenshots bewahren Pixel.** Was vor dem Bild geschah, geht verloren.
- **Videos bewahren Bewegung.** Absicht und Struktur gehen verloren.
- **CapturePack bewahrt Kontext.** Das Replay und die durch es hindurch
  aufgezeichnete Fenstergeometrie, das im Standbild gewählte Objekt, die
  Anmerkungen und den Zustand, der tatsächlich erfasst wurde.

## Erst zurückspulen

Der Fehler ist schon passiert? Ist die Live-Aufnahme eingeschaltet (Standard),
hält CapturePack das jüngste Replay im Speicher bereit. Drücke `Ctrl+Alt+C`
*nachdem* etwas schiefgegangen ist, und scrolle dann mit dem Mausrad **durch die
Zeit zurück** zu dem Bild, in dem es kaputtging. Ist die Live-Aufnahme aus, wird
nichts aufgezeichnet, und der Hotkey sagt dir, dass die Aufnahme aus ist.

## Was der strukturierte Kontext aussagt

Eine Anmerkung auf einem Standbild kann mehr benennen als ein Rechteck. Die
Anmerkungen eines Videos sind die Rahmen, die du gezeichnet hast, plus der
Moment, den jeder von ihnen erklärt:

- **Identität des Ziels:** UIA-Name, Steuerelementtyp (die semantische Rolle des
  Steuerelements), AutomationId, Prozess- oder Fensteridentität, sofern die
  Anwendung sie preisgibt; eine optionale Chrome-DOM-Auswahl kann stattdessen
  Selektor, Rolle, Text und URL tragen.
- **Erfasster Zustand in der Zeit:** der gewählte Augenblick, das Display, auf dem
  er lag, und die in diesem Augenblick beobachteten Grenzen.
- **Sichtbare und erzählte Belege:** Originalmedien, bearbeitbare Anmerkungen,
  erzeugte Ansichten und Berichte; ein Video-Pack ergänzt Keyframes, eine
  Zeitleiste und die durch sie hindurch aufgezeichnete Fenstergeometrie.

Dieser Kontext lässt sich direkt aus dem einfachen Ordner lesen. Eine verbundene
KI kann außerdem den **schreibgeschützten MCP-Server** der App nutzen und so
beginnen: *„Analysiere das neueste CapturePack.“*

## 🌍 Sprachen

CapturePack spricht **9 Sprachen**: English · 한국어 · 日本語 · 中文 · Español · Français · Deutsch · Português · Русский

- Die App folgt automatisch deiner **Systemsprache** — jederzeit unter Einstellungen → Allgemein änderbar.
- Erzeugte Pack-Dokumente (`viewer.html`, `README.md`, `report.md`, `skills/`) können einer eigenen Spracheinstellung folgen; deine eigenen Beschreibungen werden nie übersetzt.
- [capturepack.dev](https://capturepack.dev) erkennt die Browsersprache ebenfalls automatisch.

## Prinzipien

Local first · Offline first · offenes Format · Plugin-basiert · keine Cloud · kein Login · keine Datenbank · keine KI-Abhängigkeit · kein Vendor-Lock-in.

Erzeugte CapturePacks sollen für immer lesbar bleiben.

## Was CapturePack bewusst nicht tut

CapturePack setzt sich bewusst strikte Produktgrenzen:

- **Keine Cloud-Dienste, Kontopflichten oder heimliche Telemetrie:** Vollständig lokal und offline. Es werden keine Telemetrie-, Tracking- oder Absturzdaten vom System gesendet. Die einzige ausgehende Netzwerkanfrage ist die optionale Update-Prüfung über GitHub Releases (unter Einstellungen → Allgemein abschaltbar).
- **Keine Tastenprotokollierung (Keylogging):** Erfasst Mauskoordinaten, Klicks und Fensterereignisse synchron zur Replay-Uhr. Tastatureingaben werden niemals belauscht oder aufgezeichnet (`input.key.*` ist reserviert und verboten).
- **Keine versteckten Hintergrundpixel bei Bereichsaufnahmen:** Bereichs-Screenshots (`Ctrl+Alt+S`) speichern ausschließlich das gewählte Pixelrechteck und dessen Platzierungsmetadaten. Die Anwendung behält niemals heimlich den gesamten Desktop oder nicht ausgewählte Monitore.
- **Keine interaktive Objektauswahl während der Videoaufzeichnung:** Das Durchlaufen des Barrierefreiheitsbaums während der Aufnahme würde übermäßig viel CPU beanspruchen. Videoaufnahmen erfassen Fenstergeometrien über die Zeit, aber die interaktive Steuerelement-Auswahl (Object Pick) bleibt ausschließlich Standbildern vorbehalten.
- **Kein unangekündigtes oder stillschweigendes Löschen:** Aufbewahrungsrichtlinien folgen exakt den benutzerdefinierten Speicher- und Tage-Grenzen. Manuelles Bereinigen verschiebt Packs in den Windows-Papierkorb, anstatt Daten unwiderruflich ohne Rückfrage zu vernichten.
- **Keine ungeprüfte automatische Geheimnisentfernung:** Weichzeichnen ist eine nicht-destruktive visuelle Abdeckung. Die Software behauptet nicht, Zugangsdaten oder sensible Daten magisch zu erkennen; der Nutzer bleibt dafür verantwortlich, Standbilder vor der Weitergabe visuell zu prüfen.
- **Keine externen Issue-Tracker im Kern gebündelt:** Der Kern enthält keinen Code zur Ticketerstellung in Jira, GitHub, Linear usw. Solche Integrationen werden an Post-Save-Action-Plugins oder Webhooks delegiert.

## Was in einem CapturePack steckt

Das Pack ist ein einfacher **Ordner** — durchsuchbar, bearbeitbar, ehrlich. Ein
vollständiges ZIP (`.zip`) ist eine optionale Kopie zur Weitergabe und enthält
weiterhin die Originalbelege. Verlauf bietet außerdem eine geprüfte
**Share Copy** (`.share.zip`), deren einzige Medien geprüfte annotierte
PNG-Standbilder sind; eine erzeugte README, ein Offline-Viewer und ein minimales
geschlossenes Inventar begleiten sie.

Video-Packs können enthalten:

```
CapturePack_2026-07-27_143052/
├── replay.mp4               # Originalbeleg (oder replay.webm als Rückfall)
├── replay_annotated.webm    # optionale abgeleitete Ansicht; nur bei Manifest-Deklaration
├── snapshot.png             # das erfasste Bild (Original)
├── annotations.json         # die wahre Quelle: Rahmen, Lebensdauern, Nummern, Unschärfe
├── timeline.json            # Video-Packs: maschinenlesbares Ereignisprotokoll
├── viewer.html              # per Doppelklick offline zu öffnen; kein Server
├── report.md                # deine Beschreibung, LLM-fertig
├── manifest.json            # Formatversion, Inventar
├── README.md                # das erste Dokument, das ein Mensch liest
├── skills/                  # für KI strukturierter Kontext (funktioniert auch ohne MCP)
└── plugins/                 # erfasste UI-Objekt-Metadaten, sofern vorhanden
```

Bild-Packs sind bewusst anders:

```
CapturePack_2026-07-27_143052/
├── snapshot.png             # der ausdrückliche Bereich oder der ganze virtuelle Desktop
├── annotations.json         # Anmerkungen zum Bild
├── viewer.html              # per Doppelklick offline zu öffnen; kein Server
├── report.md · README.md
├── manifest.json            # capture_kind: image
├── skills/                  # bildspezifischer Kontext; kein Timeline-Skill
└── plugins/                 # optionale Objekt-Metadaten
```

Ein Bild-Pack hält `capture_kind: "image"` fest und dazu entweder einen Bereichs-
oder einen Vollbild-Geltungsbereich. Es hat kein Replay und keine
`timeline.json`. Ein Bereichsbild speichert außerdem, woher der Ausschnitt
stammt, ohne Pixel außerhalb des Ausschnitts abzulegen.
Auch Objekt-Metadaten sind optionale Belege: Gibt eine Anwendung kein brauchbares
UI-Objekt preis, sagt das Pack das — statt Kontext zu erfinden.

Die Spezifikation zählt mehr als jede Implementierung — jede Sprache kann CapturePack-Dateien erzeugen. Siehe [SPEC.md](SPEC.md).

## Plugins und After-Save-Aktionen

Einstellungen → Plugins unterteilt Erweiterungen in zwei klare Kategorien:

1. **Temporale Kontext-Provider (Temporal Context Providers):** Plugins, die während der Aufnahme zeitindizierte Metadaten bereitstellen (wie Windows UI Automation oder die Chrome-DOM-Erweiterung). Siehe [docs/temporal-provider-api.md](docs/temporal-provider-api.md).
2. **After-Save-Aktionen (After Save Actions):** Automatisierungspipelines, die sequentiell ausgeführt werden, sobald ein Pack dauerhaft auf der Festplatte gesichert ist (und optional nach Abschluss des Hintergrund-Videorenderings). Aktionen können lokale Skripte ausführen oder HTTP-Webhooks anstoßen. Die Isolation ist strikt: Eine hängende oder fehlgeschlagene Aktion gefährdet niemals das gespeicherte Pack, blockiert nicht die Oberfläche und erzeugt keine unbehandelten Fehler. Webhook-Geheimnisse werden lokal mit Windows DPAPI (`safeStorage`) verschlüsselt, und Klartext-HTTP außerhalb von Loopback wird abgewiesen.

## MCP — mit deinen Aufnahmen sprechen

Die App enthält einen optionalen, schreibgeschützten
[MCP](https://modelcontextprotocol.io)-Server, der standardmäßig aktiviert ist
und automatisch unter `http://127.0.0.1:39393/mcp` startet (nur localhost). Unter
Einstellungen → MCP lässt er sich sofort stoppen oder vom Autostart ausnehmen. Er
liest ausschließlich CapturePacks, die bereits gespeichert wurden, und kann keine
Bild- oder Videoaufnahme starten.

Eine KI kann `capturepack_history` aufrufen, um Bild- und Videoaufzeichnungen zu
durchsuchen, und dann `capturepack_open` mit der gewählten id;
`capturepack_latest` bleibt die Abkürzung zum neuesten Pack.

```
claude mcp add --transport http capturepack http://127.0.0.1:39393/mcp
```

Werkzeuge, Client-Einrichtung und Einstellungen: [docs/MCP.md](docs/MCP.md).

## Einstellungen und Diagnose

- Unter Einstellungen → Aufnahme lassen sich die Kürzel für Video (`Ctrl+Alt+C`)
  und Bild (`Ctrl+Alt+S`), die Replay-Länge und die Aufnahmerate von 5–30 fps
  unabhängig voneinander einstellen.
- Über CapturePack / Information → **Protokollordner öffnen** öffnet die lokale,
  in der Größe begrenzte Laufzeitdiagnose. Protokolle werden nie automatisch
  hochgeladen.

## Installation & Build

### Vorgefertigter Windows-Installer

Lade den aktuellen Installer von den [GitHub Releases](https://github.com/r2cuerdame/capturepack/releases/latest) herunter:

1. Lade `CapturePack-Setup-0.5.0.exe` und `SHA256SUMS.txt` herunter.
2. Prüfe die Prüfsumme in PowerShell:
   ```powershell
   Get-FileHash CapturePack-Setup-0.5.0.exe -Algorithm SHA256
   ```
3. Führe den Installer aus. Da die Open-Source-Codesignierung noch beantragt wird, zeigt Windows SmartScreen einen Hinweis: Klicke auf **Weitere Informationen** → **Trotzdem ausführen**.

### Aus dem Quellcode bauen

Voraussetzungen:
- Windows 10/11 (64-Bit)
- [Node.js](https://nodejs.org/) `>= 22.12.0` (LTS empfohlen)
- npm `>= 10.9.0`

```powershell
# Repository klonen
git clone https://github.com/r2cuerdame/capturepack.git
cd capturepack/core

# Festgelegte Abhängigkeiten installieren
npm ci

# Im lokalen Entwicklungsmodus starten
npm run dev

# Release-Candidate-Validierung ausführen (alle Tests, Typcheck, Build, Smoke)
npm run qa:rc
```

## Status

**0.5.0 ist der aktuelle öffentliche Windows-Download.** CapturePack ist
weiterhin ein Projekt im Frühstadium; bewahre beim Melden eines Problems das
Original-Pack auf. Siehe [GOAL.md](GOAL.md) für die Produktvision und
[ROADMAP.md](ROADMAP.md) für die nächsten Schritte.

Bekannte Einschränkung: Die PTS-Ausrichtung von Video und Kontext je Display
wird in [Issue #89](https://github.com/r2cuerdame/capturepack/issues/89) weiter
vermessen. CapturePack zeichnet mehrdeutige Zeitbelege auf, statt sie hinter
einem fest einprogrammierten globalen Offset zu verstecken.

## Dokumentation

- [Dokumentationsindex](docs/README.md) — der beste Einstieg für Entwicklung,
  Integrationen, QA, Releases, Schemata und historisches Material.
- [Pack-Spezifikation](SPEC.md) und [Architektur](ARCHITECTURE.md) — der
  Open-Format-Vertrag und die aktuellen Implementierungsgrenzen.
- [Release-QA](docs/QA.md), [aktuelle Übergabe](docs/HANDOFF.md) und
  [Release-Prozess](docs/RELEASING.md) — wie Änderungen geprüft, übergeben und
  veröffentlicht werden.
- [MCP](docs/MCP.md) und [Temporal-Provider-API](docs/temporal-provider-api.md)
  — schreibgeschützter Zugriff auf gespeicherte Packs und Kontextanbindung.

CapturePack `0.5.0` ist die Version der Anwendung. Die `format_version` des Packs
entwickelt sich unabhängig davon durch additive Formatänderungen weiter; Leser
müssen sich an [SPEC.md](SPEC.md) halten, statt die Formatunterstützung aus der
App-Version abzuleiten.

## Sicherheit und Signierung

Windows-Builds sind derzeit nicht signiert (SmartScreen warnt — *Weitere Informationen → Trotzdem ausführen*);
jede Version liefert `SHA256SUMS.txt` zur Überprüfung, und ein Antrag auf eine OSS-Codesignatur läuft.
Details, Rollen im Team und Datenschutzpraxis: [docs/CODE_SIGNING.md](docs/CODE_SIGNING.md).

## Datenschutz vor dem Teilen

Bildschirmpixel, Fenstertitel und barrierefreie Namen — dazu Selektor, Rolle,
Text und URL, wenn Chrome DOM genutzt wird — können vertraulich sein. CapturePack
behält Aufnahmen und Objektkontext auf diesem Rechner und lädt weder Aufnahmen
noch Telemetrie oder Absturzberichte hoch. Die einzige ausgehende Anfrage der App
ist die optionale Updateprüfung über GitHub Releases, die sich unter
Einstellungen → Allgemein abschalten lässt.

Unschärfe ist nicht destruktiv: Sie schützt erzeugte annotierte Ansichten, aber
`snapshot.png` und das Original-Replay im vollständigen Pack bleiben
ungeschwärzt. Wenn Originalmedien oder strukturierter Kontext privat bleiben
müssen, nutze Verlauf → **Share Copy** und prüfe vor dem Senden die
Vorschau jedes enthaltenen Standbilds. Die
Share Copy schließt Originale, sämtliche Videocontainer, Manifeste,
Annotationen, Timelines, Plugin-Kontext und erzeugte Pack-Dokumente aus; die
enthaltenen PNGs werden nur aus ihren Pixeldaten kanonisch neu codiert. Trotzdem
garantiert sie nicht, dass die geprüften abgeleiteten Bilder keine unmarkierten
Geheimnisse enthalten.

## ♥ Unterstützen

CapturePack ist kostenlos, quelloffen und cloudfrei — keine Konten, keine Telemetrie, nichts zu verkaufen.
Wenn es dir Zeit spart, hält [**eine Förderung auf GitHub**](https://github.com/sponsors/r2cuerdame) das Projekt in Bewegung.

## Lizenz

[MIT](LICENSE)
