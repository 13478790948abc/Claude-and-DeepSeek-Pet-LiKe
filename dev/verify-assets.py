#!/usr/bin/env python
"""
Independent QA harness for the Claude x DeepSeek desk-pet ART assets.

Written by qa-verifier from D:\\plugging\\.dsh-duo-pet\\SPEC.md (binding
contract). It never writes outside .dsh-duo-pet/dev/ and never modifies the
package under test.

Checks (SPEC sections 4.1-4.4 and section 10 item 4):
  * assets/spritesheet.png: PNG magic, IHDR 5280x2400, bit-depth 8, color type
    6 (RGBA); 12 cols x 5 rows of 440x480 cells; used cells row0 col0-7,
    row1-4 col0-11; every used cell solid (alpha > 16) coverage > 1.5%;
    unused cells (row0 col8-11) fully transparent (alpha == 0 everywhere);
    every used cell's solid bbox inside x[6,434] / y[6,474];
    consecutive frames in the same row are not pixel-identical.
  * icon.png at the package root: PNG magic, 256x256, RGBA, <= 256 KiB.
  * assets/sally.mp3 and assets/done.mp3: MP3 magic (ID3 or MPEG frame sync),
    ffmpeg/ffprobe-decodable, both ~2.19 s (2026-10-28: same user voice clip).

Run with the bundled/Anaconda Python that has Pillow (3.x):
    D:\\APP\\Anaconda3\\python.exe verify-assets.py [--json <path>] [--pkg <dir>]
        [--ffmpeg <path>]

Exit codes: 0 = PASS, 1 = FAIL, 2 = NOT-READY (assets missing), 3 = harness error.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import struct
import subprocess
import sys
import tempfile
from pathlib import Path

try:
    from PIL import Image
except Exception as exc:  # pragma: no cover - environment guard
    print(f"HARNESS INTERNAL ERROR: Pillow is not importable: {exc}")
    sys.exit(3)

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
DEFAULT_PKG = ROOT / "duo-pet-plugin"
DEFAULT_REPORT = HERE / "assets-report-latest.json"


def _default_ffmpeg():
    """Portable ffmpeg lookup: env var -> PATH -> the author's local build."""
    import os
    import shutil

    from_env = os.environ.get("DUO_PET_FFMPEG")
    if from_env:
        return Path(from_env)
    on_path = shutil.which("ffmpeg")
    if on_path:
        return Path(on_path)
    return Path(r"D:\plugging\_tools\ffmpeg\imageio_ffmpeg\binaries\ffmpeg-win-x86_64-v7.1.exe")


DEFAULT_FFMPEG = _default_ffmpeg()

PNG_MAGIC = b"\x89PNG\r\n\x1a\n"
CELL_W = 440
CELL_H = 480
COLS = 12
ROWS = 5
SHEET_W = CELL_W * COLS  # 5280
SHEET_H = CELL_H * ROWS  # 2400
# (row, action, used_frame_count)
# 2026-10-28: row1-3 are the `snuggle` animation (Claude + DeepSeek snuggle, hearts).
ROW_ACTIONS = [(0, "idle", 8), (1, "snuggle", 12), (2, "snuggle", 12), (3, "snuggle", 12), (4, "done", 12)]
SOLID_ALPHA = 16  # SPEC: "瀹炲績鍍忕礌锛坅lpha > 16锛?
MIN_COVERAGE = 0.015  # > 1.5 %
BBOX_X_MIN, BBOX_X_MAX = 6, CELL_W - 6  # 6 .. 434
BBOX_Y_MIN, BBOX_Y_MAX = 6, CELL_H - 6  # 6 .. 474
ICON_MAX_BYTES = 256 * 1024
AUDIO_SPECS = [
    # (relative path, expected duration in seconds, expected byte size)
    # 2026-10-28: both sally.mp3 and done.mp3 are the user-provided voice clip
    # ("盐津虾嘛"), normalized loudness, ~2.19 s / 35,569 B each.
    ("assets/sally.mp3", 2.19, 35569),
    ("assets/done.mp3", 2.19, 35569),
]
DURATION_TOLERANCE_S = 0.20

rows: list[dict] = []


