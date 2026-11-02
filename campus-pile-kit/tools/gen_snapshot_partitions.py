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
    # 2026-11-02 v2.72 登记、2026-11-03 v2.76 正式进统计：本部北院的停车场
    # （57 台，B1-01~B7-09）。⚠️ 它排在最后 = 前端 RV_AREAS 的第 6 档。
    # 顺序本身已不再决定 cron 偏移（v2.65 起按 key 取组），但仍按台数从大到小
    # 排，便于人工核对。
    ('北院-体育馆北停车场', 'beiyuan', '体育馆北停车场'),
]

# 「登记在册、但这一版**还不进快照分区**」的 location。
#
# 为什么要有这么一张表：免费版**一个账号**只有 5 条 cron trigger，而 4 跳分区
# + 1 跳统计早就用满了（见 snapshot-worker/config.mjs 里 AREA_CRON_GROUPS 那段）。
# 加一个区不能靠「再开一条 cron」，只能靠**重排已有 4 跳的分组配平**。
#
# 🔴 2026-11-03 已清空：北院 57 台**已接入**一周回顾。做法不是加 cron，而是
#    把「住宅」从 :03 挪到 :00 与朝晖同跳、:02 收下物业，空出 :03 给北院独占
#    （实测北院 5 批 5.3 秒，18 秒扫描预算还剩 12.6 秒）。
#    详见 config.mjs 的 AREA_CRON_GROUPS。
#
# ⚠️ 这张表**留着别删**：它还是「先上页面、暂不进统计」的开关，第 7 个区
#    若一时排不开，可以先用它挡一下，避免 partitions 里有区却没排 cron
#    （那种情况的症状是统计每小时都缺这一区，覆盖率被打成 5/7，比不收录更糟）。
NO_SNAPSHOT = set()

SUBREQUEST_LIMIT = 50

DEV_RE = re.compile(r"\{\s*id:\s*'([^']+)'([^}]*)\}")


def parse_device_records():
    """读 DEFAULT_DEVICES，返回完整记录。

    除了分区表要的 (id, location, src)，这里也带上 code/name/portCount ——
    `gen_catalog.py` 要拿它们生成对外目录。两个生成器共用同一份解析，
    避免「同一条清单被两处各读一遍、然后各自漂」。

    返回 [{id, code, name, location, src, portCount}]；`src` 缺省 'zm'（住芒）。
    """
    src = io.open(INDEX, encoding='utf-8', newline='').read()
    m = re.search(r'const DEFAULT_DEVICES = \[(.*?)\n\s*\];', src, re.S)
    if not m:
        sys.exit('找不到 DEFAULT_DEVICES（index.html 结构变了？）')
    out = []
    for dm in DEV_RE.finditer(m.group(1)):
        dev_id, rest = dm.group(1), dm.group(2)
        loc = re.search(r"location:\s*'([^']+)'", rest)
        if not loc:
            sys.exit('设备 %s 没有 location' % dev_id)
        code = re.search(r"code:\s*'([^']+)'", rest)
        name = re.search(r"name:\s*'([^']+)'", rest)
        s = re.search(r"src:\s*'([^']+)'", rest)
        pc = re.search(r'portCount:\s*(\d+)', rest)
        out.append({
            'id': dev_id,
            'code': code.group(1) if code else '',
            'name': name.group(1) if name else '',
            'location': loc.group(1),
            'src': s.group(1) if s else 'zm',
            'portCount': int(pc.group(1)) if pc else None,
        })
    return out


def parse_devices():
    """读 DEFAULT_DEVICES，返回 [(id, location, src)]。"""
    return [(d['id'], d['location'], d['src']) for d in parse_device_records()]


def build():
    devices = parse_devices()
    known = {loc for loc, _, _ in AREA_ORDER}
    for dev_id, loc, _ in devices:
        if loc not in known:
            sys.exit('设备 %s 的分区「%s」没有登记在 AREA_ORDER 里' % (dev_id, loc))

    areas = []
    for loc, key, name in AREA_ORDER:
        # 登记了但这一版不进快照分区的（北院 57 台）—— 跳过，别让它进 partitions.mjs。
        # ⚠️ 跳过时**不校验有没有设备**：那个校验是给「分区有桩、但漏排了快照」用的，
        #    这里本来就是故意不排。
        if loc in NO_SNAPSHOT:
            continue
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
 * ⚠️ `areas` 的**顺序不代表 cron 排班** —— v2.65 起按 key 取组，见 config.mjs
 *    的 AREA_CRON_GROUPS（一张「哪一跳刷哪几个区」的表）。这里只按台数大到小排。
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
