#!/usr/bin/env python3
"""Estimates the Work Report's past from saved Claude Code sessions.

Reads ~/.claude/projects/*/*.jsonl and writes ~/.claude/rods-rack-data/report-history.json, which
the Work Report reads when a session starts. It uses the live recorder's rules: one prompt you
typed that ended with an answer is one task; helper agents, slash commands, notifications and
plugin prompts are not tasks; a task's kind comes from the tools it and its helpers used.

Run it again to re-sort the same stretch with the current rules (it keeps the first run's cutoff,
so nothing the live report already counted is counted twice):
    python3 rods-rack/scripts/report-history.py
Add --refresh to move the cutoff up to now instead. Tasks the live report recorded earlier on the
new cutoff day are then counted twice.
"""
import argparse
import glob
import json
import os
import re
import sys
from collections import defaultdict
from datetime import datetime

PROJECTS = os.path.expanduser("~/.claude/projects")
OUT = os.path.expanduser("~/.claude/rods-rack-data/report-history.json")
KINDS = ["emails", "documents", "media", "research", "coding", "other"]
WRITE_TOOLS = {"Write", "Edit", "MultiEdit", "NotebookEdit"}

# The same rules as classify() in hooks/report-logic.ts.
MAIL = re.compile(r"gmail|outlook|email|_mail|mail_", re.I)
MEDIA_TOOL = re.compile(r"image|video|openart|higgsfield|photo|thumbnail|gif|nano.?banana|generate_image", re.I)
MEDIA_FILE = re.compile(r"\.(png|jpe?g|gif|webp|heic|svg|mp4|mov|webm|m4v|avi|mkv)$", re.I)
DOC_TOOL = re.compile(r"docx|pptx|xlsx|\bpdf\b|_pdf|pdf_|slides?|spreadsheet|sheets?|claude_docs|google_drive|documents?|word", re.I)
DOC_FILE = re.compile(r"\.(docx?|pptx?|xlsx?|pdf|odt|rtf|key|pages)$", re.I)
CODE_COMMAND = re.compile(r"\b(git (commit|push|merge|rebase|checkout|switch)|npm (run|test|install|ci)|npx|pnpm|yarn|bun|pytest|jest|vitest|tsc|cargo|go (build|test|run)|dotnet|msbuild|gradle|mvn|make|claude plugin (test|validate))\b")
RESEARCH = re.compile(r"websearch|webfetch|web_search|fetch|search_web|transcript|youtube|yt-dlp|context7|scrape|deep-research|research", re.I)


def signals_of(block):
    name = block.get("name") or ""
    inp = block.get("input") if isinstance(block.get("input"), dict) else {}
    out = [("tool", name)]
    # Only a file written says what the work was; one merely read (a screenshot) does not.
    if name in WRITE_TOOLS:
        for key in ("file_path", "notebook_path"):
            if isinstance(inp.get(key), str) and inp[key]:
                out.append(("file", inp[key]))
    if isinstance(inp.get("skill"), str):
        out.append(("tool", inp["skill"]))
    if isinstance(inp.get("command"), str):
        out.append(("bash", inp["command"][:300]))
    return out


def classify(signals):
    tools = [v for k, v in signals if k == "tool"]
    files = [v for k, v in signals if k == "file"]
    commands = [v for k, v in signals if k == "bash"]
    if any(MAIL.search(t) for t in tools):
        return "emails"
    if any(MEDIA_TOOL.search(t) for t in tools) or any(MEDIA_FILE.search(f) for f in files):
        return "media"
    if any(DOC_TOOL.search(t) for t in tools) or any(DOC_FILE.search(f) for f in files):
        return "documents"
    if files or any(CODE_COMMAND.search(c) for c in commands):
        return "coding"
    if any(RESEARCH.search(t) for t in tools) or any(re.search(r"yt-dlp|curl\s+https?:", c) for c in commands):
        return "research"
    return "other"


def parse_time(stamp):
    try:
        return datetime.fromisoformat(stamp.replace("Z", "+00:00"))
    except (AttributeError, ValueError):
        return None


def is_typed(o):
    """A prompt the person typed: human origin, plain text, not a slash command or notice."""
    if o.get("type") != "user" or o.get("isMeta") or o.get("isSidechain"):
        return False
    origin = o.get("origin") or {}
    if origin and origin.get("kind") != "human":
        return False
    content = (o.get("message") or {}).get("content")
    if isinstance(content, list):
        if any(isinstance(b, dict) and b.get("type") == "tool_result" for b in content):
            return False
        content = " ".join(b.get("text", "") for b in content if isinstance(b, dict) and b.get("type") == "text")
    if not isinstance(content, str):
        return False
    text = content.strip()
    return text != "" and not text.startswith(("/", "<", "[Request interrupted"))


