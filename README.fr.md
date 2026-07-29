# capturepack

[English](README.md) · [한국어](README.ko.md) · [日本語](README.ja.md) · [中文](README.zh.md) · [Español](README.es.md) · **Français** · [Deutsch](README.de.md) · [Português](README.pt.md) · [Русский](README.ru.md)

[![Release](https://img.shields.io/github/v/release/r2cuerdame/capturepack?color=7c5cff&label=release)](https://github.com/r2cuerdame/capturepack/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/r2cuerdame/capturepack/total?color=7c5cff)](https://github.com/r2cuerdame/capturepack/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

## Remontez le bug. Choisissez l’objet. Donnez son état à l’IA.

**CapturePack transforme un replay continu — 30 secondes par défaut — en preuves structurées pour les humains et l’IA.**

Appuyez sur le raccourci après le problème, revenez à l’image concernée puis choisissez le
contrôle ou la fenêtre capturés. CapturePack conserve leur identité, leur position et leur
mouvement observés afin que l’IA n’ait pas à les déduire des seuls pixels.

🌐 **[capturepack.dev](https://capturepack.dev)** · [Télécharger](https://github.com/r2cuerdame/capturepack/releases/latest)

Version Windows publique actuelle : **CapturePack 0.3.0** · source/candidate : **0.3.1**

<p align="center">
  <img src="https://raw.githubusercontent.com/r2cuerdame/capturepack/main/site/assets/demo.svg?v=4" alt="CapturePack revient à une image passée, choisit un contrôle enfant, affiche son nom et son type capturés, suit le déplacement observé de sa fenêtre et exporte des preuves structurées pour l’IA." width="760">
</p>

## Fonctionnement

1. **Remontez** — avec l’enregistrement en direct activé par défaut, appuyez sur
   `Ctrl+Alt+C` après le bug. La durée est réglable de 1 à 60 secondes. Une fois
   l’enregistrement coupé, rien n’est enregistré.
2. **Choisissez** — Object Pick enregistre les limites observées, le nom accessible, le type
   du contrôle et l’instant choisi. Sans contrôle enfant, la vraie fenêtre sert de repli.
3. **Suivez le mouvement** — fenêtre et contrôle sont observés sur l’horloge du replay.
   Chaque échantillon nomme son écran : un pack multiécran rouvert conserve temps et
   coordonnées même lorsque l’objet change de moniteur.
4. **Transmettez le contexte** — partagez le dossier ou laissez une IA lire les packs déjà
   sauvegardés via le serveur MCP facultatif, local et en lecture seule.

### Sources du contexte objet

- **Windows UI Automation (intégré) :** nom accessible, type sémantique, AutomationId,
  identité processus/fenêtre et limites observées lorsque l’application les expose.
- **Chrome DOM (extension facultative en aperçu) :** sélecteur, rôle, texte et URL de
  l’élément explicitement choisi ; elle ne diffuse pas le DOM en continu.
- **Fenêtre HWND en repli :** faute de contrôle enfant, enregistre la vraie fenêtre et sa
  géométrie observée au lieu d’inventer un objet.

### Besoin d’une seule image ?

`Ctrl+Alt+S` ouvre la sélection de zone et permet de franchir les limites entre moniteurs.
**Capture plein écran** enregistre explicitement tous les écrans dans une seule image du
bureau virtuel. Elle s’ouvre dans le même éditeur à 100 % natif lorsque possible. Un pack
image ne contient ni vidéo ni `timeline.json` ; une zone ne conserve que ses pixels et sa
position, jamais un plein écran ou un autre moniteur cachés.

## Contenu du pack

```text
Pack vidéo                       Pack image
replay.mp4 ou replay.webm        snapshot.png
replay_annotated.webm (facultatif; si le manifest le déclare)
snapshot.png                     report.md · README.md · skills/
annotations.json · timeline.json plugins/ (facultatif)
plugins/ · manifest.json         manifest.json (capture_kind: image)
                                  sans replay ni chronologie
```

Objets et trajectoires sont des preuves facultatives : s’ils n’ont pas été observés, le pack
le dit sans inventer de contexte.

## MCP

Le serveur [MCP](https://modelcontextprotocol.io) facultatif et en lecture seule est activé
et démarré par défaut sur `http://127.0.0.1:39393/mcp`. Il peut être arrêté ou ne plus
démarrer automatiquement dans Réglages → MCP. Il lit uniquement les packs déjà enregistrés
et ne peut lancer aucune capture. Utilisez `capturepack_history`, `capturepack_open` ou
`capturepack_latest`. Voir [docs/MCP.md](docs/MCP.md).

## Réglages et diagnostics

- Réglages → Capture permet de modifier séparément les raccourcis vidéo
  (`Ctrl+Alt+C`) et image (`Ctrl+Alt+S`), la durée et la cadence de 1–30 fps.
- Informations → **Ouvrir le dossier des journaux** ouvre les diagnostics
  locaux. Ils ne sont jamais envoyés automatiquement.

## Confidentialité avant partage

Pixels, titres de fenêtres, noms accessibles et champs DOM peuvent contenir des informations
sensibles. CapturePack n’envoie ni captures, ni télémétrie, ni rapports de plantage. Sa seule
requête externe est la vérification facultative des mises à jour GitHub, désactivable.

Le flou est non destructif : il protège les vues annotées, mais `snapshot.png` et le replay
original du pack complet restent non caviardés. Vérifiez l’original et ne partagez pas le
pack complet s’il contient des informations privées.

## État, sécurité et licence

0.3.0 reste la version publique ; 0.3.1 est candidate jusqu’à sa présence dans
GitHub Releases. Le build n’est pas signé : SmartScreen peut avertir. Chaque
version fournit `SHA256SUMS.txt`.

Local d’abord · sans cloud · sans compte · sans télémétrie · [Licence MIT](LICENSE)
