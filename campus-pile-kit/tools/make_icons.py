# -*- coding: utf-8 -*-
"""生成 PWA 图标（纯标准库，不装 Pillow）。

    python tools/make_icons.py

产物写到 web/icons/：
    icon-192.png            普通图标（Android 桌面 / 通知）
    icon-512.png            普通图标（启动画面 / 商店样式）
    icon-maskable-512.png   自适应图标，内容缩进安全区，避免被系统裁掉
    apple-touch-icon.png    iOS 加到主屏用的 180×180

图形是"绿色圆角方块 + 白色闪电"，和看板里的空闲色 #1D9E75 一致。
"""

from __future__ import annotations

import struct
import zlib
from pathlib import Path

OUT_DIR = Path(__file__).resolve().parent.parent / "web" / "icons"

GREEN = (0x1D, 0x9E, 0x75)
WHITE = (0xFF, 0xFF, 0xFF)

# 闪电轮廓，坐标归一化到 0..1，包围盒大致居中
BOLT = [
    (0.560, 0.120),
    (0.298, 0.548),
    (0.462, 0.548),
    (0.404, 0.880),
    (0.702, 0.430),
    (0.520, 0.430),
]

SAMPLES = 3  # 每个像素 3×3 超采样做抗锯齿


def _png_chunk(tag: bytes, data: bytes) -> bytes:
    return (struct.pack(">I", len(data)) + tag + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))


def write_png(path: Path, size: int, rows: list[bytes]) -> None:
    raw = b"".join(b"\x00" + row for row in rows)
    blob = b"\x89PNG\r\n\x1a\n"
    blob += _png_chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
    blob += _png_chunk(b"IDAT", zlib.compress(raw, 9))
    blob += _png_chunk(b"IEND", b"")
    path.write_bytes(blob)


def _in_round_rect(x: float, y: float, radius: float, inset: float) -> bool:
    lo, hi = inset, 1.0 - inset
    if not (lo <= x <= hi and lo <= y <= hi):
        return False
    if radius <= 0:
        return True
    # 把坐标折叠到左上角，一次判断就够：两个方向离边界的距离都小于半径 → 落在角区
    dx, dy = min(x - lo, hi - x), min(y - lo, hi - y)
    if dx < radius and dy < radius:
        return (dx - radius) ** 2 + (dy - radius) ** 2 <= radius ** 2
    return True


def _in_polygon(x: float, y: float, poly) -> bool:
    inside = False
    total = len(poly)
    for i in range(total):
        x1, y1 = poly[i]
        x2, y2 = poly[(i + 1) % total]
        if (y1 > y) != (y2 > y):
            hit = (x2 - x1) * (y - y1) / (y2 - y1) + x1
            if x < hit:
                inside = not inside
    return inside


def render(size: int, maskable: bool) -> list[bytes]:
    """maskable=True 时铺满整块画布，图形缩到 78% 落在安全区内。"""
    if maskable:
        radius, inset, scale, offset = 0.0, 0.0, 0.78, 0.11
    else:
        radius, inset, scale, offset = 0.22, 0.0, 1.0, 0.0

    poly = [((x - 0.5) * scale + 0.5, (y - 0.5) * scale + 0.5) for x, y in BOLT]

    rows = []
    step = 1.0 / (size * SAMPLES)
    total = SAMPLES * SAMPLES
    for py in range(size):
        row = bytearray()
        for px in range(size):
            bg_hits = bolt_hits = 0
            for sy in range(SAMPLES):
                for sx in range(SAMPLES):
                    x = (px * SAMPLES + sx + 0.5) * step
                    y = (py * SAMPLES + sy + 0.5) * step
                    if _in_round_rect(x, y, radius, inset):
                        bg_hits += 1
                        if _in_polygon(x, y, poly):
                            bolt_hits += 1
            if bg_hits == 0:
                row += b"\x00\x00\x00\x00"
                continue
            bolt = bolt_hits / total
            rgb = tuple(round(WHITE[i] * bolt + GREEN[i] * (1 - bolt)) for i in range(3))
            row += bytes((*rgb, round(bg_hits / total * 255)))
        rows.append(bytes(row))
    return rows


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    targets = [
        ("icon-192.png", 192, False),
        ("icon-512.png", 512, False),
        ("icon-maskable-512.png", 512, True),
        ("apple-touch-icon.png", 180, False),
    ]
    for name, size, maskable in targets:
        write_png(OUT_DIR / name, size, render(size, maskable))
        print(f"写入 {OUT_DIR / name}  ({size}×{size})")


if __name__ == "__main__":
    main()
