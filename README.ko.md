# capturepack

[English](README.md) · **한국어** · [日本語](README.ja.md) · [中文](README.zh.md) · [Español](README.es.md) · [Français](README.fr.md) · [Deutsch](README.de.md) · [Português](README.pt.md) · [Русский](README.ru.md)

[![Release](https://img.shields.io/github/v/release/r2cuerdame/capturepack?color=7c5cff&label=release)](https://github.com/r2cuerdame/capturepack/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/r2cuerdame/capturepack/total?color=7c5cff)](https://github.com/r2cuerdame/capturepack/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

## 버그를 되감고, 객체를 선택하고, 그 상태를 AI에게 전달하세요

**CapturePack은 기본 30초의 순환 리플레이를 사람과 AI가 읽을 수 있는 구조화된 증거로 바꿉니다.**

문제가 생긴 뒤 단축키를 눌러 그 순간으로 되감고, 객체 선택으로 과거 프레임의
캡처된 컨트롤이나 창을 고르세요. CapturePack은 픽셀만 보고 추측하게 하지 않고
대상의 식별 정보, 관측된 위치와 움직임을 보존합니다.

🌐 **[capturepack.dev](https://capturepack.dev)** · [다운로드](https://github.com/r2cuerdame/capturepack/releases/latest)

현재 공개 Windows 릴리스: **CapturePack 0.3.2**

<p align="center">
  <img src="https://raw.githubusercontent.com/r2cuerdame/capturepack/main/site/assets/motion/ko/capturepack-time-machine-poster.webp" alt="오른쪽 NOW에서 시작해 재생 헤드를 왼쪽 5초 전으로 이동하고, 그 과거 프레임에 존재했던 하위 UI 컨트롤을 복원해 선택한 뒤 AI용 구조화 증거를 내보내는 CapturePack" width="760">
</p>

방향을 보세요. 재생 헤드는 **오른쪽 NOW**에서 시작해 **왼쪽 5초 전**으로
이동하고, 그 뒤에야 현재에는 사라진 **저장 버튼**이 다시 나타나 선택할 수
있습니다. 객체 선택은 그 과거 시점에 캡처된 식별 정보와 상태를 기록합니다.

## 사용 흐름

1. **되감기** — 라이브 녹화가 켜진 기본 상태에서 버그가 난 뒤 `Ctrl+Alt+C`를
   누르세요. 리플레이 길이는 1–60초로 설정할 수 있습니다. 라이브 녹화를 끄면
   아무것도 기록되지 않습니다.
2. **객체 선택** — 선택한 과거 프레임에서 커서 아래의 캡처된 컨트롤을 고릅니다.
   관측 경계, 접근성 이름, 컨트롤 유형과 선택 시점이 기록되며, 하위 컨트롤을
   얻지 못하면 실제 창이 대체 대상이 됩니다.
3. **움직임 추적** — 소유 창과 컨트롤의 위치는 리플레이 시계에 맞춰 관측됩니다.
   모든 표본이 디스플레이를 명시하므로 저장 후 다시 연 멀티 모니터 팩과 화면을
   넘어 이동한 객체도 같은 시간과 좌표를 유지합니다.
4. **구조화된 맥락 전달** — 폴더를 개발자나 AI에게 전달하거나, 선택 사항인
   로컬 전용 읽기 전용 MCP 서버로 이미 저장한 팩을 읽게 하세요.

### 객체 정보의 출처

- **Windows UI Automation(기본 내장):** 앱이 제공하는 접근성 이름, 의미 있는
  컨트롤 유형, AutomationId, 프로세스/창 식별 정보와 관측 경계.
- **Chrome DOM(선택 프리뷰 확장):** 사용자가 명시적으로 고른 요소의 selector,
  역할, 텍스트와 URL. DOM을 계속 전송하지 않습니다.
- **HWND 창 대체 경로:** 하위 컨트롤을 얻지 못하면 객체를 만들어내지 않고 실제
  창과 관측된 위치를 기록합니다.

### 한 장이면 충분할 때

`Ctrl+Alt+S`는 기본적으로 영역 선택을 엽니다. 모니터 경계를 끊김 없이 드래그할
수 있고, 상단의 **전체 화면 캡처**는 모든 모니터를 하나의 가상 데스크톱 이미지로
명시적으로 캡처합니다. 이미지는 같은 편집기에서 가능한 경우 원본 100%로 열립니다.
이미지 팩에는 영상과 `timeline.json`이 없으며, 영역 팩은 선택한 픽셀과 크롭 위치만
저장하고 숨겨진 전체 화면이나 다른 모니터 이미지를 보관하지 않습니다.

## 팩의 구성

영상 팩:

```text
CapturePack_2026-07-27_143052/
├── replay.mp4               # 원본(replay.webm 대체 가능)
├── replay_annotated.webm    # 선택 파생본; 매니페스트 선언 시에만
├── snapshot.png
├── annotations.json         # 객체 식별 정보 + 관측 경계
├── timeline.json
├── report.md · README.md · skills/
├── plugins/                 # UIA / 선택 Chrome DOM 맥락
└── manifest.json
```

이미지 팩:

```text
CapturePack_2026-07-27_143052/
├── snapshot.png             # 선택 영역 또는 전체 가상 데스크톱
├── annotations.json
├── report.md · README.md · skills/
├── plugins/                 # 선택 객체 맥락
└── manifest.json            # capture_kind: image, 영상/타임라인 없음
```

객체 정보와 이동 트랙은 관측된 경우에만 들어갑니다. 사용할 수 있는 UI 객체나
표본이 없으면 팩은 그 사실을 그대로 말하며 맥락을 만들어내지 않습니다.

## MCP

앱에는 선택 가능한 읽기 전용 [MCP](https://modelcontextprotocol.io) 서버가 있으며,
기본적으로 `http://127.0.0.1:39393/mcp`에서 활성화·자동 시작됩니다. 설정 → MCP에서
즉시 중지하거나 자동 시작을 끌 수 있습니다. 서버는 사용자가 이미 저장한 이미지와
영상 팩만 읽고 새 캡처를 시작할 수 없습니다.

`capturepack_history`로 기록을 찾고 `capturepack_open`으로 선택하거나,
`capturepack_latest`로 최신 팩을 바로 열 수 있습니다. 자세한 설정은
[docs/MCP.md](docs/MCP.md)를 참고하세요.

## 설정과 진단

- 설정 → 캡처에서 영상(`Ctrl+Alt+C`)과 이미지(`Ctrl+Alt+S`) 단축키를
  각각 바꾸고, 리플레이 길이와 1–30 fps 캡처 속도를 설정할 수 있습니다.
- 정보 → **로그 폴더 열기**에서 로컬 실행 진단을 확인할 수 있습니다.
  로그는 자동 업로드되지 않습니다.

## 공유 전 개인정보 확인

화면 픽셀, 창 제목과 접근성 이름, Chrome DOM의 selector·역할·텍스트·URL에는
민감정보가 들어갈 수 있습니다. CapturePack은 캡처, 텔레메트리, 충돌 보고서를
업로드하지 않습니다. 앱의 유일한 외부 요청은 설정에서 끌 수 있는 선택적인
GitHub 릴리스 업데이트 확인입니다.

블러는 비파괴 방식입니다. 주석이 렌더링된 결과물은 보호하지만 전체 팩의
`snapshot.png`와 원본 리플레이는 가려지지 않은 상태로 남습니다. 전체 팩을
공유하기 전에 원본을 확인하고, 비공개 정보가 있으면 팩 전체를 공유하지 마세요.

## 상태와 보안

0.3.2가 현재 공개 버전입니다. 현재 빌드는 서명되지 않아 SmartScreen이
경고할 수 있으며, 모든 릴리스에는 검증용 `SHA256SUMS.txt`가 포함됩니다.

로컬 우선 · 오프라인 우선 · 오픈 포맷 · 클라우드 없음 · 로그인 없음 · 텔레메트리 없음

## 라이선스

[MIT](LICENSE)
