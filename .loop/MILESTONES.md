# capturepack — MILESTONES

<!-- 구현 순서, 마일스톤, 완료 조건, 의존성. -->

## 분석 백로그 (자동)
- [ ] V2 인프로세스 플러그인 API — 서드파티가 코드로 붙을 런타임 표면이 없음 (#69). 디스크 규약(plugins/<name>/, SPEC §11)은 이미 완성
- [ ] after-save 액션 호스트 — 팩 상태·파이프라인·재시도·멱등성 (#68)
- [ ] Settings > Plugins 에 실제 상태 표시와 액션 순서 변경 UI (#69)
- [ ] Chrome 확장 Phase 2 잔여분 — Shadow DOM 관통 및 SPA 라우트 변경 감지 (extensions/chrome 소스에 shadowRoot 처리 없음을 확인)
- [ ] Git 플러그인 · Console 플러그인 — 미착수
- [ ] Unreal / Unity 엔진 컨텍스트 프로바이더 — 미착수
- [ ] 관측된 프로바이더 증거를 넘어서는 앱별 오브젝트 생명주기 추적
- [ ] AI 보조 주석 — 프롬프트 빌더 미착수 (단, AI 의존성 없음 원칙 유지)
- [ ] Windows 코드 서명 (#21) — 현재 공개 설치 파일 미서명, SmartScreen 경고 발생
- [ ] #76 실물 3화면 인수 테스트 미실행 — 7항목 체크리스트, 합성 데스크로 5개 위험 중 4개만 커버
- [ ] #137 세 화면에서 트레이·토스트가 어느 디스플레이의 리플레이가 실패했는지 말하지 않음 — payload 는 정확, 렌더러가 누락. 화면 명명 방식이라는 제품 결정 선행 필요
- [ ] capture-e2e CI 잡을 continue-on-error 에서 required 로 승격 — 0.4.1 후보에서 실제로 빨간불이 초록 런에 묻혔음
- [ ] 죽은 코드 제거: requestBoundedObservedControlPick(editor.ts:2813) / boundedObservedPickFallback(objectPickPolicy.ts:73) 경로가 video 전용 가드와 image 전용 피킹 게이트로 상호배타 → 도달 불가. check:editor-ux:146 이 존재를 고정하므로 체크도 함께 정리 필요
- [ ] 시작 시 소스 지연 캘리브레이션이 insufficient-motion-transitions 후 재시도하지 않음 — 팩 시계가 wall-clock 폴백으로 내려가며 그 비용은 미측정
- [ ] MCP 확장 도구 — compare/merge/diff/statistics, exportPDF/HTML/Issue, findByApplication/URL/WindowTitle
- [ ] MCP frame(time_s) 의 실제 리플레이 프레임 디코딩 — 현재는 가장 가까운 주석 키프레임 또는 snapshot.png 반환
- [ ] sanitized sharing — 공유 ZIP 에서 미검열 원본 리플레이/스냅샷을 제외하는 내보내기 옵션
- [ ] 필드 QA 매트릭스 재실행 — 5분간 CPU/private bytes/working set/JS heap/레코더/스톨, 1fps 및 30fps 지속, 물리 혼합 DPI 장시간 녹화
- [ ] 실제 Desktop Duplication 교착 상황에서 windows-gdi-bitblt 폴백이 인수하는 것을 목격한 기록 없음 (#62 는 경로 존재로 종결)
- [ ] Chrome 엘리먼트 픽커를 일반 https 페이지에서 의도적으로 무장한 1회 실행 기록 (0.3.4 사이클부터 미결)
- [ ] 대형 모듈 분할 검토 — editor.ts 5,180 / session.ts 4,536 / capture.ts 4,061 / i18n.ts 4,880 / ipc.ts 1,728 줄, 저장소 자체 '작은 모듈' 규약과 긴장
- [ ] 표준 테스트 러너 부재 — 82개 자체 체크 중 소스 텍스트 정규식 단언 방식은 리팩터링에 취약
- [ ] .loop 거버넌스 원장 채우기 — GOAL/STATUS/KNOWLEDGE 가 플레이스홀더 상태이며 저장소 문서와 이중화되어 있음
- [ ] LoopOffice 스캔 범위 수정 — .claude/worktrees/ 의 낡은 사본을 세어(파일 10,773개) 'Settings 화면이 워크트리 경로에 있다'는 잘못된 관측 사실을 기록 중
- [ ] manifest.schema.json 최상단 description 이 'through format 0.6.0' 으로 남아 있음 (본문은 0.7.0 필드 반영 완료)
- [ ] electron-builder 개발 전용 전이 의존성의 high 권고 16건 — 현 릴리스 라인에 상향 경로 없음, 재평가 필요
- [ ] macOS / Linux 지원 없음 — 빌드 타깃은 NSIS 단일, UIA 는 PowerShell 경유로 Windows 결합
