# Question Pane

When Claude has three or more questions for you, it calls the `ask_questions` tool instead of
writing a numbered list in chat. The questions open in a pane, numbered and grouped under their
section headings, each with its own answer box.

- **Tab** or **Enter** moves to the next answer; Enter on the last one moves to **Submit**.
- **Submit** sends every question with its answer back to Claude as your next message.
  Blank answers go as "(no answer)".
- Closed the pane by accident? `/questions` reopens it with what you'd typed.
- **Turn it off** with `/question-pane off` (or the "Question form" switch in Rods Rack); `/question-pane on`
  turns it back on. Off, Claude asks in chat as a numbered list. The choice is kept across sessions.

Answer boxes are one line each. The mobile app draws no text fields yet, so there the pane only
says the questions are waiting.

## Developing

`claude --plugin-dir question-pane` loads it straight from the repo. `claude plugin test question-pane`
runs the tests. Any change needs a version bump in `.claude-plugin/plugin.json`.
