#!/usr/bin/env python3
"""
Hyperframes-style variant generator.

Take ONE master 9:16 short and produce N ad-ready variants by compositing:
  - Hook text overlays (positioned top/bottom, randomized CTA copy)
  - Gradient washes (randomized brand colors)
  - Frame padding for IG/TikTok/YouTube Shorts origins
  - Live "credits" badges rotated by variant id

No third-party services. Just Pillow + ffmpeg. Output is H.264 + AAC where
the source provides audio, or silent H.264 for short-form reels that mute
by default.

Usage:
    python3 variants.py \
        --input master_short.mp4 \
        --output-dir ./variants \
        --count 25 \
        --aspect 9:16 \
        --logo /path/to/logo.png
"""
from __future__ import annotations

import argparse
import json
import os
import random
import shutil
import subprocess
import sys
from dataclasses import dataclass, asdict
from pathlib import Path

try:
    from PIL import Image, ImageDraw, ImageFont
except ImportError:
    print("Missing dependency: pip install Pillow", file=sys.stderr)
    sys.exit(2)


# Brand-safe hook and CTA pools. Add to these without touching layout code.
HOOKS = [
    "Stop scrolling.",
    "Here's what nobody tells you:",
    "I tried this for 7 days.",
    "Three reasons this works:",
    "The truth about {topic}.",
    "Most people get this wrong.",
    "Watch this before you {action}.",
    "If you're seeing this, it's for you.",
]
CTAS = [
    "Tap the link in bio",
    "Comment 'YES' to get started",
    "Save this for later",
    "Follow for part 2",
    "DM us 'READY'",
    "Share with someone who needs this",
    "Book your free call →",
    "Try it free for 14 days",
]
TOPICS = ["content", "growth", "marketing", "editing", "posting", "strategy"]
ACTIONS = ["post", "shoot", "publish", "launch", "scale", "edit"]


@dataclass
class VariantSpec:
    variant_id: int
    hook: str
    cta: str
    accent: str  # hex color
    bg_tint: str  # hex color
    placement: str  # "top" | "center" | "bottom"
    seed: int


def _font(size: int) -> ImageFont.FreeTypeFont:
    """Best-effort cross-platform font loader. Falls back to PIL default."""
    candidates = [
        "/System/Library/Fonts/Helvetica.ttc",
        "/System/Library/Fonts/SFNSDisplay.ttf",
        "/Library/Fonts/Arial.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    ]
    for p in candidates:
        if os.path.exists(p):
            try:
                return ImageFont.truetype(p, size)
            except Exception:
                continue
    return ImageFont.load_default()


def _probe(path: Path) -> tuple[int, int, float]:
    """Return (width, height, duration_seconds)."""
    out = subprocess.check_output([
        "ffprobe", "-v", "error",
        "-select_streams", "v:0",
        "-show_entries", "stream=width,height:format=duration",
        "-of", "json", str(path)
    ], text=True)
    data = json.loads(out)
    s = data["streams"][0]
    d = float(data.get("format", {}).get("duration", 0))
    return int(s["width"]), int(s["height"]), d


def _overlay_frame(width: int, height: int, spec: VariantSpec) -> Image.Image:
    """Render the static hook/CTA overlay PNG."""
    img = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    # Soft tint band across the top or bottom 30% of the frame
    band_h = int(height * 0.30)
    if spec.placement == "top":
        y0 = 0
    elif spec.placement == "center":
        y0 = (height - band_h) // 2
    else:
        y0 = height - band_h
    tint = _hex_to_rgba(spec.bg_tint, alpha=140)
    draw.rectangle([(0, y0), (width, y0 + band_h)], fill=tint)

    # Accent stripe
    accent = _hex_to_rgba(spec.accent, alpha=255)
    if spec.placement == "top":
        draw.rectangle([(0, y0 + band_h - 6), (width, y0 + band_h)], fill=accent)
    elif spec.placement == "center":
        draw.rectangle([(0, y0), (width, y0 + 6)], fill=accent)
        draw.rectangle([(0, y0 + band_h - 6), (width, y0 + band_h)], fill=accent)
    else:
        draw.rectangle([(0, y0), (width, y0 + 6)], fill=accent)

    # Hook text
    hook_font = _font(int(height * 0.075))
    cta_font = _font(int(height * 0.045))
    pad = int(width * 0.06)

    if spec.placement == "top":
        ty_hook = y0 + int(band_h * 0.20)
        ty_cta = y0 + int(band_h * 0.65)
    elif spec.placement == "center":
        ty_hook = y0 + int(band_h * 0.25)
        ty_cta = y0 + int(band_h * 0.60)
    else:
        ty_hook = y0 + int(band_h * 0.18)
        ty_cta = y0 + int(band_h * 0.55)

    draw.text((pad, ty_hook), spec.hook, font=hook_font, fill=(255, 255, 255, 255))
    draw.text((pad, ty_cta), spec.cta, font=cta_font, fill=_hex_to_rgba(spec.accent, alpha=255))

    # Variant badge bottom-right corner
    badge_font = _font(int(height * 0.028))
    badge = f"#{spec.variant_id:02d}"
    bbox = draw.textbbox((0, 0), badge, font=badge_font)
    bw, bh = bbox[2] - bbox[0], bbox[3] - bbox[1]
    bx = width - bw - pad
    by = height - bh - pad
    draw.rectangle([(bx - 12, by - 6), (bx + bw + 12, by + bh + 6)], fill=accent)
    draw.text((bx, by), badge, font=badge_font, fill=(0, 0, 0, 255))
    return img


def _hex_to_rgba(hex_color: str, alpha: int = 255) -> tuple[int, int, int, int]:
    h = hex_color.lstrip("#")
    return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16), alpha)


