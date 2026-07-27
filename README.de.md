# capturepack

[English](README.md) · [한국어](README.ko.md) · [日本語](README.ja.md) · [中文](README.zh.md) · [Español](README.es.md) · [Français](README.fr.md) · **Deutsch** · [Português](README.pt.md) · [Русский](README.ru.md)

[![Release](https://img.shields.io/github/v/release/r2cuerdame/capturepack?color=7c5cff&label=release)](https://github.com/r2cuerdame/capturepack/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/r2cuerdame/capturepack/total?color=7c5cff)](https://github.com/r2cuerdame/capturepack/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![Sponsor](https://img.shields.io/badge/%E2%99%A5_Sponsor-ea4aaa)](https://github.com/sponsors/r2cuerdame)

## Kannst du einen Bug in unter 5 Sekunden erklären?

**CapturePack ist der schnellste Weg, einem LLM etwas zu erklären.**

> Erfasse Kontext, keine Screenshots.
>
> Bessere Eingabe. Bessere Antworten.

CapturePack ist ein Open-Source-Format und -Toolkit zur Kontexterfassung, das Menschen und KI hilft, visuelle Probleme zu verstehen — jenseits von Screenshots und Bildschirmaufnahmen.

🌐 **[capturepack.dev](https://capturepack.dev)** · [Herunterladen](https://github.com/r2cuerdame/capturepack/releases/latest)

<p align="center">
  <!-- Absolute raw URL with a version query: GitHub proxies README images through
       camo, which caches by source URL — without the bump a fixed demo keeps
       rendering the stale copy for hours. Bump ?v= whenever demo.svg changes. -->
  <img src="https://raw.githubusercontent.com/r2cuerdame/capturepack/main/site/assets/demo.svg?v=2" alt="Demo: Ctrl+Alt+C drücken, die letzten 30 Sekunden frieren ein, das Mausrad scrubbt durch die Zeit, per Ziehen das Objekt auswählen, die Annotation schreiben — und das CapturePack ist gespeichert." width="760">
</p>

Ein CapturePack-**Ordner** bündelt, was ein Screenshot nicht kann: die letzten 30 Sekunden Replay, einen Schnappschuss, bearbeitbare Annotationen, eine maschinenlesbare Ereignis-Zeitleiste sowie Berichte für Mensch und KI — alles, was ein anderer Entwickler oder ein beliebiges LLM braucht, um die Lage sofort zu verstehen. Zum Teilen wird der Ordner zu einer einzigen `.capturepack`-Datei gepackt.

## Der 5-Sekunden-Workflow

```
Ctrl+Alt+C  →  capture  →  5-second annotation  →  save  →  drop into
                                                              ChatGPT / Claude / Codex / Cursor / Gemini
                                                              or send to another developer
```

## Warum

- **Screenshots bewahren Pixel.** Was vor dem Frame passiert ist, geht verloren.
- **Videos bewahren Bewegung.** Absicht und Struktur gehen verloren.
- **CapturePack bewahrt Kontext.** Zeit, Raum, Absicht, Umgebung.

## 🕰 Eine Zeitmaschine

Der Bug ist längst passiert? CapturePack hat **schon aufgenommen**. Drücke `Ctrl+Alt+C`
*nachdem* etwas schiefgeht — die letzten 30 Sekunden frieren ein, und das Mausrad
scrollt dich **zurück durch die Zeit** bis zu genau dem Frame, an dem es kaputtging.
Annotiere diesen Moment, nicht eine Nachstellung.

## 🤖 Für LLMs gebaut

Ein CapturePack ist Input, den eine KI wirklich versteht:

- Wirf das Pack in **ChatGPT, Claude, Codex, Cursor, Gemini** — der generierte Bericht
  und die Kontextdateien erklären die Lage ganz ohne zusätzliches Prompting.
- Oder häng überhaupt nichts an: Die App betreibt einen **MCP-Server**, eine verbundene KI
  hört also nur *„Analysiere das neueste CapturePack.“* und liest es selbst.

Bessere Eingabe. Bessere Antworten.

## 🌍 Sprachen

CapturePack spricht **9 Sprachen**: English · 한국어 · 日本語 · 中文 · Español · Français · Deutsch · Português · Русский

- Die App folgt automatisch deiner **Systemsprache** — jederzeit änderbar unter Einstellungen → Allgemein.
- Generierte Pack-Dokumente (`README.md`, `report.md`, `skills/`) können einer eigenen Spracheinstellung folgen; deine eigenen Beschreibungen werden nie übersetzt.
- [capturepack.dev](https://capturepack.dev) erkennt auch deine Browsersprache automatisch.

## Prinzipien

Local-first · Offline-first · Offenes Format · Plugin-basiert · Keine Cloud · Kein Login · Keine Datenbank · Keine KI-Abhängigkeit · Kein Vendor-Lock-in.

Erzeugte CapturePacks sollen für immer lesbar bleiben.

## Was in einem CapturePack steckt

Das Pack ist ein schlichter **Ordner** — durchstöberbar, bearbeitbar, ehrlich. Das ZIP
(`.capturepack`) entsteht nur, wenn du teilen willst.

```
CapturePack_2026-07-27_143052/
├── replay.webm              # Originalbeweis — wird nie verändert
├── replay_annotated.webm    # Annotationen eingebrannt; läuft in jedem Player
├── snapshot.png             # der aufgenommene Frame (Original)
├── annotations.json         # die wahre Quelle: Rahmen, Lebensdauer, Nummern, Unschärfe
├── timeline.json            # maschinenlesbares Ereignisprotokoll
├── report.md                # deine Beschreibung, LLM-fertig
├── manifest.json            # Formatversion, Inventar
├── README.md                # das erste Dokument, das ein Mensch liest
├── skills/                  # Kontext, für KI strukturiert (funktioniert ohne MCP)
└── plugins/                 # strukturierte Metadaten aus Integrationen
```

Ein reines Screenshot-Pack — `manifest.json` + `snapshot.png`, sonst nichts — ist vollkommen gültig.

Die Spezifikation zählt mehr als jede Implementierung — jede Sprache kann CapturePack-Dateien erzeugen. Siehe [SPEC.md](SPEC.md).

## MCP — sprich mit deinen Aufnahmen

Die App bringt einen dauerhaft laufenden, schreibgeschützten [MCP](https://modelcontextprotocol.io)-Server unter `http://127.0.0.1:39393/mcp` mit (nur localhost). So findet und analysiert jede KI dein neuestes Pack von selbst — „Analysiere das neueste CapturePack.“ ist der ganze Prompt.

```
claude mcp add --transport http capturepack http://127.0.0.1:39393/mcp
```

Tools, Client-Einrichtung und Einstellungen: [docs/MCP.md](docs/MCP.md).

## Status

Frühe Entwicklungsphase. Die Projektvision steht in [GOAL.md](GOAL.md), was als Nächstes kommt in [ROADMAP.md](ROADMAP.md).

## Sicherheit &amp; Signierung

Windows-Builds sind derzeit nicht signiert (SmartScreen warnt — *Weitere Informationen → Trotzdem ausführen*);
jedes Release liefert `SHA256SUMS.txt` zur Überprüfung, und ein Antrag auf OSS-Code-Signierung
läuft bereits. Details, Team-Rollen und Datenschutzpraxis: [docs/CODE_SIGNING.md](docs/CODE_SIGNING.md).

## ♥ Unterstützen

CapturePack ist kostenlos, Open Source und cloudfrei — keine Konten, keine Telemetrie, nichts zu verkaufen.
Wenn es dir Zeit spart, hält [**Sponsern auf GitHub**](https://github.com/sponsors/r2cuerdame) das Projekt in Bewegung.

## Lizenz

[MIT](LICENSE)
