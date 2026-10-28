# -*- coding: utf-8 -*-
"""new Claude cutout: drop the orange dot above her head, core alpha 255, 1px feather."""
import numpy as np
from PIL import Image, ImageFilter

SRC = r'D:\plugging\.dsh-duo-pet\ref\claude_white_rgba.png'
OUT = r'D:\plugging\.dsh-duo-pet\art\cutouts\claude.png'

im = Image.open(SRC).convert('RGBA')
a = np.array(im).astype(np.float32)
alpha = a[:, :, 3] / 255.0

# keep only the largest alpha component (removes the detached orange dot)
core = alpha > 0.35
try:
    from scipy import ndimage
    lab, n = ndimage.label(core)
    if n > 1:
        sizes = ndimage.sum(core, lab, range(1, n + 1))
        keep = int(np.argmax(sizes)) + 1
        core = lab == keep
        print('components:', n, 'kept size', int(sizes.max()))
except Exception as e:
    print('scipy fallback', e)

try:
    from scipy import ndimage
    core = ndimage.binary_erosion(core, iterations=1)
    core = ndimage.binary_dilation(core, iterations=1)
except Exception:
    pass
mask = Image.fromarray((core * 255).astype(np.uint8), 'L').filter(
    ImageFilter.GaussianBlur(1.0))
a[:, :, 3] = np.array(mask, dtype=np.float32)
out = Image.fromarray(np.clip(a, 0, 255).astype(np.uint8), 'RGBA')
bb = out.getchannel('A').getbbox()
out = out.crop(bb)
out.save(OUT)
for nm, col in (('white', (255, 255, 255, 255)), ('dark', (30, 32, 40, 255))):
    bg = Image.new('RGBA', out.size, col)
    bg.alpha_composite(out)
    bg.convert('RGB').save(OUT.replace('claude.png', '_preview_claude_%s.png' % nm))
print('claude ->', out.size)
