# claude-code-routing-detector

[English](README.md) | 한국어

<p align="center">
  <img src="docs/demo.gif" alt="demo">
</p>

선택한 모델과 실제로 답변한 모델이 같은지 보여주는 초록 테마 Claude Code statusline입니다.

## 표시 내용

| 줄 | 내용 |
|---|---|
| 1 | 모델 확인 · thinking effort · git 브랜치 · 세션 비용(API 요금 환산) |
| 2 | context window 사용량 |
| 3 | 5시간 사용량 한도, 리셋까지 남은 시간 |
| 4 | 주간 사용량 한도, 리셋까지 남은 시간 |

모델 확인 표시는 세 가지입니다.

| 표시 | 의미 |
|---|---|
| `✓ Opus 5.5` (초록) | 최근 답변을 선택한 모델이 만들었습니다 |
| `⚠ selected:<id> / actual:<id>` (빨강) | 최근 답변을 다른 모델이 만들었습니다 |
| `… Opus 5.5` (흐린 색) | 이 세션에 아직 답변이 없거나, 대화 기록을 읽지 못했습니다 |

`/model`로 모델을 바꾼 직후에도 새 모델이 한 번 답변할 때까지 `⚠`가 표시됩니다([한계](#한계) 참고).

3, 4번째 줄은 Claude Pro/Max 구독자에게만 보이며, 세션의 첫 답변 뒤에 나타납니다.

## 색상

전체를 초록 계열로 그려서, 문제가 없을 때는 차분하게 보입니다. 빨강은 실제로 확인이 필요할 때만 나옵니다.

| 색 | 쓰이는 곳 |
|---|---|
| 밝은 초록 | 선택한 모델 확인(`✓`) |
| 초록 | git 브랜치, 70% 미만 막대 |
| 연두 | 70~89% 막대 |
| 빨강 | 모델 불일치(`⚠`), 90% 이상 막대 |
| 흐린 초록 | effort, 라벨, 비용, 토큰 수, 리셋 시간, 구분자 |

## 동작 방식

1. Claude Code가 선택한 모델(`model.id`)과 대화 기록 경로(`transcript_path`)를 stdin으로 넘겨줍니다.
2. 스크립트가 대화 기록 파일을 끝에서부터 읽어서(처음에는 마지막 64 KB만), 메인 대화의 가장 최근 답변을 찾습니다.
3. 그 답변의 `message.model`을 선택한 모델과 비교합니다.

세부 사항:

- 서브에이전트 기록(`isSidechain: true`)은 건너뜁니다. 서브에이전트는 원래 다른 모델을 쓸 수 있기 때문입니다.
- `<synthetic>` 기록(중단이나 오류 때 생기는 자리표시 항목)은 건너뜁니다.
- `[1m]` 같은 접미사와 `-20251001` 같은 날짜 접미사는 비교할 때 무시합니다.

## 한계

- `message.model`은 API 서버가 응답에 적어 준 모델 이름입니다. 이 도구는 **보고된** 모델이 선택과 일치하는지 확인합니다. 서버가 실제로 실행한 모델과 다른 이름을 적는다면 이 도구로는 알아낼 수 없습니다. 클라이언트 쪽 도구로는 그것을 검증할 방법이 없습니다.
- `/model`로 모델을 바꾼 직후에는 새 모델이 한 번 답변할 때까지 `⚠`가 표시됩니다. 최근 답변이 아직 이전 모델의 것이기 때문입니다.

## 설치

Node.js가 필요합니다. 다른 의존성은 없습니다.

1. `statusline.js`를 `~/.claude/statusline.js`에 저장합니다.

   ```sh
   curl -o ~/.claude/statusline.js https://raw.githubusercontent.com/seonggyujo/claude-code-routing-detector/main/statusline.js
   ```

2. `~/.claude/settings.json`에 아래 내용을 추가합니다.

   ```json
   {
     "statusLine": {
       "type": "command",
       "command": "node ~/.claude/statusline.js",
       "refreshInterval": 20
     }
   }
   ```

   `refreshInterval`은 세션이 쉬고 있을 때도 리셋 시간이 갱신되게 합니다.

   Windows에서는 `command` 경로에 슬래시(`/`)를 쓰세요.

## 테스트

```sh
node test.js
```

가짜 대화 기록으로 일치, 불일치, 답변 없음, 큰 파일, 파일 없음 경우를 확인합니다.

## 라이선스

MIT
