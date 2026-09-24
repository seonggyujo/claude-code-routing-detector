---
description: Show how often the answering model differed from the selected model, with a daily chart
argument-hint: "[days]"
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/report.js"`

Days requested: "$ARGUMENTS"

If no days were requested, show the 30-day report above. If a whole number of days was requested, instead run `node "${CLAUDE_PLUGIN_ROOT}/report.js" <days>` with the Bash tool and show its output. Anything else: show the report above.

Show the report exactly as printed, inside a code block, with nothing before it. After the code block, add nothing unless there are mismatches. If there are, add one sentence: a mismatch means only that the reported model name differed from the selection at that moment, and it can also come from a fallback model or from switching models while an answer was in progress. Do not guess any other cause.
