# -*- coding: utf-8 -*-
"""v6: 1:1 cutout route. Clean cutouts + build the 56-frame spritesheet,
icon and previews.  Characters are pure reference pixels; animation is
translation / rotation / small squash only, plus drawn tongue + hearts + stars.
"""
import math
import os
import sys

import numpy as np
from PIL import Image, ImageChops, ImageDraw, ImageFilter

ART = r'D:\plugging\.dsh-duo-pet\art'
CUT = os.path.join(ART, 'cutouts')
ROOT = r'D:\plugging\.dsh-duo-pet'
PLUGIN = os.path.join(ROOT, 'duo-pet-plugin')
OUT_ASSETS = os.path.join(PLUGIN, 'assets')
OUT_ICON = os.path.join(PLUGIN, 'icon.png')
PREVIEW = os.path.join(ART, 'preview')
FRAMES = os.path.join(ART, 'frames')

CW, CH = 440, 480
COLS, ROWS = 12, 5
BASELINE = 445.0
H_CL = 296.0          # Claude target height
H_DS = 292.0          # DeepSeek target height
GAP = -10.0
ACTIONS = [('idle', 0, 8, 250), ('snuggle', 1, 36, 83), ('done', 4, 12, 100)]


def load_char(name, height):
    im = Image.open(os.path.join(CUT, name + '.png')).convert('RGBA')
    w, h = im.size
    nw = max(1, int(round(w * height / h)))
    return im.resize((nw, int(round(height))), Image.LANCZOS)


def split_upper(img, frac=0.57, feather=26):
    w, h = img.size
    sy = int(h * frac)
    um = Image.new('L', (w, h), 0)
    lm = Image.new('L', (w, h), 0)
    du = ImageDraw.Draw(um)
    dl = ImageDraw.Draw(lm)
    du.rectangle([0, 0, w, sy - feather], fill=255)
    dl.rectangle([0, sy - feather - 8, w, h], fill=255)
    for i in range(feather * 2):
        v = int(255 * i / float(feather * 2))
        du.line([(0, sy - feather + i), (w, sy - feather + i)], fill=255 - v)
    up = img.copy()
    up.putalpha(ImageChops.multiply(up.getchannel('A'), um))
    lo = img.copy()
    lo.putalpha(ImageChops.multiply(lo.getchannel('A'), lm))
    return up, lo, sy


CLAUDE = load_char('claude', H_CL)


def make_pat_body(img):
    """clone a blouse patch over the clasped hands so the arm can be redrawn."""
    w, h = img.size
    out = img.copy()
    src_box = (int(w * 0.58), int(h * 0.40), int(w * 0.80), int(h * 0.56))
    dst_box = (int(w * 0.30), int(h * 0.38), int(w * 0.54), int(h * 0.57))
    patch = out.crop(src_box).transpose(Image.FLIP_LEFT_RIGHT)
    patch = patch.resize((dst_box[2] - dst_box[0], dst_box[3] - dst_box[1]), Image.LANCZOS)
    mw, mh = patch.size
    m = Image.new('L', (mw, mh), 0)
    dm = ImageDraw.Draw(m)
    dm.ellipse([-mw * 0.12, -mh * 0.12, mw * 1.12, mh * 1.12], fill=255)
    m = m.filter(ImageFilter.GaussianBlur(mw * 0.14))
    out.paste(patch, (dst_box[0], dst_box[1]), m)
    return out


CLAUDE_PAT = make_pat_body(CLAUDE)


def split_head_body(img, frac=0.52, feather=24):
    w, h = img.size
    sy = int(h * frac)
    hm = Image.new('L', (w, h), 0)
    dh = ImageDraw.Draw(hm)
    dh.ellipse([int(w * 0.08), -int(h * 0.06), int(w * 0.92), sy + feather], fill=255)
    hm = hm.filter(ImageFilter.GaussianBlur(feather * 0.6))
    body = img.copy()
    bm = Image.new('L', (w, h), 0)
    db = ImageDraw.Draw(bm)
    db.rectangle([0, sy, w, h], fill=255)
    for i in range(8):
        db.line([(0, sy - 8 + i), (w, sy - 8 + i)], fill=int(255 * i / 8.0))
    body.putalpha(ImageChops.multiply(body.getchannel('A'), bm))
    head = img.copy()
    head.putalpha(ImageChops.multiply(head.getchannel('A'), hm))
    return head, body, sy


