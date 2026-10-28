# -*- coding: utf-8 -*-
"""photo-style composites v2: fit the pair's union bbox to 84% of the frame."""
import math
import os

import numpy as np

from PIL import Image, ImageDraw, ImageFilter

ART = r'D:\plugging\.dsh-duo-pet\art'
CUT = os.path.join(ART, 'cutouts')
OUT = os.path.join(ART, 'photo')
SIZE = 1600
FILL = 0.84
os.makedirs(OUT, exist_ok=True)


def load(name, height):
    im = Image.open(os.path.join(CUT, name + '.png')).convert('RGBA')
    w, h = im.size
    im = im.resize((max(1, int(round(w * height / h))), height), Image.LANCZOS)
    # tighten the silhouette: drop the soft light fringe left by the source cutout
    a = np.array(im.getchannel('A')).astype(np.float32)
    a = np.clip((a - 70.0) / 175.0, 0, 1) * 255.0
    im.putalpha(Image.fromarray(a.astype(np.uint8), 'L'))
    return im


# ---- build the pair on a transparent big canvas ---------------------------
H_CL, H_DS = 1400, 1372
CL = load('claude', H_CL)
DS = load('deepseek', H_DS)
BIG = 2600
FIG = Image.new('RGBA', (BIG, BIG), (0, 0, 0, 0))
GAP = 40
total_w = CL.size[0] + GAP + DS.size[0]
x0 = (BIG - total_w) // 2
base = (BIG + max(CL.size[1], DS.size[1])) // 2
CL_POS = (x0, base - CL.size[1])
DS_POS = (x0 + CL.size[0] + GAP, base - DS.size[1])

# soft ground shadow
sh = Image.new('RGBA', (BIG, BIG), (0, 0, 0, 0))
d = ImageDraw.Draw(sh)
for pos, img in ((CL_POS, CL), (DS_POS, DS)):
    cx = pos[0] + img.size[0] / 2
    rx = img.size[0] * 0.34
    d.ellipse([cx - rx, base - 16, cx + rx, base + 22], fill=(96, 66, 78, 110))
sh = sh.filter(ImageFilter.GaussianBlur(16))
FIG.alpha_composite(sh)
FIG.alpha_composite(DS, DS_POS)
FIG.alpha_composite(CL, CL_POS)

