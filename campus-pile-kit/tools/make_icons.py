# -*- coding: utf-8 -*-
"""生成 PWA 图标 —— 花体字标「Changge」（长大蓝底）。

    python tools/make_icons.py            # 出图标 + favicon.svg

为什么是这个造型：
  花体的 "Changge" 就是签名本身 —— 图标里不写中文、不加图形，只把这串手写体压在蓝底上，
  缩到任务栏/主屏还是一眼认出「这是长歌的那个站」。
  字体是 Segoe Script Bold（Windows 自带的连笔手写体），已转成轮廓路径存在
  tools/lockup-changge.txt —— 改字迹只需要重跑 python tools/dump_lockup.py。

产物（写到 chd-charge/icons/）：
    icon-192.png            普通图标（Android 桌面 / 通知）
    icon-512.png            普通图标（启动画面 / 商店样式）
    icon-maskable-512.png   自适应图标：满底 + 内容缩进安全区，避免被系统裁掉
    apple-touch-icon.png    iOS 加到主屏：必须**满底无圆角**，圆角由 iOS 自己切
                            （自带圆角会变成「圆角套圆角」，四角透出底色）
    favicon.svg             浏览器标签页图标（index.html 外链它，8.8KB 走缓存更划算）

渲染借本机 Edge 无头模式出 1024 母版（SVG 的渐变和抗锯齿比脚本硬画准），
再交给 Pillow 缩各档尺寸 —— LANCZOS 缩小的边缘比 1× 直接出图干净。
"""
from __future__ import annotations

import subprocess
import sys
import tempfile
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / "chd-charge" / "icons"
LOCKUP = ROOT / "tools" / "lockup-changge.txt"

EDGE_CANDIDATES = [
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
]

RX = 116             # 圆角半径（512 基准）；iOS / maskable 版必须为 0
BG_TOP = "#24599B"   # 长大蓝（校徽标准蓝那一族）
BG_BOTTOM = "#0A2144"
MASK_INSET = 0.82    # maskable 安全区：内容缩到 82%，系统裁圆也切不到字带

GRAD = (f'<linearGradient id="bg" x1="0" y1="0" x2="0.32" y2="1">'
        f'<stop offset="0" stop-color="{BG_TOP}"/>'
        f'<stop offset="1" stop-color="{BG_BOTTOM}"/></linearGradient>')

HEAD = ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" '
        'width="512" height="512">')


def load_lockup() -> str:
    """读已转曲的花体字标（tools/lockup-changge.txt，由 dump_lockup.py 生成）。"""
    if not LOCKUP.exists():
        sys.exit(f"缺少字标路径：{LOCKUP}\n先跑 python tools/dump_lockup.py 生成")
    d = LOCKUP.read_text(encoding="utf-8").strip()
    if not d.startswith("M"):
        sys.exit(f"字标路径格式不对（应以 M 开头）：{d[:40]}")
    return d


CONTENT = f'<path d="{load_lockup()}" fill="#FFFFFF"/>'


def build_svg(with_bg: bool = True, rx: int = RX, with_content: bool = True) -> str:
    """三种组合：圆角成品 / 满底 / 只有内容（透明底）。

    defs 无条件输出 —— 现在内容只有纯白字标，用不到渐变，
    但保留这个习惯：哪天给字加渐变填充，省掉 defs 会让「只有内容」那层静默空掉。
    """
    parts = [HEAD, f"<defs>{GRAD}</defs>"]
    if with_bg:
        parts.append(f'<rect width="512" height="512" rx="{rx}" fill="url(#bg)"/>')
    if with_content:
        parts.append(CONTENT)
    parts.append("</svg>")
    return "".join(parts)


def _edge() -> str:
    for p in EDGE_CANDIDATES:
        if Path(p).exists():
            return p
    sys.exit("找不到 Edge / Chrome，无法把 SVG 渲染成位图")


def render(svg: str, tmp: Path, name: str) -> Image.Image:
    """SVG → 512×512 RGBA（dsf=2 渲染成 1024 再缩回，边缘更干净）。"""
    svg_path = tmp / f"{name}.svg"
    html_path = tmp / f"{name}.html"
    png_path = tmp / f"{name}.png"
    svg_path.write_text(svg, encoding="utf-8")
    html_path.write_text(
        '<!doctype html><meta charset="utf-8">'
        '<style>html,body{margin:0;padding:0;background:transparent}'
        'img{display:block;width:512px;height:512px}</style>'
        f'<img src="{name}.svg">', encoding="utf-8")
    subprocess.run([
        _edge(), "--headless=new", "--disable-gpu", "--hide-scrollbars",
        "--default-background-color=00000000",
        f"--screenshot={png_path}", "--window-size=512,512",
        "--force-device-scale-factor=2",
        html_path.as_uri(),
    ], check=False, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    if not png_path.exists():
        sys.exit(f"渲染失败：{name}")
    return Image.open(png_path).convert("RGBA").resize((512, 512), Image.LANCZOS)


def save(img: Image.Image, size: int, name: str) -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    path = OUT_DIR / name
    img.resize((size, size), Image.LANCZOS).save(path, optimize=True)
    print(f"  {name:24s} {size}×{size}  {path.stat().st_size:,} B")


def main() -> None:
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        print("渲染母版…")
        rounded = render(build_svg(rx=RX), tmp, "rounded")        # 成品（带圆角）
        flat = render(build_svg(rx=0), tmp, "flat")               # 满底（iOS）
        base = render(build_svg(rx=0, with_content=False), tmp, "base")    # 只有底
        content = render(build_svg(with_bg=False), tmp, "content")         # 只有内容

        # maskable：满底铺满 + 内容按安全区缩小居中（底色同源，接缝看不出来）
        mask = base.copy()
        small = content.resize((round(512 * MASK_INSET),) * 2, Image.LANCZOS)
        off = (512 - small.width) // 2
        mask.alpha_composite(small, (off, off))

        print("写出图标：")
        save(rounded, 192, "icon-192.png")
        save(rounded, 512, "icon-512.png")
        save(mask, 512, "icon-maskable-512.png")
        save(flat, 180, "apple-touch-icon.png")

        # favicon 外链文件：字标路径 8.8KB，内联进 index.html 只会让首个字节更大
        fav = OUT_DIR / "favicon.svg"
        fav.write_text(build_svg(rx=RX), encoding="utf-8")
        print(f"  {'favicon.svg':24s} SVG        {fav.stat().st_size:,} B")

        # 顺手留对照图给 review 用（不进仓库）
        out = ROOT / "scratch" / "icon-long" / "out"
        out.mkdir(parents=True, exist_ok=True)

        preview = Image.new("RGBA", (512 * 3 + 80, 512 + 40), (245, 246, 242, 255))
        for i, im in enumerate([rounded, mask, flat]):
            preview.alpha_composite(im, (20 + i * (512 + 20), 20))
        preview.save(out / "final.png")

        sizes = [192, 96, 64, 48, 32, 16]
        rowH = 210
        sheet = Image.new("RGBA", (960, rowH * 2 + 30), (247, 246, 242, 255))
        for r, bg in enumerate([(247, 246, 242, 255), (23, 25, 23, 255)]):
            y0 = r * (rowH + 30)
            sheet.paste(bg, (0, y0, 960, y0 + rowH))
            x = 30
            for s in sizes:
                sheet.alpha_composite(rounded.resize((s, s), Image.LANCZOS),
                                      (x, y0 + (rowH - s) // 2))
                x += s + 46
        sheet.save(out / "sizes.png")


if __name__ == "__main__":
    main()
