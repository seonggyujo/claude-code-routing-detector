# claude-code-routing-detector

English | [한국어](README.ko.md)

<p align="center">
  <img src="docs/demo.gif" alt="demo">
</p>

A green-themed Claude Code statusline that shows whether the model that actually answered matches the model you selected.

## What it shows

| Line | Content |
|---|---|
| 1 | Model check · thinking effort · git branch · session cost (API-equivalent) |
| 2 | Context window usage |
| 3 | 5-hour usage limit, time until reset |
| 4 | Weekly usage limit, time until reset |

The model check has three states:

| Display | Meaning |
|---|---|
| `✓ Opus 5.5` (green) | The latest answer came from the selected model |
| `⚠ selected:<id> / actual:<id>` (red) | The latest answer came from a different model |
| `… Opus 5.5` (muted) | No answer yet in this session, or the transcript could not be read |

`⚠` also shows right after you switch models with `/model`, until the new model answers once (see [Limitations](#limitations)).

Lines 3 and 4 appear only for Claude Pro/Max subscribers, after the first answer in a session.

## Colors

Everything is drawn in shades of green, so the status line stays calm when nothing is wrong. Red appears only for real alarms.

| Color | Used for |
|---|---|
| Bright green | Selected model confirmed (`✓`) |
| Green | Git branch, meter bars under 70% |
| Yellow-green | Meter bars from 70% to 89% |
| Red | Model mismatch (`⚠`), meter bars at 90% or more |
| Muted greens | Effort, labels, cost, token counts, reset times, separators |

## How it works

1. Claude Code passes the selected model (`model.id`) and the transcript path (`transcript_path`) to the status line on stdin.
2. The script reads the transcript file backwards, starting with the last 64 KB, and finds the most recent assistant message of the main conversation.
3. It compares that message's `message.model` with the selected model.

Details:

- Subagent entries (`isSidechain: true`) are skipped, because subagents can use other models on purpose.
- `<synthetic>` entries (placeholders written on interruptions and errors) are skipped.
- Suffixes such as `[1m]` and date suffixes such as `-20251001` are ignored when comparing.

## Limitations

- `message.model` is the model name that the API server writes into its response. This tool checks that the **reported** model matches your selection. If a server reported a model name that did not match the model that actually ran, this tool could not detect it. No client-side tool can verify that.
- Right after you switch models with `/model`, the check shows `⚠` until the new model answers once, because the latest answer still comes from the previous model.

## Install

Requires Node.js. No other dependencies.

1. Save `statusline.js` to `~/.claude/statusline.js`:

   ```sh
   curl -o ~/.claude/statusline.js https://raw.githubusercontent.com/seonggyujo/claude-code-routing-detector/main/statusline.js
   ```

2. Add this to `~/.claude/settings.json`:

   ```json
   {
     "statusLine": {
       "type": "command",
       "command": "node ~/.claude/statusline.js",
       "refreshInterval": 20
     }
   }
   ```

   `refreshInterval` keeps the reset timers moving while the session is idle.

   On Windows, use forward slashes in the `command` path.

## Test

```sh
node test.js
```

Feeds fake transcripts to the script and checks the match, mismatch, no-answer, large-file and missing-file cases.

## License

MIT
