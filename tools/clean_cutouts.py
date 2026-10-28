# -*- coding: utf-8 -*-
"""Clean the u2net cutouts into art/cutouts/{deepseek,claude}.png.

- rebuild a crisp alpha from the u2net mask (core > 0.5, largest component, 1px feather)
- DeepSeek: remove the glass / straw on her left and clone the hair colour back
- Claude: drop the warm background strip on her left, lift the washed-out boots
Outputs are cropped to the alpha bbox.
"""
import numpy as np
from PIL import Image, ImageFilter

SRC = r'D:\plugging\.dsh-duo-pet\ref\cutout_u2net'
OUT = r'D:\plugging\.dsh-duo-pet\art\cutouts'


def largest_core(alpha, thr=110):
    core = (alpha > thr)
    lab = np.zeros_like(core, dtype=np.int32)
    # simple two-pass-ish flood fill using scipy if available
    try:
        from scipy import ndimage
        lab, n = ndimage.label(core)
        if n > 1:
            sizes = ndimage.sum(core, lab, range(1, n + 1))
            keep = int(np.argmax(sizes)) + 1
            core = lab == keep
    except Exception:
        pass
    return core


def feather(mask, radius=1.0):
    m = Image.fromarray((mask * 255).astype(np.uint8), 'L')
    m = m.filter(ImageFilter.GaussianBlur(radius))
    return m


def mirror_fill(arr, box, src_x_center, feather_px=6):
    """clone hair colour leftwards across the glass area by mirroring columns."""
    x0, y0, x1, y1 = box
    for y in range(y0, y1):
        for x in range(x0, x1):
            sx = 2 * src_x_center - x
            sx = min(arr.shape[1] - 1, max(0, sx))
            arr[y, x, :3] = arr[y, sx, :3]


def clean(name):
    im = Image.open(f'{SRC}\\{name}_full_rgba.png').convert('RGBA')
    a = np.array(im).astype(np.float32)
    h, w = a.shape[:2]
    alpha = a[:, :, 3] / 255.0
    ys, xs = np.mgrid[0:h, 0:w]

    if name == 'deepseek':
        # --- glass + straw: rebuild that side by mirroring the right half about x=400
        mir = a[:, ::-1, :]
        for x in range(0, 268):
            wgt = 1.0 if x < 208 else max(0.0, (268 - x) / 60.0)
            a[520:1100, x, :] = a[520:1100, x, :] * (1 - wgt) + mir[520:1100, 139 + x, :] * wgt
        alpha = a[:, :, 3] / 255.0
        alpha[(xs < 18)] = 0.0
        alpha[(xs < 150) & (ys > 620) & (ys < 1085)] = np.maximum(
            alpha[(xs < 150) & (ys > 620) & (ys < 1085)], 0.97)
        # ---- mirrored light-blue whale tail on the left: remove it
        rgb = a[:, :, :3]
        tailm = (ys > 895) & (ys < 1090) & (xs > 70) & (xs < 260) & \
                (rgb[:, :, 2] > 150) & (rgb[:, :, 2] > rgb[:, :, 0] + 25)
        alpha[tailm] = 0.0
        # ---- warm beige sofa patch on the right (between hair and wing)
        beige = (rgb[:, :, 0] > 130) & (rgb[:, :, 0] > rgb[:, :, 2] + 18) & \
                (ys > 470) & (ys < 1020) & (xs > 480) & (xs < 692)
        alpha[beige] = 0.0
        # ---- mirror the clean right half onto the left half (kills glass)
        mir = a[:, ::-1, :].copy()
        a[:, 0:400, :] = mir[:, 139:539, :]
        alpha = a[:, :, 3] / 255.0
        rgb2 = a[:, :, :3]
        tail2 = (ys > 860) & (ys < 1090) & (xs > 30) & (xs < 240) & \
                (rgb2[:, :, 2] > 145) & (rgb2[:, :, 2] > rgb2[:, :, 0] + 22)
        alpha[tail2] = 0.0
        # ---- thin grey straw residue above the face
        rgbs = a[:, :, :3] / 255.0
        mxs = rgbs.max(axis=2)
        mns = rgbs.min(axis=2)
        sats = np.where(mxs > 0.02, (mxs - mns) / np.maximum(mxs, 1e-5), 0.0)
        strawline = (ys > 150) & (ys < 620) & (xs > 320) & (xs < 470) & \
                    (sats < 0.10) & (mxs < 0.72)
        alpha[strawline] = 0.0
        # ---- beige showing through the ahoge loop
        aholoop = (ys > 18) & (ys < 132) & (xs > 258) & (xs < 400) & \
                  (rgb[:, :, 0] > rgb[:, :, 2] + 6)
        alpha[aholoop] = 0.0
        alpha = np.clip(alpha, 0.0, 1.0)
    else:
        # --- warm background strip on the viewer-left
        rgb = a[:, :, :3] / 255.0
        mx = rgb.max(axis=2)
        mn = rgb.min(axis=2)
        sat = np.where(mx > 0.02, (mx - mn) / np.maximum(mx, 1e-5), 0.0)
        strip = (xs < 72) & (ys > 640) & (ys < 1340)
        bgish = strip & ((mx > 0.80) | (sat < 0.14))
        alpha[bgish] = 0.0
        # boots: lift the washed-out semi-transparent bottom
        boot = (ys > 1130) & (ys < 1420) & (xs > 120)
        boost = a.copy()
        boost[:, :, 3] = 255.0
        b = a.copy()
        b[boot, :3] = np.clip(a[boot, :3] * 1.10 + 6, 0, 255)
        a = b

    if name == 'claude':
        # beige sofa/wall wedge on her cut-off right side
        rgbs = a[:, :, :3] / 255.0
        mx2 = rgbs.max(axis=2)
        mn2 = rgbs.min(axis=2)
        sat2 = np.where(mx2 > 0.02, (mx2 - mn2) / np.maximum(mx2, 1e-5), 0.0)
        warm = rgbs[:, :, 0] > rgbs[:, :, 2] + 0.04
        band = ((ys > 320) & (ys < 770)) | ((ys > 930) & (ys < 1140))
        beige2 = (xs > 370) & band & warm & (sat2 > 0.14) & (sat2 < 0.44) & \
                 (mx2 > 0.55) & (mx2 < 0.93)
        alpha[beige2] = 0.0
        # also clip the outermost 3px where the source crop cut her body
        alpha[(xs > a.shape[1] - 3)] = 0.0
        alpha = np.clip(alpha, 0.0, 1.0)
    core = largest_core(alpha * 255.0, 165)
    try:
        from scipy import ndimage
        core = ndimage.binary_erosion(core, iterations=1)
    except Exception:
        pass
    out_alpha = feather(core, 1.2)
    a[:, :, 3] = np.array(out_alpha, dtype=np.float32)
    out = Image.fromarray(np.clip(a, 0, 255).astype(np.uint8), 'RGBA')
    bb = out.getchannel('A').getbbox()
    out = out.crop(bb)
    import os
    os.makedirs(OUT, exist_ok=True)
    out.save(f'{OUT}\\{name}.png')
    # previews
    for nm, col in (('white', (255, 255, 255, 255)), ('dark', (30, 32, 40, 255))):
        bg = Image.new('RGBA', out.size, col)
        bg.alpha_composite(out)
        bg.convert('RGB').save(f'{OUT}\\_preview_{name}_{nm}.png')
    print(name, 'cropped ->', out.size)


if __name__ == '__main__':
    clean('deepseek')
    print('done')

