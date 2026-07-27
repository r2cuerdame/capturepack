# capturepack

[English](README.md) · [한국어](README.ko.md) · [日本語](README.ja.md) · [中文](README.zh.md) · [Español](README.es.md) · [Français](README.fr.md) · [Deutsch](README.de.md) · [Português](README.pt.md) · **Русский**

[![Release](https://img.shields.io/github/v/release/r2cuerdame/capturepack?color=7c5cff&label=release)](https://github.com/r2cuerdame/capturepack/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/r2cuerdame/capturepack/total?color=7c5cff)](https://github.com/r2cuerdame/capturepack/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![Sponsor](https://img.shields.io/badge/%E2%99%A5_Sponsor-ea4aaa)](https://github.com/sponsors/r2cuerdame)

## Сможете объяснить баг меньше чем за 5 секунд?

**CapturePack — самый быстрый способ объяснить что-то LLM.**

> Захватывайте контекст, а не скриншоты.
>
> Лучше ввод — лучше ответы.

CapturePack — открытый формат захвата контекста и набор инструментов к нему: он помогает людям и ИИ понимать визуальные проблемы там, где скриншотов и записей экрана уже не хватает.

🌐 **[capturepack.dev](https://capturepack.dev)** · [Скачать](https://github.com/r2cuerdame/capturepack/releases/latest)

<p align="center">
  <!-- Absolute raw URL with a version query: GitHub proxies README images through
       camo, which caches by source URL — without the bump a fixed demo keeps
       rendering the stale copy for hours. Bump ?v= whenever demo.svg changes. -->
  <img src="https://raw.githubusercontent.com/r2cuerdame/capturepack/main/site/assets/demo.svg?v=2" alt="Демо: нажмите Ctrl+Alt+C — последние 30 секунд застывают, колесо мыши перематывает время, выделите объект перетаскиванием, напишите аннотацию, и CapturePack сохранён." width="760">
</p>

**Папка** CapturePack собирает то, что скриншоту не под силу: последние 30 секунд реплея, снимок экрана, редактируемые аннотации, машиночитаемую хронологию событий и отчёты, понятные и человеку, и ИИ, — всё, что нужно другому разработчику или любой LLM, чтобы сразу разобраться в ситуации. Когда нужно поделиться, упакуйте папку в один файл `.capturepack`.

## Рабочий процесс за 5 секунд

```
Ctrl+Alt+C  →  capture  →  5-second annotation  →  save  →  drop into
                                                              ChatGPT / Claude / Codex / Cursor / Gemini
                                                              or send to another developer
```

## Почему

- **Скриншот сохраняет пиксели.** Теряется всё, что было до кадра.
- **Видео сохраняет движение.** Теряются намерение и структура.
- **CapturePack сохраняет контекст.** Время, пространство, намерение, окружение.

## 🕰 Это машина времени

Баг уже случился? CapturePack **уже вёл запись**. Нажмите `Ctrl+Alt+C`
*после* того, как что-то пошло не так, — последние 30 секунд застывают, а колесо
мыши прокручивает вас **назад во времени** к тому самому кадру, где всё сломалось.
Аннотируйте этот момент, а не его реконструкцию.

## 🤖 Создан для LLM

CapturePack — это ввод, который ИИ действительно понимает:

- Бросьте пак в **ChatGPT, Claude, Codex, Cursor, Gemini** — сгенерированный
  отчёт и файлы контекста объяснят ситуацию без единого лишнего промпта.
- А можно вообще ничего не прикладывать: приложение поднимает **MCP-сервер**, так что
  подключённому ИИ достаточно услышать *«Проанализируй последний CapturePack»* — дальше он справится сам.

Лучше ввод — лучше ответы.

## 🌍 Языки

CapturePack говорит на **9 языках**: English · 한국어 · 日本語 · 中文 · Español · Français · Deutsch · Português · Русский

- Приложение автоматически следует **языку системы** — сменить его можно в любой момент в Настройки → Общие.
- Документы внутри пака (`README.md`, `report.md`, `skills/`) могут жить со своей настройкой языка; ваши собственные описания не переводятся никогда.
- [capturepack.dev](https://capturepack.dev) тоже сам определяет язык браузера.

## Принципы

Локально прежде всего · Офлайн прежде всего · Открытый формат · На плагинах · Без облака · Без входа в аккаунт · Без базы данных · Без зависимости от ИИ · Без привязки к вендору.

Созданные CapturePack должны оставаться читаемыми вечно.

## Что внутри CapturePack

Пак — это обычная **папка**: открывается, редактируется, ничего не прячет. ZIP (`.capturepack`)
создаётся, только когда вы хотите чем-то поделиться.

```
CapturePack_2026-07-27_143052/
├── replay.webm              # оригинальная улика — никогда не изменяется
├── replay_annotated.webm    # аннотации вшиты в видео; играет в любом плеере
├── snapshot.png             # захваченный кадр (оригинал)
├── annotations.json         # первоисточник: рамки, длительности, номера, размытие
├── timeline.json            # машиночитаемый журнал событий
├── report.md                # ваше описание, готовое для LLM
├── manifest.json            # версия формата, опись содержимого
├── README.md                # первый документ, который читает человек
├── skills/                  # контекст, структурированный для ИИ (работает и без MCP)
└── plugins/                 # структурированные метаданные от интеграций
```

Пак только со скриншотом — `manifest.json` + `snapshot.png`, и больше ничего, — полностью валиден.

Спецификация важнее любой реализации: файлы CapturePack может генерировать любой язык. См. [SPEC.md](SPEC.md).

## MCP — говорите со своими захватами

В приложение встроен постоянно работающий [MCP](https://modelcontextprotocol.io)-сервер только для чтения по адресу `http://127.0.0.1:39393/mcp` (доступен лишь с localhost), поэтому любой ИИ сам найдёт и разберёт ваш последний пак — весь промпт умещается в «Проанализируй последний CapturePack».

```
claude mcp add --transport http capturepack http://127.0.0.1:39393/mcp
```

Инструменты, настройка клиентов и параметры: [docs/MCP.md](docs/MCP.md).

## Статус

Ранняя стадия разработки. Видение проекта — в [GOAL.md](GOAL.md), ближайшие планы — в [ROADMAP.md](ROADMAP.md).

## Безопасность и подпись

Сборки для Windows пока не подписаны (SmartScreen предупредит — *Подробнее → Выполнить в любом случае*);
в каждом релизе есть `SHA256SUMS.txt` для проверки, а заявка на сертификат подписи кода
для open source уже подана и ждёт решения. Подробности, роли команды и практики приватности: [docs/CODE_SIGNING.md](docs/CODE_SIGNING.md).

## ♥ Поддержать

CapturePack бесплатен, открыт и обходится без облака — ни аккаунтов, ни телеметрии, ничего на продажу.
Если он экономит вам время, [**спонсорство на GitHub**](https://github.com/sponsors/r2cuerdame) поможет ему двигаться дальше.

## Лицензия

[MIT](LICENSE)
