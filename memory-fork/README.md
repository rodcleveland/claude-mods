# memory-fork

> Rodman Cleveland's fork of [Ray Amjad's memory-fork](https://github.com/ray-amjad/claude-code-mods/tree/main/plugins/memory-fork) (MIT). It adds the vault staging and memsearch writes described under **Other memory stores**; the rest is Ray's.

A Claude Code mod that keeps your auto-memory up to date in the background, so the main session never stops to write it.

![memory-fork in a session: two "remember" turns, the Memory bar above the prompt with the lines added and removed and the files changed, with Open and Hide buttons, the Memory pane showing each run's added, updated and deleted files with their line counts, and the four steps from turn end to files on disk](diagram.png)

After every turn:

1. **Haiku judges the turn.** It reads the last exchange and your `MEMORY.md` index and answers `SKIP` or `UPDATE: <what to save>`.
2. **A fork drafts the change.** `$.model.fork` replays the session's own transcript (served from the prompt cache) with the current memory files attached. Every tool is denied; it can only reply with JSON: `{"write": [{"name", "content"}], "delete": [...]}`.
3. **The mod writes it.** The files are written with `$.fs.write` and deletions run as `rm -f`, only for bare `*.md` names inside the project's memory folder. `MEMORY.md` is never deleted.

## Other memory stores

The fork also writes `note`: one or two sentences for the work log. When it is not empty:

- **Obsidian vault (staged).** The note is appended to `~/.claude/memory-fork/staging/<project-slug>.md`
  (`<project-slug>` is the working directory with every non-alphanumeric character turned into `-`,
  as in the auto-memory folder). Nothing is written into the vault mid-session: `/closesession`
  (and `/wrap`, which runs it) folds the staged notes into the vault in its own voice and commits
  them with the session, then deletes the staging file. Writing the vault every turn would leave it
  dirty, and `/wrap` deliberately never commits files that were already dirty.
- **memsearch.** Only when the `memsearch` command is on the PATH (`uvx` is not used, since it would
  download memsearch every turn). The note is appended to `<git root>/.memsearch/memory/YYYY-MM-DD.md`
  (or `$MEMSEARCH_DIR/memory/`) in memsearch's own `### HH:MM` turn format, then
  `memsearch index` runs with the collection named the way memsearch's `derive-collection.sh` names it.

The band ends with `· vault staged` and, when memsearch was tried, `· memsearch`.

A band above the prompt shows the run (`Memory: updating …`, then the lines added and removed and the files changed, as in `Memory: +13 −13 · db-p99-under-10ms.md, MEMORY.md`) with **Open** and **Hide** buttons. **Open** shows a pane listing every run this session, each file with its own `+added −removed` count, and the session total at the top. `/memory-fork` opens the same pane.

The main session is told that memory is handled, and its own `Write`/`Edit` calls into the memory folder are refused.

## Why a model fork, not a subagent

The first version spawned a forked agent to write the files. In auto mode every agent spawn goes to the permission classifier, and the classifier gives no verdict on a spawn the user never typed, so every run failed. A tool-less `$.model.fork` makes no tool calls, and the files are written by the mod's own code.

That also means **the writes skip every permission prompt, in every mode.** The file-name guard is the only limit on them. Read `hooks/register.tsx` before you install it.

## Install

```
/plugin uninstall memory-fork@claude-code-mods
/plugin install memory-fork@claude-mods
```

Uninstall Ray's copy first, or both run after every turn and write the same memory twice.

## Develop

```
claude --plugin-dir ./memory-fork
claude plugin validate .
claude plugin test .
```