DS = load_char('deepseek', H_DS)
CL_UP, CL_LO, CL_SPLIT = split_upper(CLAUDE, 0.57, 14)
DS_UP, DS_LO, DS_SPLIT2 = split_upper(DS, 0.55, 14)
DS_HEAD, DS_BODY, DS_SPLIT = split_head_body(DS)
TOTAL = CLAUDE.size[0] + GAP + DS.size[0]
X0 = (CW - TOTAL) / 2.0 - 4.0
CL_POS = (X0, BASELINE - CLAUDE.size[1])
DS_POS = (X0 + CLAUDE.size[0] + GAP, BASELINE - DS.size[1])
CL_CX = CL_POS[0] + CLAUDE.size[0] / 2.0
DS_CX = DS_POS[0] + DS.size[0] / 2.0
DS_MOUTH = (0.497, 0.443)          # fraction inside the DS cutout
CL_CHEEK = (0.60, 0.47)          # fraction inside the Claude cutout


# ---------------------------------------------------------------------------
def kf(t, pts):
    if t <= pts[0][0]:
        return pts[0][1]
    for (ta, va), (tb, vb) in zip(pts, pts[1:]):
        if t <= tb:
            u = (t - ta) / (tb - ta) if tb > ta else 1.0
            u = u * u * (3 - 2 * u)
            return va + (vb - va) * u
    return pts[-1][1]


def clamp(v, a=0.0, b=1.0):
    return max(a, min(b, v))


def transform(img, pos, rot, dx=0.0, dy=0.0, sy=1.0, pivot=None):
    """rotate about a pivot (fraction of w/h, default centre), then translate."""
    w, h = img.size
    pad = 90
    if abs(rot) > 0.01:
        canvas = Image.new('RGBA', (w + 2 * pad, h + 2 * pad), (0, 0, 0, 0))
        canvas.paste(img, (pad, pad))
        if pivot is None:
            cx, cy = pad + w / 2.0, pad + h / 2.0
        else:
            cx, cy = pad + pivot[0] * w, pad + pivot[1] * h
        img2 = canvas.rotate(rot, resample=Image.BICUBIC, center=(cx, cy))
        ox, oy = -pad, -pad
    else:
        img2 = img
        ox, oy = 0, 0
    if abs(sy - 1.0) > 0.001:
        nh = max(1, int(round(img2.size[1] * sy)))
        img2 = img2.resize((img2.size[0], nh), Image.LANCZOS)
    return img2, (pos[0] + dx + ox, pos[1] + dy + oy)


def feature_pt(pos, size, frac, rot, pivot, dx, dy):
    x = pos[0] + frac[0] * size[0]
    y = pos[1] + frac[1] * size[1]
    if abs(rot) > 0.01:
        px = pos[0] + pivot[0] * size[0]
        py = pos[1] + pivot[1] * size[1]
        r = math.radians(rot)
        ca, sa = math.cos(r), math.sin(r)
        dxp, dyp = x - px, y - py
        x, y = px + dxp * ca + dyp * sa, py - dxp * sa + dyp * ca
    return x + dx, y + dy


def paste_center(base, img, pos):
    base.alpha_composite(img, (int(round(pos[0])), int(round(pos[1]))))


def ground_shadow(base, cx, rx, alpha=1.0):
    lay = Image.new('RGBA', (CW * 2, CH * 2), (0, 0, 0, 0))
    d = ImageDraw.Draw(lay)
    d.ellipse([(cx - rx) * 2, (BASELINE - 6) * 2, (cx + rx) * 2, (BASELINE + 7) * 2],
              fill=(60, 40, 52, int(120 * alpha)))
    lay = lay.resize((CW, CH), Image.LANCZOS).filter(ImageFilter.GaussianBlur(4))
    base.alpha_composite(lay)