def record(check_id: str, title: str, status: str, detail: str) -> None:
    rows.append(
        {
            "id": check_id,
            "title": title,
            "pass": status == "PASS",
            "status": status,
            "evidence": detail,
        }
    )
    print(f"[{status}] {check_id} {title} :: {detail}", flush=True)


def check(check_id: str, title: str, fn) -> bool:
    try:
        detail = fn()
        record(check_id, title, "PASS", detail if detail is not None else "ok")
        return True
    except AssertionError as exc:
        record(check_id, title, "FAIL", str(exc))
        return False
    except Exception as exc:  # noqa: BLE001 - report harness exceptions as failures
        record(check_id, title, "FAIL", f"{type(exc).__name__}: {exc}")
        return False


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def png_ihdr(data: bytes) -> tuple[int, int, int, int]:
    """Return (width, height, bit_depth, color_type) from the PNG IHDR chunk."""
    assert data[:8] == PNG_MAGIC, "PNG magic bytes are wrong"
    assert data[8:12] == b"\x00\x00\x00\r", "PNG does not start with an IHDR chunk of length 13"
    assert data[12:16] == b"IHDR", f"first PNG chunk is {data[12:16]!r}, expected b'I HDR'"
    width, height, bit_depth, color_type = struct.unpack(">IIBB", data[16:26])
    return width, height, bit_depth, color_type


