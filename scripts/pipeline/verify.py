#!/usr/bin/env python3
import subprocess
import sys
from pathlib import Path

def verify_video(file_path):
    """Verifies resolution and aspect ratio of the output video."""
    print(f"Verifying {file_path}...")

    # ffprobe command to get width and height
    cmd = [
        "ffprobe", "-v", "error", "-select_streams", "v:0",
        "-show_entries", "stream=width,height", "-of", "json", str(file_path)
    ]

    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        print(f"ffprobe failed: {result.stderr}")
        return False

    import json
    data = json.loads(result.stdout)
    width = data['streams'][0]['width']
    height = data['streams'][0]['height']

    print(f"Resolution: {width}x{height}")

    # Check for 9:16 aspect ratio (approx)
    ratio = width / height
    is_vertical = 0.55 <= ratio <= 0.57 # 9/16 = 0.5625

    if is_vertical and width == 1080 and height == 1920:
        print("✅ Quality Check Passed: Valid 1080x1920 vertical video.")
        return True
    else:
        print("❌ Quality Check Failed: Incorrect resolution or aspect ratio.")
        return False

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python3 verify.py <video_file>")
        sys.exit(1)

    success = verify_video(sys.argv[1])
    sys.exit(0 if success else 1)
