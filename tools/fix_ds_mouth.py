# -*- coding: utf-8 -*-
"""give DeepSeek a cute small oval mouth (replaces the tiny slit) in the cutout."""
import numpy as np
from PIL import Image, ImageChops, ImageDraw, ImageFilter

P = r'D:\plugging\.dsh-duo-pet\art\cutouts\deepseek.png'
im = Image.open(P).convert('RGBA')
w, h = im.size
A = np.array(im)

MX, MY = 373, 484                 # old mouth centre (cutout px)
COVER = (int(w * 0.048), int(h * 0.023))   # ellipse radii covering the old mouth
MW, MH = 52, 30                   # new mouth ellipse (cutout px)  ~14x8 cell px

# --- 1. skin colour from a ring around the mouth ---------------------------
ring = []
for dx, dy in [(-60, -30), (60, -30), (-60, 30), (60, 30), (0, -45), (0, 45),
               (-80, 0), (80, 0)]:
    x, y = MX + dx, MY + dy
    if 0 <= x < w and 0 <= y < h and A[y, x, 3] > 200:
        ring.append(A[y, x, :3].astype(float))
skin = np.mean(ring, axis=0)
print('skin', skin)

# --- 2. erase the old mouth + residue with a precise mirrored-skin clone ---
# source: the same skin band on the other side of the face centre line
sw, sh2 = 54, 66
src = im.crop((MX - sw // 2, MY - 74, MX + sw // 2, MY - 74 + sh2))
mask = Image.new('L', (sw, sh2), 0)
dm = ImageDraw.Draw(mask)
dm.ellipse([1, 1, sw - 2, sh2 - 2], fill=255)
mask = mask.filter(ImageFilter.GaussianBlur(1.2))          # 1px AA edge only
out = im.copy()
out.paste(src, (int(MX - sw / 2), int(MY - sh2 / 2)), mask)

# --- 3. sharp anti-aliased mouth (4x draw -> LANCZOS, no extra blur) ------
S4 = 4
mo4 = Image.new('RGBA', (MW * S4, MH * S4), (0, 0, 0, 0))
d = ImageDraw.Draw(mo4)


def ell(cx, cy, rx, ry, fill):
    d.ellipse([(cx - rx) * S4, (cy - ry) * S4, (cx + rx) * S4, (cy + ry) * S4], fill=fill)


# rose body + a soft deeper rim (vector shapes only, no blur filter)
ell(MW / 2, MH / 2, MW / 2 - 1.0, MH / 2 - 0.8, (196, 114, 124, 255))
for k in range(5):
    t = k / 4.0
    ell(MW / 2, MH / 2, MW / 2 - 0.4 - 0.5 * k, MH / 2 - 0.3 - 0.45 * k,
        (170 - int(8 * t), 84 + int(18 * t), 96 + int(20 * t), int(64 + 30 * t)))
ell(MW / 2, MH / 2 + 1.5, MW / 2 - 7.0, MH / 2 - 6.0, (206, 126, 136, 120))
mo = mo4.resize((MW, MH), Image.LANCZOS)
out.alpha_composite(mo, (int(MX - MW / 2), int(MY - MH / 2)))

# --- 4. subtle lower-lip shading -----------------------------------------
sh = Image.new('RGBA', (w, h), (0, 0, 0, 0))
d = ImageDraw.Draw(sh)
d.ellipse([MX - MW / 2 - 2, MY + 3, MX + MW / 2 + 2, MY + MH / 2 + 9],
          fill=(226, 186, 178, 40))
sh = sh.filter(ImageFilter.GaussianBlur(5.0))
out = Image.alpha_composite(out, sh)

out.save(P)
# previews at sprite scale
for nm, c in (('white', (246, 244, 240, 255)), ('dark', (30, 32, 40, 255))):
    bg = Image.new('RGBA', out.size, c)
    bg.alpha_composite(out)
    bg.convert('RGB').save(r'D:\plugging\.dsh-duo-pet\art\preview\_ds_face_%s.png' % nm)
crop = out.crop((MX - 110, MY - 100, MX + 110, MY + 90))
bg = Image.new('RGBA', crop.size, (246, 244, 240, 255))
bg.alpha_composite(crop)
bg.convert('RGB').resize((crop.width * 3, crop.height * 3), Image.LANCZOS).save(
    r'D:\plugging\.dsh-duo-pet\art\preview\_ds_mouth_new.png')
print('mouth redone')
