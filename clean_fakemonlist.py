import os
import json
from pathlib import Path

fakemon_dir = Path("fakemon")
output_file = fakemon_dir / "fakemonlist.json"

# Get all json files except fakemonlist.json
files = sorted([
    f.stem for f in fakemon_dir.glob("*.json")
    if f.name != "fakemonlist.json"
])

with open(output_file, "w") as f:
    json.dump({"fakemon": files}, f, indent=2)

print(f"Updated fakemonlist.json with {len(files)} fakemon:")
for name in files:
    print(f"  {name}")