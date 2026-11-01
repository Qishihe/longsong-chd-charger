#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""从站点设备清单生成快照 Worker 的分区表（snapshot-worker/partitions.mjs）。

    生成：python tools/gen_snapshot_partitions.py
    校验：python tools/gen_snapshot_partitions.py --check   （CI / 守门用，不一致时退出码 1）

为什么要生成：分区表里的 `ids` 是「哪台桩归哪个区」的唯一副本，而真源在
`chd-charge/index.html` 的 `DEFAULT_DEVICES`。两份手抄的清单迟早会漂 ——
一旦漂了，症状是**静默的**：快照少了一台桩，占用率的分母变小，页面照样
显示"正常"，只有把两边的台数逐个比才看得出来。

⚠️ 分区**顺序**就是 cron 的分钟偏移顺序（config.mjs 的 AREA_CRON_MINUTES
   按下标对应），所以 AREA_ORDER 不能随手调整。
"""
import io
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
INDEX = os.path.join(ROOT, 'chd-charge', 'index.html')
OUT = os.path.join(ROOT, 'snapshot-worker', 'partitions.mjs')

# location → (key, 展示名)。键是英文短名：它出现在 /api/stats 的 JSON 字段
# 和前端 RV_AREAS 里，**改名等于改接口**，不要动已有的四个。
AREA_ORDER = [
    ('渭水-朝晖体育场南', 'chaohui', '朝晖体育场南'),
    ('渭水-北门', 'beimen', '北门'),
    ('渭水-20号楼', 'b20', '20号楼'),
    ('渭水-物业服务中心', 'wuye', '物业服务中心'),
    ('渭水-住宅', 'zhu', '住宅'),
]

SUBREQUEST_LIMIT = 50

DEV_RE = re.compile(r"\{\s*id:\s*'([^']+)'([^}]*)\}")


def parse_devices():
    """读 DEFAULT_DEVICES，返回 [(id, location, src)]。"""
    src = io.open(INDEX, encoding='utf-8', newline='').read()
    m = re.search(r'const DEFAULT_DEVICES = \[(.*?)\n\s*\];', src, re.S)
    if not m:
        sys.exit('找不到 DEFAULT_DEVICES（index.html 结构变了？）')
    out = []
    for dm in DEV_RE.finditer(m.group(1)):
        dev_id, rest = dm.group(1), dm.group(2)
        loc = re.search(r"location:\s*'([^']+)'", rest)
        s = re.search(r"src:\s*'([^']+)'", rest)
        if not loc:
            sys.exit('设备 %s 没有 location' % dev_id)
        out.append((dev_id, loc.group(1), s.group(1) if s else 'zm'))
    return out


def build():
    devices = parse_devices()
    known = {loc for loc, _, _ in AREA_ORDER}
    for dev_id, loc, _ in devices:
        if loc not in known:
            sys.exit('设备 %s 的分区「%s」没有登记在 AREA_ORDER 里' % (dev_id, loc))

    areas = []
    for loc, key, name in AREA_ORDER:
        rows = [(i, s) for i, l, s in devices if l == loc]
        if not rows:
            sys.exit('分区「%s」一台设备都没有 —— 要么清单删了，要么 AREA_ORDER 写错了' % loc)
        srcs = {s for _, s in rows}
        if len(srcs) > 1:
            # 一个分区只能走一个数据源：/api/pile 一次只认一个 src，
            # 混着放会让其中一半的 id 打到错的平台、整批报错。
            sys.exit('分区「%s」里混了两个数据源 %s，请拆成两个分区' % (loc, sorted(srcs)))
        one = {'key': key, 'name': name, 'location': loc}
        src = srcs.pop()
        if src != 'zm':
            one['src'] = src
        one['ids'] = [i for i, _ in rows]
        one['count'] = len(one['ids'])
        areas.append(one)

    return {
        'schema': 1,
        'source': 'chd-charge/index.html#DEFAULT_DEVICES',
        'generator': 'tools/gen_snapshot_partitions.py',
        'total': sum(a['count'] for a in areas),
        'subrequestLimit': SUBREQUEST_LIMIT,
        'areas': areas,
    }


HEADER = """/**
 * 自动生成，请勿手改。
 * 真源：campus-pile-kit/chd-charge/index.html 的 DEFAULT_DEVICES
 * 重新生成：python tools/gen_snapshot_partitions.py
 * 一致性校验：python tools/gen_snapshot_partitions.py --check
 *
 * ⚠️ `areas` 的顺序 = cron 分钟的偏移顺序（见 config.mjs 的 AREA_CRON_MINUTES）。
 * ⚠️ 分区里的 `src` 缺省表示住芒；写了 `lvcc` 表示这批桩在驴充充平台，
 *    扫它们时 /api/pile 要带 `src: 'lvcc'`（不需要凭证）。
 */
"""


def render(data):
    body = json.dumps(data, ensure_ascii=False, indent=2)
    return HEADER + 'export const PARTITIONS = ' + body + ';\n'


def main():
    text = render(build())
    if '--check' in sys.argv:
        try:
            old = io.open(OUT, encoding='utf-8', newline='').read()
        except OSError:
            sys.exit('partitions.mjs 还不存在，先跑一次生成')
        if old.replace('\r\n', '\n') == text.replace('\r\n', '\n'):
            print('[OK] partitions.mjs 与 DEFAULT_DEVICES 一致')
            return
        data = build()
        print('[X] partitions.mjs 与 DEFAULT_DEVICES 已经漂了：')
        try:
            cur = json.loads(re.search(r'export const PARTITIONS = (\{.*\});', old, re.S).group(1))
        except Exception:
            sys.exit('    现有文件解析失败，直接重新生成吧')
        for a in data['areas']:
            got = next((x for x in cur.get('areas', []) if x.get('key') == a['key']), None)
            if not got:
                print('    + 缺分区 %s（%d 台）' % (a['key'], a['count']))
                continue
            if got.get('ids') != a['ids']:
                print('    ~ 分区 %s 的 id 列表不一致（现在 %d 台 / 应为 %d 台）'
                      % (a['key'], len(got.get('ids') or []), a['count']))
        if cur.get('total') != data['total']:
            print('    ~ total %s → %s' % (cur.get('total'), data['total']))
        sys.exit(1)

    io.open(OUT, 'w', encoding='utf-8', newline='\n').write(text)
    data = build()
    print('已生成 %s：%d 个分区 / %d 台（%s）' % (
        os.path.relpath(OUT, ROOT), len(data['areas']), data['total'],
        '、'.join('%s=%d' % (a['key'], a['count']) for a in data['areas'])))


if __name__ == '__main__':
    main()
