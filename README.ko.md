# claude-code-routing-detector

[English](README.md) | 한국어

<p align="center">
  <img src="docs/demo.gif" alt="demo">
</p>

선택한 모델과 실제로 답변한 모델이 같은지 보여주고, 확인한 결과를 내 컴퓨터에 기록해 두는 초록 테마 Claude Code statusline입니다.

## 설치

Node.js가 필요합니다. 다른 의존성은 없습니다.

### 플러그인 (추천)

Claude Code에서 실행합니다.

```
/plugin marketplace add seonggyujo/claude-code-routing-detector
/plugin install routing-detector@routing-detector
```

첫 번째 명령은 이 저장소를 플러그인 출처로 등록만 합니다. 설치는 두 번째 명령으로 합니다.

설치한 뒤 아무 메시지나 보내세요. statusline이 없으면 플러그인이 설정을 해 두고, Claude가 재시작을 한 번 안내합니다. 재시작하면 statusline이 보입니다(Claude Code는 시작할 때만 statusline 설정을 읽습니다). 이미 쓰는 statusline이 있으면 그대로 둡니다. 거기에 모델 확인 한 줄을 추가하거나 교체하려면 `/routing-detector:setup`을 실행하세요.

| 명령 | 하는 일 |
|---|---|
| `/routing-detector:setup` | 번호 목록에서 고릅니다: statusline이 없을 때만 표시, 내 것에 한 줄 추가, 내 것을 교체, 끄기 |
| `/routing-detector:history [days]` | [히스토리](#히스토리) 리포트를 봅니다 (기본 30일) |
| `/routing-detector:disable` | 끄고 이전 statusline으로 되돌립니다 |

플러그인을 제거해도 설정은 되돌려지지 않습니다. `/plugin uninstall` 전에 `/routing-detector:disable`을 먼저 실행하세요.

플러그인이 설정하는 방식: 스크립트를 `~/.claude/routing-detector/`에 복사하고, `~/.claude/settings.json`의 `statusLine`이 그 복사본을 가리키게 합니다. 플러그인 폴더는 버전마다 바뀌기 때문에, 업데이트 후에는 세션 시작 hook이 복사본을 새로 고칩니다. 이전 `statusLine`은 따로 보관해 두었다가 `disable` 때 되돌립니다.

### 직접 설치

1. `statusline.js`를 `~/.claude/statusline.js`에 저장하고, 히스토리 요약용 `report.js`도 같은 곳에 저장합니다.

   ```sh
   curl -o ~/.claude/statusline.js https://raw.githubusercontent.com/seonggyujo/claude-code-routing-detector/main/statusline.js
   curl -o ~/.claude/report.js https://raw.githubusercontent.com/seonggyujo/claude-code-routing-detector/main/report.js
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

## 표시 내용

| 줄 | 내용 |
|---|---|
| 1 | 모델 확인 · thinking effort · git 브랜치 · 세션 비용(API 요금 환산) · 30일 요약 |
| 2 | context window 사용량 |
| 3 | 5시간 사용량 한도, 리셋까지 남은 시간 |
| 4 | 주간 사용량 한도, 리셋까지 남은 시간 |

모델 확인 표시는 세 가지입니다.

| 표시 | 의미 |
|---|---|
| `✓ Opus 5.5` (초록) | 최근 답변을 선택한 모델이 만들었습니다 |
| `⚠ selected:<id> / actual:<id>` (빨강) | 최근 답변을 다른 모델이 만들었습니다 |
| `… Opus 5.5` (흐린 색) | 다음 답변을 기다리는 중입니다. 아직 답변이 없거나, 방금 `/model`로 모델을 바꿨거나, 최근 답변이 statusline이 지켜보기 전에 쓰인 경우입니다 |

30일 요약 `30d 0/1,240`은 최근 30일 동안 확인한 답변 중 불일치 건수입니다.

3, 4번째 줄은 Claude Pro/Max 구독자에게만 보이며, 세션의 첫 답변 뒤에 나타납니다.

플러그인에서 "내 것에 한 줄 추가"를 고르면, 원래 쓰던 statusline은 그대로 두고 그 아래에 1번째 줄(모델 확인과 30일 요약)만 붙습니다.

## 색상

전체를 초록 계열로 그려서, 문제가 없을 때는 차분하게 보입니다. 빨강은 눈여겨볼 곳에만 씁니다.

| 색 | 쓰이는 곳 |
|---|---|
| 밝은 초록 | 선택한 모델 확인(`✓`) |
| 초록 | git 브랜치, 70% 미만 막대 |
| 연두 | 70~89% 막대 |
| 빨강 | 모델 불일치(`⚠`), 30일 요약의 불일치 건수, 90% 이상 막대 |
| 흐린 초록 | effort, 라벨, 비용, 토큰 수, 리셋 시간, 구분자 |

## 동작 방식

1. Claude Code가 선택한 모델(`model.id`)과 대화 기록 경로(`transcript_path`)를 stdin으로 넘겨줍니다.
2. 스크립트가 대화 기록에서 지난 실행 뒤에 추가된 부분만 읽어서, 메인 대화의 새 답변을 찾습니다.
3. 새 답변마다 `message.model`을 그 시점에 선택된 모델과 비교하고, 결과를 [히스토리](#히스토리)에 추가합니다.

답변은 statusline이 처음 봤을 때 한 번만 확인합니다. 그래서 `/model`로 모델을 바꿔도 이전 답변이 불일치로 바뀌지 않습니다.

세부 사항:

- 서브에이전트 기록(`isSidechain: true`)은 건너뜁니다. 서브에이전트는 원래 다른 모델을 쓸 수 있기 때문입니다.
- `<synthetic>` 기록(중단이나 오류 때 생기는 자리표시 항목)은 건너뜁니다.
- 답변 하나가 대화 기록에 여러 줄(thinking, 텍스트, 도구 호출)로 나뉘어 쓰이는 경우가 많습니다. 이 줄들은 같은 `message.id`를 공유하므로 한 번으로 셉니다.
- `[1m]` 같은 접미사와 `-20251001` 같은 날짜 접미사는 비교할 때 무시합니다.
- statusline이 대화 기록을 처음 볼 때(세션을 이어서 열었거나 막 설치했을 때)는 이미 있던 답변을 확인하지 않습니다. 그 답변이 쓰일 때 어떤 모델이 선택되어 있었는지 알 수 없기 때문입니다.

## 히스토리

확인한 답변은 모두 `~/.claude/routing-detector/history.jsonl`에 한 줄씩 추가됩니다. 시각, 세션 ID, 프로젝트 경로, 선택한 모델, 보고된 모델, 메시지 ID가 남습니다. 이 파일은 내 컴퓨터에만 있습니다.

리포트는 플러그인이면 `/routing-detector:history`로, 직접 설치했다면 아래 명령으로 봅니다.

```sh
node ~/.claude/report.js      # 최근 30일
node ~/.claude/report.js 7    # 최근 7일
```

출력 예시:

```
Last 30 days: 334 answers checked, 3 reported a model other than the one selected (0.9%).

09-20  ■■■■■■■■■■■■■■■■■    82
09-21  ■■■■■■■■■■■          54
09-22  ■■■■■■■■■■■■■■       71  ⚠ 2
09-23  ■■■■■■               29
09-24  ■■■■■■■■■■■■■■■■■■■■ 98  ⚠ 1

Answers by reported model:
  claude-opus-5-5  331
  claude-sonnet-5    3

Mismatches:
  2026-09-22 09:00  selected claude-opus-5-5  reported claude-sonnet-5  /home/me/project
  2026-09-22 09:07  selected claude-opus-5-5  reported claude-sonnet-5  /home/me/project
  2026-09-24 09:00  selected claude-opus-5-5  reported claude-sonnet-5  /home/me/project
```

히스토리의 불일치는 그 시점에 보고된 모델 이름이 선택과 달랐다는 뜻일 뿐입니다. fallback 모델처럼 Claude Code가 일부러 다른 모델을 쓰게 하는 설정이나, 답변이 진행되는 도중에 모델을 바꾼 경우에도 생길 수 있습니다.

## 한계

- `message.model`은 API 서버가 응답에 적어 준 모델 이름입니다. 이 도구는 **보고된** 모델이 선택과 일치하는지 확인합니다. 서버가 실제로 실행한 모델과 다른 이름을 적는다면 이 도구로는 알아낼 수 없습니다. 클라이언트 쪽 도구로는 그것을 검증할 방법이 없습니다.
- 이 statusline이 실행되는 동안 쓰인 답변만 확인합니다. statusline 없이 진행한 세션의 답변과, statusline이 대화 기록을 처음 볼 때 이미 있던 답변은 히스토리에 없습니다.

## 테스트

```sh
node test.js
```

가짜 대화 기록으로 표시와 히스토리를 확인합니다. 일치, 불일치, `/model` 전환, 여러 줄로 나뉜 답변, 한 턴의 여러 답변, 아직 쓰이는 중인 줄, 새 세션과 이어 연 세션, 큰 파일과 없는 파일 경우를 다룹니다. 리포트, 30일 요약, 플러그인 설정(세션 시작 때 켜기, `/routing-detector:setup`의 각 선택지, statusline 복원, 내 statusline이 실패하거나 느릴 때의 한 줄 추가 모드)도 확인합니다.

## 라이선스

MIT
