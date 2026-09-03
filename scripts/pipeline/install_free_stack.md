# Free Local Creative Stack — Install Runbook

**Zero-cost replacements for Opus Clip, ElevenLabs, Suno, Runway.**

This is the production-grade install order for the Trident Social creative pipeline. Everything here is free, runs locally on Apple Silicon, and feeds directly into the Quorum pipeline already shipped.

## Pre-flight

```bash
# Already on the box
which ffmpeg yt-dlp ollama whisper-cpp
brew list | grep whisper-cpp
ls /Applications | grep -E "Adobe Premiere Pro 2026|DaVinci Resolve"
```

## Layer 1: Voice (TTS) — `piper-tts`

Replaces ElevenLabs. Local, infinite generations, voice cloning supported.

```bash
# Install
brew install piper-tts

# Download a base voice (en_US lessac medium, free CC0)
mkdir -p ~/Models/piper
curl -L -o ~/Models/piper/en_US-lessac-medium.onnx \
  https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/lessac/medium/en_US-lessac-medium.onnx
curl -L -o ~/Models/piper/en_US-lessac-medium.onnx.json \
  https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/lessac/medium/en_US-lessac-medium.onnx.json

# Test
echo "Your Williams Media trial is ready." | \
  piper --model ~/Models/piper/en_US-lessac-medium.onnx \
        --output_file /tmp/piper_test.wav
afplay /tmp/piper_test.wav
```

Quorum hook: `scripts/pipeline/tts.py` (to be added in next pass).

## Layer 2: Music — `stable-audio-open`

Replaces Suno. Open-source from Stability AI, runs locally on Apple Silicon via `mlx`.

```bash
mkdir -p ~/Models/stable-audio-open && cd ~/Models/stable-audio-open
# HuggingFace CLI login required (free account)
pip install -U "huggingface_hub[cli]"
huggingface-cli download stabilityai/stable-audio-open-1.0 \
  --include "*.safetensors" "*.json" "*.txt" --local-dir .

# Inference (Python API)
pip install stable-audio-tools
python3 -c "
from stable_audio_tools import get_pretrained_model
model, _ = get_pretrained_model('stabilityai/stable-audio-open-1.0')
print('Stable Audio loaded for local generation')
"
```

Quorum hook: `scripts/pipeline/music.py` (to be added in next pass).

## Layer 3: B-roll — `ComfyUI` (portable)

Replaces Runway. Pixel-perfect control over AnimateDiff / Stable Video Diffusion workflows.

```bash
# Portable install (no Python venv hell)
mkdir -p ~/Apps/comfyui && cd ~/Apps/comfyui
git clone https://github.com/comfyanonymous/ComfyUI.git .
pip install -r requirements.txt --no-cache-dir

# Optional but recommended for Apple Silicon GPU acceleration
pip install --no-cache-dir comfy-cli
comfy --workspace=. --no-setup install --nvidia  # skip --nvidia on M-series
# For Apple Silicon:
pip install --no-cache-dir torch torchvision torchaudio

# Models
mkdir -p models/checkpoints models/vae models/loras
# SD 1.5 base (small, fast, fits 16GB unified memory)
wget -O models/checkpoints/v1-5-pruned.safetensors \
  https://huggingface.co/runwayml/stable-diffusion-v1-5/resolve/main/v1-5-pruned.safetensors

# Start the server (leave running)
python3 main.py --listen 127.0.0.1 --port 8188
```

Quorum hook: `asset_layer.py` already pings `http://127.0.0.1:8188/system_stats`.

## Layer 4: Hyperframes-style variants — `Pillow` (already shipping)

Already shipped. One master → N branded shorts with randomized hooks/CTAs. Test:

```bash
cd ~/CLAUDE/unified-ai-operator
pip install Pillow
python3 scripts/pipeline/variants.py \
  --input /path/to/master_short.mp4 \
  --output-dir /tmp/variants \
  --count 5 \
  --logo /path/to/logo.png
ls /tmp/variants/
```

## Layer 5: Stock Footage APIs (FREE direct)

Replaces paid stock libraries. Direct API keys, zero markup.

| Provider | Free Tier | Where to get a key |
| :--- | :--- | :--- |
| **Pexels** | Unlimited requests, attribution required | https://www.pexels.com/api/ |
| **Pixabay** | 100 req / 60s | https://pixabay.com/api/docs/ |
| **Coverr** | Free download, no API key needed | https://coverr.co |

After you grab keys, store them via OpenClaw secrets:

```bash
openclaw config set secrets.providers.vault --provider-source file \
  --provider-path ~/.quorum/secrets.json --provider-mode json
```

Then `~/.quorum/secrets.json`:

```json
{
  "pexels": "YOUR_KEY",
  "pixabay": "YOUR_KEY",
  "runway": "YOUR_KEY_ONLY_IF_NEEDED"
}
```

## Layer 6: Background removal — `rembg`

Replaces paid services for thumbnails / cutouts.

```bash
pip install "rembg[gpu,cli]"
rembg i input.png output.png
```

## Verification

```bash
# Run the whole chain against a test asset
cd ~/CLAUDE/unified-ai-operator
node scripts/pipeline/pipeline.mjs --input /path/to/test.mp4 --output-dir /tmp/pipeline_test
ls /tmp/pipeline_test/

# Run the variants generator
python3 scripts/pipeline/variants.py \
  --input /path/to/test.mp4 \
  --output-dir /tmp/variants_test \
  --count 10

# Run the asset fetcher (Pexels only off the start; rest is gated)
python3 scripts/pipeline/asset_layer.py \
  --topic "laptop on white desk" \
  --auth ~/.quorum/secrets.json
```

## When ALL of this is wired

You will own a creative pipeline that can match Opus Clip output for **$0/month in software** (electricity aside). That's the moat — competitors can't undercut your production cost.
