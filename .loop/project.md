---
stage: 보수/PLC
platform: web
productStage: released
platforms:
  - web
version: 0.5.1
deployWorkflow: pages.yml
smokeUrl: https://capturepack.dev
versionNeedle: CapturePack
---

CapturePack 은 웹이고, 공식 배포 워크플로는 pages.yml 이다. release.yml 은 사람이 직접 실행한다.

## 성능 원칙

의종(2026-11-25 11:28 KST, 춈스케 전달): "CapturePack의 강점은 성능을 아주 적게 먹는 것이다."

- 릴리즈마다 CPU·GPU·메모리 사용량과 화면 끊김(25ms 넘는 프레임/분)을 이전 공개 버전과 같은 조건으로 나란히 잰다. 하나라도 늘면 릴리즈하지 않는다.
- 이 비교는 `gh release` 전 단계의 게이트다. 절차와 판정은 `docs/RELEASING.md` 의 Resource comparison gate, 도구는 `core/scripts/release-perf-compare.ps1` 이다.
- 측정은 수동 지표만 쓴다. 입력 주입·화면 깨우기를 하지 않고, 시스템 CPU 60% 아래에서만 재며, 22:00~08:00에는 설치·재시작·측정 실행을 하지 않는다.