def tongue_layer(p0, p1, width=7.0, max_len=32.0):
    lay = Image.new('RGBA', (CW * 2, CH * 2), (0, 0, 0, 0))
    d = ImageDraw.Draw(lay)
    vx, vy = p1[0] - p0[0], p1[1] - p0[1]
    dist = math.hypot(vx, vy) or 1.0
    L = min(dist, max_len)
    ux, uy = vx / dist, vy / dist
    n = 22
    pts = []
    for i in range(n):
        t = i / (n - 1)
        # slight downward bow + gentle curl at the tip
        bow = 2.2 * math.sin(math.pi * t) * (1 if uy >= 0 else -1)
        pts.append((p0[0] + ux * L * t, p0[1] + uy * L * t + bow))
    # dark rose outline
    for i, (x, y) in enumerate(pts):
        t = i / (n - 1)
        r = width * (0.62 - 0.16 * t)
        d.ellipse([(x - r - 1.6) * 2, (y - r - 1.6) * 2,
                   (x + r + 1.6) * 2, (y + r + 1.6) * 2], fill=(190, 92, 108, 255))
    tipx, tipy = pts[-1]
    tr = width * 0.48
    d.ellipse([(tipx - tr - 1.6) * 2, (tipy - tr - 1.6) * 2,
               (tipx + tr + 1.6) * 2, (tipy + tr + 1.6) * 2], fill=(190, 92, 108, 255))
    # pink body with a soft lighter core
    for i, (x, y) in enumerate(pts):
        t = i / (n - 1)
        r = width * (0.62 - 0.16 * t)
        d.ellipse([(x - r) * 2, (y - r) * 2, (x + r) * 2, (y + r) * 2],
                  fill=(242, 146, 158, 255))
    d.ellipse([(tipx - tr) * 2, (tipy - tr) * 2, (tipx + tr) * 2, (tipy + tr) * 2],
              fill=(242, 146, 158, 255))
    for i, (x, y) in enumerate(pts):
        t = i / (n - 1)
        r = width * (0.62 - 0.16 * t)
        if t > 0.15:
            d.ellipse([(x - r * 0.42) * 2, (y - r * 0.55) * 2,
                       (x + r * 0.05) * 2, (y + r * 0.15) * 2], fill=(255, 184, 192, 255))
    # single highlight near the tip
    d.ellipse([(tipx - 1.8) * 2, (tipy - 3.0) * 2, (tipx + 2.4) * 2, (tipy + 0.6) * 2],
              fill=(255, 240, 242, 235))
    return lay.resize((CW, CH), Image.LANCZOS)


def heart_pts(cx, cy, r, rot=0.0, n=36):
    pts = []
    for i in range(n):
        t = 2 * math.pi * i / n
        x = 16 * math.sin(t) ** 3
        y = -(13 * math.cos(t) - 5 * math.cos(2 * t) - 2 * math.cos(3 * t)
              - math.cos(4 * t))
        p = (cx + x * r / 16.0, cy + y * r / 16.0)
        if rot:
            rr = math.radians(rot)
            dx, dy = p[0] - cx, p[1] - cy
            p = (cx + dx * math.cos(rr) - dy * math.sin(rr),
                 cy + dx * math.sin(rr) + dy * math.cos(rr))
        pts.append(p)
    return pts


def star_pts(cx, cy, r, inner=None, rot=0.0):
    inner = r * 0.36 if inner is None else inner
    pts = []
    for i in range(8):
        a = math.radians(-90 + i * 45 + rot)
        rr = r if i % 2 == 0 else inner
        pts.append((cx + rr * math.cos(a), cy + rr * math.sin(a)))
    return pts


