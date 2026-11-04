이번 실행(345-4)에서도 #345 시험을 **하나도 돌리지 못했습니다.** 그래서 코드는 바꾸지 않았고 커밋할 것도 없습니다. 작업 트리는 깨끗합니다. 수용 기준 1과 2의 코드는 345-2에서 이미 머지됐습니다(PR #348). 남은 것은 수용 기준 3, 즉 시험이 실제로 통과하는지 확인하는 일인데, 이 환경에서는 할 수 없습니다.

## 막힌 곳

- `node core/scripts/document-snapshot-check.mjs`를 한 번 시도했지만 승인이 필요하다며 거부됐습니다. 비대화형 실행이라 승인을 받을 수 없어서 다시 시도하지 않았습니다.
- `core/node_modules`가 아직 없습니다. 그래서 node가 허용되더라도 `check:chrome-bridge`는 `npm ci` 없이는 돌지 않습니다.
- node를 실행하지 않고 문법만이라도 검사하려고 Serena 진단 도구를 써 보려 했지만, 이것도 권한이 없었습니다.

## 확인한 것

- 345-3 이후의 커밋 두 개는 `.loop/project.md`와 실행 보고서만 바꿨습니다. 그래서 확장 코드와 시험은 345-3이 손으로 따라가며 확인한 것과 똑같습니다. 같은 확인을 다시 하지는 않았습니다.
- `content-script.js`와 `document-snapshot.js`는 이번에 새로 읽었습니다. 틀린 곳은 찾지 못했습니다.
  - 피커는 열린 shadow root 안으로 따라 들어가 실제로 그려진 요소를 고릅니다. closed root를 만나면 host에서 멈추고, 깊이는 32단계로 제한됩니다.
  - 스냅샷은 shadow root 안의 요소도 기록합니다. 숨겨진 host는 그 안까지 통째로 빼고, `MAX_ELEMENTS` 한도는 shadow 안 요소도 똑같이 셉니다.
  - 다만 실행해 본 결과가 아니라 읽어 본 결과일 뿐입니다.

## 아직 고치지 않은 문제 (345-3에서 찾은 것)

열린 shadow root 안에 있는 iframe에서 요소를 고르면 그 선택이 아무 말 없이 사라집니다.
- 원인은 `childFrames()`가 `document.querySelectorAll('iframe, frame')`만 봐서 그런 iframe을 찾지 못하는 것입니다.
- 그 결과 맨 위 프레임은 무장된 채로 남고, Escape를 눌러도 그 iframe에는 전달되지 않습니다.
- #345 전부터 있던 프레임 체인 문제이고 시험할 수 없어서 건드리지 않았습니다. 별도 이슈로 다루는 편이 좋겠습니다.

## 사람이 해야 할 것

`core`에서 다음을 실행해 통과하는지 확인해 주세요.

```
npm ci
npm run check:document-snapshot
npm run check:frame-geometry
npm run check:full-page-capture
npm run check:chrome-bridge
```

- 모두 통과하면 #345를 닫아도 됩니다.
- 실행 권한 설정에서 `node`와 `npm`이 허용될 때까지는 #345를 다시 배정해도 345-3, 345-4와 같은 결과만 나옵니다. 그때까지 `blocked`를 붙여 두기를 권합니다.

다음 실행이 같은 시도를 반복하지 않도록 메모를 고쳤습니다. 이 환경에서는 node, npm, csx, Serena 모두 막혀 있다는 내용입니다. 공개 라이브러리 코드는 쓰지 않았기 때문에 csx 검색과 보고는 하지 않았습니다.
