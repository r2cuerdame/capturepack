# capturepack

[English](README.md) · [한국어](README.ko.md) · [日本語](README.ja.md) · [中文](README.zh.md) · [Español](README.es.md) · **Français** · [Deutsch](README.de.md) · [Português](README.pt.md) · [Русский](README.ru.md)

[![Release](https://img.shields.io/github/v/release/r2cuerdame/capturepack?color=7c5cff&label=release)](https://github.com/r2cuerdame/capturepack/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/r2cuerdame/capturepack/total?color=7c5cff)](https://github.com/r2cuerdame/capturepack/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![Sponsor](https://img.shields.io/badge/%E2%99%A5_Sponsor-ea4aaa)](https://github.com/sponsors/r2cuerdame)

## Pouvez-vous expliquer un bug en moins de 5 secondes ?

**CapturePack est le moyen le plus rapide d’expliquer quelque chose à un LLM.**

> Capturez le contexte, pas des captures d’écran.
>
> De meilleures entrées. De meilleures réponses.

CapturePack est un format et une boîte à outils open source de capture de contexte, qui aident les humains et l’IA à comprendre les problèmes visuels au-delà des captures d’écran et des enregistrements vidéo.

🌐 **[capturepack.dev](https://capturepack.dev)** · [Télécharger](https://github.com/r2cuerdame/capturepack/releases/latest)

<p align="center">
  <!-- Absolute raw URL with a version query: GitHub proxies README images through
       camo, which caches by source URL — without the bump a fixed demo keeps
       rendering the stale copy for hours. Bump ?v= whenever demo.svg changes. -->
  <img src="https://raw.githubusercontent.com/r2cuerdame/capturepack/main/site/assets/demo.svg?v=2" alt="Démo : appuyez sur Ctrl+Alt+C, les 30 dernières secondes se figent, la molette fait défiler le temps, glissez pour sélectionner l’objet, écrivez l’annotation, et le CapturePack est enregistré." width="760">
</p>

Un **dossier** CapturePack rassemble tout ce qu’une capture d’écran ne peut pas contenir : les 30 dernières secondes de replay, un instantané, des annotations modifiables, une chronologie d’événements lisible par une machine, et des rapports lisibles aussi bien par un humain que par une IA — tout ce qu’il faut à un autre développeur ou à n’importe quel LLM pour comprendre la situation immédiatement. Au moment de partager, empaquetez le dossier en un seul fichier `.capturepack`.

## Le flux en 5 secondes

```
Ctrl+Alt+C  →  capture  →  5-second annotation  →  save  →  drop into
                                                              ChatGPT / Claude / Codex / Cursor / Gemini
                                                              or send to another developer
```

## Pourquoi

- **Les captures d’écran conservent les pixels.** Vous perdez ce qui s’est passé avant l’image.
- **Les vidéos conservent le mouvement.** Vous perdez l’intention et la structure.
- **CapturePack conserve le contexte.** Le temps, l’espace, l’intention, l’environnement.

## 🕰 Une machine à remonter le temps

Le bug est déjà passé ? CapturePack **enregistrait déjà**. Appuyez sur `Ctrl+Alt+C`
*après* que ça a déraillé — les 30 dernières secondes se figent, et la molette vous fait
**remonter le temps** jusqu’à l’image exacte où tout a cassé. Annotez ce moment-là,
pas une reconstitution.

## 🤖 Conçu pour les LLM

Un CapturePack, c’est une entrée qu’une IA comprend vraiment :

- Déposez le pack dans **ChatGPT, Claude, Codex, Cursor, Gemini** — le rapport généré
  et les fichiers de contexte expliquent la situation sans le moindre prompt en plus.
- Ou n’attachez rien du tout : l’app fait tourner un **serveur MCP**, alors une IA connectée
  entend simplement *« Analyse le dernier CapturePack »* et le lit toute seule.

De meilleures entrées. De meilleures réponses.

## 🌍 Langues

CapturePack parle **9 langues** : English · 한국어 · 日本語 · 中文 · Español · Français · Deutsch · Português · Русский

- L’app suit automatiquement la **langue de votre système** — changez-la à tout moment dans Paramètres → Général.
- Les documents générés dans le pack (`README.md`, `report.md`, `skills/`) peuvent suivre leur propre réglage de langue ; vos descriptions à vous ne sont jamais traduites.
- [capturepack.dev](https://capturepack.dev) détecte aussi automatiquement la langue de votre navigateur.

## Principes

Local d’abord · Hors ligne d’abord · Format ouvert · Basé sur des plugins · Sans cloud · Sans compte · Sans base de données · Sans dépendance à l’IA · Sans enfermement propriétaire.

Les CapturePacks générés doivent rester lisibles pour toujours.

## Ce que contient un CapturePack

Le pack est un simple **dossier** — explorable, modifiable, honnête. Le ZIP (`.capturepack`)
n’est créé que lorsque vous voulez partager.

```
CapturePack_2026-07-27_143052/
├── replay.webm              # preuve d’origine — jamais modifiée
├── replay_annotated.webm    # annotations incrustées ; se lit dans n’importe quel lecteur
├── snapshot.png             # l’image capturée (originale)
├── annotations.json         # la vraie source : cadres, durées, numéros, flou
├── timeline.json            # journal d’événements lisible par une machine
├── report.md                # votre description, prête pour un LLM
├── manifest.json            # version du format, inventaire
├── README.md                # le premier document que lit un humain
├── skills/                  # contexte structuré pour l’IA (fonctionne sans MCP)
└── plugins/                 # métadonnées structurées venues des intégrations
```

Un pack réduit à une capture d’écran — `manifest.json` + `snapshot.png`, rien d’autre — reste parfaitement valide.

La spécification compte plus que n’importe quelle implémentation — n’importe quel langage peut générer des fichiers CapturePack. Voir [SPEC.md](SPEC.md).

## MCP — parlez à vos captures

L’app embarque un serveur [MCP](https://modelcontextprotocol.io) toujours actif et en lecture seule sur `http://127.0.0.1:39393/mcp` (localhost uniquement) : n’importe quelle IA peut ainsi trouver et analyser votre dernier pack toute seule — « Analyse le dernier CapturePack », c’est tout le prompt.

```
claude mcp add --transport http capturepack http://127.0.0.1:39393/mcp
```

Outils, configuration des clients et paramètres : [docs/MCP.md](docs/MCP.md).

## État

Tout début du développement. Voir [GOAL.md](GOAL.md) pour la vision du projet et [ROADMAP.md](ROADMAP.md) pour la suite.

## Sécurité &amp; signature

Les builds Windows ne sont pas encore signés (SmartScreen affichera un avertissement — *Informations complémentaires → Exécuter quand même*) ;
chaque version publie `SHA256SUMS.txt` pour vérification, et une demande de certificat de signature
de code pour l’open source est en cours. Détails, rôles de l’équipe et pratiques de confidentialité : [docs/CODE_SIGNING.md](docs/CODE_SIGNING.md).

## ♥ Soutenir

CapturePack est gratuit, open source et sans cloud — pas de compte, pas de télémétrie, rien à vendre.
S’il vous fait gagner du temps, [**le sponsoriser sur GitHub**](https://github.com/sponsors/r2cuerdame) le fait avancer.

## Licence

[MIT](LICENSE)