def effects_layer(effects):
    if not effects:
        return None
    lay = Image.new('RGBA', (CW * 2, CH * 2), (0, 0, 0, 0))
    d = ImageDraw.Draw(lay)
    for e in effects:
        x, y, r, a = e['x'], e['y'], e['r'], e.get('alpha', 1.0)
        if a <= 0.02:
            continue
        if e['type'] == 'heart':
            d.polygon([(u * 2, v * 2) for u, v in heart_pts(x, y, r * 1.18, e.get('rot', 0))],
                      fill=(255, 255, 255, int(230 * a)))
            d.polygon([(u * 2, v * 2) for u, v in heart_pts(x, y, r, e.get('rot', 0))],
                      fill=(255, 126, 156, int(255 * a)))
            d.polygon([(u * 2, v * 2) for u, v in
                       heart_pts(x - r * 0.3, y - r * 0.3, r * 0.3, e.get('rot', 0))],
                      fill=(255, 255, 255, int(200 * a)))
        else:
            d.polygon([(u * 2, v * 2) for u, v in star_pts(x, y, r * 1.2, r * 0.42, e.get('rot', 0))],
                      fill=(255, 255, 255, int(235 * a)))
            d.polygon([(u * 2, v * 2) for u, v in star_pts(x, y, r, r * 0.33, e.get('rot', 0))],
                      fill=(255, 224, 140, int(245 * a)))
            d.polygon([(u * 2, v * 2) for u, v in star_pts(x, y, r * 0.42, r * 0.16, e.get('rot', 0))],
                      fill=(255, 255, 255, int(240 * a)))
    return lay.resize((CW, CH), Image.LANCZOS)


# ---------------------------------------------------------------------------
# poses: (claude, ds, effects) with claude/ds = dict(dx,dy,rot,sy)
def idle_poses(i):
    ph = 2 * math.pi * i / 8.0
    bob = -2.6 * math.sin(ph)
    c = dict(dx=0.0, dy=bob, rot=0.6 * math.sin(ph + 0.6), sy=1.0)
    d = dict(dx=0.0, dy=-2.0 * math.sin(ph + 1.1), rot=-0.5 * math.sin(ph + 1.7), sy=1.0)
    return c, d, []


def snuggle_poses(i):
    """Only the upper bodies lean together; feet and skirts stay put."""
    if i >= 35:
        c, d, eff = idle_poses(0)
        c = dict(c); d = dict(d)
        c.update(urot=0.0, udx=0.0, udy=0.0)
        d.update(urot=0.0, udx=0.0, udy=0.0)
        return c, d, eff, 0.0, 0.0
    t = i * 0.083                                    # 0..2.9 s
    L = kf(t, [(0.0, 0.0), (0.60, 1.0), (2.30, 1.0), (2.95, 0.0)])
    sway = math.sin(2 * math.pi * t / 1.45)
    breath = math.sin(2 * math.pi * t / 1.15)
    c = dict(dx=(33.0 + 0.9 * sway) * L,             # whole body leans right
             dy=(-0.5 + 0.7 * breath) * L,
             rot=(-7.0 - 0.4 * sway) * L,
             sy=1.0)
    d = dict(dx=(-34.0 - 0.9 * sway) * L,            # whole body leans left
             dy=(-1.0 + 0.8 * breath) * L,
             rot=(7.0 + 0.4 * sway) * L,
             sy=1.0)
    eff = []
    for k, (f0, x0, y0, r0) in enumerate((
            (3, 224, 146, 10.5), (11, 238, 136, 9.6), (19, 216, 140, 10.0))):
        age = i - f0
        if 0 <= age <= 18:
            u = age / 18.0
            sc = 0.9 + 0.22 * math.sin(math.pi * u)
            eff.append(dict(type='heart',
                            x=x0 + 5 * math.sin(u * 2.2 + k * 1.3),
                            y=y0 - 22 * u,
                            r=r0 * sc * L,
                            alpha=min(1.0, age / 2.0) * (1 - clamp((u - 0.6) / 0.4)),
                            rot=8 * math.sin(u * 3.0)))
    return c, d, eff, L, 0.0


