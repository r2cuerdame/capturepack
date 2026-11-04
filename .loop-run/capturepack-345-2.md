#345를 구현했지만 **시험은 한 번도 돌리지 못했고 커밋도 하지 못했습니다.** 이번 실행은 `config/providers.yaml`에 따라 Read/Edit/Write/Glob/Grep만 허용됩니다. 그래서 Bash, PowerShell, csx 실행기 모두 승인 대기에서 막혔고 `node --check`와 `git add`도 거부됐습니다. 변경 7개 파일은 `loop/345-2` 작업 트리에 커밋되지 않은 채 남아 있습니다. 새 시험은 코드를 손으로 따라가며 확인만 했습니다.

## 바꾼 것

- **피커** (`extensions/chrome/content-script.js`)
  - 마우스 아래 요소를 찾을 때, 열린 shadow root 안으로 따라 들어가 실제로 그려진 요소(예: 플레이어 안의 버튼)를 고릅니다. 하이라이트와 클릭 모두 이 방식을 씁니다.
  - 마우스를 움직이지 않고 클릭하면 예전에는 host가 잡혔는데, 이제 같은 방식으로 안쪽 요소를 찾습니다.
  - shadow 안 요소의 selector를 `#player >>> div > button:nth-of-type(2)` 형태로 만듭니다. 문서 기준 selector로는 shadow 안에 닿을 수 없기 때문입니다(`>>>`는 Puppeteer의 표기). 같은 태그가 shadow root 맨 위에 여러 개 있어도 순번으로 구분합니다.
  - closed root는 host로 고르고, 깊이는 32단계로 제한해 반복을 막습니다.
- **스냅샷** (`extensions/chrome/document-snapshot.js`)
  - 열린 shadow root 안의 요소도 같은 가시성·허용 속성 규칙으로 기록합니다.
  - closed root이거나 읽다가 예외가 나면 건너뛰고, 숨겨진 host는 그 안까지 통째로 뺍니다.
  - 기록 한도 `MAX_ELEMENTS`는 shadow 안 요소도 똑같이 셉니다.
  - 스냅샷의 `omitted` 목록에 "closed shadow root 내부"를 추가했습니다.
- **확장 버전 0.4.1 → 0.4.2** (`manifest.json`, `frame-geometry-check.mjs`의 버전 고정값). 앱은 이 번호가 바뀔 때만 확장 폴더를 다시 복사합니다(`core/src/main/chrome/install.ts:136`). 올리지 않으면 새 피커가 설치된 사용자에게 가지 않습니다.
- **시험**
  - `document-snapshot-check.mjs`: shadow 안 요소 기록, 중첩 shadow, 기존 거부 규칙 유지(비밀번호, 숨김), closed root와 예외를 던지는 host, 한도 적용.
  - `chrome-bridge-check.mjs`: 배포되는 세 확장 파일을 가짜 컴포넌트 페이지에서 그대로 실행합니다. 하이라이트 위치, 클릭으로 고른 요소와 selector, 중첩 root, closed root, 스냅샷 내용을 확인합니다. 그 피킹 결과를 실제 앱 연결로 보내 앱 로그에 안쪽 요소의 selector가 찍히는지도 봅니다.
- **ROADMAP**: Shadow DOM 항목을 완료로 표시하고, SPA 경로 감지는 미완으로 남겼습니다.

## 실행해야 할 것

`core`에서 다음을 실행해 통과를 확인한 뒤 커밋해 주세요. 커밋 신원은 `r2cuerdame` / `r2cuerdame@users.noreply.github.com`입니다.

```
npm run check:document-snapshot
npm run check:frame-geometry
npm run check:full-page-capture
npm run check:chrome-bridge
```

## 고치지 않은 기존 문제

1. **피킹 결과에 문서 스냅샷이 실리지 않습니다.** `onClick`은 스냅샷을 찍지만 `sendPick`이 그것을 보내지 않습니다. 0.2.0(`49a7808`)부터 계속 그랬습니다. 고치면 팩에 담기는 내용이 바뀌므로 #345에 넣지 않았습니다. 별도 이슈로 다룰 만합니다. 그래서 브리지 시험은 스냅샷을 `__capturepackDocumentSnapshot()` 직접 호출로 확인합니다(수용 기준 2가 지정한 함수).
2. **slot에 배치되지 않은 host의 직접 텍스트가 기록될 수 있습니다.** 화면에 보이지 않는 텍스트라 "보이는 것만 기록" 원칙에 어긋날 수 있습니다. 이번 변경 전부터 있던 동작이며, 바꾸지 않았습니다.

공개 라이브러리 코드가 아니라 브라우저 DOM API만 썼기 때문에 csx 검색과 보고 대상은 없었습니다.
