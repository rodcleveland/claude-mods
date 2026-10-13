#!/usr/bin/env python3
"""Estimates the Work Report's past from saved Claude Code sessions.

Reads ~/.claude/projects/*/*.jsonl and writes ~/.claude/rods-rack-data/report-history.json, which
the Work Report reads when a session starts. It uses the live recorder's rules: one prompt you
typed that ended with an answer is one task; helper agents, slash commands, notifications and
plugin prompts are not tasks; a task's kind comes from the tools it and its helpers used.

It also counts the tokens every saved response used, helpers' and unfinished requests' included, as
the live report does. Each response is counted once, even when a resumed session repeats it. Tokens
are counted up to the first run that counted them (tokensUntil), so run it once before restarting
into a version of Rods Rack that counts tokens live.

Run it again to re-sort the same stretch with the current rules (it keeps the first run's cutoff,
so nothing the live report already counted is counted twice):
    python3 rods-rack/scripts/report-history.py
Add --refresh to move the cutoff up to now instead. Tasks the live report recorded earlier on the
new cutoff day are then counted twice, and so are tokens since tokensUntil.
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
KINDS = ["emails", "documents", "media", "artifacts", "research", "coding", "other"]
WRITE_TOOLS = {"Write", "Edit", "MultiEdit", "NotebookEdit"}

# The same rules as classify() in hooks/report-logic.ts.
MAIL = re.compile(r"gmail|outlook|email|_mail|mail_", re.I)
MEDIA_TOOL = re.compile(r"image|video|openart|higgsfield|photo|thumbnail|gif|nano.?banana|generate_image|^generate$", re.I)
BROWSER = re.compile(r"claude-in-chrome|chrome-browser|agent-browser|browser_", re.I)
MEDIA_FILE = re.compile(r"\.(png|jpe?g|gif|webp|heic|svg|mp4|mov|webm|m4v|avi|mkv)$", re.I)
DOC_TOOL = re.compile(r"docx|pptx|xlsx|\bpdf\b|_pdf|pdf_|slides?|spreadsheet|sheets?|claude_docs|google_drive|documents?|word", re.I)
ARTIFACT_TOOL = re.compile(r"artifact", re.I)
DOC_FILE = re.compile(r"\.(docx?|pptx?|xlsx?|pdf|odt|rtf|key|pages)$", re.I)
CODE_COMMAND = re.compile(r"\b(git (commit|push|merge|rebase|checkout|switch)|npm (run|test|install|ci)|npx|pnpm|yarn|bun|pytest|jest|vitest|tsc|cargo|go (build|test|run)|dotnet|msbuild|gradle|mvn|make|claude plugin (test|validate))\b")
RESEARCH = re.compile(r"websearch|webfetch|web_search|fetch|search_web|transcript|youtube|yt-dlp|context7|scrape|deep-research|research|claude-in-chrome|chrome-browser|agent-browser|browser_", re.I)
DOWNLOAD = re.compile(r"yt-dlp|\b(curl|wget)\b[^|;&\n]*https?://")

# The same shell rule as writesOutsideTmp() in hooks/report-logic.ts.
SCRIPT_WRITE = re.compile(r"""\b(python3?|node)\b[\s\S]*(open\([^)]*['"][wax]\+?['"]|write_text|\.write\(|writeFileSync|json\.dump)""")
QUOTED_PATH = re.compile(r"""['"]((?:~|\.{1,2})?/?[\w.@~-]+(?:/[\w.@~-]+)*\.[A-Za-z]\w{0,5}|/[\w.@~-]+(?:/[\w.@~-]+)+)['"]""")


def words(segment):
    return [re.sub(r"""^['"]|['"]$""", "", w) for w in re.findall(r""""[^"]*"|'[^']*'|\S+""", segment)]


def shell_targets(line):
    out = []
    for segment in re.split(r"&&|\|\||;|\|", line):
        ws = words(segment.strip())
        for i, w in enumerate(ws):
            if w in (">", ">>"):
                out.append(ws[i + 1] if i + 1 < len(ws) else "")
            elif re.match(r"^>>?[^>&]", w):
                out.append(re.sub(r"^>>?", "", w))
        args = [w for w in ws if not re.match(r"^\w+=", w)]
        cmd = args[0] if args else ""
        rest = [w for w in args[1:] if not w.startswith("-") and not w.startswith(">") and not re.match(r"^\d?>", w)]
        if cmd in ("tee", "rm", "mkdir", "touch"):
            out += rest
        elif cmd in ("cp", "mv") and len(rest) > 1:
            out.append(rest[-1])
        elif cmd == "sed" and any(re.match(r"^-i", a) for a in args) and rest:
            out.append(rest[-1])
    return [p for p in out if p]


def writes_outside_tmp(command):
    """True when a shell command changed a file outside /tmp."""
    env = {}
    for m in re.finditer(r"""(?:^|[\s;&])([A-Za-z_]\w*)=("([^"]*)"|'([^']*)'|([^\s;&]+))""", command):
        env[m.group(1)] = next((g for g in (m.group(3), m.group(4), m.group(5)) if g is not None), "")
    text = re.sub(r"\$\{?([A-Za-z_]\w*)\}?", lambda m: env.get(m.group(1), m.group(0)), command)
    cd = re.search(r"""(?:^|[\s;&(])cd\s+("([^"]+)"|'([^']+)'|([^\s;&|]+))""", text)
    cwd = "" if cd is None else next((g for g in (cd.group(2), cd.group(3), cd.group(4)) if g is not None), "")

    targets, heredoc = [], None
    for line in text.split("\n"):
        if heredoc is not None:
            if line.strip() == heredoc:
                heredoc = None
            continue
        targets += shell_targets(line)
        opens = re.search(r"""<<-?\s*['"]?(\w+)['"]?""", line)
        if opens:
            heredoc = opens.group(1)
    if SCRIPT_WRITE.search(text):
        targets += [m.group(1) for m in QUOTED_PATH.finditer(text)]

    def is_tmp(p):
        return p.startswith("/tmp/") or p == "/tmp" or (not p.startswith("/") and not p.startswith("~") and (cwd.startswith("/tmp/") or cwd == "/tmp"))

    return any(not p.startswith("/dev/") and not re.match(r"^\w+://", p) and not is_tmp(p) for p in targets)


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
        out.append(("bash", inp["command"][:4000]))
    return out


def classify(signals):
    tools = [v for k, v in signals if k == "tool"]
    files = [v for k, v in signals if k == "file"]
    commands = [v for k, v in signals if k == "bash"]
    if any(MAIL.search(t) for t in tools):
        return "emails"
    if any(MEDIA_TOOL.search(t) and not BROWSER.search(t) for t in tools) or any(MEDIA_FILE.search(f) for f in files):
        return "media"
    if any(DOC_TOOL.search(t) for t in tools) or any(DOC_FILE.search(f) for f in files):
        return "documents"
    if any(ARTIFACT_TOOL.search(t) for t in tools):
        return "artifacts"
    if files or any(CODE_COMMAND.search(c) or writes_outside_tmp(c) for c in commands):
        return "coding"
    if any(RESEARCH.search(t) for t in tools) or any(DOWNLOAD.search(c) for c in commands):
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


def tokens_in(path, seen, until):
    """(local day, model, input, output, cache read, cache write) for each response not yet seen."""
    out = []
    for o in rows(path):
        if o.get("type") != "assistant":
            continue
        m = o.get("message") or {}
        usage, model, t = m.get("usage"), m.get("model"), parse_time(o.get("timestamp"))
        if not isinstance(usage, dict) or not model or model == "<synthetic>" or t is None or t > until:
            continue
        # One response is saved as several rows, one per content block, each repeating its usage.
        key = (m.get("id"), o.get("requestId"))
        if key[0] is None or key in seen:
            continue
        seen.add(key)
        parts = [usage.get(k) for k in ("input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens")]
        parts = [n if isinstance(n, int) and n > 0 else 0 for n in parts]
        if sum(parts) > 0:
            out.append((t.astimezone().strftime("%Y-%m-%d"), model, *parts))
    return out


def main():
    parser = argparse.ArgumentParser(description="Estimate the Work Report's past from saved sessions.")
    parser.add_argument("--refresh", action="store_true", help="move the cutoff up to now")
    args = parser.parse_args()

    now = datetime.now().astimezone()
    until, cutoff_day, generated = now, now.strftime("%Y-%m-%d"), now.isoformat(timespec="seconds")
    tokens_until = None
    if not args.refresh and os.path.exists(OUT):
        try:
            with open(OUT, encoding="utf-8") as fh:
                previous = json.load(fh)
            until = datetime.fromisoformat(previous["generatedAt"])
            cutoff_day, generated = previous["cutoffDay"], previous["generatedAt"]
            tokens_until = previous.get("tokensUntil")
        except (OSError, ValueError, KeyError):
            pass
    # Tokens were not counted before this version: the first run that counts them sets their own cutoff.
    tokens_generated = tokens_until if not args.refresh and isinstance(tokens_until, str) else now.isoformat(timespec="seconds")
    tokens_until_time = datetime.fromisoformat(tokens_generated)

    days = defaultdict(lambda: {"kinds": {k: 0 for k in KINDS}, "models": defaultdict(int),
                                "tokens": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0}, "modelTokens": defaultdict(int)})
    # Sessions run from Claude's own scratch space (/tmp/claude-*) are test runs, not your work.
    files = [p for p in glob.glob(os.path.join(PROJECTS, "*", "*.jsonl")) if not os.path.basename(os.path.dirname(p)).startswith("-tmp-")]
    total, total_tokens, seen = 0, 0, set()
    for n, path in enumerate(files, 1):
        helpers = glob.glob(os.path.join(os.path.splitext(path)[0], "subagents", "*.jsonl"))
        for source in [path, *helpers]:
            for day, model, inp, out, read, write in tokens_in(source, seen, tokens_until_time):
                t = days[day]["tokens"]
                t["input"], t["output"], t["cacheRead"], t["cacheWrite"] = t["input"] + inp, t["output"] + out, t["cacheRead"] + read, t["cacheWrite"] + write
                days[day]["modelTokens"][model] += inp + out + read + write
                total_tokens += inp + out + read + write
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
        "tokensUntil": tokens_generated,
        "days": {d: {"kinds": v["kinds"], "models": dict(v["models"]), "tokens": v["tokens"], "modelTokens": dict(v["modelTokens"])}
                 for d, v in sorted(days.items())},
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as fh:
        json.dump(history, fh, separators=(",", ":"))
    kinds = {k: sum(v["kinds"][k] for v in days.values()) for k in KINDS}
    print(f"wrote {OUT}: {total} tasks over {len(days)} days, {min(days, default='-')} to {max(days, default='-')}, up to {generated}")
    print("by kind: " + ", ".join(f"{k} {n}" for k, n in kinds.items()))
    print(f"tokens: {total_tokens:,} up to {tokens_generated}")


if __name__ == "__main__":
    main()