# ---------------------------------------------------------------------------
# spritesheet.png
# ---------------------------------------------------------------------------
def analyze_sheet(sheet_path: Path) -> dict:
    data = sheet_path.read_bytes()
    evidence: dict = {
        "path": str(sheet_path),
        "bytes": len(data),
        "sha256": sha256_file(sheet_path),
        "cells": {},
        "rows": {},
    }

    def _png() -> str:
        width, height, bit_depth, color_type = png_ihdr(data)
        assert (width, height) == (SHEET_W, SHEET_H), (
            f"IHDR says {width}x{height}, expected {SHEET_W}x{SHEET_H}"
        )
        assert bit_depth == 8, f"IHDR bit depth is {bit_depth}, expected 8"
        assert color_type == 6, f"IHDR color type is {color_type}, expected 6 (RGBA)"
        return f"PNG magic ok; IHDR {width}x{height} bit_depth=8 color_type=6 (RGBA)"

    if not check("S1", "spritesheet.png is a 5280x2400 RGBA PNG (12x5 cells of 440x480)", _png):
        return evidence

    try:
        image = Image.open(sheet_path)
        image.load()
    except Exception as exc:  # noqa: BLE001
        record("S2", "Pillow decodes spritesheet.png", "FAIL", f"{type(exc).__name__}: {exc}")
        return evidence
    mode = image.mode
    rgba = image.convert("RGBA")
    evidence["mode"] = mode
    evidence["size"] = [rgba.width, rgba.height]
    if not check(
        "S2",
        "decoded spritesheet is RGBA 5280x2400",
        lambda: _assert_decoded(rgba, mode),
    ):
        return evidence

    cell_metrics: dict[tuple[int, int], dict] = {}
    for row in range(ROWS):
        prev_bytes: bytes | None = None
        for col in range(COLS):
            box = (col * CELL_W, row * CELL_H, (col + 1) * CELL_W, (row + 1) * CELL_H)
            cell = rgba.crop(box)
            alpha = cell.getchannel("A")
            hist = alpha.histogram()
            total = CELL_W * CELL_H
            transparent = hist[0]
            gt0 = total - transparent
            solid = total - sum(hist[: SOLID_ALPHA + 1])  # alpha > 16 i.e. >= 17
            solid_mask = alpha.point(lambda value: 255 if value > SOLID_ALPHA else 0)
            raw = cell.tobytes()
            cell_metrics[(row, col)] = {
                "coverage_gt0": gt0 / total,
                "coverage_solid": solid / total,
                "solid_pixels": solid,
                "transparent_pixels": transparent,
                "bbox_solid": solid_mask.getbbox(),
                "identical_prev": prev_bytes is not None and raw == prev_bytes,
            }
            prev_bytes = raw

    # -- used cells: solid coverage > 1.5 % -----------------------------------
    used_ok = True
    for row, action, frame_count in ROW_ACTIONS:
        def _used(row=row, action=action, frame_count=frame_count) -> str:
            problems = []
            worst = None
            for col in range(frame_count):
                metrics = cell_metrics[(row, col)]
                coverage = metrics["coverage_solid"]
                if coverage <= MIN_COVERAGE:
                    problems.append(
                        f"row {row} ({action}) col {col}: solid coverage {coverage * 100:.3f}% <= 1.5%"
                    )
                if worst is None or coverage < worst[0]:
                    worst = (coverage, col)
            assert not problems, "; ".join(problems)
            return (
                f"row {row} ({action}): {frame_count} used cells, min solid coverage "
                f"{worst[0] * 100:.2f}% at col {worst[1]} (threshold > 1.5%)"
            )

        used_ok &= check(f"S3.{row}", f"row {row} ({action}) every used frame has solid coverage > 1.5%", _used)

    # -- row0 unused cells col 8-11 fully transparent -------------------------
    def _unused() -> str:
        problems = []
        for col in range(8, COLS):
            metrics = cell_metrics[(0, col)]
            if metrics["transparent_pixels"] != CELL_W * CELL_H:
                problems.append(
                    f"row 0 col {col}: {CELL_W * CELL_H - metrics['transparent_pixels']} non-transparent pixel(s)"
                )
        assert not problems, "; ".join(problems)
        return "row 0 cols 8-11 are fully transparent (alpha == 0 everywhere)"

    unused_ok = check("S4", "unused cells row0 col8-11 have alpha all 0", _unused)

    # -- solid bbox inside x[6,434] / y[6,474] -------------------------------
    bbox_report: dict[str, list] = {}
    bbox_ok = True
    for row, action, frame_count in ROW_ACTIONS:
        def _bbox(row=row, action=action, frame_count=frame_count) -> str:
            problems = []
            bboxes = []
            for col in range(frame_count):
                bbox = cell_metrics[(row, col)]["bbox_solid"]
                if bbox is None:
                    problems.append(f"row {row} col {col}: no solid pixels")
                    bboxes.append(None)
                    continue
                x0, y0, x1, y1 = bbox
                bboxes.append([x0, y0, x1, y1])
                if x0 < BBOX_X_MIN or y0 < BBOX_Y_MIN or x1 > BBOX_X_MAX or y1 > BBOX_Y_MAX:
                    problems.append(
                        f"row {row} col {col}: solid bbox {bbox} outside "
                        f"x[{BBOX_X_MIN},{BBOX_X_MAX}] y[{BBOX_Y_MIN},{BBOX_Y_MAX}]"
                    )
            assert not problems, "; ".join(problems)
            bbox_report[action if action != "snuggle" else f"snuggle.row{row}"] = bboxes
            max_x1 = max(b[2] for b in bboxes if b)
            max_y1 = max(b[3] for b in bboxes if b)
            min_x0 = min(b[0] for b in bboxes if b)
            min_y0 = min(b[1] for b in bboxes if b)
            return (
                f"row {row} ({action}): {frame_count} solid bboxes inside limits; "
                f"worst x=[{min_x0},{max_x1}] y=[{min_y0},{max_y1}]"
            )

        bbox_ok &= check(f"S5.{row}", f"row {row} ({action}) solid bbox stays inside x[6,434] y[6,474]", _bbox)

    # -- consecutive frames differ (same row) --------------------------------
    motion_ok = True
    for row, action, frame_count in ROW_ACTIONS:
        def _motion(row=row, action=action, frame_count=frame_count) -> str:
            identical = [
                f"{col - 1}=={col}"
                for col in range(1, frame_count)
                if cell_metrics[(row, col)]["identical_prev"]
            ]
            assert not identical, (
                f"row {row} ({action}) has pixel-identical consecutive frames: {', '.join(identical)}"
            )
            return (
                f"row {row} ({action}): all {frame_count - 1} consecutive frame pair(s) differ by at least 1 pixel"
            )

        motion_ok &= check(f"S6.{row}", f"row {row} ({action}) consecutive frames are not identical", _motion)

    # -- evidence -------------------------------------------------------------
    for (row, col), metrics in cell_metrics.items():
        evidence["cells"][f"r{row}c{col}"] = {
            "coverage_solid": round(metrics["coverage_solid"], 6),
            "bbox_solid": list(metrics["bbox_solid"]) if metrics["bbox_solid"] else None,
            "non_transparent_pixels": CELL_W * CELL_H - metrics["transparent_pixels"],
        }
    evidence["bbox_solid"] = bbox_report
    evidence["used_cells"] = {
        "row0": [0, 7],
        "row1": [0, 11],
        "row2": [0, 11],
        "row3": [0, 11],
        "row4": [0, 11],
    }
    return evidence


