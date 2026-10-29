#!/usr/bin/env python3
import os, subprocess, tempfile
from PIL import Image, ImageDraw

PUBLIC = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "public")
SRC = os.path.join(PUBLIC, "icon.svg")
BIG = 1024


def render(svg, size, tmp):
    src = os.path.join(tmp, f"{size}.svg")
    out = os.path.join(tmp, f"{size}.png")
    profile = os.path.join(tmp, "profile")
    os.makedirs(profile, exist_ok=True)
    open(src, "w").write(svg)
    subprocess.run(["firefox", "--headless", "--no-remote", "--profile", profile,
                    f"--window-size={size},{size}", "--screenshot", out, "file://" + src],
                   check=True, timeout=90, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    return Image.open(out).convert("RGBA")


def rounded(im, size, radius):
    k = 4
    mask = Image.new("L", (size * k, size * k), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, size * k - 1, size * k - 1), radius=radius * size * k, fill=255)
    out = im.resize((size, size), Image.LANCZOS)
    out.putalpha(mask.resize((size, size), Image.LANCZOS))
    return out


def main():
    svg = open(SRC).read()
    flat = svg.replace('rx="115"', 'rx="0"')
    safe = flat.replace('<g id="mark">', '<g id="mark" transform="translate(256 256) scale(.78) translate(-271 -256)">')
    with tempfile.TemporaryDirectory() as tmp:
        full = render(flat, BIG, tmp)
        mask = render(safe, BIG, tmp)
    jobs = [
        ("icon-180.png", full.resize((180, 180), Image.LANCZOS).convert("RGB")),
        ("icon-192.png", rounded(full, 192, 0.225)),
        ("icon-512.png", rounded(full, 512, 0.225)),
        ("icon-512-maskable.png", mask.resize((512, 512), Image.LANCZOS).convert("RGB")),
    ]
    for name, im in jobs:
        path = os.path.join(PUBLIC, name)
        im.save(path, optimize=True)
        print(f"{name}: {im.size[0]}x{im.size[1]}, {os.path.getsize(path)} bytes")


if __name__ == "__main__":
    main()
