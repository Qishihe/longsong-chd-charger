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
        "XLA29282",
        "XLA30300",
        "XLA29720",
        "XLA23805",
        "XLA23789",
        "XLA23807",
        "XLA29401",
        "XLA29452",
        "XLA30468",
        "XLA29410",
        "XLA28826",
        "XLA29207",
        "XLA28792",
        "XLA29463",
        "XLA29108",
        "XLA29233",
        "XLA29269",
        "XLA29137",
        "XLA28827",
        "XLA29316",
        "XLA29438",
        "XLA28838",
        "XLA29388",
        "XLA29417",
        "XLA29439",
        "XLA29004",
        "XLA29125",
        "XLA29002",
        "XLA29287",
        "XLA29208",
        "XLA28875",
        "XLA29402",
        "XLA28866",
        "XLA29035",
        "XLA29277",
        "XLA29464"
      ],
      "count": 36
    },
    {
      "key": "beimen",
      "name": "北门",
      "location": "渭水-北门",
      "ids": [
        "XLB03249",
        "XLB03277",
        "XLB02992",
        "XLB03769",
        "XLB03721",
        "XLB03595",
        "XLB03690",
        "XLB04421",
        "XLB03596",
        "XLB04169",
        "XLB03319",
        "XLB04471",
        "XLB03770",
        "XLB03739",
        "XLB03270",
        "XLB03467",
        "XLB03170",
        "XLB03169",
        "XLB02946",
        "XLB03412",
        "XLB03335",
        "XLB03199",
        "XLB03131",
        "XLB03899",
        "XLB03991",
        "XLB03298",
        "XLB01363",
        "XLB01288",
        "XLB01367",
        "XLB01228",
        "XLB04138",
        "XLB03369",
        "XLB03403",
        "XLB04215",
        "XLB03505",
        "XLB03062",
        "XLB03357"
      ],
      "count": 37
    },
    {
      "key": "b20",
      "name": "20号楼",
      "location": "渭水-20号楼",
      "ids": [
        "XLA36125",
        "XLA35420",
        "XLA31449",
        "XLA31931",
        "XLA31844",
        "XLA31743",
        "XLA31746",
        "XLA35361",
        "XLA31757",
        "XLA33369",
        "XLA35428",
        "XLA36092",
        "XLA32017",
        "XLA35369",
        "XLA36186",
        "XLA31748",
        "XLA35413",
        "XLA32266",
        "XLA31759",
        "XLA35364",
        "XLA35511",
        "XLA35363",
        "XLA31980",
        "XLA35421"
      ],
      "count": 24
    },
    {
      "key": "wuye",
      "name": "物业服务中心",
      "location": "渭水-物业服务中心",
      "ids": [
        "XLA55127",
        "XLA29284",
        "XLA28839",
        "XLA29461",
        "XLB04073",
        "XLA29263",
        "XLA29408",
        "XLA28996",
        "XLA29457",
        "XLA35412",
        "XLA36111",
        "XLB04070"
      ],
      "count": 12
    },
    {
      "key": "zhu",
      "name": "住宅",
      "location": "渭水-住宅",
      "src": "lvcc",
      "ids": [
        "865777078529432",
        "866907053459649",
        "863069059213877",
        "866907052208807",
        "860048071208423",
        "860048071219040",
        "862289058733268",
        "862289058759602"
      ],
      "count": 8
    }
  ]
};
