# capturepack

[English](README.md) · [한국어](README.ko.md) · [日本語](README.ja.md) · [中文](README.zh.md) · [Español](README.es.md) · **Français** · [Deutsch](README.de.md) · [Português](README.pt.md) · [Русский](README.ru.md)

[![Release](https://img.shields.io/github/v/release/r2cuerdame/capturepack?color=7c5cff&label=release)](https://github.com/r2cuerdame/capturepack/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/r2cuerdame/capturepack/total?color=7c5cff)](https://github.com/r2cuerdame/capturepack/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![Sponsor](https://img.shields.io/badge/%E2%99%A5_Sponsor-ea4aaa)](https://github.com/sponsors/r2cuerdame)

## Remontez le bug. Marquez l’instant. Donnez son état à l’IA.

**CapturePack transforme un replay continu — 30 secondes par défaut — en preuves
structurées pour les humains et l’IA.**

Appuyez sur le raccourci après le problème et remontez jusqu’à l’image où il s’est
produit. Encadrez ce qui a cassé, écrivez ce que vous vouliez dire, enregistrez. Le
pack emporte le replay, la géométrie des fenêtres et des contrôles que le bureau a
enregistrée au fil du temps, et vos annotations — au lieu de laisser une IA tout
déduire des seuls pixels.

**Object Pick est une fonction de capture fixe.** Prenez une capture d’écran et vous
pourrez cliquer sur le vrai contrôle sous le curseur : CapturePack enregistre son
nom, son rôle, son AutomationId et son processus, et dans un navigateur toute la
page visible. Un replay ne peut pas offrir la même chose honnêtement — voir
[pourquoi](#pourquoi-object-pick-appartient-à-la-capture-fixe) — c’est pourquoi une
vidéo reçoit les cadres que vous dessinez.

Le pack enregistré correspond à ce que l’utilisateur a capturé : un pack vidéo réunit
le replay, les images, les annotations, le contexte objet et une chronologie
d’événements ; un pack image contient l’image fixe explicite, les annotations et le
contexte objet. Double-cliquez sur `viewer.html` pour examiner l’un ou l’autre hors
ligne, sans installer CapturePack ni démarrer de serveur. Le pack reste un dossier
local et ouvert, qui fonctionne sans IA, sans compte et sans service cloud.

🌐 **[capturepack.dev](https://capturepack.dev)** · [Télécharger](https://github.com/r2cuerdame/capturepack/releases/latest)

Version Windows publique actuelle : **CapturePack 0.3.4**. Object Pick appartient
désormais à l’image fixe, là où il peut être complet : une capture d’écran emporte
l’arbre UI Automation entier ainsi que la page visible de chaque fenêtre de
navigateur ouverte sur le bureau. Une vidéo, elle, garde le replay, la chronologie et
les cadres que vous dessinez.

<p align="center">
  <a href="https://capturepack.dev/">
    <img src="https://raw.githubusercontent.com/r2cuerdame/capturepack/main/site/assets/motion/fr/capturepack-time-machine-poster.webp" alt="CapturePack part de MAINTENANT à droite, déplace la tête de lecture vers la gauche jusqu’à 5 secondes plus tôt, encadre la défaillance qui a déjà disparu de l’écran, puis exporte des preuves structurées pour l’IA." width="760">
  </a>
</p>

Observez le sens de la marche : la tête de lecture part de **MAINTENANT, à droite**,
et se déplace **vers la gauche jusqu’à 5 secondes plus tôt**, là où la défaillance
déjà disparue de l’écran est encore présente et peut être marquée. Les mêmes preuves
sont enregistrées sous forme de données structurées pour l’IA.

## Fonctionnement

1. **Remontez** — tant que l’enregistrement en direct est actif (le réglage par
   défaut), appuyez sur `Ctrl+Alt+C` après le bug, puis parcourez le replay figé
   jusqu’à l’image où l’interface était fautive. La durée du replay est réglable de
   1 à 60 secondes.
2. **Marquez** — faites glisser un cadre avec le bouton droit sur ce qui a cassé et
   écrivez ce que vous vouliez dire. Le cadre a une durée de vie : il apparaît et
   disparaît avec l’instant qu’il explique.
3. **Ou prenez l’image fixe et choisissez l’objet** — appuyez sur le raccourci de
   capture d’écran : Object Pick met en évidence le vrai contrôle sous le curseur. Un
   clic enregistre son nom accessible, son type de contrôle, son AutomationId, son
   processus et ses limites observées ; à défaut de données de contrôle, la fenêtre
   reste le repli. Dans un navigateur, le pack conserve aussi la page elle-même :
   chaque élément que vous pouviez voir, avec son rôle, son rectangle et son texte.
   Ce que vous avez saisi, les champs de mot de passe et tout ce qui est masqué sont
   délibérément refusés, et la charge utile énumère ce qu’elle a laissé de côté, pour
   qu’un lecteur comprenne qu’un formulaire d’apparence vide est un caviardage.
4. **Transmettez un contexte structuré** — enregistrez le dossier pour un autre
   développeur, déposez-le dans ChatGPT, Claude, Codex, Cursor ou Gemini, ou laissez
   une IA connectée le lire via le serveur MCP intégré, en lecture seule.

### Pourquoi Object Pick appartient à la capture fixe

Non pas parce qu’un replay ne mériterait pas qu’on y sélectionne quelque chose, mais
parce qu’on ne peut y sélectionner qu’à *moitié*.

La géométrie des fenêtres coûte peu : CapturePack l’échantillonne une centaine de
fois par seconde et sait donc dire quelle fenêtre se trouvait où, à n’importe quelle
image. Parcourir les **contrôles** d’une fenêtre, en revanche, coûte cher — un seul
parcours des fenêtres Chromium d’un bureau ordinaire prend 326 ms, contre 13,9 ms
pour tout le reste réuni — si bien que le traqueur actif pendant un enregistrement se
limite à 3 % de CPU et les ignore. Résultat : une fonction qui proposait le bouton à
l’intérieur du navigateur à l’instant exact de la capture, et seulement la fenêtre du
navigateur une seconde avant ou après, sans rien à l’écran pour vous dire lequel des
deux vous teniez.

Une image fixe ne connaît pas cette coupure. C’est un instant unique, le parcours
complet s’y exécute et tous les contrôles du bureau sont disponibles. C’est donc là
que va la précision.

Une vidéo continue d’*enregistrer* ce qui était là : la géométrie des fenêtres et des
contrôles au fil du temps arrive bien dans la chronologie de contexte du pack, où une
IA peut la lire. Ce qu’elle ne fait plus, c’est vous inviter à cliquer dessus.

### Sources du contexte objet

- **Windows UI Automation (intégré) :** nom accessible du contrôle, type sémantique,
  AutomationId, identité processus/fenêtre et limites observées lorsque l’application
  les expose.
- **Chrome DOM (extension facultative, en aperçu) :** sélecteur, rôle, texte et URL
  de l’élément que vous choisissez explicitement — cliquez sur l’icône CapturePack
  dans la barre d’outils, puis sur l’élément. Cela fonctionne à l’intérieur des
  iframes, ne lit la page que pour cette sélection et ne diffuse pas le DOM en
  continu. Réglages › Plugins › Chrome DOM indique ce que le sélecteur a fait en
  dernier, de sorte qu’une sélection qui n’arrive pas explique pourquoi.
  **Cliquez une seule fois sur l’icône CapturePack et autorisez le navigateur.**
  Ensuite, vous n’appuyez plus sur rien dans Chrome : votre raccourci de capture
  habituel emporte la page visible avec lui. Cette autorisation unique existe parce
  que Chrome ne voit jamais un raccourci global — il ne confie une page à une
  extension que pour un clic effectué dans Chrome, ou à une extension que
  l’utilisateur a autorisée. Rien n’est retenu tant que vous n’avez pas donné cette
  autorisation (l’installation n’affiche aucun avertissement de permission), et
  `chrome://extensions` la retire à tout moment. Un pack écrit sans cette
  autorisation ne contient tout simplement aucune page, et le dit.
- **Fenêtre HWND en repli :** faute de contrôle enfant disponible, CapturePack
  enregistre malgré tout la vraie fenêtre et sa géométrie observée, au lieu
  d’inventer un contrôle.

### Besoin d’une seule image ?

Appuyez sur `Ctrl+Alt+S` pour ouvrir la capture de zone. Le tracé d’une zone est le
mode par défaut ; le bouton **Capture plein écran**, en haut, capture explicitement
l’intégralité du bureau virtuel — tous les moniteurs dans une seule image. Le
résultat s’ouvre dans le même éditeur de contexte à 100 % natif (ou à l’échelle prise
en charge la plus proche pour un bureau exceptionnellement grand) et peut être
déplacé, mais le pack est déclaré comme image et ne contient aucun fichier de replay.
Un pack de zone ne stocke que les pixels sélectionnés, plus les métadonnées de
placement du recadrage — il ne conserve ni plein écran ni second moniteur cachés.

## Pourquoi

- **Une capture d’écran conserve des pixels.** Vous perdez ce qui s’est passé avant
  l’image.
- **Une vidéo conserve le mouvement.** Vous perdez l’intention et la structure.
- **CapturePack conserve le contexte.** Le replay et la géométrie des fenêtres
  enregistrée pendant celui-ci, l’objet choisi dans une image fixe, les annotations
  et l’état réellement capturé.

## Remontez d’abord

Le bug a déjà eu lieu ? Si l’enregistrement en direct est actif (le réglage par
défaut), CapturePack garde le replay récent en mémoire. Appuyez sur `Ctrl+Alt+C`
*après* le problème, puis utilisez la molette de la souris pour **remonter le temps**
jusqu’à l’image où tout a cassé. Enregistrement en direct désactivé, rien n’est
enregistré, et le raccourci vous prévient que l’enregistrement est coupé.

## Ce que dit le contexte structuré

Une annotation faite sur une image fixe peut identifier bien plus qu’un rectangle.
Les annotations d’une vidéo, ce sont les cadres que vous avez dessinés, plus
l’instant que chacun explique :

- **Identité de la cible :** nom UIA, type de contrôle (son rôle sémantique),
  AutomationId, identité de processus ou de fenêtre lorsque l’application les expose ;
  une sélection Chrome DOM facultative peut à la place porter sélecteur, rôle, texte
  et URL.
- **État capturé dans le temps :** l’instant choisi, l’écran sur lequel il se
  trouvait et les limites observées à cet instant.
- **Preuves visuelles et narratives :** média d’origine, annotations modifiables,
  vues et rapports générés ; un pack vidéo y ajoute des images clés, une chronologie
  et la géométrie des fenêtres enregistrée pendant le replay.

Ce contexte se lit directement depuis le dossier brut. Une IA connectée peut aussi
passer par le **serveur MCP en lecture seule** de l’application et commencer par :
*« Analyse le dernier CapturePack. »*

## 🌍 Langues

CapturePack parle **9 langues** : English · 한국어 · 日本語 · 中文 · Español · Français · Deutsch · Português · Русский

- L’application suit automatiquement la **langue du système** — modifiable à tout moment dans Réglages → Général.
- Les documents générés dans le pack (`viewer.html`, `README.md`, `report.md`, `skills/`) peuvent suivre leur propre réglage de langue ; vos descriptions ne sont jamais traduites.
- [capturepack.dev](https://capturepack.dev) détecte lui aussi la langue de votre navigateur.

## Principes

Local d’abord · Hors ligne d’abord · Format ouvert · Architecture à plugins · Sans cloud · Sans compte · Sans base de données · Sans dépendance à l’IA · Sans enfermement propriétaire.

Les CapturePacks générés doivent rester lisibles pour toujours.

## Ce que contient un CapturePack

Le pack est un simple **dossier** — explorable, modifiable, honnête. Le ZIP
(`.capturepack`) n’est créé que lorsque vous voulez partager.

Un pack vidéo peut contenir :

```
CapturePack_2026-07-27_143052/
├── replay.mp4               # preuve d'origine (ou replay.webm en repli)
├── replay_annotated.webm    # vue dérivée facultative ; seulement si le manifest la déclare
├── snapshot.png             # l'image capturée (originale)
├── annotations.json         # la véritable source : cadres, durées de vie, numéros, flou
├── timeline.json            # packs vidéo : journal d'événements lisible par une machine
├── viewer.html              # vue hors ligne, à double-cliquer ; aucun serveur
├── report.md                # votre description, prête pour un LLM
├── manifest.json            # version du format, inventaire
├── README.md                # le premier document que lit un humain
├── skills/                  # contexte structuré pour l'IA (fonctionne sans MCP)
└── plugins/                 # métadonnées d'objet d'interface capturées, si disponibles
```

Un pack image est délibérément différent :

```
CapturePack_2026-07-27_143052/
├── snapshot.png             # la zone explicite ou le bureau virtuel complet
├── annotations.json         # annotations de l'image
├── viewer.html              # vue hors ligne, à double-cliquer ; aucun serveur
├── report.md · README.md
├── manifest.json            # capture_kind: image
├── skills/                  # contexte propre à l'image ; pas de skill de chronologie
└── plugins/                 # métadonnées d'objet facultatives
```

Un pack image enregistre `capture_kind: "image"` ainsi qu’une portée : zone ou plein
écran. Il n’a ni replay ni `timeline.json`. Une image de zone note en outre d’où
venait le recadrage, sans stocker le moindre pixel en dehors de celui-ci.
Les métadonnées d’objet sont elles aussi des preuves facultatives : si une
application n’expose aucun objet d’interface exploitable, le pack le dit au lieu de
fabriquer du contexte.

La spécification compte plus que n’importe quelle implémentation — n’importe quel langage peut générer des fichiers CapturePack. Voir [SPEC.md](SPEC.md).

## MCP — dialoguez avec vos captures

L’application inclut un serveur [MCP](https://modelcontextprotocol.io) facultatif, en
lecture seule, activé et démarré automatiquement par défaut sur
`http://127.0.0.1:39393/mcp` (localhost uniquement). Réglages → MCP permet de
l’arrêter immédiatement ou de désactiver son démarrage automatique. Il ne lit que les
CapturePacks déjà enregistrés par l’utilisateur et ne peut lancer aucune capture,
image ou vidéo.

Une IA peut appeler `capturepack_history` pour parcourir ou rechercher les
enregistrements image et vidéo, puis `capturepack_open` avec l’identifiant retenu ;
`capturepack_latest` reste le raccourci vers le pack le plus récent.

```
claude mcp add --transport http capturepack http://127.0.0.1:39393/mcp
```

Outils, configuration des clients et réglages : [docs/MCP.md](docs/MCP.md).

## Réglages et diagnostics

- Réglages → Capture configure indépendamment les raccourcis vidéo (`Ctrl+Alt+C`) et
  image (`Ctrl+Alt+S`), la durée du replay et la cadence de capture de 5 à 30 fps.
- À propos / Informations → **Ouvrir le dossier des journaux** ouvre les diagnostics
  d’exécution locaux, dont la taille est plafonnée. Les journaux ne sont jamais
  envoyés automatiquement.

## État

**0.3.4 est la version Windows publique actuellement téléchargeable.** CapturePack
reste un projet à un stade précoce : conservez le pack d’origine lorsque vous
signalez un problème, et consultez [GOAL.md](GOAL.md) pour la vision produit et
[ROADMAP.md](ROADMAP.md) pour la suite.

Limite connue : l’alignement des PTS vidéo/contexte par écran est encore en cours de
mesure dans l’[issue #89](https://github.com/r2cuerdame/capturepack/issues/89).
CapturePack enregistre une preuve de timing ambiguë plutôt que de la masquer derrière
un décalage global codé en dur.

## Documentation

- [Index de la documentation](docs/README.md) — le meilleur point d’entrée pour
  l’ingénierie, les intégrations, la QA, les publications, les schémas et les
  documents historiques.
- [Spécification du pack](SPEC.md) et [architecture](ARCHITECTURE.md) — le contrat de
  format ouvert et les limites de l’implémentation actuelle.
- [QA de publication](docs/QA.md), [passation en cours](docs/HANDOFF.md) et
  [processus de publication](docs/RELEASING.md) — comment les changements sont
  vérifiés, transmis et publiés.
- [MCP](docs/MCP.md) et [API du fournisseur temporel](docs/temporal-provider-api.md)
  — accès en lecture seule aux packs enregistrés et intégration des fournisseurs de
  contexte.

CapturePack `0.3.4` est la version de l’application. Le `format_version` des packs
évolue indépendamment, par ajouts successifs au format ; les lecteurs doivent suivre
[SPEC.md](SPEC.md) plutôt que déduire la prise en charge du format de la version de
l’application.

## Sécurité et signature

Les builds Windows ne sont pour l’instant pas signés (SmartScreen affichera un avertissement — *Informations complémentaires → Exécuter quand même*) ;
chaque version fournit `SHA256SUMS.txt` pour vérification, et une demande de certificat
de signature de code open source est en cours. Détails, rôles de l’équipe et pratiques de confidentialité : [docs/CODE_SIGNING.md](docs/CODE_SIGNING.md).

## Confidentialité avant partage

Les pixels de l’écran, les titres de fenêtres et les noms accessibles — ainsi que le
sélecteur, le rôle, le texte et l’URL lorsque Chrome DOM est utilisé — peuvent être
sensibles. CapturePack conserve les captures et le contexte objet sur cette machine
et n’envoie aucune capture, aucune télémétrie ni aucun rapport de plantage. Sa seule
requête sortante est la vérification facultative des mises à jour via GitHub
Releases, désactivable dans Réglages → Général.

Le flou est non destructif : il protège les vues annotées générées, mais
`snapshot.png` et le replay original contenus dans le pack complet restent non
caviardés. Vérifiez un pack avant de le partager, et ne partagez pas le pack complet
lorsque son média d’origine contient des informations qui doivent rester privées.

## ♥ Soutien

CapturePack est gratuit, open source et sans cloud — aucun compte, aucune télémétrie, rien à vendre.
S’il vous fait gagner du temps, [**un parrainage sur GitHub**](https://github.com/sponsors/r2cuerdame) l’aide à avancer.

## Licence

[MIT](LICENSE)