def done_poses(i):
    if i >= 11:
        return idle_poses(0)
    if i == 10:
        c, d, _ = idle_poses(0)
        c = dict(c)
        d = dict(d)
        c['dy'] += 1.6
        c['rot'] += 0.5
        d['dy'] += 1.2
        d['rot'] -= 0.4
        return c, d, []
    t = i * 0.1
    j = kf(t, [(0.0, 0.0), (0.10, 3.0), (0.22, -11.0), (0.55, -11.0),
               (0.68, -2.0), (0.80, 0.0)])
    c = dict(dx=0.0, dy=j, rot=kf(t, [(0.0, 0.0), (0.22, -3.0), (0.6, -2.0), (0.85, 0.0)]),
             sy=1.0)
    d = dict(dx=0.0, dy=j * 0.8, rot=kf(t, [(0.0, 0.0), (0.12, -2.5), (0.35, 2.5),
                                            (0.6, -2.0), (0.85, 0.0)]), sy=1.0)
    eff = []
    for f0, x0, y0, ph in ((2, 68, 120, 0.0), (2, 214, 96, 1.1), (4, 100, 84, 2.0),
                           (5, 190, 132, 0.7), (7, 136, 78, 1.6)):
        age = i - f0
        if 0 <= age <= 9:
            u = age / 9.0
            eff.append(dict(type='star', x=x0 + 8 * math.sin(ph + u * 2.2),
                            y=y0 - 26 * u, r=8.5 + 2.6 * u,
                            alpha=0.95 * min(1.0, age / 1.5) * (1 - clamp((u - 0.5) / 0.5)),
                            rot=u * 40 + ph * 20))
    return c, d, eff


# ---------------------------------------------------------------------------
SKIN = (250, 222, 206, 255)
SKIN_D = (226, 186, 172, 255)
SLEEVE = (252, 250, 247, 255)
SLEEVE_D = (226, 214, 206, 255)


