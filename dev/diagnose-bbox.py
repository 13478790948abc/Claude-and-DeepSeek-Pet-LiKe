#!/usr/bin/env python
"""QA diagnostic (dev-only): locate solid (alpha>16) pixels that leave the
SPEC bbox x[6,434]/y[6,474] in the current spritesheet, and characterise them
(alpha level / position) so art-master gets actionable evidence.
"""
from __future__ import annotations

from pathlib import Path

from PIL import Image

PKG = Path(r"D:\plugging\.dsh-duo-pet\duo-pet-plugin")
SHEET = PKG / "assets" / "spritesheet.png"
CELL_W, CELL_H = 440, 480
COLS, ROWS = 12, 5
ROW_FRAMES = [8, 12, 12, 12, 12]
LIMIT = (6, 6, 434, 474)  # x0, y0, x1, y1 (exclusive right/bottom)

img = Image.open(SHEET).convert("RGBA")
print(f"sheet: {img.size} mode={img.mode}")
total_frames = sum(ROW_FRAMES)
bad_frames = 0
bad_cells = []
for row, frames in enumerate(ROW_FRAMES):
    for col in range(frames):
        cell = img.crop((col * CELL_W, row * CELL_H, (col + 1) * CELL_W, (row + 1) * CELL_H))
        alpha = cell.getchannel("A")
        mask = alpha.point(lambda v: 255 if v > 16 else 0)
        bbox = mask.getbbox()
        if bbox is None:
            continue
        x0, y0, x1, y1 = bbox
        violations = []
        if x0 < LIMIT[0]:
            violations.append(f"left x0={x0}")
        if y0 < LIMIT[1]:
            violations.append(f"top y0={y0}")
        if x1 > LIMIT[2]:
            violations.append(f"right x1={x1}")
        if y1 > LIMIT[3]:
            violations.append(f"bottom y1={y1}")
        if not violations:
            continue
        bad_frames += 1
        # characterise violating pixels
        viol_pixels = []
        for y in range(CELL_H):
            for x in range(CELL_W):
                a = alpha.getpixel((x, y))
                if a > 16 and (x < LIMIT[0] or y < LIMIT[1] or x >= LIMIT[2] or y >= LIMIT[3]):
                    viol_pixels.append((x, y, a))
        alphas = [p[2] for p in viol_pixels]
        edge_x = sorted({p[0] for p in viol_pixels})
        edge_y = sorted({p[1] for p in viol_pixels})
        bad_cells.append({
            "cell": f"r{row}c{col}",
            "bbox": bbox,
            "violations": violations,
            "viol_pixel_count": len(viol_pixels),
            "viol_alpha_min": min(alphas),
            "viol_alpha_max": max(alphas),
            "viol_alpha_median": sorted(alphas)[len(alphas) // 2],
            "viol_x_range": [edge_x[0], edge_x[-1]],
            "viol_y_range": [edge_y[0], edge_y[-1]],
            "sample":
            viol_pixels[:5],
        })

print(f"bad frames: {bad_frames}/{total_frames}")
for item in bad_cells:
    print(
        f"{item['cell']}: bbox={item['bbox']} ({', '.join(item['violations'])}) "
        f"viol_px={item['viol_pixel_count']} alpha={item['viol_alpha_min']}..{item['viol_alpha_max']} "
        f"(median {item['viol_alpha_median']}) x={item['viol_x_range']} y={item['viol_y_range']} "
        f"sample={item['sample']}"
    )

# For a couple of representative cells, dump the alpha profile at the offending edge.
for cell_id in ("r2c0", "r1c7", "r0c5", "r4c3"):
    row = int(cell_id[1])
    col = int(cell_id[3:])
    cell = img.crop((col * CELL_W, row * CELL_H, (col + 1) * CELL_W, (row + 1) * CELL_H))
    alpha = cell.getchannel("A")
    print(f"\n--- {cell_id} edge alpha profiles ---")
    for x in range(0, 10):
        col_vals = [alpha.getpixel((x, y)) for y in range(CELL_H)]
        print(f"x={x}: max_alpha={max(col_vals)} px>16={sum(1 for v in col_vals if v > 16)}")
    for x in range(CELL_W - 10, CELL_W):
        col_vals = [alpha.getpixel((x, y)) for y in range(CELL_H)]
        print(f"x={x}: max_alpha={max(col_vals)} px>16={sum(1 for v in col_vals if v > 16)}")
    for y in range(0, 10):
        row_vals = [alpha.getpixel((x, y)) for x in range(CELL_W)]
        print(f"y={y}: max_alpha={max(row_vals)} px>16={sum(1 for v in row_vals if v > 16)}")

# overall alpha>16 vs higher thresholds near edges: how many frames would pass at alpha>40?
print("\n--- threshold sensitivity (frames violating at alpha>16 / >24 / >40 / >64) ---")
for threshold in (16, 24, 40, 64):
    count = 0
    for row, frames in enumerate(ROW_FRAMES):
        for col in range(frames):
            cell = img.crop((col * CELL_W, row * CELL_H, (col + 1) * CELL_W, (row + 1) * CELL_H))
            alpha = cell.getchannel("A")
            mask = alpha.point(lambda v, t=threshold: 255 if v > t else 0)
            bbox = mask.getbbox()
            if bbox is None:
                continue
            x0, y0, x1, y1 = bbox
            if x0 < 6 or y0 < 6 or x1 > 434 or y1 > 474:
                count += 1
    print(f"alpha>{threshold}: {count} violating frames")
