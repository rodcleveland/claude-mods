# Rods Rack

A Claude Code mod that adds an orange `◆ Rods Rack ▾` chip to the right end of the prompt footer.
Clicking the chip, or running `/tools` (or `/rods-rack`), toggles a control panel for:

- **Model** and **effort** for the main conversation. A pick in the panel is pinned: every request uses it,
  and the status line says so (`Rods Rack: Haiku 5.5 · XHigh`). **Default** in either row hands control
  back to the session; a model pick or Default in the Model row turns Auto Model off. A native `/model`
  or `/effort` does not clear a pin: in a live check the model-switch event never reached the plugin
  (`classic.PostModelSwitch`), and Claude Code does not send `/effort` to plugins at all. Press
  **Default** to hand control back.
- **Clean View**: tool calls, diffs and command output hidden, and a plain checklist of the job
  above the prompt (see below). The same switch as `/simple`.
- **Prompt Upgrade**: your prompt is rewritten by Haiku to be clearer before it is sent. If the
  rewrite fails or takes longer than 5 seconds, your original is sent unchanged.
- **Question form**: turns the Question Pane mod on or off (the same switch as `/question-pane`).
  The row only shows when that mod is installed; the mod keeps the setting itself.
- **Auto Model**: picks the model for each new prompt you type (see below). Also the gold
  `Auto Model: On` / slate `Auto Model: Off` chip in the footer, and `/automodel`.
- **Helper agents**: the model subagents use (Fast & Cheap → Haiku, Balanced → Sonnet, Same as main),
  when Claude does not name one on the Agent call.
- **Team size**: how many helper agents each request is split across (1, 3, 5, 10, 20, 50, 100 or
  Custom). The same setting as the Agent Dock's (see below).
- **Launch**: the **Agent Dock**, the **Work Report**, **YouTube TV** and **⌸ Open Notepad**, which
  starts Windows Notepad through PowerShell (`powershell.exe` on the PATH, else its usual path under
  `/mnt/c`; a toast says so if neither runs).

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
- **What you see**: the status-line entry `Auto · <model>`, and a `Rods Rack: …` entry beside it when
  the panel pins an effort. The session's own model name in your status line does not change, because
  plugins cannot set the session's model; like the Model row, Auto Model swaps the model on each
  main-conversation request.
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
  request that used fewer gets one follow-up asking for the rest, unless Clean View is on and Claude
  already finished every step of its plan (then nothing is left to split). Claude can still launch
  fewer; the dock shows the real count.
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

## Work Report

A pane of what Claude has finished for you: tasks done, an estimate of the hours that saved, what
that time is worth, and the tokens used, with Today, Week (last 7 days), Month (last 30 days) and Year (January 1
through today) tabs.

- **Open it**: `/report`, the `◆ Report` chip in the footer, or ▤ Work Report in the panel.
- **What counts**: one prompt you typed that ends with an answer is one task. Helper agents, tool
  steps, cancelled turns, slash commands, plugin prompts and messages sent mid-turn do not count.
- **Kinds**: Emails (any mail tool), Images and video (image or video tools or the `generate`
  skill, or an image or video file written), Documents (document, slide or spreadsheet tools, or a
  document file written), Artifacts (published pages, dashboards and apps: the Artifact tools),
  Coding (any other file written; a build, test or git command;
  or a shell edit or script that changed a file outside `/tmp`), Research (web search, page reading,
  browser automation, transcripts, `curl` or `wget` downloads) and Other, decided by the tools the
  request and its helpers used, in that order. Artifacts outrank Coding, so building a page that
  gets published counts as Artifacts; Coding outranks Research, so looking up docs while coding is
  coding. A file only read (a screenshot looked at while debugging) does not count. Other
  is what is left: answers with no tools, read-only investigation, and coordination tools such as
  AskUserQuestion and SendMessage.