def _assert_decoded(rgba: "Image.Image", mode: str) -> str:
    assert mode == "RGBA", f"decoded image mode is {mode!r}, expected 'RGBA'"
    assert rgba.size == (SHEET_W, SHEET_H), (
        f"decoded size is {rgba.size[0]}x{rgba.size[1]}, expected {SHEET_W}x{SHEET_H}"
    )
    return f"mode={mode}, size={rgba.size[0]}x{rgba.size[1]}, cells={COLS}x{ROWS} of {CELL_W}x{CELL_H}"


# ---------------------------------------------------------------------------
# icon.png
# ---------------------------------------------------------------------------
def verify_icon(icon_path: Path) -> dict:
    data = icon_path.read_bytes()
    evidence: dict = {
        "path": str(icon_path),
        "bytes": len(data),
        "sha256": sha256_file(icon_path),
    }

    def _png() -> str:
        width, height, bit_depth, color_type = png_ihdr(data)
        assert (width, height) == (256, 256), f"IHDR says {width}x{height}, expected 256x256"
        assert bit_depth == 8, f"IHDR bit depth is {bit_depth}, expected 8"
        assert color_type == 6, f"IHDR color type is {color_type}, expected 6 (RGBA)"
        return f"PNG magic ok; IHDR 256x256 bit_depth=8 color_type=6 (RGBA), {len(data)} bytes"

    ok = check("I1", "icon.png has PNG magic and is 256x256 RGBA", _png)
    ok &= check(
        "I2",
        "icon.png is <= 256 KiB",
        lambda: _assert_icon_size(len(data)),
    )
    if not ok:
        return evidence
    try:
        image = Image.open(icon_path)
        image.load()
    except Exception as exc:  # noqa: BLE001
        record("I3", "Pillow decodes icon.png", "FAIL", f"{type(exc).__name__}: {exc}")
        return evidence
    rgba = image.convert("RGBA")
    evidence["mode"] = image.mode
    evidence["size"] = [rgba.width, rgba.height]
    alpha = rgba.getchannel("A")
    hist = alpha.histogram()
    total = rgba.width * rgba.height
    gt0 = total - hist[0]
    evidence["alpha_coverage"] = round(gt0 / total, 6)
    check(
        "I3",
        "icon.png decodes RGBA with visible content",
        lambda: _assert_icon_content(rgba, image.mode, gt0 / total),
    )
    return evidence


def _assert_icon_size(size: int) -> str:
    assert size <= ICON_MAX_BYTES, f"icon.png is {size} bytes, limit is {ICON_MAX_BYTES} bytes (256 KiB)"
    return f"{size} bytes <= {ICON_MAX_BYTES} bytes (256 KiB)"


def _assert_icon_content(rgba: "Image.Image", mode: str, coverage: float) -> str:
    assert mode == "RGBA", f"decoded icon mode is {mode!r}, expected 'RGBA'"
    assert rgba.size == (256, 256), f"decoded icon size is {rgba.size[0]}x{rgba.size[1]}, expected 256x256"
    assert coverage > 0.01, f"icon opaque coverage is {coverage * 100:.2f}% (<= 1%); icon looks empty"
    return f"mode={mode}, size=256x256, opaque coverage={coverage * 100:.2f}%"


