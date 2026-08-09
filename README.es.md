# capturepack

[English](README.md) · [한국어](README.ko.md) · [日本語](README.ja.md) · [中文](README.zh.md) · **Español** · [Français](README.fr.md) · [Deutsch](README.de.md) · [Português](README.pt.md) · [Русский](README.ru.md)

[![Release](https://img.shields.io/github/v/release/r2cuerdame/capturepack?color=7c5cff&label=release)](https://github.com/r2cuerdame/capturepack/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/r2cuerdame/capturepack/total?color=7c5cff)](https://github.com/r2cuerdame/capturepack/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![Sponsor](https://img.shields.io/badge/%E2%99%A5_Sponsor-ea4aaa)](https://github.com/sponsors/r2cuerdame)

## Rebobina el fallo. Marca el instante. Entrega el estado a la IA.

**CapturePack convierte una repetición continua —30 segundos por defecto— en
evidencia estructurada para personas e IA.**

Pulsa el atajo cuando algo salga mal y rebobina hasta el fotograma en el que
ocurrió. Encuadra lo que falló, escribe lo que querías decir y guarda. El pack
lleva la repetición, la geometría de ventanas y controles que el escritorio
registró a lo largo del tiempo y tus anotaciones, en vez de dejar que una IA lo
deduzca todo a partir de los píxeles.

**Object Pick es una función de la imagen fija.** Haz una captura de pantalla y
podrás hacer clic en el control real que hay bajo el cursor: CapturePack registra
su nombre, su rol, su AutomationId y su proceso, y en un navegador toda la página
visible. Una repetición no puede ofrecer lo mismo con honestidad —consulta
[por qué](#por-qué-la-selección-de-objetos-pertenece-a-la-imagen-fija)—, así que
un vídeo se queda con los recuadros que dibujas.

El pack guardado se corresponde con lo que el usuario capturó: un pack de vídeo
reúne la repetición, los fotogramas, las anotaciones, el contexto de objetos y
una cronología de eventos; un pack de imagen contiene la imagen fija explícita,
las anotaciones y el contexto de objetos. Haz doble clic en `viewer.html` para
revisar cualquiera de los dos sin conexión, sin instalar CapturePack ni levantar
un servidor. Sigue siendo una carpeta local y abierta que funciona sin IA, sin
cuenta y sin servicios en la nube.

🌐 **[capturepack.dev](https://capturepack.dev)** · [Descargar](https://github.com/r2cuerdame/capturepack/releases/latest)

Versión pública actual para Windows: **CapturePack 0.4.2**. Ahora se puede
volver a leer la página del navegador que guarda un pack —al reabrir una
captura no se recuperaba nada— y lo que ofrece la selección de objetos se
mide, ya no se supone.

<p align="center">
  <a href="https://capturepack.dev/">
    <img src="https://raw.githubusercontent.com/r2cuerdame/capturepack/main/site/assets/motion/es/capturepack-time-machine-poster.webp" alt="CapturePack parte de AHORA a la derecha, mueve el cabezal hacia la izquierda hasta 5 segundos atrás, encuadra el fallo que ya ha desaparecido de la pantalla y exporta evidencia estructurada para la IA." width="760">
  </a>
</p>

Fíjate en la dirección: el cabezal parte de **AHORA, a la derecha**, y viaja
**hacia la izquierda, hasta 5 segundos atrás**, donde el fallo que ya ha
desaparecido de la pantalla sigue estando ahí para poder marcarlo. Esa misma
evidencia se guarda como datos estructurados para la IA.

## Flujo de trabajo

1. **Rebobina** — con la grabación en vivo activada (lo predeterminado), pulsa
   `Ctrl+Alt+C` después del fallo y recorre la repetición congelada hasta el
   fotograma en el que la interfaz estaba mal. La duración de la repetición se
   configura entre 1 y 60 segundos.
2. **Márcalo** — arrastra con el botón derecho un recuadro sobre lo que falló y
   escribe lo que querías decir. El recuadro tiene una duración propia, así que
   aparece y desaparece con el instante que explica.
3. **O captura la imagen fija y selecciona el objeto** — pulsa el atajo de
   captura de pantalla y Object Pick resaltará el control real que hay bajo el
   cursor. Un clic registra su nombre accesible, su tipo de control, su
   AutomationId, su proceso y los límites observados; cuando no hay datos del
   control, la ventana sigue siendo la alternativa. En un navegador el pack
   conserva además la propia página: todos los elementos que podías ver, con su
   rol, su rectángulo y su texto. Lo que hayas escrito, los campos de contraseña
   y cualquier cosa oculta se descartan a propósito, y el contenido enumera lo
   que dejó fuera para que quien lo lea sepa que un formulario aparentemente
   vacío es una redacción.
4. **Entrega contexto estructurado** — guarda la carpeta para otro
   desarrollador, suéltala en ChatGPT, Claude, Codex, Cursor o Gemini, o deja
   que una IA conectada la lea a través del servidor MCP integrado y de solo
   lectura.

### Por qué la selección de objetos pertenece a la imagen fija

No porque no merezca la pena seleccionar dentro de una repetición, sino porque
allí solo se puede seleccionar *a medias*.

La geometría de las ventanas es barata: CapturePack la muestrea alrededor de cien
veces por segundo, así que puede decirte qué ventana estaba dónde en cualquier
fotograma. Recorrer los **controles** de una ventana no es barato —un solo
recorrido de las ventanas de Chromium en un escritorio normal cuesta 326 ms
frente a los 13,9 ms de todo lo demás junto—, así que el rastreador que se
ejecuta durante una grabación se autorregula para no pasar del 3 % de CPU y los
omite. El resultado era una función que ofrecía el botón dentro del navegador en
el instante exacto de la captura, y solo la ventana del navegador un segundo
antes o después, sin nada en pantalla que te dijera cuál de las dos cosas tenías.

Una imagen fija no tiene esa división. Es un único instante, sobre él se ejecuta
el recorrido completo y todos los controles del escritorio están disponibles. Así
que ahí es donde va la precisión.

Un vídeo sigue *registrando* lo que había: la geometría de ventanas y controles a
lo largo del tiempo llega a la cronología de contexto del pack para que una IA la
lea. Lo que ya no hace es invitarte a hacer clic en ella.

### De dónde sale el contexto de objetos

- **Windows UI Automation (integrado):** nombre accesible del control, tipo
  semántico, AutomationId, identidad de proceso y de ventana, y los límites
  observados cuando la aplicación los expone.
- **Chrome DOM (extensión opcional en vista previa):** selector, rol, texto y URL
  del elemento que eliges explícitamente: haz clic en el icono de CapturePack de
  la barra de herramientas y después en el elemento. Funciona dentro de iframes,
  lee la página solo para esa selección y no transmite el DOM de forma continua.
  Ajustes › Plugins › Chrome DOM informa de lo último que hizo el selector, de
  modo que una selección que no llega explica por qué.
  **Haz clic una vez en el icono de CapturePack y concede el permiso en el
  navegador.** A partir de ahí no tienes que pulsar nada en Chrome: tu atajo de
  captura habitual se trae consigo la página visible. Ese permiso único existe
  porque Chrome nunca ve un atajo global: solo entrega una página a una extensión
  cuando el clic se hace dentro de Chrome, o cuando el usuario ha autorizado esa
  extensión. No se retiene nada hasta que lo autorizas (la instalación no muestra
  ningún aviso de permisos) y `chrome://extensions` lo revoca en cualquier
  momento. Un pack escrito sin ese permiso simplemente no lleva página, y lo dice.
- **Ventana HWND como alternativa:** cuando no hay ningún control hijo
  disponible, CapturePack registra igualmente la ventana real y su geometría
  observada en vez de inventarse un control.

### ¿Solo necesitas un fotograma?

Pulsa `Ctrl+Alt+S` para abrir la captura de región. Arrastrar una región es lo
predeterminado; el botón **Capturar pantalla completa** de la parte superior
captura explícitamente todo el escritorio virtual: todos los monitores en una
sola imagen. El resultado se abre en el mismo editor de contexto al 100 % nativo
(o a la escala admitida más cercana si el escritorio es excepcionalmente grande)
y se puede desplazar, pero el pack se declara como imagen y no contiene ningún
archivo de repetición. Un pack de región guarda solo los píxeles seleccionados
más los metadatos de posición del recorte: no conserva una pantalla completa ni
un segundo monitor ocultos.

## Por qué

- **Las capturas de pantalla conservan píxeles.** Pierdes lo que pasó antes del
  fotograma.
- **Los vídeos conservan el movimiento.** Pierdes la intención y la estructura.
- **CapturePack conserva el contexto.** La repetición y la geometría de ventanas
  registrada a lo largo de ella, el objeto seleccionado en una imagen fija, las
  anotaciones y el estado que se capturó de verdad.

## Rebobinar primero

¿El fallo ya ha ocurrido? Si la grabación en vivo está activada (lo
predeterminado), CapturePack ya tiene la repetición reciente lista en memoria.
Pulsa `Ctrl+Alt+C` *después* de que algo salga mal y usa la rueda del ratón para
retroceder **en el tiempo** hasta el fotograma en el que se rompió. Si desactivas
la grabación en vivo no se registra nada, y el atajo te avisa de que la grabación
está apagada.

## Qué dice el contexto estructurado

Una anotación hecha sobre una imagen fija puede identificar algo más que un
rectángulo. Las anotaciones de un vídeo son los recuadros que dibujaste, más el
instante que explica cada uno:

- **Identidad del objetivo:** nombre UIA, tipo de control (el rol semántico del
  control), AutomationId e identidad de proceso o de ventana cuando la aplicación
  los expone; una selección opcional de Chrome DOM puede aportar en su lugar
  selector, rol, texto y URL.
- **Estado capturado en el tiempo:** el instante seleccionado, la pantalla en la
  que estaba y los límites observados en ese instante.
- **Evidencia visual y narrativa:** medios originales, anotaciones editables,
  vistas e informes generados; un pack de vídeo añade fotogramas clave, una
  cronología y la geometría de ventanas registrada a lo largo de ella.

Ese contexto se puede leer directamente desde la carpeta. Una IA conectada
también puede usar el **servidor MCP de solo lectura** de la aplicación y empezar
con: *«Analiza el último CapturePack»*.

## 🌍 Idiomas

CapturePack habla **9 idiomas**: English · 한국어 · 日本語 · 中文 · Español · Français · Deutsch · Português · Русский

- La aplicación sigue automáticamente el **idioma del sistema**; puedes cambiarlo cuando quieras en Ajustes → General.
- Los documentos generados dentro del pack (`viewer.html`, `README.md`, `report.md`, `skills/`) pueden seguir su propia configuración de idioma; tus descripciones nunca se traducen.
- [capturepack.dev](https://capturepack.dev) también detecta el idioma de tu navegador.

## Principios

Local primero · Sin conexión primero · Formato abierto · Basado en plugins · Sin nube · Sin inicio de sesión · Sin base de datos · Sin dependencia de IA · Sin dependencia de proveedor.

Los CapturePacks generados deben seguir siendo legibles para siempre.

## Qué hay dentro de un CapturePack

El pack es una **carpeta** normal y corriente: se puede explorar, se puede editar
y es honesta. El ZIP (`.capturepack`) solo se crea cuando quieres compartirlo.

Un pack de vídeo puede contener:

```
CapturePack_2026-07-27_143052/
├── replay.mp4               # evidencia original (o replay.webm como alternativa)
├── replay_annotated.webm    # vista derivada opcional; solo si el manifest la declara
├── snapshot.png             # el fotograma capturado (original)
├── annotations.json         # la fuente real: recuadros, duraciones, números, desenfoque
├── timeline.json            # packs de vídeo: registro de eventos legible por máquina
├── viewer.html              # vista sin conexión con doble clic; sin servidor
├── report.md                # tu descripción, lista para un LLM
├── manifest.json            # versión del formato, inventario
├── README.md                # el primer documento que lee una persona
├── skills/                  # contexto estructurado para IA (funciona sin MCP)
└── plugins/                 # metadatos de objetos de UI capturados, cuando existen
```

Los packs de imagen son deliberadamente distintos:

```
CapturePack_2026-07-27_143052/
├── snapshot.png             # la región explícita o todo el escritorio virtual
├── annotations.json         # anotaciones de la imagen
├── viewer.html              # vista sin conexión con doble clic; sin servidor
├── report.md · README.md
├── manifest.json            # capture_kind: image
├── skills/                  # contexto propio de la imagen; sin skill de cronología
└── plugins/                 # metadatos de objeto opcionales
```

Un pack de imagen registra `capture_kind: "image"` y un ámbito de región o de
pantalla completa. No tiene repetición ni `timeline.json`. Una imagen de región
registra además de dónde salió el recorte, sin guardar píxeles fuera de él.
Los metadatos de objeto también son evidencia opcional: si una aplicación no
expone un objeto de UI utilizable, el pack lo dice en vez de fabricar contexto.

La especificación importa más que cualquier implementación: cualquier lenguaje puede generar archivos CapturePack. Consulta [SPEC.md](SPEC.md).

## MCP — habla con tus capturas

La aplicación incluye un servidor [MCP](https://modelcontextprotocol.io)
opcional y de solo lectura, activado e iniciado automáticamente por defecto en
`http://127.0.0.1:39393/mcp` (solo en localhost). Ajustes → MCP puede detenerlo
al instante o desactivar su arranque automático. Solo lee los CapturePacks que el
usuario ya ha guardado y no puede iniciar una captura de imagen ni de vídeo.

Una IA puede llamar a `capturepack_history` para explorar o buscar registros de
imagen y de vídeo, y después a `capturepack_open` con el id elegido;
`capturepack_latest` sigue siendo el atajo para el pack más reciente.

```
claude mcp add --transport http capturepack http://127.0.0.1:39393/mcp
```

Herramientas, configuración del cliente y ajustes: [docs/MCP.md](docs/MCP.md).

## Ajustes y diagnóstico

- Ajustes → Captura configura por separado los atajos de vídeo (`Ctrl+Alt+C`) e
  imagen (`Ctrl+Alt+S`), la duración de la repetición y la tasa de captura de
  5 a 30 fps.
- Acerca de / Información → **Abrir carpeta de registros** abre los diagnósticos
  locales de ejecución, con tamaño limitado. Los registros nunca se suben
  automáticamente.

## Estado

**0.4.2 es la descarga pública actual para Windows.** CapturePack sigue siendo un
proyecto en fase temprana, así que conserva el pack original cuando informes de
un problema y consulta [GOAL.md](GOAL.md) para la visión del producto y
[ROADMAP.md](ROADMAP.md) para lo que viene después.

Limitación conocida: la alineación de PTS entre vídeo y contexto por pantalla
sigue en medición en la [incidencia #89](https://github.com/r2cuerdame/capturepack/issues/89).
CapturePack registra la evidencia temporal ambigua en lugar de esconderla tras un
desfase global fijado en el código.

## Documentación

- [Índice de documentación](docs/README.md) — el mejor punto de entrada para
  ingeniería, integraciones, QA, publicaciones, esquemas y material histórico.
- [Especificación del pack](SPEC.md) y [arquitectura](ARCHITECTURE.md) — el
  contrato del formato abierto y los límites de la implementación actual.
- [QA de versión](docs/QA.md), [traspaso actual](docs/HANDOFF.md) y
  [proceso de publicación](docs/RELEASING.md) — cómo se verifican, se traspasan
  y se publican los cambios.
- [MCP](docs/MCP.md) y [API del proveedor temporal](docs/temporal-provider-api.md)
  — acceso de solo lectura a los packs guardados e integración de proveedores de
  contexto.

CapturePack `0.4.2` es la versión de la aplicación. El `format_version` del pack
evoluciona de forma independiente mediante cambios aditivos del formato; quien lo
lea debe seguir [SPEC.md](SPEC.md) en lugar de deducir la compatibilidad del
formato a partir de la versión de la aplicación.

## Seguridad y firma

Las compilaciones de Windows todavía no están firmadas (SmartScreen avisará: *Más información → Ejecutar de todas formas*);
cada versión incluye `SHA256SUMS.txt` para verificarla y hay una solicitud de firma de código
para proyectos de código abierto pendiente de aprobación. Detalles, roles del equipo y prácticas
de privacidad: [docs/CODE_SIGNING.md](docs/CODE_SIGNING.md).

## Privacidad antes de compartir

Los píxeles de la pantalla, los títulos de ventana y los nombres accesibles
—más el selector, el rol, el texto y la URL cuando se usa Chrome DOM— pueden ser
sensibles. CapturePack mantiene las capturas y el contexto de objetos en esta
máquina y no sube ninguna captura, telemetría ni informe de fallos. Su única
petición saliente es la comprobación opcional de actualizaciones en GitHub
Releases, que puede desactivarse en Ajustes → General.

El desenfoque no es destructivo: protege las vistas anotadas que se generan, pero
`snapshot.png` y la repetición original que hay dentro del pack completo siguen
sin censurar. Revisa un pack antes de compartirlo y no compartas el pack completo
cuando sus medios originales contengan información que deba seguir siendo
privada.

## ♥ Apoyo

CapturePack es gratuito, de código abierto y sin nube: sin cuentas, sin telemetría, nada que vender.
Si te ahorra tiempo, [**patrocinarlo en GitHub**](https://github.com/sponsors/r2cuerdame) ayuda a que siga avanzando.

## Licencia

[MIT](LICENSE)
