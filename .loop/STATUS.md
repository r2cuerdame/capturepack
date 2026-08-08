# capturepack — STATUS

## 기술 스택

- **런타임**: Electron 43 + TypeScript 5.6, Node >= 22.12. 트레이 상주 앱(메인 윈도우 없음).
- **빌드**: esbuild 번들링(core/scripts/build.mjs) → electron-builder(NSIS, Windows 전용, oneClick). 빌드에 Windows 필수 — .NET csc.exe 로 native-replay-capture.exe 컴파일, MSVC 있으면 dxgi-timing-reference.exe 도 컴파일(선택).
- **런타임 의존성 4개만**: @modelcontextprotocol/sdk ^1.30.0, adm-zip ^0.6.0, electron-updater ^6.3.9, zod ^4.4.3.
- **플랫폼 결합**: Windows UI Automation 은 PowerShell 헬퍼(uia-dump.ps1 / context-host.ps1) 경유. macOS/Linux 타깃 없음.
- **배포**: GitHub Releases + electron-updater(sha512 검증, 종료 시 설치). 발행은 수동 workflow_dispatch.

## 디렉토리 구조

- `SPEC.md`(152KB) / `GOAL.md`(168KB) / `ARCHITECTURE.md` / `ROADMAP.md` / `CHANGELOG.md` — 포맷 규격과 설계·측정 이력. 문서가 코드보다 상위 계약.
- `core/src/main/` — 메인 프로세스. index.ts(합성 루트 884줄), session.ts(캡처 흐름 4,536줄), capture.ts(1,998줄), exporter.ts(2,109줄), uia.ts, mcp/(server·service·store·tools), chrome/(domBridge·nativeHost·install), context/(clock·surfaceLane·controlLane·timeline·windowsContextTimeline·inputEvents·providerHost·packObjects 등 시간축 컨텍스트 엔진).
- `core/src/renderer/` — capture/(리플레이 링버퍼 4,061줄 + fragmentedMp4Ring·webmDualSlotRing·replayPixelClock·sourceLatencyCalibration), editor/(주석 에디터 5,180줄 + objects·scrub·objectPickPolicy), history/, settings/, image-region/, about/, welcome/, toast/, render/.
- `core/src/shared/` — types.ts(포맷 타입 1,225줄), ipc.ts(IPC 계약 1,728줄), i18n.ts(9개 언어 4,880줄), context/(protocol·manifest·resolver·surfaces), keyframes·numbering·retention·track·motion 등.
- `core/scripts/` — check:* 회귀 82개 + qa-gate.mjs + 픽스처. .ts 체크는 esbuild 로 번들 후 electron 스텁으로 실행.
- `extensions/chrome/` — MV3 확장(background·content-script·document-snapshot·frame-geometry) + 네이티브 메시징 호스트 매니페스트.
- `tools/validate-capturepack.mjs` — 구현과 독립인 스펙 검증기. `site/` — capturepack.dev 정적 사이트(9개 언어 + 로케일별 모션 에셋). `docs/` — QA·RELEASING·MCP·HANDOFF·schemas.
- `.loop/`, `.loop/office/` — LoopOffice 거버넌스 원장. 현재 대부분 비어 있음.

## 구현된 기능 (검증됨)