# ---------------------------------------------------------------------------
# audio
# ---------------------------------------------------------------------------
def mp3_magic_ok(data: bytes) -> bool:
    if len(data) < 4:
        return False
    if data[:3] == b"ID3":
        return True
    # MPEG audio frame sync: 11 set bits; layer bits must not be 00 (reserved).
    return data[0] == 0xFF and (data[1] & 0xE0) == 0xE0 and (data[1] & 0x06) != 0x00


def ffmpeg_probe(ffmpeg: Path, path: Path) -> tuple[str, float | None]:
    """Run ffmpeg -i with stderr redirected to a FILE (no pipes) and parse it."""
    with tempfile.NamedTemporaryFile("w+b", suffix=".log", delete=False) as log:
        log_path = Path(log.name)
    try:
        with log_path.open("wb") as log_handle:
            subprocess.run(
                [str(ffmpeg), "-hide_banner", "-i", str(path)],
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=log_handle,
                timeout=60,
                check=False,
            )
        text = log_path.read_text(encoding="utf-8", errors="replace")
    finally:
        try:
            log_path.unlink()
        except OSError:
            pass
    duration = None
    match = re.search(r"Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)", text)
    if match:
        duration = int(match.group(1)) * 3600 + int(match.group(2)) * 60 + float(match.group(3))
    return text, duration

def _audio_line(log_text: str) -> str:
    for line in log_text.splitlines():
        if "Audio:" in line:
            return line.strip()
    return ""


# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------
def main() -> int:
    parser = argparse.ArgumentParser(description="Independent QA for duo-pet art assets")
    parser.add_argument("--json", default=str(DEFAULT_REPORT), help="JSON report path")
    parser.add_argument("--pkg", default=str(DEFAULT_PKG), help="package directory")
    parser.add_argument("--ffmpeg", default=str(DEFAULT_FFMPEG), help="ffmpeg executable")
    args = parser.parse_args()

    pkg = Path(args.pkg)
    sheet_path = pkg / "assets" / "spritesheet.png"
    icon_path = pkg / "icon.png"
    ffmpeg = Path(args.ffmpeg)

    evidence: dict = {"packageDir": str(pkg), "python": sys.version.split()[0], "ffmpeg": str(ffmpeg)}

    missing = [str(p) for p in (sheet_path, icon_path) if not p.is_file()]
    if missing:
        record("A0", "art assets present", "NOT-READY", f"missing: {', '.join(missing)}")
    else:
        record("A0", "art assets present", "PASS", f"{sheet_path}; {icon_path}")

    if sheet_path.is_file():
        evidence["spritesheet"] = analyze_sheet(sheet_path)
    if icon_path.is_file():
        evidence["icon"] = verify_icon(icon_path)

    audio_pkg = Path(args.pkg)
    try:
        audio_evidence, _ = verify_audio_with_pkg(ffmpeg, audio_pkg)
        evidence["audio"] = audio_evidence
    except Exception as exc:  # noqa: BLE001
        record("AU", "audio assets", "FAIL", f"{type(exc).__name__}: {exc}")

    counts: dict[str, int] = {}
    for row in rows:
        counts[row["status"]] = counts.get(row["status"], 0) + 1
    exit_code = 0
    if counts.get("NOT-READY"):
        exit_code = 2
    elif counts.get("FAIL"):
        exit_code = 1
    verdict = "PASS" if exit_code == 0 else ("NOT-READY" if exit_code == 2 else "FAIL")

    print("\n================ DUO-PET ASSET QA SUMMARY ================")
    for row in rows:
        if row["status"] == "PASS":
            continue
        print(f"{row['status']:<10} {row['id']:<12} {row['title']}")
        print(f"{'':<10} -> {row['evidence']}")
    print("---------------------------------------------------------")
    print("counts: " + ", ".join(f"{key}={value}" for key, value in sorted(counts.items())))
    print(f"verdict: {verdict}")
    print("=========================================================")

    report = {
        "generatedAt": __import__("datetime").datetime.now().astimezone().isoformat(),
        "packageDir": str(pkg),
        "verdict": verdict,
        "counts": counts,
        "evidence": evidence,
        "rows": rows,
    }
    try:
        report_path = Path(args.json)
        report_path.parent.mkdir(parents=True, exist_ok=True)
        report_path.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        print(f"report: {args.json}")
    except Exception as exc:  # noqa: BLE001
        print(f"could not write JSON report: {exc}")
    return exit_code


