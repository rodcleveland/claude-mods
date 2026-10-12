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
