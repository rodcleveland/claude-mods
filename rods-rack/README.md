# Rods Rack

A Claude Code mod that adds an orange `◆ Rods Rack ▾` chip to the right end of the prompt footer.
Clicking the chip, or running `/tools` (or `/rods-rack`), toggles a control panel for:

- **Model** and **effort** for the main conversation.
- **Clean View**: tool calls, diffs and command output hidden, and a plain checklist of the job
  above the prompt (see below). The same switch as `/simple`.
- **Prompt Upgrade**: your prompt is rewritten by Haiku to be clearer before it is sent. If the
  rewrite fails or takes longer than 5 seconds, your original is sent unchanged.
- **Auto Model**: picks the model for each new prompt you type (see below). Also the gold
  `Auto Model: On` / slate `Auto Model: Off` chip in the footer, and `/automodel`.
- **Helper agents**: the model subagents use (Fast & Cheap → Haiku, Balanced → Sonnet, Same as main),
  when Claude does not name one on the Agent call.
- **Team size**: how many helper agents each request is split across (1, 3, 5, 10, 20, 50, 100 or
  Custom). The same setting as the Agent Dock's (see below).
- **Launch**: *Create photo or video* (edit `CREATE_PROMPT` in `hooks/register.tsx`) and the
  **Agent Dock**.

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

On the terminal the checklist sits in a rounded border. Each job takes its own color in turn (blue,
purple, teal, orange, pink, periwinkle) for its border, title, ▶ and meter; green, yellow and the
error color keep meaning done, needs you and stuck. Under the header, once Claude has a plan,
`Step 2 of 4` with a bar and the whole job's percent (done steps in full, the current step by its
reported percent). The header follows the job: its name and running time; **Needs you** with the reason while a
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

## Auto Model

While it is on, each new prompt you type is first sorted by Haiku (8 tokens, 4 seconds at most)
into one of four levels, and the main conversation runs on that level's model:

| Level | For | Model |
| --- | --- | --- |
| small | summarize, sort, extract, rename, translate, reformat, a short fact | Haiku 5.5 |
| everyday | an email, a post, a short draft, a small edit, a one-file question | Sonnet 5.5 |
| strong (default) | software, multi-step projects, research, analysis, planning | Opus 5.5 |
| strongest | hours-long research, a very large build or migration | Fable 5.1 |

- If the sort fails or times out, a guess from the prompt's words decides, strong when in doubt.
- Never sorted, so the model stays: a short reply (under four words, or "ok", "keep going", "do it"),
  a slash command, and a message sent while Claude is working. Helper agents keep their own models.
- If a request comes back "model not found", Auto Model steps down past that model from the next
  prompt on. The prompt that failed is not resent.
- **Controls**: the panel row, the footer chip, `/automodel on`, `/automodel off`, `/automodel status`.
  Turning it off puts back the model you had before. Picking a model by hand (the panel's Model row,
  `/model` or the model picker) turns it off. The setting is saved across sessions.
- **What you see**: only the status-line entry `Auto · <model>`. The session's own model name in your
  status line does not change, because plugins cannot set the session's model; like the Model row,
  Auto Model swaps the model on each main-conversation request.
- **Costs**: one tiny Haiku call per sorted prompt. Substantial prompts go to Opus and the hardest
  to Fable, which uses a plan's limits faster than working on Sonnet. With Prompt Upgrade on too,
  the two Haiku calls run at the same time.
- The four models are a constant (`MODELS` in `hooks/register.tsx`): this build exposes no model list.
  The sorting rules, short-reply check and word guess are in `hooks/auto-model.ts`.

## Agent Dock

Pick a **Team Size**, and every request you send is split across that many helper agents running
in parallel, with a pane that shows each helper as a card.

- **Open or fold it**: `/dock`, or ◆ Agent Dock in the Rods Rack panel. Folded, a busy dock shows as
  `12 working · 8 queued · 30 done` in the status line. `/dock` again reopens it. It docks beside the
  transcript in the fullscreen layout; if the window is too narrow it says so in a toast.
