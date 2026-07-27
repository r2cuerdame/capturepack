# capturepack

[English](README.md) · [한국어](README.ko.md) · [日本語](README.ja.md) · [中文](README.zh.md) · **Español** · [Français](README.fr.md) · [Deutsch](README.de.md) · [Português](README.pt.md) · [Русский](README.ru.md)

[![Release](https://img.shields.io/github/v/release/r2cuerdame/capturepack?color=7c5cff&label=release)](https://github.com/r2cuerdame/capturepack/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/r2cuerdame/capturepack/total?color=7c5cff)](https://github.com/r2cuerdame/capturepack/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![Sponsor](https://img.shields.io/badge/%E2%99%A5_Sponsor-ea4aaa)](https://github.com/sponsors/r2cuerdame)

## ¿Puedes explicar un bug en menos de 5 segundos?

**CapturePack es la forma más rápida de explicarle algo a un LLM.**

> Captura contexto, no capturas de pantalla.
>
> Mejor entrada. Mejores respuestas.

CapturePack es un formato abierto de captura de contexto —y las herramientas para usarlo— que ayuda a humanos y a la IA a entender problemas visuales más allá de lo que muestran las capturas de pantalla y las grabaciones.

🌐 **[capturepack.dev](https://capturepack.dev)** · [Descargar](https://github.com/r2cuerdame/capturepack/releases/latest)

<p align="center">
  <!-- Absolute raw URL with a version query: GitHub proxies README images through
       camo, which caches by source URL — without the bump a fixed demo keeps
       rendering the stale copy for hours. Bump ?v= whenever demo.svg changes. -->
  <img src="https://raw.githubusercontent.com/r2cuerdame/capturepack/main/site/assets/demo.svg?v=2" alt="Demo: pulsa Ctrl+Alt+C, los últimos 30 segundos se congelan, la rueda del ratón recorre el tiempo, arrastra para seleccionar el objeto, escribe la anotación y el CapturePack queda guardado." width="760">
</p>

Una **carpeta** CapturePack reúne lo que una captura de pantalla no puede: los últimos 30 segundos de replay, el fotograma capturado, anotaciones editables, una cronología de eventos legible por máquinas e informes legibles por humanos y por IA — todo lo que otro desarrollador o cualquier LLM necesita para entender la situación al instante. Cuando quieras compartirla, empaqueta la carpeta en un único archivo `.capturepack`.

## El flujo de 5 segundos

```
Ctrl+Alt+C  →  capture  →  5-second annotation  →  save  →  drop into
                                                              ChatGPT / Claude / Codex / Cursor / Gemini
                                                              or send to another developer
```

## Por qué

- **Las capturas de pantalla conservan píxeles.** Pierdes todo lo que pasó antes de ese fotograma.
- **Los vídeos conservan el movimiento.** Pierdes la intención y la estructura.
- **CapturePack conserva el contexto.** Tiempo, espacio, intención, entorno.

## 🕰 Es una máquina del tiempo

¿El bug ya ocurrió? CapturePack **ya estaba grabando**. Pulsa `Ctrl+Alt+C`
*después* de que algo falle: los últimos 30 segundos quedan congelados y la rueda
del ratón te lleva **atrás en el tiempo** hasta el fotograma exacto en el que se
rompió. Anota ese instante, no una recreación.

## 🤖 Hecho para LLMs

Un CapturePack es una entrada que la IA entiende de verdad:

- Suelta el pack en **ChatGPT, Claude, Codex, Cursor o Gemini**: el informe generado
  y los archivos de contexto explican la situación sin escribir ni un prompt más.
- O no adjuntes nada: la app levanta un **servidor MCP**, así que a una IA conectada
  le basta con oír *«Analiza el último CapturePack»* para leerlo por su cuenta.

Mejor entrada. Mejores respuestas.

## 🌍 Idiomas

CapturePack habla **9 idiomas**: English · 한국어 · 日本語 · 中文 · Español · Français · Deutsch · Português · Русский

- La app sigue automáticamente el **idioma de tu sistema**: cámbialo cuando quieras en Ajustes → General.
- Los documentos generados del pack (`README.md`, `report.md`, `skills/`) pueden tener su propio idioma; tus descripciones nunca se traducen.
- [capturepack.dev](https://capturepack.dev) también detecta el idioma de tu navegador.

## Principios

Local primero · Offline primero · Formato abierto · Basado en plugins · Sin nube · Sin inicio de sesión · Sin base de datos · Sin dependencia de la IA · Sin ataduras a ningún proveedor.

Los CapturePacks generados deben seguir siendo legibles para siempre.

## Qué hay dentro de un CapturePack

El pack es una **carpeta** normal y corriente: explorable, editable, honesta. El ZIP
(`.capturepack`) solo se crea cuando quieres compartir.

```
CapturePack_2026-07-27_143052/
├── replay.webm              # evidencia original — nunca se modifica
├── replay_annotated.webm    # anotaciones incrustadas; se ve en cualquier reproductor
├── snapshot.png             # el fotograma capturado (original)
├── annotations.json         # la fuente real: cajas, duraciones, números, desenfoque
├── timeline.json            # registro de eventos legible por máquinas
├── report.md                # tu descripción, lista para un LLM
├── manifest.json            # versión del formato, inventario
├── README.md                # el primer documento que lee un humano
├── skills/                  # contexto estructurado para la IA (funciona sin MCP)
└── plugins/                 # metadatos estructurados de las integraciones
```

Un pack de solo captura —`manifest.json` + `snapshot.png`, nada más— es totalmente válido.

La especificación importa más que cualquier implementación: cualquier lenguaje puede generar archivos CapturePack. Consulta [SPEC.md](SPEC.md).

## MCP — habla con tus capturas

La app incluye un servidor [MCP](https://modelcontextprotocol.io) de solo lectura y siempre activo en `http://127.0.0.1:39393/mcp` (solo localhost), para que cualquier IA encuentre y analice tu último pack por su cuenta: «Analiza el último CapturePack» es todo el prompt.

```
claude mcp add --transport http capturepack http://127.0.0.1:39393/mcp
```

Herramientas, configuración del cliente y ajustes: [docs/MCP.md](docs/MCP.md).

## Estado

En desarrollo temprano. Consulta [GOAL.md](GOAL.md) para conocer la visión del proyecto y [ROADMAP.md](ROADMAP.md) para ver lo que viene.

## Seguridad y firma

Las compilaciones de Windows aún no están firmadas (SmartScreen te avisará — *Más información → Ejecutar de todas formas*);
cada versión incluye `SHA256SUMS.txt` para verificarla, y hay una solicitud de firma de código
para proyectos OSS en trámite. Detalles, roles del equipo y prácticas de privacidad: [docs/CODE_SIGNING.md](docs/CODE_SIGNING.md).

## ♥ Apoya el proyecto

CapturePack es gratis, open source y sin nube: sin cuentas, sin telemetría, nada que vender.
Si te ahorra tiempo, [**patrocinarlo en GitHub**](https://github.com/sponsors/r2cuerdame) hace que siga avanzando.

## Licencia

[MIT](LICENSE)
