# -*- coding: utf-8 -*-
"""把公开源码里的设备占位符换回真实编号、演示坐标偏移归零。

仓库是公开的，所以 `chd-charge/index.html` 的 `DEFAULT_DEVICES`、
`snapshot-worker/partitions.mjs` 里写的都是 `PILE0001` 这类占位符，
`map-amap.js` 里还有一层约 300 m 的 `GEO_SHIFT`。
真值单独放在 `campus-pile-kit/private/devices.private.json`（.gitignore 排除）。

两条使用路径
------------
1. **打包**：`tools/make_cloudflare.py` 自动调用 `inject_text()` —— 对**内存里的文本**
   注入后再交给 esbuild 压缩。源码文件一个字节都不动，所以仓库始终是干净的。
   🔴 注入必须在压缩之前：esbuild 会把 IIFE 里的 `var GEO_SHIFT` 改名，压完就找不到锚点了。
2. **本地预览**：`python tools/inject_private.py --out scratch/_devsite`
   生成一份注入过的站点副本，对那个目录起服务。直接看源码目录会看到桩点飘到校区外。

🔴 `tools/check_release.py` 有一条守门专门检查源码里没有真实编号，别绕过。
"""
import io
import json
import os
import re
import shutil
import sys

KIT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PRIVATE = os.path.join(KIT, 'private', 'devices.private.json')

# 占位符：PILE + 4 位序号。一次替换，避免 200 次 str.replace 的前缀问题
PH_RE = re.compile(r'PILE\d{4}')

# map-amap.js 里的演示偏移声明（压缩前后都能匹配：只关心赋值右边）
SHIFT_RE = re.compile(r'GEO_SHIFT\s*=\s*\{[^{}]*\}')
SHIFT_ZERO = 'GEO_SHIFT = { lng: 0, lat: 0 }'

TEXT_EXT = {'.html', '.htm', '.js', '.mjs', '.json', '.css', '.txt', '.svg', '.webmanifest'}


def load_private(path=None):
    """读私有清单，返回 (占位符→真实编号, 原始数据)。文件缺失直接报错 ——
    静默降级会把占位符发到线上，查出来的全是「平台没响应」。"""
    p = path or PRIVATE
    if not os.path.exists(p):
        raise SystemExit(
            '找不到私有设备清单：%s\n'
            '  这份文件不入库，是设备编号的唯一真值来源。\n'
            '  从备份恢复：D:\\chd-backup\\ 或历史 devices.private.json 副本。' % p)
    data = json.loads(io.open(p, encoding='utf-8').read())
    table = {d['ph']: d['id'] for d in data.get('devices', [])}
    if len(table) < 100:
        raise SystemExit('私有清单只有 %d 台，明显不对（应约 200）' % len(table))
    return table, data


def inject_text(text, table=None, stats=None):
    """把文本里的占位符换成真实编号、偏移归零。返回新文本。"""
    if table is None:
        table, _ = load_private()

    def sub(m):
        ph = m.group(0)
        real = table.get(ph)
        if real is None:
            if stats is not None:
                stats['unknown'] = stats.get('unknown', 0) + 1
            return ph
        if stats is not None:
            stats['ids'] = stats.get('ids', 0) + 1
        return real

    text = PH_RE.sub(sub, text)

    def sub_shift(m):
        if stats is not None:
            stats['shift'] = stats.get('shift', 0) + 1
        return SHIFT_ZERO

    return SHIFT_RE.sub(sub_shift, text)


def inject_file(path, table=None, stats=None):
    """原地注入一个文本文件；二进制/无法解码的直接跳过（返回 False）。"""
    try:
        raw = io.open(path, encoding='utf-8', newline='').read()
    except (UnicodeDecodeError, OSError):
        return False
    out = inject_text(raw, table, stats)
    if out != raw:
        io.open(path, 'w', encoding='utf-8', newline='').write(out)
    return True


def inject_dir(root, table=None):
    """对整个目录做注入（只碰文本后缀）。返回统计。"""
    if table is None:
        table, _ = load_private()
    stats = {'files': 0, 'ids': 0, 'shift': 0}
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in ('node_modules', '.git')]
        for name in filenames:
            if os.path.splitext(name)[1].lower() not in TEXT_EXT:
                continue
            if inject_file(os.path.join(dirpath, name), table, stats):
                stats['files'] += 1
    return stats


def verify_dir(root):
    """核对一个目录里已经没有占位符、偏移已归零。返回问题列表。"""
    problems = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in ('node_modules', '.git')]
        for name in filenames:
            if os.path.splitext(name)[1].lower() not in TEXT_EXT:
                continue
            p = os.path.join(dirpath, name)
            try:
                t = io.open(p, encoding='utf-8', newline='').read()
            except (UnicodeDecodeError, OSError):
                continue
            left = PH_RE.findall(t)
            if left:
                problems.append('%s 还有 %d 个占位符（%s）'
                                % (os.path.relpath(p, root), len(left), left[:3]))
            m = SHIFT_RE.search(t)
            if m and not re.search(r'lng:\s*0\s*,\s*lat:\s*0', m.group(0)):
                problems.append('%s 的 GEO_SHIFT 没归零：%s'
                                % (os.path.relpath(p, root), m.group(0)))
    return problems


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    site = os.path.join(KIT, 'chd-charge')

    if '--verify' in argv:
        i = argv.index('--verify')
        target = argv[i + 1] if len(argv) > i + 1 else os.path.join(KIT, 'dist-cloudflare')
        bad = verify_dir(target)
        if bad:
            print('[X] %d 处没注入干净：' % len(bad))
            for b in bad:
                print('   ', b)
            return 1
        print('[OK] %s 已完全注入（无占位符、偏移为 0）' % os.path.relpath(target, KIT))
        return 0

    if '--out' in argv:
        i = argv.index('--out')
        if len(argv) <= i + 1:
            raise SystemExit('--out 需要一个目标目录')
        dest = argv[i + 1]
        if os.path.exists(dest):
            shutil.rmtree(dest)
        shutil.copytree(site, dest, ignore=shutil.ignore_patterns('catalog.json'))
        stats = inject_dir(dest)
        print('已生成注入副本：%s（%d 个文件、%d 处编号、%d 处偏移）'
              % (dest, stats['files'], stats['ids'], stats['shift']))
        bad = verify_dir(dest)
        if bad:
            print('[X] 校验没过：')
            for b in bad:
                print('   ', b)
            return 1
        print('下一步：python campus-pile-kit/chd-charge/serve_gzip.py --root %s --port 8909' % dest)
        return 0

    raise SystemExit(__doc__ + '\n用法：\n'
                     '  python tools/inject_private.py --out scratch/_devsite\n'
                     '  python tools/inject_private.py --verify dist-cloudflare\n')


if __name__ == '__main__':
    sys.exit(main())
