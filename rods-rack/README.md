# Rods Rack

A Claude Code mod that adds an orange `◆ Rods Rack ▾` chip to the right end of the prompt footer.
Clicking the chip, or running `/tools` (or `/rack`), toggles a control panel for:

- **Model** and **effort** for the main conversation.
- **Clean View**: tool calls, diffs and command output hidden, and a plain checklist of the job
  above the prompt (see below). The same switch as `/simple`.
- **Prompt Upgrade**: your prompt is rewritten by Haiku to be clearer before it is sent. If the
  rewrite fails or takes longer than 5 seconds, your original is sent unchanged.
- **Helper agents**: the model subagents use (Fast & Cheap → Haiku, Balanced → Sonnet, Same as main).
- **Launch**: *Create photo or video* (edit `CREATE_PROMPT` in `hooks/register.tsx`) and the
  **Agent Dock**, a pane listing subagents with status, model and elapsed time.

Your choices are saved and come back in new sessions and after `/clear`, `/resume` and `/branch`.

## Clean View

While Claude works, this sits just above the prompt:

```
Build my landing page · 1m 12s                     [ ● Clean View: ON ]
✓ Read your brand notes            ██████████  Done
▶ Build the pricing section        ██████░░░░  60%
○ Add the contact form             ░░░░░░░░░░  Next
○ Polish the footer                ░░░░░░░░░░  Up next
```

The header follows the job: its name and running time; **Needs you** with the reason while a
permission prompt, a question or your reply is awaited (the current step's ▶ becomes ‖);
`⚠ Stuck:` with one plain sentence; `■ Stopped` after Esc; and `✓ All done · took …`, which shrinks
to one line after 5 seconds. Tool rows, results, folded tool groups and the background hint are
hidden; Claude's written replies stay.

- **Turn it on or off**: click `[ ● Clean View: ON ]` at the right of the band, the Clean View
  switch in the panel, or type `/simple on`, `/simple off` or `/simple` (flips it). It starts on and
  the choice is saved across restarts. Off, every hidden row comes back and only the button stays.
- **How the checklist is filled**: the mod gives Claude two tools, `plan_steps` (2 to 8 plain step
  names, up front) and `report_progress` (a step and a percent), and adds a system-prompt section
  asking Claude to use them on every request. Until a plan exists, every other tool the main
  conversation calls is refused with a note to call `plan_steps` first (ToolSearch, TodoWrite,
  TaskCreate, TaskUpdate and AskUserQuestion always pass; subagents are never gated). A to-do list
  from TodoWrite or TaskCreate counts as the plan.
- **Job names**: a new prompt shows two placeholder steps at once, and Haiku (low effort) names the
  job in the background. Every step name passes through `cleanName`, which strips code, paths and
  file names and trims to 40 characters.
- **Costs**: one small Haiku call per new job, plus the `plan_steps` / `report_progress` calls Claude
  makes each turn. Clean View only runs in interactive sessions; a `-p` run is untouched.
- **For other mods**: the checklist is plugin state `rods-rack.checklist` (typed in
  `types/index.d.ts`), beside `rods-rack.cleanViewEnabled` and the animation's `rods-rack.tick`.

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

## Hooks and `$` calls

Hooks:

- `session.start`: load saved settings, close the panel, register `/tools` and `/rack`.
- `classic.SessionStart`: reload saved settings after `/clear`, `/resume` and `/branch`.
- `command.run` on `tools` and `rack`: toggle the panel.
- `ui.close`: stop the Agent Dock's timer.
- `ui.render` on `SessionMode`: the footer chip.
- `ui.render` on `AbovePrompt`: the control panel, below whatever else the band draws.
- `ui.render` on `Pane` `rods-rack-dock`: the Agent Dock.

Clean View's hooks live in `hooks/clean-view.tsx` (`registerCleanView(on)`):

- `session.start` (interactive sessions only): load the switch, register `/simple`, `plan_steps`
  and `report_progress`.
- `classic.SessionStart` on `clear`: empty the checklist.
- `command.run` on `simple`: the switch.
- `prompt.compose`: the system-prompt section asking Claude to plan and report.
- `turn.start`: start a job (placeholders, Haiku names it) or carry on the open one.
- `tool.call` on `plan_steps` and `report_progress`: fill the checklist.
- `tool.call`: the plan gate; Needs you, Stuck and their clearing; TodoWrite and Task rows.
- `classic.Notification`: permission prompts and questions become Needs you.
- `classic.StopFailure`: an API error becomes one calm Stuck sentence.
- `turn.complete`: Stopped, Stuck, waiting for your reply, or All done.
- `ui.render` on `AbovePrompt`: the checklist and its button, on top of the band.
- `ui.render` on `ToolUse`, `ToolResult` and `ToolGroup` (hidden) and `ToolProgress` (hint blanked).
- `turn.step`: apply model and effort, and record each subagent's model and start time.
- `prompt.submit`: Prompt Upgrade.
- `tool.call` on `Agent`: Helper agents.

`$` calls: `$.agent.list`, `$.clock.after`, `$.clock.every`, `$.clock.now`, `$.command.register`,
`$.model.complete`, `$.prompt.submit`, `$.state.get`, `$.state.set`, `$.store.get`, `$.store.set`,
`$.tool.register`, `$.ui.invalidate`, `$.ui.log`, `$.ui.open`, `$.ui.resolve`, `$.ui.toast`.
