/**
 * 自动生成，请勿手改。
 * 真源：campus-pile-kit/chd-charge/index.html 的 DEFAULT_DEVICES
 * 重新生成：python tools/gen_snapshot_partitions.py
 * 一致性校验：python tools/gen_snapshot_partitions.py --check
 *
 * ⚠️ `areas` 的顺序 = cron 分钟的偏移顺序（见 config.mjs 的 AREA_CRON_MINUTES）。
 * ⚠️ 分区里的 `src` 缺省表示住芒；写了 `lvcc` 表示这批桩在驴充充平台，
 *    扫它们时 /api/pile 要带 `src: 'lvcc'`（不需要凭证）。
 */
export const PARTITIONS = {
  "schema": 1,
  "source": "chd-charge/index.html#DEFAULT_DEVICES",
  "generator": "tools/gen_snapshot_partitions.py",
  "total": 117,
  "subrequestLimit": 50,
  "areas": [
    {
      "key": "chaohui",
      "name": "朝晖体育场南",
      "location": "渭水-朝晖体育场南",
      "ids": [
        "PILEXXXX",
        "PILEXXXX",
        "PILEXXXX",
        "PILEXXXX",
        "PILEXXXX",
        "PILEXXXX",
        "PILEXXXX",
        "PILEXXXX",
        "PILEXXXX",
        "PILEXXXX",
        "PILEXXXX",
        "PILEXXXX",
        "PILEXXXX",
        "PILEXXXX",
        "PILEXXXX",
        "PILEXXXX",
        "PILEXXXX",
        "PILEXXXX",
        "PILEXXXX",
        "PILEXXXX",
        "PILEXXXX",
        "PILEXXXX",
        "PILEXXXX",
        "PILEXXXX",
        "PILEXXXX",
        "PILEXXXX",
        "PILEXXXX",
        "PILEXXXX",
        "PILEXXXX",
        "PILEXXXX",
        "PILEXXXX",
        "PILEXXXX",
        "PILEXXXX",
        "PILEXXXX",
        "PILEXXXX",
        "PILEXXXX"
      ],
      "count": 36
    },
    {
      "key": "beimen",
      "name": "北门",
      "location": "渭水-北门",
      "ids": [
        "PILEXXXX",
        "PILEXXXX",
        "PILEXXXX",
        "PILEXXXX",
        "PILEXXXX",
        "PILEXXXX",
        "PILEXXXX",
        "PILEXXXX",
        "PILEXXXX",
        "PILEXXXX",
        "PILEXXXX",
        "PILEXXXX",
        "PILEXXXX",
        "PILEXXXX",
        "PILEXXXX",
        "PILEXXXX",
        "PILEXXXX",
        "PILEXXXX",
        "PILEXXXX",
        "PILEXXXX",
        "PILEXXXX",
        "PILEXXXX",
        "PILEXXXX",
        "PILEXXXX",
        "PILEXXXX",
        "PILEXXXX",
        "PILEXXXX",
        "PILEXXXX",
        "PILEXXXX",
        "PILEXXXX",
        "PILEXXXX",
        "PILEXXXX",
        "PILEXXXX",
        "PILEXXXX",
        "PILEXXXX",
        "PILEXXXX",
        "PILEXXXX"
      ],
      "count": 37
    },
    {
      "key": "b20",
      "name": "20号楼",
      "location": "渭水-20号楼",
      "ids": [
        "PILEXXXX",
        "PILEXXXX",
        "PILEXXXX",
        "PILEXXXX",
        "PILEXXXX",
        "PILEXXXX",
        "PILEXXXX",
        "PILEXXXX",
        "PILEXXXX",
        "PILEXXXX",
        "PILEXXXX",
        "PILEXXXX",
        "PILEXXXX",
        "PILEXXXX",
        "PILEXXXX",
        "PILEXXXX",
        "PILEXXXX",
        "PILEXXXX",
        "PILEXXXX",
        "PILEXXXX",
        "PILEXXXX",
        "PILEXXXX",
        "PILEXXXX",
        "PILEXXXX"
      ],
      "count": 24
    },
    {
      "key": "wuye",
      "name": "物业服务中心",
      "location": "渭水-物业服务中心",
      "ids": [
        "PILEXXXX",
        "PILEXXXX",
        "PILEXXXX",
        "PILEXXXX",
        "PILEXXXX",
        "PILEXXXX",
        "PILEXXXX",
        "PILEXXXX",
        "PILEXXXX",
        "PILEXXXX",
        "PILEXXXX",
        "PILEXXXX"
      ],
      "count": 12
    },
    {
      "key": "zhu",
      "name": "住宅",
      "location": "渭水-住宅",
      "src": "lvcc",
      "ids": [
        "PILEXXXX",
        "PILEXXXX",
        "PILEXXXX",
        "PILEXXXX",
        "PILEXXXX",
        "PILEXXXX",
        "PILEXXXX",
        "PILEXXXX"
      ],
      "count": 8
    }
  ]
};
