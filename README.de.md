# capturepack

[English](README.md) · [한국어](README.ko.md) · [日本語](README.ja.md) · [中文](README.zh.md) · [Español](README.es.md) · [Français](README.fr.md) · **Deutsch** · [Português](README.pt.md) · [Русский](README.ru.md)

[![Release](https://img.shields.io/github/v/release/r2cuerdame/capturepack?color=7c5cff&label=release)](https://github.com/r2cuerdame/capturepack/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/r2cuerdame/capturepack/total?color=7c5cff)](https://github.com/r2cuerdame/capturepack/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

## Den Fehler zurückspulen. Das Objekt wählen. Der KI seinen Zustand geben.

**CapturePack macht aus einem laufenden Replay — standardmäßig 30 Sekunden — strukturierte Belege für Menschen und KI.**

Drücke den Hotkey nach dem Fehler, gehe zum betroffenen Bild zurück und wähle das erfasste
Steuerelement oder Fenster. CapturePack bewahrt Identität, beobachtete Position und Bewegung,
damit eine KI sie nicht allein aus Pixeln erraten muss.

🌐 **[capturepack.dev](https://capturepack.dev)** · [Herunterladen](https://github.com/r2cuerdame/capturepack/releases/latest)

Aktuelle öffentliche Windows-Version: **CapturePack 0.3.0** · Quell-/Release-Kandidat: **0.3.1**

<p align="center">
  <img src="https://raw.githubusercontent.com/r2cuerdame/capturepack/main/site/assets/demo.svg?v=4" alt="CapturePack springt zu einem früheren Bild, wählt ein untergeordnetes UI-Steuerelement, zeigt erfassten Namen und Typ, folgt der beobachteten Fensterbewegung und exportiert strukturierte KI-Belege." width="760">
</p>

## Ablauf

1. **Zurückspulen** — bei standardmäßig aktiver Live-Aufnahme nach dem Fehler
   `Ctrl+Alt+C` drücken. Die Länge ist von 1–60 Sekunden einstellbar. Ist die
   Aufnahme aus, wird nichts aufgezeichnet.
2. **Objekt wählen** — Object Pick speichert beobachtete Grenzen, barrierefreien Namen,
   Steuerelementtyp und Zeitpunkt. Fehlen Daten des Kind-Elements, dient das echte Fenster
   als Rückfall.
3. **Bewegung verfolgen** — Fenster und Steuerelement werden auf der Replay-Uhr beobachtet.
   Jede Probe nennt ihr Display; wieder geöffnete Multi-Monitor-Packs behalten Zeit und
   Koordinaten auch beim Wechsel zwischen Monitoren.
4. **Kontext übergeben** — Ordner teilen oder bereits gespeicherte Packs über den optionalen,
   lokalen und schreibgeschützten MCP-Server von einer KI lesen lassen.

### Quellen des Objektkontexts

- **Windows UI Automation (integriert):** barrierefreier Name, semantischer Typ,
  AutomationId, Prozess-/Fensteridentität und beobachtete Grenzen, sofern verfügbar.
- **Chrome DOM (optionale Vorschau-Erweiterung):** Selektor, Rolle, Text und URL des
  ausdrücklich gewählten Elements; kein permanenter DOM-Stream.
- **HWND-Fenster als Rückfall:** speichert statt eines erfundenen Objekts das echte Fenster
  und seine beobachtete Geometrie.

### Nur ein Bild benötigt?

`Ctrl+Alt+S` öffnet die Bereichsauswahl; Ziehen funktioniert nahtlos über Monitorgrenzen.
**Vollbildaufnahme** speichert ausdrücklich alle Monitore in einem Bild des virtuellen
Desktops. Das Bild öffnet sich im selben Editor bei nativen 100 %, wenn möglich. Ein
Bild-Pack enthält kein Video und keine `timeline.json`; ein Bereich speichert nur seine
Pixel und Position, nie ein verborgenes Vollbild oder einen zweiten Monitor.

## Pack-Inhalt

```text
Video-Pack                        Bild-Pack
replay.mp4 oder replay.webm       snapshot.png
replay_annotated.webm (optional; nur bei Manifest-Deklaration)
snapshot.png                      report.md · README.md · skills/
annotations.json · timeline.json  plugins/ (optional)
plugins/ · manifest.json          manifest.json (capture_kind: image)
                                   kein Replay, keine Timeline
```

Objekte und Bewegungswege sind optionale Belege. Wurden sie nicht beobachtet, sagt das Pack
dies ausdrücklich und erfindet keinen Kontext.

## MCP

Der optionale, schreibgeschützte [MCP](https://modelcontextprotocol.io)-Server ist
standardmäßig unter `http://127.0.0.1:39393/mcp` aktiv und startet automatisch.
Unter Einstellungen → MCP lässt er sich stoppen oder vom Autostart ausschließen. Er liest
nur bereits gespeicherte Packs und kann keine Aufnahme starten. Nutze `capturepack_history`,
`capturepack_open` oder `capturepack_latest`. Details: [docs/MCP.md](docs/MCP.md).

## Einstellungen und Diagnose

- Unter Einstellungen → Aufnahme lassen sich Video- (`Ctrl+Alt+C`) und
  Bildkürzel (`Ctrl+Alt+S`), Replay-Länge und 1–30 fps getrennt einstellen.
- Information → **Protokollordner öffnen** öffnet die lokalen Diagnosen.
  Protokolle werden nie automatisch hochgeladen.

## Datenschutz vor dem Teilen

Pixel, Fenstertitel, barrierefreie Namen und DOM-Felder können vertraulich sein. CapturePack
lädt keine Aufnahmen, Telemetrie oder Absturzberichte hoch. Die einzige externe Anfrage ist
die optionale, abschaltbare GitHub-Updateprüfung.

Unschärfe ist nicht destruktiv: Sie schützt annotierte Ansichten, aber `snapshot.png` und
das Original-Replay im vollständigen Pack bleiben ungeschwärzt. Prüfe das Original und teile
das vollständige Pack nicht, wenn es private Daten enthält.

## Status, Sicherheit und Lizenz

0.3.0 bleibt die öffentliche Version; 0.3.1 ist ein Release-Kandidat, bis es in
GitHub Releases erscheint. Der Build ist noch nicht signiert, daher kann
SmartScreen warnen; jede Version enthält `SHA256SUMS.txt`.

Local-first · keine Cloud · kein Konto · keine Telemetrie · [MIT-Lizenz](LICENSE)
