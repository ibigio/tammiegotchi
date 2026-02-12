# Nano Banana (Flash) Image Generation Setup

This repo contains a minimal script to call the Gemini Nano Banana image model and save the generated image to disk.

## 1) Prerequisites

- Python 3.9+
- A Gemini API key with access to image generation models

## 2) Set your API key

```bash
export GEMINI_API_KEY="your_api_key_here"
```

If you want this every shell session, add that line to your shell profile (for zsh: `~/.zshrc`).

## 3) Generate and save an image

```bash
python3 nanobanana_generate.py "A pixel-art robot watering plants on a balcony at sunrise" -o output.png
```

Expected success output:

```text
Saved image to output.png (image/png)
```

## 4) Options

- `-o, --output` output path (default `generated_image.png`)
- `-m, --model` model name (default `gemini-2.5-flash-image`)
- `-e, --edit` input image path to edit instead of pure text-to-image
- `--remove-white-bg` remove white background to transparent after generation (default enabled; requires `ffmpeg`)
- `--no-remove-white-bg` disable white-to-transparent post-processing
- `--white-key` hex color to key out (default `FFFFFF`)
- `--white-similarity` key tolerance (default `0.08`)
- `--white-blend` edge blend (default `0.02`)
- `--bg-remove-mode` choose background removal mode: `key` (default) or `flood-fill`
- `--flood-fill-threshold` flood-fill tolerance per RGB channel (default `20`)

Example custom model flag:

```bash
python3 nanobanana_generate.py "A watercolor mountain village in winter" -m gemini-2.5-flash-image -o mountain.png
```

## 5) Edit an existing image (example: add a hat)

```bash
python3 nanobanana_generate.py "Add a small red baseball hat to the character. Keep everything else the same." --edit out.png -o out_hat.png
```

## Notes

- The script prints any text parts returned by the model and saves the first image part it finds.
- If your key or model access is not enabled, the script prints the full API error response for debugging.

### Transparent default behavior

```bash
python3 nanobanana_generate.py \
  "Keep the same character and hat. Use a pure white background." \
  --edit out_hat2.png \
  -o out_hat_transparent.png
```

### Flood-fill mode (preserve interior whites)

This mode flood-fills from image corners, so white details inside the subject are kept.

```bash
python3 nanobanana_generate.py \
  "This raccoon but from the side, facing right." \
  --edit out_hat2.png \
  --bg-remove-mode flood-fill \
  -o raccoon_right.png
```

## Deploy on Render (Easy)

This repo includes a Render Blueprint file: `render.yaml`.

1. In Render, choose **New +** -> **Blueprint**.
2. Connect your GitHub repo.
3. Render will detect `render.yaml` and prefill service settings.
4. Add `GEMINI_API_KEY` in the service environment variables.
5. Deploy.

Health check endpoint is `GET /healthz`.
