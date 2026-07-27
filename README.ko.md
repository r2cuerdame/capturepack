# capturepack

[English](README.md) · **한국어** · [日本語](README.ja.md) · [中文](README.zh.md) · [Español](README.es.md) · [Français](README.fr.md) · [Deutsch](README.de.md) · [Português](README.pt.md) · [Русский](README.ru.md)

[![Release](https://img.shields.io/github/v/release/r2cuerdame/capturepack?color=7c5cff&label=release)](https://github.com/r2cuerdame/capturepack/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/r2cuerdame/capturepack/total?color=7c5cff)](https://github.com/r2cuerdame/capturepack/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![Sponsor](https://img.shields.io/badge/%E2%99%A5_Sponsor-ea4aaa)](https://github.com/sponsors/r2cuerdame)

## 버그를 5초 안에 설명할 수 있나요?

**CapturePack은 LLM에게 무언가를 설명하는 가장 빠른 방법입니다.**

> 스크린샷이 아니라, 맥락을 캡처하세요.
>
> 더 좋은 입력. 더 좋은 답변.

CapturePack은 스크린샷과 화면 녹화를 넘어, 사람과 AI가 눈에 보이는 문제를 제대로 이해하도록 돕는 오픈소스 맥락 캡처 포맷이자 툴킷입니다.

🌐 **[capturepack.dev](https://capturepack.dev)** · [다운로드](https://github.com/r2cuerdame/capturepack/releases/latest)

<p align="center">
  <!-- Absolute raw URL with a version query: GitHub proxies README images through
       camo, which caches by source URL — without the bump a fixed demo keeps
       rendering the stale copy for hours. Bump ?v= whenever demo.svg changes. -->
  <img src="https://raw.githubusercontent.com/r2cuerdame/capturepack/main/site/assets/demo.svg?v=2" alt="데모: Ctrl+Alt+C를 누르면 지난 30초가 멈추고, 마우스 휠로 시간을 거슬러 이동하고, 드래그로 개체를 선택하고, 주석을 적으면 CapturePack이 저장됩니다." width="760">
</p>

CapturePack **폴더**에는 스크린샷이 담지 못하는 것이 들어 있습니다. 지난 30초의 리플레이, 스냅샷, 편집 가능한 주석, 기계가 읽는 이벤트 타임라인, 그리고 사람과 AI가 모두 읽는 리포트까지 — 다른 개발자든 어떤 LLM이든 상황을 바로 이해하는 데 필요한 모든 것입니다. 공유할 일이 생기면 폴더를 `.capturepack` 파일 하나로 묶으세요.

## 5초 워크플로

```
Ctrl+Alt+C  →  capture  →  5-second annotation  →  save  →  drop into
                                                              ChatGPT / Claude / Codex / Cursor / Gemini
                                                              or send to another developer
```

## 왜?

- **스크린샷은 픽셀을 남깁니다.** 그 프레임 이전에 무슨 일이 있었는지는 사라집니다.
- **영상은 움직임을 남깁니다.** 의도와 구조는 사라집니다.
- **CapturePack은 맥락을 남깁니다.** 시간, 공간, 의도, 환경까지.

## 🕰 타임머신입니다

버그가 이미 지나갔다고요? CapturePack은 **이미 녹화하고 있었습니다**. 뭔가 잘못된
*뒤에* `Ctrl+Alt+C`를 누르면 지난 30초가 그대로 멈추고, 마우스 휠을 굴려
**시간을 거슬러** 정확히 고장난 그 프레임까지 갈 수 있습니다. 재현한 장면이 아니라,
바로 그 순간에 주석을 다세요.

## 🤖 LLM을 위해 태어났습니다

CapturePack은 AI가 실제로 이해하는 입력입니다.

- 팩을 **ChatGPT, Claude, Codex, Cursor, Gemini**에 넣어 보세요 — 함께 생성된
  리포트와 맥락 파일이 별도의 프롬프트 없이 상황을 설명합니다.
- 아예 아무것도 첨부하지 않아도 됩니다. 앱이 **MCP 서버**를 띄워 두기 때문에, 연결된
  AI는 *"방금 캡처한 것 분석해줘"* 한마디만 듣고 스스로 읽습니다.

더 좋은 입력. 더 좋은 답변.

## 🌍 언어

CapturePack은 **9개 언어**를 말합니다: English · 한국어 · 日本語 · 中文 · Español · Français · Deutsch · Português · Русский

- 앱은 **시스템 언어**를 자동으로 따라갑니다 — 설정 → 일반에서 언제든 바꿀 수 있습니다.
- 생성되는 팩 문서(`README.md`, `report.md`, `skills/`)는 별도의 언어 설정을 따를 수 있고, 직접 쓴 설명은 절대 번역되지 않습니다.
- [capturepack.dev](https://capturepack.dev)도 브라우저 언어를 자동으로 감지합니다.

## 원칙

로컬 우선 · 오프라인 우선 · 개방형 포맷 · 플러그인 기반 · 클라우드 없음 · 로그인 없음 · 데이터베이스 없음 · AI 의존 없음 · 벤더 종속 없음.

한 번 만들어진 CapturePack은 언제까지나 읽을 수 있어야 합니다.

## CapturePack 안에는 무엇이 있나요

팩은 그냥 **폴더**입니다 — 열어 볼 수 있고, 고칠 수 있고, 숨기는 것이 없습니다.
ZIP(`.capturepack`)은 공유하고 싶을 때만 만들어집니다.

```
CapturePack_2026-07-27_143052/
├── replay.webm              # 원본 증거 — 절대 수정되지 않음
├── replay_annotated.webm    # 주석이 입혀진 영상 — 어떤 플레이어에서도 재생
├── snapshot.png             # 캡처된 프레임 (원본)
├── annotations.json         # 진짜 원본: 박스, 지속 시간, 번호, 블러
├── timeline.json            # 기계가 읽는 이벤트 로그
├── report.md                # 직접 쓴 설명, LLM에 바로 사용
├── manifest.json            # 포맷 버전, 파일 목록
├── README.md                # 사람이 가장 먼저 읽는 문서
├── skills/                  # AI를 위해 구조화된 맥락 (MCP 없이도 동작)
└── plugins/                 # 연동에서 가져온 구조화된 메타데이터
```

`manifest.json`과 `snapshot.png`만 있고 나머지는 아무것도 없는 스크린샷 전용 팩도 완전히 유효합니다.

어떤 구현보다 명세가 먼저입니다 — 어떤 언어로든 CapturePack 파일을 만들 수 있습니다. [SPEC.md](SPEC.md)를 보세요.

## MCP — 캡처와 대화하기

앱에는 항상 켜져 있는 읽기 전용 [MCP](https://modelcontextprotocol.io) 서버가 `http://127.0.0.1:39393/mcp`(로컬호스트 전용)에 함께 들어 있습니다. 그래서 어떤 AI든 최신 팩을 스스로 찾아 분석합니다 — 프롬프트는 "방금 캡처한 것 분석해줘" 한 줄이면 끝입니다.

```
claude mcp add --transport http capturepack http://127.0.0.1:39393/mcp
```

도구, 클라이언트 연결, 설정: [docs/MCP.md](docs/MCP.md).

## 상태

초기 개발 단계입니다. 프로젝트가 향하는 곳은 [GOAL.md](GOAL.md), 다음에 만들 것은 [ROADMAP.md](ROADMAP.md)에서 확인하세요.

## 보안 및 서명

현재 Windows 빌드에는 서명이 없습니다 (SmartScreen이 경고합니다 — *추가 정보 → 실행*).
모든 릴리스에는 검증용 `SHA256SUMS.txt`가 함께 올라가며, 오픈소스용 코드 서명은 신청해 둔
상태입니다. 자세한 내용, 팀 역할, 개인정보 처리 방식: [docs/CODE_SIGNING.md](docs/CODE_SIGNING.md).

## ♥ 후원

CapturePack은 무료이고, 오픈소스이며, 클라우드가 없습니다 — 계정도, 텔레메트리도, 팔 것도 없습니다.
시간을 아껴 주었다면, [**GitHub 후원**](https://github.com/sponsors/r2cuerdame)이 이 프로젝트를 계속 나아가게 합니다.

## 라이선스

[MIT](LICENSE)