- **롤링 리플레이 버퍼**: 디스플레이당 숨김 캡처 윈도우 1개. MP4/AVC 는 MediaRecorder 1개 + 경계형 fragmented-MP4 링, 합법적 MP4 미지원 런타임은 명시적으로 다른 dual-slot WebM 폴백. 1–60초, 5–30fps 설정.
- **되감기 + 주석 에디터**: 휠 ±100ms / Shift ±1s / Alt ±1프레임, Ctrl+휠 줌, Space+드래그 팬, 우클릭 드래그 박스 + 즉시 설명, 박스별 lifetime(t_start_ms/t_end_ms), 번호·블러·텍스트는 박스 속성.
- **Object Pick(스틸 전용)**: UIA 컨트롤 / Chrome DOM 명시 픽 / HWND 윈도우 폴백 3단 사다리. `objectPickingApplies()` 단 하나가 게이트이며 check:video-no-picking 이 고정. ObjectIndex.forDisplay + context/packObjects.ts 로 저장된 팩을 Electron 없이 같은 인덱스로 열 수 있어 픽 품질이 측정 가능(check:pick-quality, 15% 한계).
- **이미지 캡처**: Ctrl+Alt+S 영역 드래그 + 전체 가상 데스크톱 버튼. capture_kind: image, 리플레이/timeline.json 없음, region 은 크롭 밖 픽셀 미저장.
- **다중 디스플레이**: media.displays 항상 기록(단일 모니터도 배열 1개), 각 항목이 실제 기록된 래스터에서 읽은 snapshot_width/height 선언(포맷 0.7.0). 음수 원점·portrait·혼합 DPI 처리.
- **타임라인 입력 이벤트**: input.mouse.move/click, input.window.focus/move/resize (포맷 0.8.0). 후크·스레드 없이 기존 표본의 차분으로 파생. input.key.* 는 5방향에서 차단(링·상수·소스·호스트·검증기).
- **내보내기**: source-first 원자적 저장. manifest/annotations/timeline/report/README/skills/plugins 를 파생 렌더링보다 먼저. 블러는 선언된 파생 뷰에만, 원본 불변. viewer.html(스크립트 없는 오프라인 뷰어), 9개 언어 팩 문서.
- **MCP 서버**: 루프백 127.0.0.1:39393, 읽기 전용. latest/history/list/open/summary/manifest/report/timeline/annotations/find_annotations/frame/replay/dom/find_dom/windows/search/export_markdown.
- **Chrome 연동**: 명시적 픽 전용, DOM 스트리밍 없음. page → service worker → 네이티브 호스트 → 사용자별 named pipe 3프로세스. iframe 픽 지원(프레임 오프셋 측정), password/입력값/숨김 요소는 거부하고 무엇을 뺐는지 payload 에 명시. 스틸은 보이는 모든 브라우저 창의 문서를 기록. client_bounds 를 windows-uia 0.5.0 에 저장해 0.4.1 에서 읽기 복구.
- **운영**: 보존 정책 + 용량 예산 자동 실행, History(검색/재편집/재렌더/패키징), 크래시 덤프 + 다음 시작 시 "비정상 종료" 고지, Windows 로그인 항목, 9개 언어 즉시 적용, 잠금 화면에서 업데이트 토스트 보류.
- **품질 게이트**: check:* 82개 + typecheck + 프로덕션 빌드 + Electron 스모크 = 85단계. CI 는 여기에 더해 capture-e2e 로 실제 캡처 3회(정상 / 프레임 기아 / 렌더 대기)를 돌려 산출된 팩에 단언.

## 미완성·주의 영역 (사실)

- **V2 플러그인 런타임 API 부재**: 디스크 규약은 완성이나 인프로세스 API·after-save 액션 호스트 없음.
- **도달 불가 코드**: editor.ts:2813 `requestBoundedObservedControlPick` 은 `captureKind === 'video'` 를 요구하는데(2823행), 유일한 호출부(3915행)는 `objectIndexOf()` 가 null 이 아닐 것을 요구하고 그 함수는 `captureKind === 'image'` 에서만 인덱스를 돌려줍니다(2593·2598행). 즉 두 조건이 상호배타이며 objectPickPolicy.ts 의 `boundedObservedPickFallback`(약 90줄)과 control-pick-check.ts 의 약 130줄 커버리지가 죽은 코드입니다. check:editor-ux(146행)가 이 호출의 존재를 오히려 고정 중.
- **필드 미검증**: 실물 3화면(#76 인수 체크리스트 미실행), 실제 DXGI 실패 시 폴백 인수인계 목격, 보고 기기 외 지속 캐딘스, 5분 CPU/메모리/스톨 매트릭스, Chrome 픽커 의도적 무장 1회 기록.
- **capture-e2e 가 continue-on-error**: 0.4.1 후보에서 실제로 빨간불이 났는데 전체 런은 초록이었음.
- **시작 시 소스 지연 캘리브레이션**이 정지 화면에서 insufficient-motion-transitions 를 보고하고 재시도하지 않아 팩 시계가 wall-clock 폴백으로 감. 그 폴백 비용은 미측정.
- **대형 모듈**: editor.ts 5,180 / session.ts 4,536 / capture.ts 4,061 / i18n.ts 4,880 / ipc.ts 1,728 줄. 저장소 자체 규약("목차가 필요한 모듈은 두 모듈이다")과 긴장.
- **테스트 방식**: 표준 프레임워크 없음. 일부 체크는 소스 텍스트 정규식 단언이라 리팩터링에 취약.
- **거버넌스 원장 공백**: .loop/GOAL.md·STATUS.md·KNOWLEDGE.md 가 플레이스홀더. LoopOffice current.md 의 "관측된 구현 사실"이 .claude/worktrees/ 의 낡은 사본을 가리킴(파일 10,773개로 집계).
- **설치 파일 미서명**(#21), electron-builder 개발 전용 의존성에 high 권고 16건(런타임 아님, 상향 경로 없음).
- **manifest.schema.json** 본문은 0.7.0 필드를 담고 있으나 최상단 description 은 "through format 0.6.0" 으로 남아 있음(경미한 불일치).
