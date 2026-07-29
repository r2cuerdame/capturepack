# capturepack

[English](README.md) · [한국어](README.ko.md) · [日本語](README.ja.md) · [中文](README.zh.md) · **Español** · [Français](README.fr.md) · [Deutsch](README.de.md) · [Português](README.pt.md) · [Русский](README.ru.md)

[![Release](https://img.shields.io/github/v/release/r2cuerdame/capturepack?color=7c5cff&label=release)](https://github.com/r2cuerdame/capturepack/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/r2cuerdame/capturepack/total?color=7c5cff)](https://github.com/r2cuerdame/capturepack/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

## Rebobina el fallo. Selecciona el objeto. Entrega su estado a la IA.

**CapturePack convierte una repetición continua —30 segundos por defecto— en evidencia estructurada para personas e IA.**

Pulsa el atajo después del fallo, vuelve al fotograma donde ocurrió y selecciona el control o
la ventana capturados. CapturePack conserva la identidad, posición y movimiento observados para
que una IA no tenga que inferirlos solo a partir de píxeles.

🌐 **[capturepack.dev](https://capturepack.dev)** · [Descargar](https://github.com/r2cuerdame/capturepack/releases/latest)

Versión actual para Windows: **CapturePack 0.3.0**

<p align="center">
  <img src="https://raw.githubusercontent.com/r2cuerdame/capturepack/main/site/assets/demo.svg?v=4" alt="CapturePack vuelve a un fotograma pasado, selecciona un control hijo, muestra su nombre y tipo capturados, sigue el movimiento observado de su ventana y exporta evidencia estructurada para IA." width="760">
</p>

## Flujo de trabajo

1. **Rebobina** — con la grabación en vivo activada de forma predeterminada, pulsa
   `Ctrl+Alt+C` después del fallo. La duración es configurable entre 1 y 60 segundos.
   Si apagas la grabación, no se registra nada.
2. **Selecciona** — Object Pick registra límites observados, nombre accesible, tipo de control
   e instante elegido. Si no hay control hijo, usa la ventana real como alternativa.
3. **Sigue el movimiento** — ventana y control se observan en el reloj de la repetición.
   Cada muestra identifica su pantalla, por lo que un pack multimonitor reabierto conserva
   tiempo y coordenadas incluso al cruzar monitores.
4. **Entrega contexto** — comparte la carpeta o deja que una IA lea packs ya guardados mediante
   el servidor MCP opcional, local y de solo lectura.

### Fuentes de contexto

- **Windows UI Automation (integrado):** nombre accesible, tipo semántico, AutomationId,
  identidad de proceso/ventana y límites observados cuando la aplicación los expone.
- **Chrome DOM (extensión opcional en vista previa):** selector, rol, texto y URL del elemento
  elegido explícitamente; no transmite el DOM continuamente.
- **Ventana HWND como alternativa:** si no hay control hijo, registra la ventana real y su
  geometría observada en vez de inventar un objeto.

### ¿Solo necesitas una imagen?

`Ctrl+Alt+S` abre la selección de región y permite arrastrar sin cortes entre monitores.
**Capturar pantalla completa** guarda explícitamente todos los monitores en una sola imagen
del escritorio virtual. Se abre en el mismo editor al 100% nativo cuando es posible. Un pack
de imagen no contiene vídeo ni `timeline.json`; una región guarda solo sus píxeles y posición,
nunca una pantalla completa o un segundo monitor ocultos.

## Contenido del pack

```text
Pack de vídeo                     Pack de imagen
replay.mp4 o replay.webm          snapshot.png
replay_annotated.webm             annotations.json
snapshot.png                      report.md · README.md · skills/
annotations.json · timeline.json  plugins/ (opcional)
plugins/ · manifest.json          manifest.json (capture_kind: image)
                                  sin repetición ni cronología
```

Los objetos y trayectorias son evidencia opcional: si no se observaron, el pack lo dice y no
inventa contexto.

## MCP

El servidor [MCP](https://modelcontextprotocol.io) opcional y de solo lectura está activado
y se inicia por defecto en `http://127.0.0.1:39393/mcp`. Puede detenerse o desactivar su inicio
automático en Ajustes → MCP. Solo lee packs que el usuario ya guardó y no puede iniciar capturas.
Usa `capturepack_history`, `capturepack_open` o el atajo `capturepack_latest`.
Consulta [docs/MCP.md](docs/MCP.md).

## Privacidad antes de compartir

Los píxeles, títulos de ventana, nombres accesibles y los campos DOM pueden contener datos
sensibles. CapturePack no sube capturas, telemetría ni informes de fallos. Su única solicitud
externa es la comprobación opcional de actualizaciones de GitHub, que puede desactivarse.

El desenfoque no es destructivo: protege las vistas anotadas, pero `snapshot.png` y la
repetición original del pack completo siguen sin censurar. Revisa el original y no compartas
el pack completo si contiene información privada.

## Estado, seguridad y licencia

0.3.0 es una versión temprana para Windows. La compilación aún no está firmada, por lo que
SmartScreen puede avisar; cada versión incluye `SHA256SUMS.txt`.

Local primero · sin nube · sin cuenta · sin telemetría · [Licencia MIT](LICENSE)
