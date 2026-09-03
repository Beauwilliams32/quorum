#!/usr/bin/env python3
import subprocess
import json
import os
import sys
from pathlib import Path

# Configuration
FFMPEG_BIN = "ffmpeg"
OUTPUT_DIR = Path("./output_shorts")
INPUT_VIDEO = ""

def run_cmd(cmd):
    print(f"Executing: {' '.join(cmd)}")
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        print(f"Error: {result.stderr}")
        sys.exit(1)
    return result.stdout

def convert_to_vertical(input_path, output_path):
    """Converts landscape to 9:16 center-crop vertical."""
    print("Step 1: Converting to vertical format...")
    cmd = [
        FFMPEG_BIN, "-i", str(input_path),
        "-vf", "crop=ih*9/16:ih:(iw-ih*9/16)/2:0,scale=1080:1920",
        "-c:v", "libx264", "-crf", "18", "-preset", "slow",
        "-c:a", "aac", "-b:a", "192k",
        "-movflags", "+faststart",
        "-y", str(output_path)
    ]
    run_cmd(cmd)

def cut_segment(input_path, start, end, output_name):
    """Cuts a specific segment losslessly."""
    print(f"Step 3: Cutting segment {output_name} from {start} to {end}...")
    cmd = [
        FFMPEG_BIN, "-ss", start, "-to", end,
        "-i", str(input_path),
        "-c", "copy", "-y", str(OUTPUT_DIR / output_name)
    ]
    run_cmd(cmd)

def main(input_file, segments_json):
    # 1. Setup
    INPUT_PATH = Path(input_file)
    VERTICAL_TEMP = OUTPUT_DIR / "temp_vertical.mp4"
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    # 2. Ingest & Convert
    convert_to_vertical(INPUT_PATH, VERTICAL_TEMP)

    # 3. Process Segments (Assuming JSON from Claude-Video)
    try:
        data = json.loads(segments_json)
    except json.JSONDecodeError:
        print("Invalid segments JSON provided.")
        return

    for i, seg in enumerate(data):
        filename = f"short_{i+1}_{seg.get('hook_type', 'segment')}.mp4"
        cut_segment(VERTICAL_TEMP, seg['start'], seg['end'], filename)

    # 4. Cleanup
    if VERTICAL_TEMP.exists():
        os.remove(VERTICAL_TEMP)

    print(f"Successfully exported {len(data)} shorts to {OUTPUT_DIR}")

if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("Usage: python3 repurpose.py <input_video> '<json_segments>'")
        sys.exit(1)

    main(sys.argv[1], sys.argv[2])
