#!/usr/bin/env python3
import argparse
import base64
from collections import deque
import mimetypes
import json
import os
import shutil
import subprocess
import sys
import tempfile
from typing import Dict, Optional, Tuple
import urllib.error
import urllib.request


API_BASE = "https://generativelanguage.googleapis.com/v1beta/models"


def _normalize_hex_color(color: str) -> str:
    normalized = color.strip().lstrip("#").upper()
    if len(normalized) != 6:
        raise ValueError("Color must be 6 hex digits, e.g. FFFFFF")
    return normalized


def _guess_mime_type(path: str) -> str:
    guessed, _ = mimetypes.guess_type(path)
    return guessed or "image/png"


def _encode_file_base64(path: str) -> str:
    with open(path, "rb") as f:
        return base64.b64encode(f.read()).decode("utf-8")


def generate_image(
    api_key: str,
    model: str,
    prompt: str,
    output_path: str,
    edit_path: Optional[str] = None,
    ref_paths: Optional[list[str]] = None,
) -> Tuple[str, Dict[str, object]]:
    url = f"{API_BASE}/{model}:generateContent"
    parts = []
    if edit_path:
        parts.append(
            {
                "inlineData": {
                    "mimeType": _guess_mime_type(edit_path),
                    "data": _encode_file_base64(edit_path),
                }
            }
        )
    if ref_paths:
        for ref_path in ref_paths:
            parts.append(
                {
                    "inlineData": {
                        "mimeType": _guess_mime_type(ref_path),
                        "data": _encode_file_base64(ref_path),
                    }
                }
            )
    parts.append({"text": prompt})

    payload = {
        "contents": [
            {
                "parts": parts
            }
        ],
        "generationConfig": {
            "responseModalities": ["TEXT", "IMAGE"]
        },
    }

    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "x-goog-api-key": api_key,
        },
        method="POST",
    )

    try:
        with urllib.request.urlopen(req, timeout=120) as response:
            body = response.read().decode("utf-8")
    except urllib.error.HTTPError as err:
        details = err.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"HTTP {err.code}: {details}") from err
    except urllib.error.URLError as err:
        raise RuntimeError(f"Network error: {err}") from err

    data = json.loads(body)

    if "error" in data:
        raise RuntimeError(f"API error: {json.dumps(data['error'])}")

    candidates = data.get("candidates", [])
    for candidate in candidates:
        content = candidate.get("content", {})
        parts = content.get("parts", [])
        for part in parts:
            inline = part.get("inlineData")
            if inline and inline.get("data"):
                image_bytes = base64.b64decode(inline["data"])
                with open(output_path, "wb") as f:
                    f.write(image_bytes)
                return inline.get("mimeType", "application/octet-stream"), data.get("usageMetadata", {})

            text = part.get("text")
            if text:
                print(f"[model text] {text}")

    raise RuntimeError("No image data found in response.")


