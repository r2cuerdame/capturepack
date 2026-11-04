이번 실행(345-3)에서도 #345 시험을 **하나도 돌리지 못했습니다.** 그래서 코드는 바꾸지 않았고 커밋할 것도 없습니다(작업 트리 깨끗함). 지난 실행(345-2)의 변경은 시험 없이 PR #348로 이미 머지됐습니다. 이번에는 그 코드와 새 시험을 손으로 따라가며 확인했고, 실패할 곳은 찾지 못했습니다. 다만 직접 돌린 결과가 아니므로 수용 기준 3은 아직 확인되지 않았습니다.

## 실행이 막힌 이유

- Bash에서 `git`, `ls`, `node --version` 같은 읽기 명령만 됩니다. `node scripts/...`와 `npm`은 승인이 필요한데, 비대화형 실행이라 승인을 받을 수 없습니다.
- csx 실행기(`run_observed_command`)도 권한이 없습니다.
- PowerShell은 `Get-Location`까지 모든 명령이 "The command line is too long"으로 실패합니다.
- `core/node_modules`가 없습니다. 그래서 node가 허용되더라도 electron이 필요한 `check:chrome-bridge`는 `npm ci` 없이는 돌지 않습니다.

## 손으로 따라가 본 결과

- **`document-snapshot-check`의 shadow 경우 5개**: 모두 PASS로 나옵니다. 열린 root 안 요소, 중첩 root, 비밀번호·숨김 규칙 유지, closed root와 예외를 던지는 host, 4000개 한도(`li` 3998개, truncated) 경우입니다.
- **`chrome-bridge-check`의 가짜 컴포넌트 페이지**: 하이라이트가 `200px/410px/80px/40px`에 놓이고, selector가 `#player >>> div > button:nth-of-type(2)`와 `#player >>> div > seek-bar >>> #thumb`으로 나옵니다. closed root는 `#closed`로 나오고, 스냅샷에 `CLOSED-INSIDE`가 없습니다. 모두 기대값과 같습니다. 앱 로그에서 찾는 문자열도 `domBridge.ts:1430`이 실제로 남기는 형식과 같습니다.
- **기존 시험에 대한 영향**:
  - 같은 확장 파일을 읽는 `frame-geometry-check`, `full-page-capture-check`, `chrome-lifecycle-check`는 바뀐 코드에 걸리지 않습니다.
  - 브리지 시험이 앱에 보내는 pick이 하나 늘었지만, 뒤의 전체 페이지 팩은 자기 페이지 이벤트만 담습니다(`session.ts:578`). 그래서 이후 검사에 영향이 없습니다.
- **앱에서 selector 쓰임**: 저장하고 보여 주기만 하고 파싱하는 곳은 없습니다. 그래서 `>>>` 형식이 문제를 일으키지 않습니다.

## 찾았지만 고치지 않은 것

**shadow root 안의 iframe에서 고른 요소가 사라집니다.** `content-script.js`의 `childFrames()`는 `document.querySelectorAll('iframe, frame')`만 봅니다. 그래서 열린 shadow root 안에 있는 iframe은 찾지 못합니다.
- 그 iframe 안에서 클릭하면, 위 프레임은 pick을 보낸 프레임을 찾지 못하고 아무 말 없이 버립니다(`host === undefined`).
- 맨 위 프레임은 계속 무장된 상태로 남습니다.
- Escape로 무장을 풀어도 그 iframe에는 전달되지 않습니다.

#345 전부터 있던 문제라서, 프레임 체인 코드를 시험 없이 건드리지 않았습니다. 별도 이슈로 다루는 편이 좋겠습니다.

## 사람이 해야 할 것

`core`에서 다음을 실행하고 통과를 확인해 주세요.

```
npm ci
npm run check:document-snapshot
npm run check:frame-geometry
npm run check:full-page-capture
npm run check:chrome-bridge
```

- 이 반복을 끊으려면 실행 권한 설정에서 `node`와 `npm` 실행을 허용해야 합니다. 지난 보고서에 따르면 그 설정은 `config/providers.yaml`에 있습니다. 이 저장소 밖이라 직접 확인하지는 못했습니다.
- 다음 실행이 같은 시도를 반복하지 않도록, 이 환경에서는 시험을 실행할 수 없다는 메모를 남겼습니다.

공개 라이브러리 코드는 쓰지 않았기 때문에 csx 검색과 보고는 하지 않았습니다.