def draw_pat_arm(base, cl_img, cl_p, ds_img, ds_p, lean, pat):
    """white-sleeve arm from Claude's right shoulder to DeepSeek's head top."""
    if lean <= 0.02:
        return
    S2 = 3
    layer = Image.new('RGBA', (CW * S2, CH * S2), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)

    sh_x = CL_POS[0] + cl_img._dx + CLAUDE.size[0] * 0.78
    sh_y = CL_POS[1] + cl_img._dy + CLAUDE.size[1] * 0.470
    hd_x = DS_POS[0] + ds_img._dx + DS.size[0] * 0.50
    hd_y = DS_POS[1] + ds_img._dy + DS.size[1] * 0.075 - 10.0 * pat
    a = (sh_x, sh_y)
    b = (hd_x, hd_y)
    vx, vy = b[0] - a[0], b[1] - a[1]
    L = math.hypot(vx, vy) or 1.0
    ux, uy = vx / L, vy / L
    nx, ny = -uy, ux
    w0, w1 = 10.0, 8.0
    pts = [(a[0] + nx * w0, a[1] + ny * w0), (b[0] + nx * w1, b[1] + ny * w1),
           (b[0] - nx * w1, b[1] - ny * w1), (a[0] - nx * w0, a[1] - ny * w0)]
    d.polygon([(x * S2, y * S2) for x, y in pts], fill=SLEEVE)
    # cuff
    cx, cy = b[0] - ux * 5, b[1] - uy * 5
    d.polygon([((cx + nx * (w1 + 2)) * S2, (cy + ny * (w1 + 2)) * S2),
               ((cx - nx * (w1 + 2)) * S2, (cy - ny * (w1 + 2)) * S2),
               ((cx - ux * 5 - nx * (w1 + 1)) * S2, (cy - uy * 5 - ny * (w1 + 1)) * S2),
               ((cx - ux * 5 + nx * (w1 + 1)) * S2, (cy - uy * 5 + ny * (w1 + 1)) * S2)],
              fill=SLEEVE_D)
    # hand (rounded palm + 4 fingers + thumb)
    hr = 9.0
    palm = [(b[0] + ux * 3 + nx * hr * 0.2, b[1] + uy * 3 + ny * hr * 0.2)]
    d.ellipse([(b[0] - hr) * S2, (b[1] - hr * 0.86) * S2,
               (b[0] + hr) * S2, (b[1] + hr * 0.96) * S2], fill=SKIN)
    for k in range(4):
        fx = b[0] + ux * (4 + k * 0.4) + nx * (-4.5 + k * 3.0)
        fy = b[1] + uy * (4 + k * 0.4) + ny * (-4.5 + k * 3.0)
        d.ellipse([(fx - 3.3) * S2, (fy - 3.3) * S2, (fx + 3.3) * S2, (fy + 3.3) * S2],
                  fill=SKIN)
    d.ellipse([(b[0] + nx * 8 - 3.6) * S2, (b[1] + ny * 8 - 3.6) * S2,
               (b[0] + nx * 8 + 3.6) * S2, (b[1] + ny * 8 + 3.6) * S2], fill=SKIN)
    # finger separation lines
    for k in range(3):
        fx = b[0] + ux * 7 + nx * (-1.5 + k * 3.0)
        fy = b[1] + uy * 7 + ny * (-1.5 + k * 3.0)
        d.line([(fx * S2, fy * S2), ((fx + ux * 3) * S2, (fy + uy * 3) * S2)],
               fill=SKIN_D, width=max(1, S2 // 2))
    # soft outline
    layer = layer.filter(ImageFilter.GaussianBlur(0.6))
    base.alpha_composite(layer.resize((CW, CH), Image.LANCZOS))


def render_cell(i, name):
    base = Image.new('RGBA', (CW, CH), (0, 0, 0, 0))
    if name == 'idle':
        cl, ds, eff = idle_poses(i)
        ext = 0.0
    elif name == 'snuggle':
        cl, ds, eff, lean, pat = snuggle_poses(i)
        ext = 0.0
    else:
        cl, ds, eff = done_poses(i)
        ext = 0.0

    ground_shadow(base, CL_CX + cl['dx'] * 0.6, CLAUDE.size[0] * 0.34)
    ground_shadow(base, DS_CX + ds['dx'] * 0.6, DS.size[0] * 0.32)

    if name == 'snuggle':
        ds_img, ds_p = transform(DS, DS_POS, ds['rot'], ds['dx'], ds['dy'],
                                 ds['sy'], (0.5, 1.0))
        cl_img, cl_p = transform(CLAUDE, CL_POS, cl['rot'], cl['dx'], cl['dy'],
                                 cl['sy'], (0.5, 1.0))
        paste_center(base, ds_img, ds_p)
        paste_center(base, cl_img, cl_p)
    elif name == 'pat':
        ds_img, ds_p = transform(DS, DS_POS, ds['rot'], ds['dx'], ds['dy'],
                                 ds['sy'], (0.5, 1.0))
        cl_img, cl_p = transform(CLAUDE, CL_POS, cl['rot'], cl['dx'], cl['dy'], cl['sy'],
                                 (0.5, 1.0))
        paste_center(base, ds_img, ds_p)
        paste_center(base, cl_img, cl_p)
    else:
        ds_img, ds_p = transform(DS, DS_POS, ds['rot'], ds['dx'], ds['dy'],
                                 ds['sy'], ds.get('pivot'))
        cl_img, cl_p = transform(CLAUDE, CL_POS, cl['rot'], cl['dx'], cl['dy'], cl['sy'])
        paste_center(base, ds_img, ds_p)
        paste_center(base, cl_img, cl_p)

    if eff:
        e = effects_layer(eff)
        if e is not None:
            base.alpha_composite(e)
    return final_fit(base)


def final_fit(img):
    a = img.getchannel('A').point(lambda v: 255 if v > 16 else 0)
    bb = a.getbbox()
    if bb and bb[0] >= 6 and bb[1] >= 6 and bb[2] <= 434 and bb[3] <= 474:
        return img
    sc = 0.97
    out = Image.new('RGBA', (CW, CH), (0, 0, 0, 0))
    small = img.resize((int(round(CW * sc)), int(round(CH * sc))), Image.LANCZOS)
    out.paste(small, (int(round(220 - 220 * sc)), int(round(445 - 445 * sc))))
    return out


def build_sheet():
    cells = {n: [None] * c for n, r, c, d in ACTIONS}
    for name, row, count, dur in ACTIONS:
        for i in range(count):
            cells[name][i] = render_cell(i, name)
    sheet = Image.new('RGBA', (CW * COLS, CH * ROWS), (0, 0, 0, 0))
    for name, row, count, dur in ACTIONS:
        for i, img in enumerate(cells[name]):
            r = 1 + i // 12 if name == 'snuggle' else row
            sheet.paste(img, ((i % 12) * CW, r * CH))
    return sheet, cells


def build_icon(cells):
    cell = cells['idle'][0]
    big = cell.resize((CW * 2, CH * 2), Image.LANCZOS)
    crop = big.crop((int(30 * 2), int(40 * 2), int(410 * 2), int(300 * 2)))
    w, h = crop.size
    sc = min(248.0 / w, 248.0 / h)
    crop = crop.resize((max(1, int(w * sc)), max(1, int(h * sc))), Image.LANCZOS)
    icon = Image.new('RGBA', (256, 256), (0, 0, 0, 0))
    icon.paste(crop, ((256 - crop.size[0]) // 2, (256 - crop.size[1]) // 2))
    return icon


def bg_of(cell, color):
    bg = Image.new('RGBA', cell.size, color)
    bg.alpha_composite(cell)
    return bg


def previews(cells):
    os.makedirs(PREVIEW, exist_ok=True)
    for nm, cell in (('idle_f00', cells['idle'][0]), ('snuggle_f12', cells['snuggle'][12]),
                     ('done_f06', cells['done'][6])):
        cell.save(os.path.join(PREVIEW, '%s_1x.png' % nm))
        bg_of(cell, (246, 244, 240, 255)).save(os.path.join(PREVIEW, '%s_light.png' % nm))
        bg_of(cell, (30, 32, 40, 255)).save(os.path.join(PREVIEW, '%s_dark.png' % nm))
        bg_of(cell.resize((286, 312), Image.LANCZOS), (246, 244, 240, 255)).save(
            os.path.join(PREVIEW, '%s_286.png' % nm))
    strip = Image.new('RGBA', (3 * (CW + 12) + 12, CH + 24), (0, 0, 0, 0))
    for k, nm in enumerate(['idle_f00', 'snuggle_f12', 'done_f06']):
        strip.paste(cells[{'idle_f00': 'idle', 'snuggle_f12': 'snuggle', 'done_f06': 'done'}[nm]][
            {'idle_f00': 0, 'snuggle_f12': 12, 'done_f06': 6}[nm]], (12 + k * (CW + 12), 12))
    bg_of(strip, (246, 244, 240, 255)).save(os.path.join(PREVIEW, 'keyframes_light.png'))
    bg_of(strip, (30, 32, 40, 255)).save(os.path.join(PREVIEW, 'keyframes_dark.png'))
    bg_of(strip.resize((int(strip.size[0] * 0.65), int(strip.size[1] * 0.65)),
                       Image.LANCZOS), (246, 244, 240, 255)).save(
        os.path.join(PREVIEW, 'keyframes_65pct.png'))
    for name, row, count, dur in ACTIONS:
        chunks = [cells[name]] if name != 'snuggle' else \
                 [cells[name][k * 12:(k + 1) * 12] for k in range(3)]
        for k, chunk in enumerate(chunks):
            w, h = int(CW * 0.34), int(CH * 0.34)
            st = Image.new('RGBA', (len(chunk) * (w + 4) + 4, h + 8), (246, 244, 240, 255))
            for j, cell in enumerate(chunk):
                st.paste(bg_of(cell, (246, 244, 240, 255)).resize((w, h), Image.LANCZOS),
                         (4 + j * (w + 4), 4))
            st.save(os.path.join(PREVIEW, 'strip_%s%s.png' % (
                name, '' if name != 'snuggle' else '_%d' % k)))
    w, h = int(CW * 0.30), int(CH * 0.30)
    ov = Image.new('RGBA', (COLS * w + 2, ROWS * h + 2), (238, 234, 228, 255))
    for name, row, count, dur in ACTIONS:
        for i, cell in enumerate(cells[name]):
            r = 1 + i // 12 if name == 'snuggle' else row
            ov.paste(bg_of(cell, (246, 244, 240, 255)).resize((w, h), Image.LANCZOS),
                     ((i % 12) * w + 1, r * h + 1))
    ov.save(os.path.join(PREVIEW, 'overview_sheet.png'))
    print('previews ->', PREVIEW)


def check_sheet(sheet):
    ok = True
    used = {0: list(range(8)), 1: list(range(12)), 2: list(range(12)),
            3: list(range(12)), 4: list(range(12))}
    if sheet.size != (CW * COLS, CH * ROWS):
        print('FAIL sheet size', sheet.size)
        ok = False
    worst = [9999, 9999, 0, 0]
    for row in range(ROWS):
        for col in range(COLS):
            cell = sheet.crop((col * CW, row * CH, (col + 1) * CW, (row + 1) * CH))
            a = cell.getchannel('A')
            hist = a.histogram()
            cov = sum(hist[17:]) / float(CW * CH)
            if col in used[row]:
                bb = a.point(lambda v: 255 if v > 16 else 0).getbbox()
                good = cov > 0.015 and bb and bb[0] >= 6 and bb[1] >= 6 and \
                    bb[2] <= 434 and bb[3] <= 474
                ok = ok and good
                if bb:
                    worst = [min(worst[0], bb[0]), min(worst[1], bb[1]),
                             max(worst[2], bb[2]), max(worst[3], bb[3])]
                if not good:
                    print('FAIL row%d col%02d cov=%.1f%% bbox=%s' % (row, col, cov * 100, bb))
            else:
                if hist[0] != CW * CH:
                    print('FAIL row%d col%02d unused not transparent' % (row, col))
                    ok = False
    for row in range(ROWS):
        for col in range(COLS - 1):
            if col not in used[row] or (col + 1) not in used[row]:
                continue
            a = sheet.crop((col * CW, row * CH, (col + 1) * CW, (row + 1) * CH))
            b = sheet.crop(((col + 1) * CW, row * CH, (col + 2) * CW, (row + 1) * CH))
            if a.tobytes() == b.tobytes():
                print('FAIL row%d adjacent %d/%d identical' % (row, col, col + 1))
                ok = False
    print('bbox union worst:', worst)
    print('SELF-CHECK', 'PASS' if ok else 'FAIL')
    return ok


def main():
    os.makedirs(OUT_ASSETS, exist_ok=True)
    os.makedirs(PREVIEW, exist_ok=True)
    os.makedirs(FRAMES, exist_ok=True)
    sheet, cells = build_sheet()
    sp = os.path.join(OUT_ASSETS, 'spritesheet.png')
    sheet.save(sp, optimize=True)
    print('wrote', sp, os.path.getsize(sp))
    for name, row, count, dur in ACTIONS:
        for i, cell in enumerate(cells[name]):
            cell.save(os.path.join(FRAMES, '%s_%02d.png' % (name, i)))
    icon = build_icon(cells)
    icon.save(OUT_ICON, optimize=True)
    print('wrote', OUT_ICON, os.path.getsize(OUT_ICON))
    previews(cells)
    ok = check_sheet(sheet)
    print('icon', Image.open(OUT_ICON).size, os.path.getsize(OUT_ICON))
    return 0 if ok else 1


if __name__ == '__main__':
    sys.exit(main())