def verify_audio_with_pkg(ffmpeg: Path, pkg: Path) -> tuple[dict, bool]:
    evidence: dict = {}
    all_ok = True
    for rel, expected, expected_bytes in AUDIO_SPECS:
        path = pkg / rel
        if not path.is_file():
            record(f"AU.{Path(rel).stem}", f"{rel} present", "NOT-READY", f"missing {path}")
            all_ok = False
            continue
        data = path.read_bytes()
        item = {
            "path": str(path),
            "bytes": len(data),
            "sha256": sha256_file(path),
            "expected_duration_s": expected,
            "expected_bytes": expected_bytes,
        }
        evidence[rel] = item

        def _magic(rel=rel, data=data) -> str:
            assert len(data) > 0, f"{rel} is empty"
            assert mp3_magic_ok(data), (
                f"{rel} has no MP3 magic: first bytes {data[:4].hex()} "
                f"(expected ID3 or MPEG frame sync 0xFF 0xEx)"
            )
            return f"{rel}: MP3 magic ok ({data[:3].hex() if data[:3] == b'ID3' else 'MPEG frame sync'}), {len(data)} bytes"

        magic_ok = check(f"AU.{Path(rel).stem}.magic", f"{rel} has MP3 magic", _magic)
        all_ok &= magic_ok

        def _bytes(rel=rel, data=data, expected_bytes=expected_bytes) -> str:
            assert len(data) == expected_bytes, (
                f"{rel} is {len(data)} bytes, expected {expected_bytes} bytes (current contract)"
            )
            return f"{rel}: {len(data)} bytes == expected {expected_bytes} bytes"

        all_ok &= check(f"AU.{Path(rel).stem}.size", f"{rel} byte size matches the current contract", _bytes)
        if not ffmpeg.is_file():
            record(
                f"AU.{Path(rel).stem}.probe",
                f"{rel} duration is ~{expected:.2f}s",
                "FAIL",
                f"ffmpeg not found at {ffmpeg}; cannot parse duration",
            )
            all_ok = False
            continue
        try:
            log_text, duration = ffmpeg_probe(ffmpeg, path)
        except Exception as exc:  # noqa: BLE001
            record(f"AU.{Path(rel).stem}.probe", f"{rel} duration is ~{expected:.2f}s", "FAIL",
                   f"ffmpeg probe failed: {type(exc).__name__}: {exc}")
            all_ok = False
            continue
        item["ffmpeg_duration_s"] = duration
        item["ffmpeg_audio_line"] = _audio_line(log_text)
        item["ffmpeg_parsed"] = "Input #0, mp3" in log_text or "Audio: mp3" in log_text

        def _probe(rel=rel, expected=expected, duration=duration, log_text=log_text) -> str:
            assert duration is not None, (
                f"ffmpeg could not parse a duration from {rel}; audio not decodable. "
                f"ffmpeg output head: {log_text[:300]!r}"
            )
            assert "mp3" in log_text.lower(), (
                f"ffmpeg did not identify an mp3 stream in {rel}: {log_text[:300]!r}"
            )
            delta = abs(duration - expected)
            assert delta <= DURATION_TOLERANCE_S, (
                f"{rel} duration {duration:.3f}s differs from {expected:.2f}s by "
                f"{delta:.3f}s (tolerance {DURATION_TOLERANCE_S:.2f}s)"
            )
            return (
                f"{rel}: ffmpeg parsed mp3, duration {duration:.3f}s (expected ~{expected:.2f}s, "
                f"delta {delta:.3f}s <= {DURATION_TOLERANCE_S:.2f}s); {_audio_line(log_text)}"
            )

        all_ok &= check(f"AU.{Path(rel).stem}.probe", f"{rel} is parseable and ~{expected:.2f}s long", _probe)
    return evidence, all_ok


if __name__ == "__main__":
    try:
        sys.exit(main())
    except SystemExit:
        raise
    except Exception as exc:  # noqa: BLE001
        print(f"HARNESS INTERNAL ERROR: {type(exc).__name__}: {exc}")
        sys.exit(3)
