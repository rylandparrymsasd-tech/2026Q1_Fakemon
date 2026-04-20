#!/usr/bin/env python3
"""
sanitize_fakemon.py
───────────────────
Replaces every forbidden word/pattern in ./fakemon/*.json with a string
of ? characters (same length as the matched text).

ONLY touches .json files inside the fakemon folder.
Never touches .html, .js, or any other file.

Usage:
    python sanitize_fakemon.py                  # dry-run (shows what would change)
    python sanitize_fakemon.py --apply          # actually write the changes
    python sanitize_fakemon.py --dir path/to/fakemon --apply

Dry-run is the default — you must pass --apply to write anything.
"""

import re
import os
import sys
import glob
import argparse
from datetime import datetime

# ─────────────────────────────────────────────────────────────────────────────
#  FORBIDDEN PATTERNS  (identical list to scan_fakemon.py)
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
    r"[\U0001F1E6-\U0001F1FF]{2}",
    r"\b(?:american|british|chinese|russian|german|french|mexican|"
    r"canadian|japanese|korean|israeli|palestinian|ukrainian|iranian|"
    r"north\s*korean|cuban)\s*flag\b",
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
#  SANITIZER
# ─────────────────────────────────────────────────────────────────────────────

def replacement_for(matched_text):
    """
    Returns a string of ? characters the same length as matched_text.
    Flag emojis are multi-byte but display as one character; count by
    len() so the JSON file remains valid after substitution.
    """
    return "?" * len(matched_text)


def sanitize_text(text):
    """
    Applies all forbidden patterns to `text`, replacing each match with ?.
    Returns (new_text, list_of_changes) where each change is
        (category, original_match, start_pos)
    """
    changes = []

    # Build one combined pass: collect all spans first, then replace
    # from right to left so positions stay valid.
    hits = []
    for category, pattern in FORBIDDEN:
        for m in pattern.finditer(text):
            hits.append((m.start(), m.end(), category, m.group(0)))

    if not hits:
        return text, []

    # Sort by start position descending so we replace from the end
    hits.sort(key=lambda h: h[0], reverse=True)

    # Deduplicate overlapping spans (keep the leftmost/longest)
    deduped = []
    occupied = set()
    for start, end, category, matched in hits:
        span = range(start, end)
        if not any(i in occupied for i in span):
            deduped.append((start, end, category, matched))
            occupied.update(span)

    # Apply replacements (already sorted right-to-left)
    result = list(text)
    for start, end, category, matched in deduped:
        replacement = list(replacement_for(matched))
        result[start:end] = replacement
        changes.append((category, matched, start))

    return "".join(result), changes


def sanitize_file(filepath, apply=False):
    """
    Reads filepath, sanitizes its content, and optionally writes it back.
    Returns (changed: bool, changes: list)
    """
    try:
        with open(filepath, "r", encoding="utf-8", errors="replace") as f:
            original = f.read()
    except OSError as e:
        print(f"  ERROR reading {filepath}: {e}")
        return False, []

    sanitized, changes = sanitize_text(original)

    if not changes:
        return False, []

    if apply:
        try:
            with open(filepath, "w", encoding="utf-8") as f:
                f.write(sanitized)
        except OSError as e:
            print(f"  ERROR writing {filepath}: {e}")
            return False, changes

    return True, changes


def sanitize_all(fakemon_dir, apply=False):
    pattern   = os.path.join(fakemon_dir, "*.json")
    all_files = sorted(glob.glob(pattern))

    if not all_files:
        print(f"[sanitize_fakemon] No .json files found in: {fakemon_dir}")
        return

    mode = "APPLYING CHANGES" if apply else "DRY RUN (no files written)"
    print(f"[sanitize_fakemon] {mode}")
    print(f"[sanitize_fakemon] Processing {len(all_files)} file(s) in '{fakemon_dir}' …\n")

    total_files_changed = 0
    total_replacements  = 0

    for filepath in all_files:
        name = os.path.basename(filepath)
        changed, changes = sanitize_file(filepath, apply=apply)

        if not changed:
            print(f"  ✓  no changes  {name}")
        else:
            total_files_changed += 1
            total_replacements  += len(changes)
            action = "WROTE" if apply else "WOULD CHANGE"
            print(f"  ⚠  {action}      {name}  ({len(changes)} replacement(s))")
            for category, matched, pos in sorted(changes, key=lambda c: c[2]):
                print(f"       [{category}]  '{matched}'  @ char {pos}")

    print(f"\n[sanitize_fakemon] Summary: {total_files_changed} file(s) affected, "
          f"{total_replacements} replacement(s) total.")

    if not apply and total_files_changed > 0:
        print("\n[sanitize_fakemon] This was a DRY RUN. To apply these changes, run:")
        print("    python sanitize_fakemon.py --apply")


# ─────────────────────────────────────────────────────────────────────────────
#  MAIN
# ─────────────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description=(
            "Replace forbidden content in fakemon/*.json with ? characters. "
            "Dry-run by default; pass --apply to write changes."
        )
    )
    parser.add_argument(
        "--dir", default="fakemon",
        help="Path to the fakemon folder (default: ./fakemon)"
    )
    parser.add_argument(
        "--apply", action="store_true",
        help="Actually write the sanitized files (default: dry-run only)"
    )
    args = parser.parse_args()

    if not os.path.isdir(args.dir):
        print(f"ERROR: Directory not found: '{args.dir}'")
        sys.exit(2)

    sanitize_all(args.dir, apply=args.apply)


if __name__ == "__main__":
    main()