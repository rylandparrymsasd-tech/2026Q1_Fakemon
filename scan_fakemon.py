#!/usr/bin/env python3
"""
scan_fakemon.py
───────────────
READ-ONLY. Scans every .json file in ./fakemon/ for forbidden content.
Writes a flagged_files.md report. Never modifies any file.

Usage:
    python scan_fakemon.py
    python scan_fakemon.py --dir path/to/fakemon
    python scan_fakemon.py --out my_report.md

Exit codes:
    0 — nothing flagged
    1 — at least one file flagged
    2 — usage / directory error
"""

import re
import os
import sys
import glob
import argparse
from datetime import datetime

# ─────────────────────────────────────────────────────────────────────────────
#  FORBIDDEN PATTERNS
#  Each entry: (category_label, compiled_regex)
#  All matching is case-insensitive on the raw file text.
# ─────────────────────────────────────────────────────────────────────────────

FORBIDDEN = []

def add(category, *patterns):
    for p in patterns:
        FORBIDDEN.append((category, re.compile(p, re.IGNORECASE)))

# ── Profanity ──────────────────────────────────────────────────────────────
add("Profanity",
    r"\bass(?:es|hole)?\b",
    r"\bbitch(?:es)?\b",
    r"\bbastard\b",
    r"\bcrap\b",
    r"\bdamn\b",
    r"\bdick\b",
    r"f+u+c+k+",
    r"sh[i1!]+t+",
    r"\bpiss\b",
    r"\bpussy\b",
    r"\bcunt\b",
    r"\bslut\b",
    r"\bwhore\b",
    r"\bcock\b",
    r"\bwtf\b",
    r"\bstfu\b",
    r"\bomfg\b",
)

# ── Slurs ──────────────────────────────────────────────────────────────────
add("Slur",
    r"\bnigger\b",
    r"\bnigga\b",
    r"\bfaggot\b",
    r"\bretard\b",
    r"\bdyke\b",
    r"\bkike\b",
    r"\bspic\b",
    r"\bwetback\b",
    r"\bchink\b",
    r"\bgook\b",
    r"\bcoon\b",
)

# ── Sexual / pornographic ──────────────────────────────────────────────────
add("Sexual/Pornographic",
    r"\bporn\b",
    r"\bxxx\b",
    r"\bnudes?\b",
    r"\bsex\b",
    r"\bsexual\b",
    r"\berotic\b",
    r"\bfetish\b",
    r"\bboobs?\b",
    r"\bpenis\b",
    r"\bvagina\b",
    r"\bmasturbat\w*",
    r"\borgasm\b",
    r"\bhentai\b",
    r"\bnsfw\b",
    r"\bnaked\b",
    r"\bstriptease\b",
    r"\bintercourse\b",
)

# ── Political ──────────────────────────────────────────────────────────────
add("Political",
    r"\btrump\b",
    r"\bbiden\b",
    r"\bobama\b",
    r"\bclinton\b",
    r"\brepublican\b",
    r"\bdemocrat\b",
    r"\bgop\b",
    r"\bliberal\b",
    r"\bconservative\b",
    r"\bsocialist\b",
    r"\bcommunist\b",
    r"\bfascist\b",
    r"\bnazi\b",
    r"\bblm\b",
    r"\bantifa\b",
    r"\bmaga\b",
    r"\babortion\b",
    r"\bpro-?life\b",
    r"\bpro-?choice\b",
    r"\binsurrection\b",
    r"\bpropaganda\b",
)

# ── Country / national flags (emoji + text) ────────────────────────────────
add("Flag/Nationalism",
    # Any Unicode regional indicator pair = a flag emoji (🇺🇸 🇬🇧 etc.)
    r"[\U0001F1E6-\U0001F1FF]{2}",
    # Text descriptions of national flags
    r"\b(?:american|british|chinese|russian|german|french|mexican|"
    r"canadian|japanese|korean|israeli|palestinian|ukrainian|iranian|"
    r"north\s*korean|cuban)\s*flag\b",
    # Emoji shortcode flags  :flag_us:  :flag_gb:  etc.
    r":flag_[a-z_]+:",
)

# ── Self-harm / crisis ─────────────────────────────────────────────────────
add("Self-Harm/Crisis",
    r"\bsuicide\b",
    r"\bself-?harm\b",
    r"\bkill\s+myself\b",
    r"\bslit\s+(?:my\s+)?wrist",
    r"\bhang\s+myself\b",
)

# ── Drug references ────────────────────────────────────────────────────────
add("Drugs",
    r"\bweed\b",
    r"\bmarijuana\b",
    r"\bcocaine\b",
    r"\bheroin\b",
    r"\bmeth\b",
    r"\bcrack\b",
    r"\bget\s+high\b",
    r"\bstoned\b",
    r"\bblazed\b",
)


