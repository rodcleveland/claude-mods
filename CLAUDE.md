# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Purpose

A collection of Claude Code mods: custom panes, status lines, slash commands and hooks.

## Layout

Each mod lives in its own top-level directory with its own README. There is no shared build,
test or lint tooling yet; when a mod adds any, document its commands here.

Any future change to the mod needs a version bump in `plugin.json` too, or the same thing will
happen. While you're working on it, you can also run `claude --plugin-dir rods-rack` to load the
mod straight from the repo with no install or bump.

## Repository

- Private GitHub repo: `rodcleveland/claude-mods`, default branch `main`.

## Project Docs (Obsidian Vault)

Architecture, feature, API, and decision docs live in `/docs/`.
Read relevant notes before making architectural decisions.

**Entry point:** `/docs/00-Maps/🗺️ Project MOC.md`

**Key references:**
- Architecture: `/docs/Architecture/System Overview.md`
- Features: `/docs/00-Maps/🗺️ Features MOC.md`
- APIs: `/docs/00-Maps/🗺️ API MOC.md`
- Decisions (ADRs): `/docs/Decisions/` — read before suggesting
  alternatives to choices already made
