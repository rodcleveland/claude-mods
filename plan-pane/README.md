# Plan-pane

Shows the plan Claude is working from in a side pane: the plan's title, its major sections, and
each milestone under them with a mark for where it stands (○ not started, ● started, ✓ done) and a
done-out-of-total count. The pane ticks milestones off as the work moves, so you can see how far
along a plan is without opening the file.

- **`/planpane`** opens the pane; **`/planpane close`** closes it. It never opens by itself.
  Rods Rack's panel has a button that runs the same command.
- The pane keeps the last plan across sessions: the next session shows it again, with its progress.

## What counts as a plan

A Markdown file in a folder named `plans` (`docs/plans`, `doc/plans`, `superpowers/plans`,
`~/.claude/plans`) that reads like a plan: a ce-plan or ce-unified-plan, a Superpowers plan, or any
document whose headings name units, tasks or phases (`### U3. Calendar view`, `### Task 2: Wire the
API`, `## Phase 1: Setup`). Requirements documents (`*-requirements.md`) are left out.

A plan shows up when Claude writes it, edits it, reads it (so a session picking up an existing plan
gets it too), or when you approve a plan at the end of plan mode. A newer plan replaces the one
shown. Helper agents' writes count as well.

## Where progress comes from

From Claude's own task and to-do lists. While a plan is loaded, Claude is asked to start each
task's subject with the milestone id from the plan ("U3: Calendar view") and to mark tasks in
progress and completed as it goes; the pane follows those marks. Ticked checkboxes in the plan
file count too. The plan file itself is never edited: progress is kept beside it.

Known limits in 0.1.0:

- Where a session has neither TaskCreate nor TodoWrite, only ticked checkboxes move the marks.
- The note asking Claude to name tasks by milestone id is part of the system prompt, so it reaches
  Claude only in a conversation that starts with a plan already loaded, not one where the plan
  appears partway through (or a resumed one).

## Colours

A row shimmers for a moment when it changes: **purple** for a section or milestone that has just
appeared, **orange** for one whose work has just started, **green** for one just finished.
Terminal and desktop draw the shimmer; VS Code and the mobile app show the same rows still, a
changed row in bold in its colour.

## Where it sits

In fullscreen mode on a terminal at least 110 columns wide the pane docks beside the
conversation; otherwise it sits above the prompt. If the window is too narrow, `/planpane` says so:
widen it and type `/planpane` again.

## Install

```
/plugin install plan-pane --marketplace rodcleveland/claude-mods
```

## Credits

The row shimmer is adapted from the [filetree](https://github.com/data-goblin/claude-code-filetree)
mod by Kurt Buhler, under the MIT License. See [ACKNOWLEDGEMENTS.md](ACKNOWLEDGEMENTS.md).

## Developing

`claude --plugin-dir plan-pane` loads it straight from the repo. `claude plugin test plan-pane`
runs the tests. Any change needs a version bump in `.claude-plugin/plugin.json`.
