---
description: Choose how the routing-detector status line is set up, from a numbered list
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/setup.js" status`

Ask the user one question with the AskUserQuestion tool. Question: "How should the routing-detector status line be set up?" Header: "Status line". Put the current setup above in the question text. Offer exactly these four options, in this order, with these labels and descriptions:

1. "Only if I have none": show it only when you have no status line of your own (default).
2. "Add a line to mine": keep your status line and add one model-check line below it.
3. "Replace mine": use it instead of your status line; /routing-detector:disable brings yours back.
4. "Turn it off": do not show it, and keep it off.

Then run the one matching command with the Bash tool, and nothing else:

1. `node "${CLAUDE_PLUGIN_ROOT}/scripts/setup.js" apply only-if-none`
2. `node "${CLAUDE_PLUGIN_ROOT}/scripts/setup.js" apply merge`
3. `node "${CLAUDE_PLUGIN_ROOT}/scripts/setup.js" apply replace`
4. `node "${CLAUDE_PLUGIN_ROOT}/scripts/setup.js" apply off`

If the user cancels or answers with something else, run nothing. Finish with the command's output in one sentence, adding that the status line updates on its next refresh.