def rows(path):
    with open(path, errors="ignore") as fh:
        for line in fh:
            if '"type":"user"' not in line and '"type":"assistant"' not in line:
                continue
            try:
                yield json.loads(line)
            except ValueError:
                continue


def helper_tools(session_dir):
    """Each helper agent's start time and the tools it used."""
    helpers = []
    for path in glob.glob(os.path.join(session_dir, "subagents", "*.jsonl")):
        start, signals = None, []
        for o in rows(path):
            t = parse_time(o.get("timestamp"))
            if start is None and t is not None:
                start = t
            if o.get("type") == "assistant":
                for b in (o.get("message") or {}).get("content") or []:
                    if isinstance(b, dict) and b.get("type") == "tool_use":
                        signals += signals_of(b)
        if start is not None:
            helpers.append((start, signals))
    return helpers


def tasks_in(path):
    """(local day, kind, model) for each finished typed request in one session file."""
    turns = []  # [prompt time, signals, last assistant stop, last model, last time]
    for o in rows(path):
        t = parse_time(o.get("timestamp"))
        if is_typed(o):
            turns.append([t, [], None, None, t])
            continue
        if not turns:
            continue
        turn = turns[-1]
        if o.get("type") == "user":
            content = (o.get("message") or {}).get("content")
            text = content if isinstance(content, str) else " ".join(
                b.get("text", "") for b in content or [] if isinstance(b, dict) and b.get("type") == "text")
            if "[Request interrupted" in text:
                turn[2] = "interrupted"
            continue
        if o.get("type") == "assistant" and not o.get("isSidechain"):
            m = o.get("message") or {}
            for b in m.get("content") or []:
                if isinstance(b, dict) and b.get("type") == "tool_use":
                    turn[1] += signals_of(b)
            if m.get("stop_reason"):
                turn[2] = m.get("stop_reason")
            if m.get("model") and m.get("model") != "<synthetic>":
                turn[3] = m.get("model")
            if t is not None:
                turn[4] = t

    helpers = helper_tools(os.path.splitext(path)[0])
    out = []
    for i, (start, signals, stop, model, end) in enumerate(turns):
        if stop != "end_turn" or end is None:
            continue
        until = turns[i + 1][0] if i + 1 < len(turns) and turns[i + 1][0] is not None else end
        for h_start, h_signals in helpers:
            if start is not None and start <= h_start <= until:
                signals = signals + h_signals
        out.append((end.astimezone().strftime("%Y-%m-%d"), classify(signals), model or "", end))
    return out


def main():
    parser = argparse.ArgumentParser(description="Estimate the Work Report's past from saved sessions.")
    parser.add_argument("--refresh", action="store_true", help="move the cutoff up to now")
    args = parser.parse_args()

    now = datetime.now().astimezone()
    until, cutoff_day, generated = now, now.strftime("%Y-%m-%d"), now.isoformat(timespec="seconds")
    if not args.refresh and os.path.exists(OUT):
        try:
            with open(OUT, encoding="utf-8") as fh:
                previous = json.load(fh)
            until = datetime.fromisoformat(previous["generatedAt"])
            cutoff_day, generated = previous["cutoffDay"], previous["generatedAt"]
        except (OSError, ValueError, KeyError):
            pass

    days = defaultdict(lambda: {"kinds": {k: 0 for k in KINDS}, "models": defaultdict(int)})
    # Sessions run from Claude's own scratch space (/tmp/claude-*) are test runs, not your work.
    files = [p for p in glob.glob(os.path.join(PROJECTS, "*", "*.jsonl")) if not os.path.basename(os.path.dirname(p)).startswith("-tmp-")]
    total = 0
    for n, path in enumerate(files, 1):
        for day, kind, model, end in tasks_in(path):
            if end > until:
                continue
            days[day]["kinds"][kind] += 1
            days[day]["models"][model or "Not recorded"] += 1
            total += 1
        if n % 100 == 0:
            print(f"  read {n} of {len(files)} sessions", file=sys.stderr)

    history = {
        "cutoffDay": cutoff_day,
        "generatedAt": generated,
        "days": {d: {"kinds": v["kinds"], "models": dict(v["models"])} for d, v in sorted(days.items())},
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as fh:
        json.dump(history, fh, separators=(",", ":"))
    kinds = {k: sum(v["kinds"][k] for v in days.values()) for k in KINDS}
    print(f"wrote {OUT}: {total} tasks over {len(days)} days, {min(days, default='-')} to {max(days, default='-')}, up to {generated}")
    print("by kind: " + ", ".join(f"{k} {n}" for k, n in kinds.items()))


if __name__ == "__main__":
    main()