bb = FIG.getchannel('A').getbbox()
FIG = FIG.crop(bb)
fw, fh = FIG.size
sc = (SIZE * FILL) / max(fw, fh)
FIG = FIG.resize((int(round(fw * sc)), int(round(fh * sc))), Image.LANCZOS)
FB = FIG.getchannel('A').getbbox()
FIG = FIG.crop(FB)
OFF = ((SIZE - FIG.size[0]) // 2, (SIZE - FIG.size[1]) // 2)


def compose(bg):
    base_img = bg.copy().convert('RGBA')
    base_img.alpha_composite(FIG, OFF)
    return base_img.convert('RGB')


def gradient(top, bottom):
    img = Image.new('RGB', (SIZE, SIZE), top)
    d = ImageDraw.Draw(img)
    for y in range(SIZE):
        t = y / (SIZE - 1.0)
        d.line([(0, y), (SIZE, y)],
               fill=tuple(int(top[i] + (bottom[i] - top[i]) * t) for i in range(3)))
    return img


def bg_a():
    img = gradient((255, 236, 244), (222, 237, 255))
    b = Image.new('RGBA', (SIZE, SIZE), (0, 0, 0, 0))
    d = ImageDraw.Draw(b)
    for (x, y, r, col) in ((330, 330, 260, (255, 255, 255, 95)),
                           (1290, 420, 310, (255, 226, 240, 85)),
                           (1050, 1210, 350, (208, 232, 255, 85)),
                           (420, 1180, 270, (255, 245, 250, 90))):
        d.ellipse([x - r, y - r, x + r, y + r], fill=col)
    b = b.filter(ImageFilter.GaussianBlur(95))
    img = Image.alpha_composite(img.convert('RGBA'), b)
    sp = Image.new('RGBA', (SIZE * 2, SIZE * 2), (0, 0, 0, 0))
    d = ImageDraw.Draw(sp)
    for i, (x, y) in enumerate([(250, 250), (1350, 260), (180, 900), (1420, 980),
                                (300, 1400), (1300, 1380), (760, 170), (900, 1440)]):
        r = 17 + (i % 3) * 8
        for k in range(4):
            a = math.radians(k * 45)
            d.line([(x * 2 - math.cos(a) * r * 2, y * 2 - math.sin(a) * r * 2),
                    (x * 2 + math.cos(a) * r * 2, y * 2 + math.sin(a) * r * 2)],
                   fill=(255, 255, 255, 155), width=5)
    sp = sp.filter(ImageFilter.GaussianBlur(1.6)).resize((SIZE, SIZE), Image.LANCZOS)
    img.alpha_composite(sp)
    return img


def bg_b():
    img = gradient((255, 247, 232), (242, 224, 198))
    b = Image.new('RGBA', (SIZE, SIZE), (0, 0, 0, 0))
    d = ImageDraw.Draw(b)
    horizon = int(SIZE * 0.76)
    d.rectangle([0, horizon, SIZE, SIZE], fill=(231, 209, 181, 255))
    d.ellipse([-260, -300, 800, 760], fill=(255, 250, 224, 155))
    b = b.filter(ImageFilter.GaussianBlur(120))
    img = Image.alpha_composite(img.convert('RGBA'), b)
    v = Image.new('L', (SIZE, SIZE), 0)
    dv = ImageDraw.Draw(v)
    dv.ellipse([-SIZE * 0.28, -SIZE * 0.28, SIZE * 1.28, SIZE * 1.28], fill=255)
    v = v.filter(ImageFilter.GaussianBlur(190))
    dark = Image.new('RGBA', (SIZE, SIZE), (118, 90, 62, 72))
    img = Image.composite(img, Image.alpha_composite(img, dark), v)
    return img


def bg_c():
    img = gradient((253, 249, 243), (246, 238, 227)).convert('RGBA')
    d = ImageDraw.Draw(img)
    m = int(SIZE * 0.045)
    d.rectangle([m, m, SIZE - m, SIZE - m], outline=(212, 194, 176, 255), width=5)
    d.rectangle([m + 18, m + 18, SIZE - m - 18, SIZE - m - 18],
                outline=(232, 220, 206, 255), width=2)
    band = int(SIZE * 0.905)
    d.rectangle([m + 19, band, SIZE - m - 19, SIZE - m - 19], fill=(255, 253, 248, 255))
    d.line([(m + 19, band), (SIZE - m - 19, band)], fill=(226, 212, 196, 255), width=2)
    return img


def main():
    outs = []
    for tag, fn in (('A', bg_a), ('B', bg_b), ('C', bg_c)):
        photo = compose(fn())
        p_png = os.path.join(OUT, 'duo_photo_%s.png' % tag)
        p_jpg = os.path.join(OUT, 'duo_photo_%s.jpg' % tag)
        photo.save(p_png, optimize=True)
        photo.save(p_jpg, quality=92, subsampling=1)
        outs.append((tag, p_png))
        print(tag, photo.size, FIG.size, OFF, os.path.getsize(p_png), os.path.getsize(p_jpg))
    tw = 520
    mont = Image.new('RGB', (tw * 3 + 80, tw + 60), (250, 248, 246))
    dm = ImageDraw.Draw(mont)
    for i, (tag, p) in enumerate(outs):
        im = Image.open(p).resize((tw, tw), Image.LANCZOS)
        mont.paste(im, (20 + i * (tw + 20), 40))
        dm.text((24 + i * (tw + 20), 16), 'Variant %s' % tag, fill=(90, 80, 76))
    mont.save(os.path.join(OUT, 'photo_preview.png'))
    print('preview', mont.size)


if __name__ == '__main__':
    main()
