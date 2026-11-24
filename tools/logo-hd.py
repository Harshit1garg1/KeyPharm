"""Make the header logo from the official KeyPharm PNG: drop its white backing box, crop to the ink, upscale 3x.

Run: python tools/logo-hd.py  (needs Pillow). Reads app/src/main/assets/keypharm-logo.png (byte-identical to
https://www.keypharm.com/images/keypharm-logo.png) and writes app/src/main/assets/keypharm-logo-hd.png.
The source is 339 x 133 px with only 223 x 46 px of ink, so upscaling cleans edges but cannot add detail;
replace with a vector logo when Keypharm supplies one.
"""
from pathlib import Path
from PIL import Image, ImageFilter

assets = Path(__file__).resolve().parents[1] / "app/src/main/assets"
src = Image.open(assets / "keypharm-logo.png").convert("RGBA")

# White to alpha: a pixel's opacity is how far it is from white; un-blend its colour from the white behind it.
out = Image.new("RGBA", src.size)
pixels, target = src.load(), out.load()
for y in range(src.height):
    for x in range(src.width):
        r, g, b, a = pixels[x, y]
        alpha = max(255 - r, 255 - g, 255 - b) / 255 * (a / 255)
        if alpha < 0.12:  # the backing box is a faint grey gradient; real ink is far darker
            target[x, y] = (255, 255, 255, 0)
            continue
        unblend = lambda c: max(0, min(255, round(255 - (255 - c) / max(alpha, 1e-6))))
        target[x, y] = (unblend(r), unblend(g), unblend(b), round(alpha * 255))

box = out.getbbox()
crop = out.crop((box[0] - 2, box[1] - 2, box[2] + 2, box[3] + 2))
hd = crop.resize((crop.width * 3, crop.height * 3), Image.LANCZOS).filter(ImageFilter.UnsharpMask(radius=1.2, percent=60, threshold=2))
hd.save(assets / "keypharm-logo-hd.png", optimize=True)
print(assets / "keypharm-logo-hd.png", hd.size)
