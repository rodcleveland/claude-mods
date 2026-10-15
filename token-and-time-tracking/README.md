# Token and Time Tracking

Tracks how many tokens each session uses and how long it takes, and keeps the numbers so you
can total them per project and per day.

## What it counts

- **On the clock**: how long the session was open. A resumed session picks up its own record and
  doesn't count the time it was closed.
- **Active**: Claude's turns plus the gaps between them shorter than the idle limit (15 minutes by
  default). A session left open overnight doesn't add hours here, so this is the figure to bill from.
- **Claude working**: how long Claude spent on each turn, summed.
- **Tokens**: input, output, cache read and cache write, per turn. Subagent tokens are counted
  separately, and their time isn't, because it overlaps the turn that started them.

## The live pane

Opens when a session starts (turn that off in the plugin's config); `/token-time` reopens it and
brings it to the front. It's drawn like Rods Rack's Work Report:

- **Tabs:** Session, Today, Week, Month, All. On every tab but Session, the chip on the right
  switches between this project and all projects. Your tab and choice are kept across sessions.
- **Tiles:** active time (out of the time on the clock), Claude working (it says "working now"
  while a turn runs), and tokens.
- **Where the time went:** active, Claude working and idle, each as a bar against the time on the clock.
- **Tokens used:** a bar per model, one for subagents, then input, output and cache tokens.
- **Chart:** active time for the last 7 days, day by day on Month, month by month on All.

The running turn counts toward Claude working and active time as it runs; its tokens arrive
when it ends. Other sessions (another terminal, another project) show up within 15 minutes.

## The report

`/token-time-report [period] [all-projects] [sessions]`

- period: `today` (the default), `yesterday`, `week` (the last 7 days), `month`, `all`, a day
  `2026-10-15`, or a range `2026-10-01..2026-10-15`
- `all-projects`: every project tracked, with a by-project table
- `sessions`: a row for each session

A period longer than a day gets a by-day table. A session that runs past midnight has its time
split between the two days; a turn's tokens count on the day it started.

## Where the numbers live

- Each project keeps its own: one file per session in `<project>/.claude/token-time/sessions/`.
  That folder holds a `.gitignore` of `*`, so none of it is committed. Delete the `.gitignore` if
  you want the numbers in the project's history.
- The list of tracked projects is kept in the mod's own store, so `all-projects` can find them.
  A project's root is its git repository's root (a worktree counts as its main repository), or
  the session's folder outside git.
- The session file is saved after every turn and every minute, so a crash loses a minute at most.

## Settings

In the config menu, or under `pluginConfigs` in settings:

- `idleMinutes` (default 15): gaps longer than this aren't active time.
- `openOnStart` (default true): open the pane when a session starts.

## Install

At the prompt of a terminal Claude Code session (2.1.275 or later):

```
/plugin install token-and-time-tracking --marketplace rodcleveland/claude-mods
```

Answer `y` to add the marketplace, then pick a scope. The repository is private, so this only works
for accounts with read access to it.

## Developing

`claude --plugin-dir token-and-time-tracking` loads it straight from the repo.
`claude plugin test token-and-time-tracking` runs the tests. Any change needs a version bump in
`.claude-plugin/plugin.json`.