- **Set the size**: `/dock 10`, the dock's Team Size row, or the panel's Team size row. Custom asks
  "How many helpers?" (1 to 100). Above 20 the dock asks first ("Big team: this uses your plan
  quickly. Continue?"), and a big team goes back to 1 in the next session. At 1, Claude decides.
- **What Claude is told**: above size 1, each typed request (not a short reply, a slash command or a
  message sent mid-turn) carries an instruction to split it into exactly N helpers, launched in one
  message, each reporting its progress with `report_progress`. Agent calls past N are refused. A
  request that used fewer gets one follow-up asking for the rest. Claude can still launch fewer; the
  dock shows the real count.
- **Queueing**: helpers past the engine's limit wait in the dock rather than being refused. "At a
  time" is the lower of `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS` (20 if unset) and
  `CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY` (10 if unset). Esc stops the waiting ones.
- **The pane**: the mission (the request's first clause), its percent and time, one bar (done a
  coral-to-gold sweep, working green, the rest a hairline), counts, and a card per helper with an
  initials badge, its task, a timer and a meter. Above 12 helpers, a strip of seats and a "working
  now" list. When all finish: "N agents finished <job> in 2m 14s". The clock runs only while helpers
  are live.
- **Costs**: each helper is a full agent. 50 helpers is roughly 50 agents' worth of usage per
  request, plus one follow-up round if Claude used fewer. Fast & Cheap runs them on Haiku.
- The plain logic is in `hooks/dock-logic.ts`; the pane and hooks in `hooks/dock.tsx`.

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
| A keybinding | None exists for plugins. `/tools` and `/rods-rack` are registered `immediate`, so they run mid-turn without starting a turn. |
| A `$.session` / `$.model` setter | None exists. A `turn.step` hook rewrites each main-loop request's model and effort. Subagent requests are left alone. |
| A list of available models | None is exposed. The four models are a constant (`MODELS`). |
| Racing the upgrade with `$.clock.sleep` | `$.model.complete` takes `timeoutMs: 5000` and resolves `aborted` on timeout. A sleep would also count against the hook's own budget. |

## Hooks and `$` calls

Hooks:

- `session.start`: load saved settings, close the panel, register `/tools`, `/rods-rack` and
  `/automodel`, and show Auto Model's status entry.
- `classic.SessionStart`: reload saved settings after `/clear`, `/resume` and `/branch`.
- `command.run` on `tools` and `rods-rack`: toggle the panel.
- `command.run` on `automodel`: Auto Model on, off and status.
- `classic.PostModelSwitch`: a model picked with `/model` or the picker turns Auto Model off.
- `classic.StopFailure` on `model_not_found`: Auto Model steps down past that model.
- `ui.render` on `SessionMode`: the footer chips (Auto Model, then Rods Rack).
- `ui.render` on `AbovePrompt`: the control panel, below whatever else the band draws.

Clean View's hooks live in `hooks/clean-view.tsx` (`registerCleanView(on)`):

- `session.start` (interactive sessions only): load the switch, register `/simple`, `plan_steps`
  and `report_progress`.
- `classic.SessionStart` on `clear`: empty the checklist.
- `command.run` on `simple`: the switch.
- `prompt.compose`: the system-prompt section asking Claude to plan and report.
- `turn.start`: mark a turn running (Auto Model reads it); start a job (placeholders, Haiku names
  it) or carry on the open one.
- `tool.call` on `plan_steps` and `report_progress`: fill the checklist.
- `tool.call`: the plan gate; Needs you, Stuck and their clearing; TodoWrite and Task rows.
- `classic.Notification`: permission prompts and questions become Needs you.
- `classic.StopFailure`: an API error becomes one calm Stuck sentence.
- `turn.complete`: mark the turn over; Stopped, Stuck, waiting for your reply, or All done.
- `ui.render` on `AbovePrompt`: the checklist and its button, on top of the band.
- `ui.render` on `ToolUse`, `ToolResult` and `ToolGroup` (hidden) and `ToolProgress` (hint blanked).
- `turn.step`: apply model and effort to the main conversation's requests.
- `prompt.submit`: Prompt Upgrade and Auto Model's pick, side by side.

The Agent Dock's hooks live in `hooks/dock.tsx` (`registerDock(on)`, registered first):

- `session.start`: restore the Team Size (a big team goes back to 1), register `/dock`.
- `command.run` on `dock`: open or fold the pane, or set the size; it answers at once.
- `ui.render` on `Pane` `rods-rack-dock`: the dock.
- `prompt.submit`: start a mission; above size 1, add the split instruction as context.
- `session.append` on `response`: queued cards as soon as Claude writes its Agent calls.
- `tool.call` on `Agent`: the helper model, the Team Size cap, the wait for a slot, the card's state.
- `turn.complete`: one nudge if the request used fewer helpers, else the summary.

Clean View's `tool.call` hooks on `plan_steps` and `report_progress` pass a helper's calls to the
dock: its plan is skipped and its report moves its card.

`$` calls: `$.agent.list`, `$.clock.after`, `$.clock.every`, `$.clock.now`, `$.command.register`,
`$.model.complete`, `$.prompt.submit`, `$.state.get`, `$.state.set`, `$.store.get`, `$.store.set`,
`$.env.get`, `$.process.run`, `$.tool.register`, `$.ui.close`, `$.ui.invalidate`, `$.ui.log`,
`$.ui.open`, `$.ui.panes`, `$.ui.resolve`, `$.ui.status`, `$.ui.toast`.
