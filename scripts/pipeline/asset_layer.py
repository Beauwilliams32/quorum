#!/usr/bin/env python3
"""
Resilient Asset Layer for the Quorum pipeline.

Local-first asset retrieval with stock-footage fallback. When the pipeline
needs a visual (B-roll, ambient shot, brand cutaway) that doesn't exist in
the local media bank, this module decides where to fetch it from based on
cost, license, and availability.

Priority order:
  1. Local Media Bank — ~/WilliamsMedia/generated/incoming/ + per-project roots
  2. FREE direct API — Pexels, Pixabay, Coverr (no third-party markup)
  3. LOCAL generation — ComfyUI / Stable Diffusion (when installed)
  4. CLOUD fallback — Runway / Replicate (only if explicitly approved)

All cloud APIs are gated by the cost envelope in pipeline_budget.json. Cloud
calls require the cost to be <= budget.max_cloud_call_usd AND user approval.

No credentials are read from environment here; pass an `auth` dict whose keys
are provider names mapped to API keys. This module is purely a router + fetcher.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Iterable


# ---------- Types ----------

@dataclass
class AssetQuery:
    """What the pipeline needs."""
    topic: str                 # free-text: "laptop on white desk, soft light"
    duration_sec: float = 5.0
    aspect: str = "9:16"
    prefer_local: bool = True
    allow_cloud: bool = False  # cloud fallback only if user said yes
    max_cloud_cost_usd: float = 0.05


@dataclass
class AssetResult:
    source: str                # "local_bank" | "pexels" | "pixabay" | "coverr" | "comfyui" | "runway" | "replicate" | "none"
    path: str | None            # absolute path on disk once downloaded/copied
    url: str | None             # source URL if applicable
    license: str = "unknown"
    cost_usd: float = 0.0
    note: str = ""


@dataclass
class Budget:
    max_cloud_call_usd: float = 0.10
    daily_cloud_usd: float = 5.00
    _spent_today_usd: float = 0.0

    def can_spend(self, amount: float) -> bool:
        return amount <= self.max_cloud_call_usd and (self._spent_today_usd + amount) <= self.daily_cloud_usd


# ---------- Local Media Bank ----------

# Per the AGENTS.md: "For Williams Media, founder-filmed phone footage is
# primary; drain ~/WilliamsMedia/generated/incoming/ before generating new media."
LOCAL_ROOTS = [
    Path.home() / "WilliamsMedia" / "generated" / "incoming",
    Path.home() / "WilliamsMedia" / "generated",
    Path.home() / "WilliamsMedia" / "archive",
]


def _scan_local(topic: str, duration_sec: float, aspect: str) -> AssetResult | None:
    """Cheap filename/substring match against the local bank."""
    topic_tokens = [t.lower() for t in re.split(r"[^a-z0-9]+", topic) if t]
    if not topic_tokens:
        return None

    candidates: list[tuple[float, Path]] = []
    for root in LOCAL_ROOTS:
        if not root.exists():
            continue
        for p in root.rglob("*"):
            if not p.is_file():
                continue
            if p.suffix.lower() not in {".mp4", ".mov", ".m4v", ".webm", ".hevc"}:
                continue
            name = p.name.lower()
            score = sum(1 for t in topic_tokens if t in name)
            if score > 0:
                candidates.append((score, p))

    if not candidates:
        return None
    candidates.sort(key=lambda x: (-x[0], x[1].stat().st_mtime))
    best = candidates[0][1]
    return AssetResult(
        source="local_bank",
        path=str(best),
        license="local_owner",
        note=f"Filename match score={candidates[0][0]} of {len(candidates)} hits in {best.parent}",
    )


# ---------- FREE Direct APIs ----------

PEXELS_VIDEO_URL = "https://api.pexels.com/videos/search"
PIXABAY_VIDEO_URL = "https://pixabay.com/api/videos/"
COVERR_LISTING_URL = "https://coverr.co/api/v1/videos"


def _http_json(url: str, headers: dict, params: dict, timeout: float = 8.0) -> dict:
    qs = urllib.parse.urlencode(params)
    req = urllib.request.Request(
        f"{url}?{qs}",
        headers=headers,
        method="GET",
    )
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def _http_get(url: str, dest: Path, timeout: float = 30.0) -> None:
    req = urllib.request.Request(url, headers={"User-Agent": "QuorumPipeline/1.0"}, method="GET")
    with urllib.request.urlopen(req, timeout=timeout) as r:
        dest.parent.mkdir(parents=True, exist_ok=True)
        with dest.open("wb") as f:
            shutil.copyfileobj(r, f)


def _pexels(topic: str, api_key: str, aspect: str) -> AssetResult | None:
    aspect_filter = {"9:16": "portrait", "16:9": "landscape", "1:1": "square"}.get(aspect, "landscape")
    try:
        data = _http_json(PEXELS_VIDEO_URL, {"Authorization": api_key}, {
            "query": topic, "per_page": 5, "orientation": aspect_filter,
        })
    except (urllib.error.HTTPError, urllib.error.URLError) as e:
        return AssetResult(source="pexels", path=None, note=f"fetch_failed: {e}")

    videos = data.get("videos", [])
    if not videos:
        return AssetResult(source="pexels", path=None, note="no_results")
    for v in videos:
        files = v.get("video_files", [])
        # Prefer HD vertical/landscape based on aspect
        files_sorted = sorted(files, key=lambda f: -abs(int(f.get("height", 0)) - 1080))
        if not files_sorted:
            continue
        url = files_sorted[0].get("link")
        if not url:
            continue
        dest = Path("/tmp") / f"quorum_pexels_{hashlib.md5(url.encode()).hexdigest()[:10]}.mp4"
        try:
            _http_get(url, dest)
        except (urllib.error.HTTPError, urllib.error.URLError):
            continue
        return AssetResult(
            source="pexels", path=str(dest), url=url,
            license="pexels-license", cost_usd=0.0,
            note=f"{v.get('width')}x{v.get('height')} {v.get('duration')}s",
        )
    return AssetResult(source="pexels", path=None, note="no_downloadable_files")


def _pixabay(topic: str, api_key: str, aspect: str) -> AssetResult | None:
    try:
        data = _http_json(PIXABAY_VIDEO_URL, {}, {
            "key": api_key, "q": topic, "per_page": 5,
            "video_type": "all",
        })
    except (urllib.error.HTTPError, urllib.error.URLError) as e:
        return AssetResult(source="pixabay", path=None, note=f"fetch_failed: {e}")

    hits = data.get("hits", [])
    if not hits:
        return AssetResult(source="pixabay", path=None, note="no_results")
    target_h = 1080
    for h in hits:
        videos = h.get("videos", {})
        candidates = []
        for quality in ("large", "medium", "small", "tiny"):
            if quality in videos:
                v = videos[quality]
                candidates.append((abs(int(v.get("height", 0)) - target_h), v.get("url")))
        candidates.sort()
        for _, url in candidates:
            if not url:
                continue
            dest = Path("/tmp") / f"quorum_pixabay_{hashlib.md5(url.encode()).hexdigest()[:10]}.mp4"
            try:
                _http_get(url, dest)
            except (urllib.error.HTTPError, urllib.error.URLError):
                continue
            return AssetResult(
                source="pixabay", path=str(dest), url=url,
                license="pixabay-license", cost_usd=0.0,
                note=f"{h.get('tags', '')}",
            )
    return AssetResult(source="pixabay", path=None, note="no_downloadable_files")


# ---------- Local Generation (ComfyUI) ----------

def _comfyui_available() -> bool:
    # Default ComfyUI install sits on 8188 if running on host
    try:
        with urllib.request.urlopen("http://127.0.0.1:8188/system_stats", timeout=1.5) as r:
            return r.status == 200
    except Exception:
        return False


def _comfyui(topic: str, duration_sec: float) -> AssetResult | None:
    """Stub: real impl requires a ComfyUI workflow payload. Returns None if unavailable."""
    if not _comfyui_available():
        return None
    # TODO: build workflow JSON for an AnimateDiff / SVD pass
    # For now, signal capability without generating.
    return AssetResult(source="comfyui", path=None, note="available_but_workflow_unspecified")


# ---------- Cloud Fallback (Gated) ----------

def _cloud_blocked(amount: float, budget: Budget, allow_cloud: bool) -> AssetResult | None:
    if not allow_cloud:
        return AssetResult(source="none", path=None, note="cloud_disallowed_by_user")
    if not budget.can_spend(amount):
        return AssetResult(source="none", path=None, note=f"budget_exceeded (need ${amount:.3f})")
    return None  # signal "OK to call cloud"


def _runway(topic: str, api_key: str, duration_sec: float) -> AssetResult | None:
    """Runway Gen-3 minimal stub. Returns None on any failure."""
    try:
        req = urllib.request.Request(
            "https://api.runwayml.com/v1/generate",
            data=json.dumps({"prompt": topic, "duration": int(duration_sec), "model": "gen3a_turbo"}).encode(),
            headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=60) as r:
            data = json.loads(r.read().decode("utf-8"))
        url = data.get("output_url")
        if not url:
            return None
        dest = Path("/tmp") / f"quorum_runway_{int(time.time())}.mp4"
        _http_get(url, dest)
        return AssetResult(source="runway", path=str(dest), url=url,
                           license="runway-toa", cost_usd=0.05, note=f"{duration_sec}s gen3a_turbo")
    except (urllib.error.HTTPError, urllib.error.URLError, json.JSONDecodeError, OSError):
        return None


# ---------- Public API ----------

def fetch_asset(query: AssetQuery, auth: dict, budget: Budget) -> AssetResult:
    """Resolve an asset query through the priority chain."""

    if query.prefer_local:
        local = _scan_local(query.topic, query.duration_sec, query.aspect)
        if local:
            return local

    pexels_key = auth.get("pexels")
    if pexels_key:
        r = _pexels(query.topic, pexels_key, query.aspect)
        if r and r.path:
            return r

    pixabay_key = auth.get("pixabay")
    if pixabay_key:
        r = _pixabay(query.topic, pixabay_key, query.aspect)
        if r and r.path:
            return r

    local_gen = _comfyui(query.topic, query.duration_sec)
    if local_gen and local_gen.path:
        return local_gen

    runway_key = auth.get("runway")
    if runway_key:
        blocked = _cloud_blocked(0.05, budget, query.allow_cloud)
        if blocked is None:
            r = _runway(query.topic, runway_key, query.duration_sec)
            if r and r.path:
                budget._spent_today_usd += r.cost_usd
                return r

    return AssetResult(source="none", path=None, note="all_sources_exhausted")


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="Resilient asset fetcher.")
    p.add_argument("--topic", required=True)
    p.add_argument("--duration", type=float, default=5.0)
    p.add_argument("--aspect", default="9:16")
    p.add_argument("--allow-cloud", action="store_true")
    p.add_argument("--auth", type=Path, default=None, help="JSON file mapping provider->key")
    p.add_argument("--budget", type=float, default=0.10)
    args = p.parse_args(argv)

    auth = {}
    if args.auth and args.auth.exists():
        auth = json.loads(args.auth.read_text())

    q = AssetQuery(
        topic=args.topic,
        duration_sec=args.duration,
        aspect=args.aspect,
        allow_cloud=args.allow_cloud,
        max_cloud_cost_usd=args.budget,
    )
    budget = Budget(max_cloud_call_usd=args.budget)
    result = fetch_asset(q, auth, budget)
    print(json.dumps(asdict(result), indent=2))
    return 0 if result.path else 1


if __name__ == "__main__":
    raise SystemExit(main())
