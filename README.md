# claude-mods

Mods for Claude Code: custom panes, status lines, slash commands and hooks. Each mod lives in its
own folder with its own README, and they install separately from this repo's marketplace.

## The mods

| Mod | Version | What it does |
| --- | --- | --- |
| [Rods Rack](rods-rack/README.md) | 0.10.0 | A footer chip that opens a control panel: model, effort and behaviour toggles, Clean View, the Agent Dock, the Work Report and a Markdown viewer. |
| [Plan Pane](plan-pane/README.md) | 0.1.0 | `/planpane` shows the plan Claude is working from in a side pane: its sections and milestones, ticked off as the work moves. |
| [Question Pane](question-pane/README.md) | 0.2.0 | When Claude has several questions for you, they open in a pane with an answer box under each and a Submit button. |
| [Tokens and time](token-and-time-tracking/README.md) | 0.3.0 | Tokens and time per session, project and day: a live pane and a `/token-time-report` command. |
| [Memory Fork](memory-fork/README.md) | 0.4.0 | After each turn, decides whether memory needs a change, writes it, and stages a note for the Obsidian vault. |

Rods Rack and Plan Pane work together when both are installed: the rack gets a **▦ Plan Pane**
button, and its Markdown viewer leaves plan files to the plan pane.

## Install

This repo is private, so installing needs GitHub access to it. In Claude Code:

```
/plugin marketplace add rodcleveland/claude-mods
/plugin install <mod> --marketplace rodcleveland/claude-mods
```

`<mod>` is the folder name: `rods-rack`, `plan-pane`, `question-pane`, `token-and-time-tracking`
or `memory-fork`. Each mod's README has its own details.

## Developing

- `claude --plugin-dir <mod>` loads a mod straight from the repo, with no install or version bump.
- `claude plugin test <mod>` runs its tests; `claude plugin validate <mod>` checks it the way the
  engine will load it.
- Any change to a mod needs a version bump in its `.claude-plugin/plugin.json`, or installs keep
  the old copy.
- `docs/` (the Obsidian vault) and `graphify-out/` are local only and not committed.