# ─────────────────────────────────────────────────────────────────────────────
#  SCANNER
# ─────────────────────────────────────────────────────────────────────────────

def scan_file(filepath):
    """
    Returns a list of findings:
        [(line_number, category, matched_text, full_line_content), ...]
    """
    findings = []
    try:
        with open(filepath, "r", encoding="utf-8", errors="replace") as f:
            lines = f.readlines()
    except OSError as e:
        return [("ERR", "File Read Error", str(e), "")]

    for lineno, line in enumerate(lines, start=1):
        seen_on_this_line = set()   # deduplicate multiple hits of same pattern on same line
        for category, pattern in FORBIDDEN:
            for match in pattern.finditer(line):
                key = (lineno, match.group(0).lower())
                if key not in seen_on_this_line:
                    seen_on_this_line.add(key)
                    findings.append((lineno, category, match.group(0), line.rstrip()))

    return findings


def scan_all(fakemon_dir):
    """
    Scans all *.json files in fakemon_dir.
    Returns:
        all_files  — list of every .json path scanned
        flagged    — dict { filepath: [findings] } for files WITH hits
    """
    pattern   = os.path.join(fakemon_dir, "*.json")
    all_files = sorted(glob.glob(pattern))

    if not all_files:
        print(f"[scan_fakemon] No .json files found in: {fakemon_dir}")
        return all_files, {}

    print(f"[scan_fakemon] Scanning {len(all_files)} file(s) in '{fakemon_dir}' …\n")

    flagged = {}
    for filepath in all_files:
        findings = scan_file(filepath)
        name     = os.path.basename(filepath)
        if findings:
            flagged[filepath] = findings
            print(f"  ⚠  FLAGGED  {name}  ({len(findings)} hit(s))")
        else:
            print(f"  ✓  clean    {name}")

    return all_files, flagged


# ─────────────────────────────────────────────────────────────────────────────
#  REPORT WRITER
# ─────────────────────────────────────────────────────────────────────────────

def write_report(flagged, total_scanned, output_path="flagged_files.md"):
    now   = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    lines = []

    lines.append("# Fakemon Content Scan Report")
    lines.append(f"\n**Generated:** {now}  ")
    lines.append(f"**Files scanned:** {total_scanned}  ")
    lines.append(f"**Files flagged:** {len(flagged)}  ")
    lines.append("\n---\n")

    if not flagged:
        lines.append("✅ **No issues found.** All files passed the content scan.")
    else:
        lines.append(
            "> ⚠️ The files below contain potentially inappropriate content.\n"
            "> Review each entry and decide whether to edit or reject the pull request.\n"
            "> To auto-replace all flagged text with `?`, run:\n"
            "> ```\n"
            "> python sanitize_fakemon.py\n"
            "> ```\n"
        )

        for filepath, findings in flagged.items():
            filename = os.path.basename(filepath)
            lines.append(f"## 🚩 `{filename}`\n")
            lines.append(f"**{len(findings)} hit(s)**\n")
            lines.append("| Line | Category | Matched Text | Full Line |")
            lines.append("|------|----------|--------------|-----------|")
            for lineno, category, matched, content in findings:
                safe_matched = matched.replace("|", "\\|")
                safe_content = content.strip().replace("|", "\\|")
                if len(safe_content) > 120:
                    safe_content = safe_content[:117] + "…"
                lines.append(
                    f"| {lineno} | {category} | `{safe_matched}` | `{safe_content}` |"
                )
            lines.append("")   # blank line between file sections

    report_text = "\n".join(lines) + "\n"

    with open(output_path, "w", encoding="utf-8") as f:
        f.write(report_text)

    print(f"\n[scan_fakemon] Report written → {output_path}")


# ─────────────────────────────────────────────────────────────────────────────
#  MAIN
# ─────────────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description="Scan fakemon/*.json for forbidden content. READ-ONLY — never modifies files."
    )
    parser.add_argument(
        "--dir", default="fakemon",
        help="Path to the fakemon folder (default: ./fakemon)"
    )
    parser.add_argument(
        "--out", default="flagged_files.md",
        help="Output report file path (default: flagged_files.md)"
    )
    args = parser.parse_args()

    if not os.path.isdir(args.dir):
        print(f"ERROR: Directory not found: '{args.dir}'")
        sys.exit(2)

    all_files, flagged = scan_all(args.dir)
    write_report(flagged, total_scanned=len(all_files), output_path=args.out)

    if flagged:
        print(f"\n[scan_fakemon] ⚠  {len(flagged)} file(s) flagged. See {args.out}")
        sys.exit(1)
    else:
        print("\n[scan_fakemon] ✅ All files clean.")
        sys.exit(0)


if __name__ == "__main__":
    main()