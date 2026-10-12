# Rods Rack

A Claude Code mod that adds an orange `◆ Rods Rack ▾` chip to the right end of the prompt footer.
Clicking the chip, or running `/tools` (or `/rack`), toggles a control panel for:

- **Model** and **effort** for the main conversation.
- **Clean View**: each tool call drawn as one `✓` / `✗` / `…` line, with its result block hidden.
- **Prompt Upgrade**: your prompt is rewritten by Haiku to be clearer before it is sent. If the
  rewrite fails or takes longer than 5 seconds, your original is sent unchanged.
- **Helper agents**: the model subagents use (Fast & Cheap → Haiku, Balanced → Sonnet, Same as main).
- **Launch**: *Create photo or video* (edit `CREATE_PROMPT` in `hooks/register.tsx`) and the
  **Agent Dock**, a pane listing subagents with status, model and elapsed time.

Your choices are saved and come back in new sessions and after `/clear`, `/resume` and `/branch`.

## Install

At the prompt of a terminal Claude Code session (2.1.275 or later):

```
/plugin install rods-rack --marketplace rodcleveland/claude-mods
```

Answer `y` to add the marketplace, then pick a scope. The repository is private, so this only works
for accounts with read access to it.

## Develop

```
claude --plugin-dir ./rods-rack
```

The folder is watched: saving a file reloads the mod. Run with `claude --debug` to see why a hook
was skipped or a drawing was refused.

```
claude plugin validate ./rods-rack
claude plugin test ./rods-rack
```

Once a session has loaded the mod, the engine writes this build's types into
`.claude-plugin/types/` (git-ignored), and `npx tsc -p rods-rack` type-checks it.

## How it maps onto the plugin API

These choices differ from the original spec because this build's API has no equivalent:

| Spec asked for | What this build has, and what the mod does |
| --- | --- |
| A footer/status-bar component | `SessionMode`, the mode labels at the right of the prompt footer. The chip is drawn there, after any existing labels. |
| A floating panel | The band above the prompt (`AbovePrompt`). The panel is a bordered box pushed to the band's right edge. It steps aside while a survey holds the band. |
| `[–]` outside the corner | Drawn by Claude Code beside every band tree; it collapses the band (also ctrl+x ctrl+a). Click the band or press ctrl+x tab to give it the keyboard. |
| A keybinding | None exists for plugins. `/tools` and `/rack` are registered `immediate`, so they run mid-turn without starting a turn. |
| A `$.session` / `$.model` setter | None exists. A `turn.step` hook rewrites each main-loop request's model and effort. Subagent requests are left alone. |
| A list of available models | None is exposed. The four models are a constant (`MODELS`). |
| Racing the upgrade with `$.clock.sleep` | `$.model.complete` takes `timeoutMs: 5000` and resolves `aborted` on timeout. A sleep would also count against the hook's own budget. |
| A divider above the footer | None exists. The `Clean View —` label is the `tail` of the hint line under the prompt (`PromptHint`). |

## Hooks and `$` calls

Hooks:

- `session.start`: load saved settings, close the panel, register `/tools` and `/rack`.
- `classic.SessionStart`: reload saved settings after `/clear`, `/resume` and `/branch`.
- `command.run` on `tools` and `rack`: toggle the panel.
- `ui.close`: stop the Agent Dock's timer.
- `ui.render` on `SessionMode`: the footer chip.
- `ui.render` on `AbovePrompt`: the control panel.
- `ui.render` on `Pane` `rods-rack-dock`: the Agent Dock.
- `ui.render` on `ToolUse`, `ToolResult` and `PromptHint`: Clean View.
- `turn.step`: apply model and effort, and record each subagent's model and start time.
- `prompt.submit`: Prompt Upgrade.
- `tool.call` on `Agent`: Helper agents.

`$` calls: `$.agent.list`, `$.clock.every`, `$.clock.now`, `$.command.register`,
`$.model.complete`, `$.prompt.submit`, `$.state.get`, `$.state.set`, `$.store.get`, `$.store.set`,
`$.ui.close`, `$.ui.invalidate`, `$.ui.log`, `$.ui.open`, `$.ui.resolve`, `$.ui.toast`.