def _brand_palette() -> list[str]:
    return ["#F78166", "#58A6FF", "#3FB950", "#FFD33D", "#BC8AFF", "#FF6B9D"]


def _generate_specs(count: int, seed: int) -> list[VariantSpec]:
    rng = random.Random(seed)
    palette = _brand_palette()
    placements = ["top", "center", "bottom"]
    specs = []
    for i in range(count):
        hook = rng.choice(HOOKS).format(
            topic=rng.choice(TOPICS),
            action=rng.choice(ACTIONS),
        )
        specs.append(VariantSpec(
            variant_id=i + 1,
            hook=hook,
            cta=rng.choice(CTAS),
            accent=rng.choice(palette),
            bg_tint=rng.choice(["#0d1117", "#161b22", "#1f2937", "#0a0e14"]),
            placement=rng.choice(placements),
            seed=rng.randint(1, 10_000_000),
        ))
    return specs


def generate(input_path: Path, output_dir: Path, count: int, logo: Path | None, seed: int = 42) -> list[dict]:
    output_dir.mkdir(parents=True, exist_ok=True)
    width, height, _ = _probe(input_path)
    specs = _generate_specs(count, seed)

    manifest = []
    for spec in specs:
        overlay = _overlay_frame(width, height, spec)
        overlay_path = output_dir / f"v{spec.variant_id:02d}_overlay.png"
        overlay.save(overlay_path)
        out_mp4 = output_dir / f"v{spec.variant_id:02d}_short.mp4"

        # Burn overlay into the master via ffmpeg, copy audio if present
        logo_filter = []
        if logo and logo.exists():
            logo_filter = [
                "-i", str(logo),
                "-filter_complex",
                f"[1:v]scale=iw*0.18:-1[lg];[0:v][lg]overlay=W-w-30:H-h-30[v]",
                "-map", "[v]", "-map", "0:a?",
            ]
        else:
            logo_filter = ["-map", "0:v", "-map", "0:a?"]

        overlay_arg = [
            "-i", str(overlay_path),
            "-filter_complex",
            f"[0:v][1:v]overlay=0:0:format=auto[v]",
            "-map", "[v]", "-map", "0:a?",
        ] if not logo_filter else overlay_arg_override(overlay_path, logo)

        cmd = [
            "ffmpeg", "-y", "-i", str(input_path),
            *overlay_arg,
            "-c:v", "libx264", "-crf", "18", "-preset", "veryfast",
            "-pix_fmt", "yuv420p",
            "-c:a", "aac", "-b:a", "128k",
            "-movflags", "+faststart",
            "-shortest",
            str(out_mp4),
        ]
        try:
            subprocess.check_output(cmd, stderr=subprocess.STDOUT)
        except subprocess.CalledProcessError as e:
            print(f"[variant {spec.variant_id}] ffmpeg failed: {e.output.decode()}", file=sys.stderr)
            continue

        manifest.append({
            **asdict(spec),
            "overlay": str(overlay_path),
            "output": str(out_mp4),
            "size_bytes": out_mp4.stat().st_size,
        })

    manifest_path = output_dir / "manifest.json"
    manifest_path.write_text(json.dumps(manifest, indent=2))
    return manifest


def overlay_arg_override(overlay_path: Path, logo: Path | None) -> list[str]:
    """Compose overlay with optional logo watermark."""
    if not logo or not logo.exists():
        return [
            "-i", str(overlay_path),
            "-filter_complex", "[0:v][1:v]overlay=0:0:format=auto[v]",
            "-map", "[v]", "-map", "0:a?",
        ]
    return [
        "-i", str(overlay_path),
        "-i", str(logo),
        "-filter_complex",
        f"[2:v]scale=iw*0.18:-1[lg];[0:v][1:v]overlay=0:0[bg];[bg][lg]overlay=W-w-30:H-h-30[v]",
        "-map", "[v]", "-map", "0:a?",
    ]


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="Hyperframes-style 1→N variant generator.")
    p.add_argument("--input", required=True, type=Path)
    p.add_argument("--output-dir", required=True, type=Path)
    p.add_argument("--count", type=int, default=25)
    p.add_argument("--logo", type=Path, default=None)
    p.add_argument("--seed", type=int, default=42)
    args = p.parse_args(argv)

    if not args.input.exists():
        print(f"Input not found: {args.input}", file=sys.stderr)
        return 2

    manifest = generate(args.input, args.output_dir, args.count, args.logo, args.seed)
    print(json.dumps({
        "ok": True,
        "count": len(manifest),
        "output_dir": str(args.output_dir),
        "manifest": str(args.output_dir / "manifest.json"),
    }, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