def remove_white_background(
    path: str, white_key: str, similarity: float, blend: float
) -> None:
    ffmpeg_bin = shutil.which("ffmpeg")
    if not ffmpeg_bin:
        raise RuntimeError("ffmpeg is required for --remove-white-bg but was not found in PATH.")

    normalized = white_key.strip().lstrip("#")
    if len(normalized) != 6:
        raise RuntimeError("--white-key must be a 6-digit hex color, e.g. FFFFFF")

    fd, tmp_path = tempfile.mkstemp(suffix=".png")
    os.close(fd)
    try:
        subprocess.run(
            [
                ffmpeg_bin,
                "-y",
                "-i",
                path,
                "-vf",
                f"colorkey=0x{normalized}:{similarity}:{blend},format=rgba",
                "-frames:v",
                "1",
                "-update",
                "1",
                tmp_path,
            ],
            check=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        os.replace(tmp_path, path)
    except subprocess.CalledProcessError as err:
        raise RuntimeError(f"ffmpeg failed: {err.stderr}") from err
    finally:
        if os.path.exists(tmp_path):
            os.remove(tmp_path)


def remove_background_flood_fill(path: str, white_key: str, threshold: int) -> None:
    try:
        from PIL import Image
    except ImportError as err:
        raise RuntimeError(
            "Pillow is required for --bg-remove-mode flood-fill. "
            "Install with: python3 -m pip install pillow"
        ) from err

    normalized = white_key.strip().lstrip("#")
    if len(normalized) != 6:
        raise RuntimeError("--white-key must be a 6-digit hex color, e.g. FFFFFF")

    key_rgb = (
        int(normalized[0:2], 16),
        int(normalized[2:4], 16),
        int(normalized[4:6], 16),
    )

    # Flatten any existing alpha onto white first, then remove only corner-connected bg.
    src = Image.open(path).convert("RGBA")
    flat = Image.new("RGBA", src.size, (255, 255, 255, 255))
    flat.alpha_composite(src)
    rgba = flat.load()
    w, h = flat.size

    visited = bytearray(w * h)

    def idx(x: int, y: int) -> int:
        return y * w + x

    def near_key(pixel: Tuple[int, int, int, int]) -> bool:
        return (
            abs(pixel[0] - key_rgb[0]) <= threshold
            and abs(pixel[1] - key_rgb[1]) <= threshold
            and abs(pixel[2] - key_rgb[2]) <= threshold
        )

    q: deque[Tuple[int, int]] = deque()
    for x, y in ((0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1)):
        if near_key(rgba[x, y]):
            i = idx(x, y)
            visited[i] = 1
            q.append((x, y))

    while q:
        x, y = q.popleft()
        rgba[x, y] = (rgba[x, y][0], rgba[x, y][1], rgba[x, y][2], 0)
        for nx, ny in ((x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)):
            if nx < 0 or ny < 0 or nx >= w or ny >= h:
                continue
            i = idx(nx, ny)
            if visited[i]:
                continue
            if near_key(rgba[nx, ny]):
                visited[i] = 1
                q.append((nx, ny))

    flat.save(path)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Generate an image with Gemini Nano Banana (2.5 Flash Image) and save it to a file."
    )
    parser.add_argument(
        "prompt",
        help="Text prompt for the image generation request.",
    )
    parser.add_argument(
        "-o",
        "--output",
        default="generated_image.png",
        help="Output file path for the generated image (default: generated_image.png).",
    )
    parser.add_argument(
        "-m",
        "--model",
        default="gemini-2.5-flash-image",
        help="Model name (default: gemini-2.5-flash-image).",
    )
    parser.add_argument(
        "-e",
        "--edit",
        help="Optional input image path to edit. If set, the prompt is applied to this image.",
    )
    parser.add_argument(
        "--ref",
        action="append",
        default=[],
        help="Optional reference image path (repeatable). Used for style/orientation guidance.",
    )
    parser.add_argument(
        "--remove-white-bg",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="Post-process output by keying white to transparency (default: enabled; use --no-remove-white-bg to disable).",
    )
    parser.add_argument(
        "--bg-remove-mode",
        choices=("key", "flood-fill"),
        default="flood-fill",
        help="Background removal mode when --remove-white-bg is enabled (default: flood-fill).",
    )
    parser.add_argument(
        "--white-key",
        default="FFFFFF",
        help="Hex color to key out with --remove-white-bg (default: FFFFFF).",
    )
    parser.add_argument(
        "--white-similarity",
        type=float,
        default=0.08,
        help="Color similarity tolerance for keying (default: 0.08).",
    )
    parser.add_argument(
        "--white-blend",
        type=float,
        default=0.02,
        help="Edge blend for keyed pixels (default: 0.02).",
    )
    parser.add_argument(
        "--flood-fill-threshold",
        type=int,
        default=20,
        help="Per-channel tolerance for flood-fill bg removal (default: 20).",
    )
    args = parser.parse_args()

    prompt = args.prompt
    if args.remove_white_bg:
        try:
            matte_hex = _normalize_hex_color(args.white_key)
        except ValueError as err:
            print(f"Invalid --white-key: {err}", file=sys.stderr)
            return 2

        # Encourage a clean matte for reliable white-to-alpha keying.
        prompt = (
            f"{prompt}\n\n"
            "Important output constraint: use a completely pure matte background "
            f"(#{matte_hex}), flat and uniform, with no shadows, floor, gradients, or texture."
        )

    api_key = os.getenv("GEMINI_API_KEY")
    if not api_key:
        print("Missing GEMINI_API_KEY environment variable.", file=sys.stderr)
        return 2

    try:
        mime_type, usage = generate_image(
            api_key=api_key,
            model=args.model,
            prompt=prompt,
            output_path=args.output,
            edit_path=args.edit,
            ref_paths=args.ref,
        )
    except Exception as err:
        print(f"Generation failed: {err}", file=sys.stderr)
        return 1

    if args.remove_white_bg:
        try:
            if args.bg_remove_mode == "flood-fill":
                remove_background_flood_fill(
                    path=args.output,
                    white_key=args.white_key,
                    threshold=args.flood_fill_threshold,
                )
                print(
                    "Applied corner flood-fill white-to-transparent removal "
                    f"(key=#{args.white_key}, threshold={args.flood_fill_threshold})."
                )
            else:
                remove_white_background(
                    path=args.output,
                    white_key=args.white_key,
                    similarity=args.white_similarity,
                    blend=args.white_blend,
                )
                print(
                    "Applied white-to-transparent keying "
                    f"(key=#{args.white_key}, similarity={args.white_similarity}, blend={args.white_blend})."
                )
        except Exception as err:
            print(f"Post-process failed: {err}", file=sys.stderr)
            return 1

    print(f"Saved image to {args.output} ({mime_type})")
    if usage:
        prompt_tokens = usage.get("promptTokenCount")
        candidate_tokens = usage.get("candidatesTokenCount")
        total_tokens = usage.get("totalTokenCount")
        image_tokens = usage.get("candidatesTokensDetails", [])
        print(
            f"Usage: prompt={prompt_tokens} candidate={candidate_tokens} total={total_tokens} details={image_tokens}"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