- **The estimate**: minutes saved per task (Emails 10, Documents 30, Images and video 20, Artifacts
  30, Research 25, Coding 20, Other 10) at $50 an hour. `/report settings` lists them; `/report settings rate 75` or
  `/report settings emails 15` changes one. Hours and dollars are always labelled as estimates.
- **Tokens used**: every token the API counted that day, from each turn's usage: yours, helper
  agents', and turns that were cancelled or finished no task, since they were spent all the same.
  The section shows the total, a bar per model, and the four parts: new input, output, cache reads
  (the conversation re-read from the prompt cache, usually most of the total) and cache writes.
  Plugin side calls (`$.model.complete`, such as Clean View's job names) and compaction are not
  counted. Days saved before 0.6.0 have no tokens, and the section is hidden when a stretch has none.
- **Saved data**: one record per calendar day in Rods Rack's store (`report:day:YYYY-MM-DD`), plus
  the settings. Days are your local dates, read from the system clock and stepped at noon.
- **Past history**: `scripts/report-history.py` estimates the days before the report was installed
  from saved sessions in `~/.claude/projects`, with the same rules, and writes
  `~/.claude/rods-rack-data/report-history.json`, which the report reads at start-up. Re-run it to
  re-sort the same stretch with the current rules: `python3 rods-rack/scripts/report-history.py`
  (it keeps the first run's cutoff, so nothing is counted twice). `--refresh` moves the cutoff up
  to now; tasks the live report already recorded earlier on that day are then counted twice.
  Sessions run from `/tmp` are skipped. On the cutoff day the estimate and the live count are
  added together. It also counts past tokens, from every saved response (helpers' included, each
  response once even when a resumed session repeats it), up to its own `tokensUntil`: the first run
  that counted tokens. Run it once before restarting into a version that counts tokens live, so
  the two meet without a gap or overlap.
- The plain logic is in `hooks/report-logic.ts`; the pane and hooks in `hooks/report.tsx`.

## YouTube TV

Something to watch while you wait: a retro TV in a pane that works as the remote, and YouTube's
own embedded player in a browser tab.

```
╭────────────────────────────────────────────────╮
│ ╭──────────────────────────────────╮     02    │
│ │ STUDY MUSIC                      │           │
│ │ Ambient Study Music To           │  CH▲  CH▼ │
│ │ Concentrate - 4 Hours of Music…  │  VOL+ VOL−│
│ │ Quiet Quest - Study Music        │  ⏻ POWER  │
│ │ ▶ PLAYING                   1/15 │           │
│ ╰──────────────────────────────────╯           │
│          R R - 1 9 9 0     C O L O R   T V     │
╰────────────────────────────────────────────────╯
NOW PLAYING  Ambient Study Music To Concentrate…
 ⏮    ❚❚    ⏭   VOL ▮▮▮▮▮▯▯▯▯▯  50
CHANNELS  1 AI Made Easy  2 Study Music  3 AI News  4 90s TV Shows  5 90s Music
SEARCH: Search YouTube or paste a link
```

- **Open the remote**: `/tv`, the `▣ TV` chip in the footer (`▣ TV ▶` while it plays), or
  ▣ YouTube TV in the panel. Opening it plays nothing: the TV comes on only when you press POWER or
  a channel, search, or paste a link.
- **The picture is in the browser, not the terminal.** The first time it comes on, the mod starts
  `scripts/tv-server.mjs`, a small program serving `scripts/tv-page.html` on `127.0.0.1` at a
  random port with a random token, and opens it in the browser `$BROWSER` names (Windows Chrome
  from WSL), else `xdg-open` or `open`. The pane sends it commands; the page reports what is
  playing. Chrome lets a page start sound only after a click, so the first video plays muted until
  you click the tab once.
- **Channels** are YouTube searches run with `yt-dlp` (15 videos each, kept for the session). The
  first five are AI Made Easy, Study Music, AI News, 90s TV Shows and 90s Music. Videos whose owners
  turned off embedding are skipped.
- **`/tv` words**: `/tv 1` to `/tv 9` for a channel, `up`, `down`, `vol 40`, `vol +`, `vol -`,
  `pause`, `play`, `next`, `prev`, `off`, `window` (open the tab again), `search lofi jazz`, a
  YouTube video or playlist link, or any other words as a search.
- **Pausing for you**: when Claude finishes its turn, or stops to ask for a permission or an
  answer, the TV pauses and says why. Press ▶ to carry on. Helper agents finishing do not pause it.
  `/tv settings autopause off` turns this off.
- **Settings**: `/tv settings` lists the channels, the volume and pausing.
  `/tv settings channel 2 Jazz Piano = smooth jazz piano` changes or adds a channel (up to 9),
  `/tv settings remove 6` removes one, and `/tv settings reset` puts the first five back. The
  volume and the last channel are saved too.
- **Off**: POWER, `/tv off`, or leaving Claude Code stops the program, and the browser tab shows
  that the TV is off. `/clear` and `/resume` keep it playing. If Rods Rack stops answering, the
  program closes itself after two minutes.
- **Needs** `node` and `yt-dlp` on the PATH. Why not in the terminal: Windows Terminal has no
  image protocol for panes, so video would be a coarse block mosaic, and YouTube's terms allow its
  embedded player but not downloading or re-drawing its streams.
- The plain logic is in `hooks/tv-logic.ts`; the pane and hooks in `hooks/tv.tsx`.

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
- `classic.PostModelSwitch`: a model picked with `/model` or the picker clears the panel's pinned model
  and turns Auto Model off. In a live check the event did not arrive for `/model`, so this may not run.
- `classic.StopFailure` on `model_not_found`: Auto Model steps down past that model.
- `ui.render` on `SessionMode`: the footer chips (Auto Model, Report, TV, then Rods Rack).
- `ui.render` on `AbovePrompt`: the control panel, above whatever else the band draws (the checklist sits just above the prompt).

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
- `ui.render` on `AbovePrompt`: the checklist and its button, at the bottom of the band, just above the prompt, with the control panel above it.
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
- `turn.complete`: one nudge if the request used fewer helpers and its Clean View plan has steps left, else the summary.

Clean View's `tool.call` hooks on `plan_steps` and `report_progress` pass a helper's calls to the
dock: its plan is skipped and its report moves its card.

The Work Report's hooks live in `hooks/report.tsx` (`registerReport(on)`):

- `session.start`: load the days, the settings and the history estimate; register `/report`.
- `command.run` on `report`: open the pane, or list and change the settings; it answers at once.
- `ui.render` on `Pane` `rods-rack-report`: the report.
- `prompt.submit` from the composer: a prompt you typed starts a task.
- `tool.call`: each tool the request and its helpers use, for the task's kind.
- `turn.complete`: a typed request that ended with an answer is recorded for today, and every
  turn's tokens (a helper's too) are added to today.

YouTube TV's hooks live in `hooks/tv.tsx` (`registerTv(on)`):

- `session.start`: load the channels and volume; register `/tv`.
- `command.run` on `tv`: open the remote, tune, change volume, play and pause, or settings; it
  answers at once and slow work (search, starting the player) runs after.
- `ui.render` on `Pane` `rods-rack-tv`: the TV and its remote.
- `turn.complete` (the main conversation's) and `classic.Notification` on permission prompts and
  questions: pause when Claude finishes or needs you.
- `session.end`: turn the TV off, except on `/clear` and `/resume`.

`$` calls: `$.agent.list`, `$.clock.after`, `$.clock.every`, `$.clock.now`, `$.command.register`,
`$.model.complete`, `$.prompt.submit`, `$.state.get`, `$.state.set`, `$.store.get`, `$.store.set`,
`$.env.get`, `$.fs.read`, `$.http.fetch`, `$.process.run`, `$.process.spawn`, `$.session.model`, `$.store.keys`, `$.tool.register`, `$.ui.close`, `$.ui.invalidate`, `$.ui.log`,
`$.ui.open`, `$.ui.panes`, `$.ui.resolve`, `$.ui.status`, `$.ui.toast`.
