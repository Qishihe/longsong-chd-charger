#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
静态站点 + gzip 压缩（零依赖，只用标准库）。

为什么需要它
------------
WorkBuddy 发布平台对 `language: static` 的默认做法是
    python3 -m http.server "$PORT" --bind 0.0.0.0
而 Python 的 http.server **不会压缩**，平台网关也不替它压缩（实测：带不带
Accept-Encoding 收到的 Content-Length 一模一样，响应里没有 Content-Encoding）。

本文件就是一个替换品：同样的目录、同样的端口，只是把文本资源 gzip 后发送。
实测本站文本资源 476 KB → 157 KB（3.03x）。

用法（本地自测）
----------------
    PORT=8092 python3 serve_gzip.py
    curl -H 'Accept-Encoding: gzip' -D - -o /dev/null http://127.0.0.1:8092/preview.html

部署（WorkBuddy 发布工具的参数，2026-10-20 起固定）
--------------------------------------------------
    目录       campus-pile-kit/chd-charge
    language   python                      ← 原来是 static，改了才有 gzip
    startCmd   python3 serve_gzip.py
    installCmd ""                          ← 没有依赖，别让它去找 requirements.txt
    entryHtml  index.html
    domainPrefix chd-charge

**回滚**：把 language 改回 static（startCmd/installCmd 留空）重新发布即可，
本文件留在目录里不参与运行，不影响 static 模式。

注意
----
* 只压文本类型。webp/jpg/png/woff2 已经是压缩格式，再 gzip 只会变大。
* `Vary: Accept-Encoding` 必须带上，否则中间的缓存会把 gz 版本发给不支持的客户端。
* 启动时把全部文件读进内存并预算 gzip（本站 16 个文件 / 2.4 MB，毫秒级），
  之后每个请求零 CPU 开销。
* 本文件自己不对外提供（见 SELF_BLOCK），免得被人下载去看实现。


/api/* 反代（2026-10-25 新增）
----------------------------
页面所有数据接口都是**相对路径**（`/api/pile`、`/api/shop`、`/api/cred`），由
Cloudflare Worker 提供。这个站只有静态服务时，实测 `POST /api/pile` 一律 **501**
（`http.server` 不收 POST）→ 页面「一直转圈、一个桩都查不到」。

所以本文件现在兼两个角色：静态托管 + `/api/*` 原样反代到主站 Worker
（`UPSTREAM`，默认 pages.dev）。**不复制 Worker 的业务逻辑** —— 缓存预算、fresh 语义、
上游协议都只有 `_worker.js` 一份，避免两份实现慢慢漂移。

反代层多做两件 Worker 自己做不到的事：

1. **`/api/pile` 全站共享缓存**（按桩位 id 存，300s / fresh 90s，与 Worker 的
   PILE_TTL / PILE_FRESH_MIN 对齐）。Worker 那边是按「调用方 IP」分桶的，反代出去
   全站共用一个出口 IP，很容易撞上它 30 次/分钟的限流（撞了就是 429 → 页面表现成
   「刚才查询的人太多了」）。本地缓存 + 在途合并后，多人同时首屏只回源一轮。

2. **上游降级兜底**：上游 429/超时/坏 JSON 时，用本地旧缓存顶上并返回 `ok: true`，
   页面继续显示上一次的数据，而不是整轮放弃。

⚠️ 两个必须记住的细节（都踩过）：
  * 转发必须改 `Origin` 成上游域 —— Worker 里有 `origin !== url.origin → 403`。
  * 转发必须伪装浏览器 UA —— Cloudflare 按签名拦 `Python-urllib/3.x`，
    返回 **Error 1010**（一个 HTML 错误页），表现成「上游全挂」。
"""

import argparse
import gzip
import json
import os
import socket
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import zlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote, urlparse

# 只有这些类型值得压。加类型前先想清楚：二进制格式压了往往更大。
COMPRESSIBLE = {
    "text/html", "text/css", "text/plain", "text/xml", "text/javascript",
    "application/javascript", "application/x-javascript", "application/json",
    "application/xml", "application/manifest+json", "image/svg+xml",
}

# 文本文件额外按扩展名兜底（系统 mimetypes 在精简镜像里可能认不全会返回
# application/octet-stream，那样就不会被压缩，白白多传几倍字节）
EXT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".htm": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".mjs": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".webmanifest": "application/manifest+json",
    ".svg": "image/svg+xml",
    ".txt": "text/plain; charset=utf-8",
    ".md": "text/plain; charset=utf-8",
    ".webp": "image/webp",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".ico": "image/x-icon",
    ".woff2": "font/woff2",
}

CACHE = {}          # 相对路径 -> (body_bytes, gz_bytes_or_None, etag, ctype)
CACHE_LOCK = threading.Lock()

# 不对外提供的路径（请求一律落到 404）
#
# 两类东西进这里：
#  1) 本文件自己 —— 免得被人下载去看实现；
#  2) **本地已删除、但云端还留着的残留文件** —— 见下面那条注释，这个坑很反直觉。
SELF_BLOCK = {
    "/serve_gzip.py",

    # 🔴 平台发布是**增量覆盖**：本地把文件删了，云端的旧文件**不会跟着消失**。
    #    2026-10-25 实测：本地删掉 preview-v3.html 后重新发布，
    #    线上 `GET /preview-v3.html` 仍然 200 返回那份 260KB 的 v3 原型。
    #    平台没有提供「删除云端文件」的接口，所以只能在服务层挡住 ——
    #    `load()` 不加载它们，请求就落到 404。文件本体还占着磁盘，但对外不可见。
    #    ⚠️ 以后在本地删任何站点文件，都要同步加到这里，否则线上照样能访问。
    "/preview-v3.html",
    "/redesign-v2.html",
    "/redesign-mockup.html",
    "/map.html",              # 高德骨架调试页
    "/map-key.example.js",    # 自部署模板（运行时不用）
    "/map-beimen.svg",        # 点位参考图（底图用 .webp）

    # 2026-10-29 v2.38：内测版整体退役（preview.html / preview-banner.js /
    # map-amap-preview.js 已从站点目录删除）。平台只做增量覆盖，云端那份删不掉，
    # 所以本地开发和线上都要显式挡住 —— 一个带密码门禁的半成品页不该对外可达。
    "/preview.html",
    "/preview-banner.js",
    "/map-amap-preview.js",

    # 2026-11-03 v2.85：抓凭证教程页下线（「换一串凭证」弹窗里不再有入口）。
    # 文件还在目录里备查，但对内对外都不再提供。
    "/help.html",

    # 2026-11-04 v2.87（A4）：凭证上传占位页下线，文件已删。
    # 线上那张 410 由 Worker 出；这里只管本地开发服务器别把它发出去。
    # ⚠️ 只列 `.html`：本地是精确路径匹配，`/admin` 这种 pretty 变体
    #    在磁盘上找不到文件，本来就是 404（线上才需要 Worker 挡，见 _worker.js）。
    "/admin.html",

    # 2026-11-08 v3.17：赞助二维码从使用说明里撤掉，文件已删。
    # 平台只做增量覆盖，本地开发服务器也一并挡住这张旧图。
    "/sponsor-qr.png",
}

# 目录级屏蔽（这些目录整个都是内部产物）
SELF_BLOCK_PREFIX = ("/redesign/",)


def _blocked(rel):
    return rel in SELF_BLOCK or rel.startswith(SELF_BLOCK_PREFIX)

# ---------------- /api 反代 ----------------
UPSTREAM = (os.environ.get("UPSTREAM") or "https://chd-charge.pages.dev").rstrip("/")
_u = urllib.parse.urlsplit(UPSTREAM)
UPSTREAM_ORIGIN = "%s://%s" % (_u.scheme, _u.netloc)
UPSTREAM_TIMEOUT = float(os.environ.get("UPSTREAM_TIMEOUT") or 25)

# 🔴 必须伪装浏览器 UA：Cloudflare 会按签名拦 `Python-urllib/3.x`，返回 **Error 1010**
#    （一个 HTML 错误页，不是 JSON），表现成「上游全挂、每台桩都查不到」。
#    实测 curl 默认 UA 能过、Python 默认 UA 不能。
UPSTREAM_UA = os.environ.get("UPSTREAM_UA") or (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36"
)

# 与 _worker.js 对齐
PILE_TTL = 300          # 普通请求：缓存多少秒内直接用
PILE_FRESH_MIN = 90     # fresh 请求：缓存比这新才复用
PILE_MAX_IDS = 40

PILE_CACHE = {}         # id -> {"at": 毫秒, "ports": [...]}；全站共享
PILE_INFLIGHT = {}      # id -> threading.Event（同一台正在查，别让十个队列一起冲）
PILE_LOCK = threading.Lock()


def _log(msg):
    sys.stderr.write("[api] " + msg + "\n")
    sys.stderr.flush()


def _post_upstream(path, payload):
    """POST JSON 到上游 Worker，返回 (status, body_dict)。异常时抛。"""
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(UPSTREAM + path, data=body, method="POST")
    req.add_header("content-type", "application/json")
    req.add_header("accept", "application/json")
    req.add_header("origin", UPSTREAM_ORIGIN)   # Worker 校验 Origin，必须写成它自己的域
    req.add_header("user-agent", UPSTREAM_UA)
    req.add_header("accept-encoding", "identity")   # 不要压缩，省得自己解
    try:
        with urllib.request.urlopen(req, timeout=UPSTREAM_TIMEOUT) as r:
            return r.status, _parse_json(r.read())
    except urllib.error.HTTPError as e:
        return e.code, _parse_json(e.read())


def _parse_json(raw):
    try:
        return json.loads(raw.decode("utf-8")) if raw else {}
    except Exception:
        return {}


def _cache_get(pid, want_fresh):
    with PILE_LOCK:
        rec = PILE_CACHE.get(pid)
    if not rec:
        return None
    age = (time.time() * 1000 - rec.get("at", 0)) / 1000.0
    if age > (PILE_FRESH_MIN if want_fresh else PILE_TTL):
        return None
    return rec, age


def _cache_put(pid, rec):
    with PILE_LOCK:
        PILE_CACHE[pid] = rec


def _plan(ids, want_fresh):
    """分出「本地够新」和「需要回源」的 id；回源那部分顺手占住 in-flight 位。"""
    hit, mine, waits = {}, [], []
    now = time.time() * 1000
    with PILE_LOCK:
        for pid in ids:
            rec = PILE_CACHE.get(pid)
            if rec:
                age = (now - rec.get("at", 0)) / 1000.0
                if age <= (PILE_FRESH_MIN if want_fresh else PILE_TTL):
                    hit[pid] = (rec, age)
                    continue
            ev = PILE_INFLIGHT.get(pid)
            if ev is not None:
                waits.append((pid, ev))
            else:
                ev = threading.Event()
                PILE_INFLIGHT[pid] = ev
                mine.append((pid, ev))
    return hit, mine, waits


def _release(pairs):
    with PILE_LOCK:
        for pid, _ev in pairs:
            PILE_INFLIGHT.pop(pid, None)
    for _pid, ev in pairs:
        ev.set()


def handle_pile(body):
    """本地共享缓存 + 只把过期的那几台发给上游。返回 (status, payload_dict)。"""
    token = body.get("token") if isinstance(body, dict) else None
    ids = body.get("ids") if isinstance(body, dict) else None
    want_fresh = bool(isinstance(body, dict) and body.get("fresh") is True)
    # 🔴 2026-10-31 v2.64：`src` 必须透传（v2.63 引入驴充充时这里漏了）。
    #   页面按源分组切批后，驴充充那批带 `src: 'lvcc'`、**不需要凭证**；
    #   反代如果把 src 丢掉，这批就会被当成住芒去查 → 一律 400 no_token，
    #   表现是「住宅那 8 台在本地起的站点上永远查不到，线上却正常」。
    src = body.get("src") if isinstance(body, dict) else None
    lvcc = src == "lvcc"

    # 只有住芒要凭证；驴充充的接口本来就是匿名的
    if not lvcc and (not isinstance(token, str) or not token):
        return 400, {"ok": False, "error": "no_token"}
    if not isinstance(ids, list) or not ids:
        return 400, {"ok": False, "error": "no_ids"}
    ids = [i for i in ids if isinstance(i, str) and 4 <= len(i) <= 32][:PILE_MAX_IDS]
    if not ids:
        return 400, {"ok": False, "error": "no_ids"}

    # 缓存键按**源**分开：两个平台的 id 命名规则不同，分开存省得将来撞车串数据。
    keys = [("lvcc:" + i) if lvcc else i for i in ids]
    rev = dict(zip(keys, ids))

    hit, mine, waits = _plan(keys, want_fresh)

    # 有人在查同一批 id → 等它（最多等一个上游超时）。没有这一步，几个访客同时
    # 首屏会排出十几条一模一样的上游请求，直接把 Worker 的每分钟限流撞满。
    if waits:
        deadline = time.time() + UPSTREAM_TIMEOUT
        for pid, ev in waits:
            ev.wait(max(0.0, deadline - time.time()))
            got = _cache_get(pid, want_fresh) or _cache_get(pid, False)
            if got:
                hit[pid] = got

    results, fetched, throttled = {}, 0, False

    if mine:
        miss_ids = [pid for pid, _ in mine]
        payload = {"ids": [rev[k] for k in miss_ids], "fresh": want_fresh}
        if lvcc:
            payload["src"] = "lvcc"
        else:
            payload["token"] = token
        try:
            status, data = _post_upstream("/api/pile", payload)
        except Exception as e:                       # 网络 / 超时
            _log("upstream pile failed: %s %s" % (type(e).__name__, e))
            status, data = 0, {}

        up = (data or {}).get("results") or {}
        if data and data.get("ok") and up:
            throttled = bool(data.get("throttled"))
            for pid in miss_ids:
                rec = up.get(rev[pid])
                if not isinstance(rec, dict):
                    continue
                if rec.get("ports"):
                    _cache_put(pid, {"at": int(rec.get("at") or time.time() * 1000),
                                     "ports": rec["ports"]})
                    results[rev[pid]] = rec
                    fetched += 1
                elif rec.get("error"):
                    # 透传平台原话，但**不写缓存** —— 失败不能钉死 5 分钟，
                    # 那会把一次抖动变成一整轮全错。
                    results[rev[pid]] = rec
        else:
            # 上游挂了 / 429 / 限流：能拿旧缓存就先用旧数据顶上，别让页面整轮放弃
            _log("pile upstream degraded: status=%s body=%s"
                 % (status, json.dumps(data, ensure_ascii=False)[:200]))
            throttled = True
            for pid in miss_ids:
                old = _cache_get(pid, False)
                results[rev[pid]] = old[0] if old else {
                    "at": 0, "error": "平台暂时没响应，稍后再点一次刷新"}
        _release(mine)

    oldest = 0
    for pid in keys:
        if rev[pid] in results:
            continue
        got = hit.get(pid) or _cache_get(pid, want_fresh) or _cache_get(pid, False)
        if got:
            results[rev[pid]] = got[0]
            oldest = max(oldest, int(got[1]))
        else:
            results[rev[pid]] = {"at": 0, "error": "还没查到，稍后再点一次刷新"}

    return 200, {
        "ok": True,
        "results": results,
        "hit": len([p for p in ids if results.get(p, {}).get("ports")]) - fetched,
        "fetched": fetched,
        "throttled": throttled,
        "fresh": want_fresh,
        "oldestAge": oldest,
    }



def guess_type(path):
    ext = os.path.splitext(path)[1].lower()
    if ext in EXT_TYPES:
        return EXT_TYPES[ext]
    import mimetypes
    return mimetypes.guess_type(path)[0] or "application/octet-stream"


def load(root):
    """把所有文件读进内存，文本顺手算好 gzip。"""
    n_raw = n_gz = 0
    skip_dirs = {"__pycache__", ".git", "node_modules"}
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in skip_dirs]
        for name in filenames:
            full = os.path.join(dirpath, name)
            rel = "/" + os.path.relpath(full, root).replace(os.sep, "/")
            if _blocked(rel):              # 本文件 + 云端残留：一律不加载（请求落到 404）
                continue
            try:
                with open(full, "rb") as f:
                    body = f.read()
            except OSError as e:
                print("skip %s: %s" % (rel, e), file=sys.stderr)
                continue
            ctype = guess_type(full)
            base = ctype.split(";")[0].strip()
            gz = None
            if base in COMPRESSIBLE and len(body) > 512:
                gz = gzip.compress(body, 6)
                if len(gz) >= len(body):      # 压不动就别压，省得白费 CPU
                    gz = None
            etag = '"%x-%x"' % (len(body), int(os.path.getmtime(full)))
            CACHE[rel] = (body, gz, etag, ctype)
            n_raw += len(body)
            n_gz += len(gz) if gz else len(body)
    print("loaded %d files, %d B raw -> %d B gzip (%.2fx)"
          % (len(CACHE), n_raw, n_gz, (n_raw / n_gz) if n_gz else 0),
          file=sys.stderr)


def add_catalog(root):
    """把对外设备目录补进内存缓存。

    `catalog.json` 是构建产物，站点目录里**不一定有**它：
    打包器（make_cloudflare.py / make_dist.py）会写进各自的 dist，
    而这里是「源码树直接跑 serve_gzip.py」的场景，现场调 ../tools/gen_catalog.py 生成。
    生成不出来不影响页面 —— 只是第三方接入端点 404。
    """
    if "/catalog.json" in CACHE:
        return
    tools = os.path.join(os.path.dirname(os.path.abspath(root)), "tools")
    try:
        if tools not in sys.path:
            sys.path.insert(0, tools)
        import gen_catalog
        data, text = gen_catalog.build_text()
    except Exception as e:  # noqa: BLE001
        print("catalog.json 未生成（%s）：/catalog.json 会 404" % e, file=sys.stderr)
        return
    body = text.encode("utf-8")
    gz = gzip.compress(body, 6) if len(body) > 512 else None
    if gz is not None and len(gz) >= len(body):
        gz = None
    etag = '"%x-%x"' % (len(body), zlib.crc32(body))
    CACHE["/catalog.json"] = (body, gz, etag, "application/json; charset=utf-8")
    print("catalog.json（内存生成）：%d 个分区 / %d 台"
          % (len(data["areas"]), data["total"]), file=sys.stderr)


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "chd-charge-static"
    sys_version = ""

    def _resolve(self):
        path = unquote(urlparse(self.path).path)
        if path.endswith("/"):
            path += "index.html"
        if path == "/index.html" or path == "":
            pass
        # 目录穿越防护
        if ".." in path.split("/"):
            return None
        if path not in CACHE and (path + "/index.html") in CACHE:
            path += "/index.html"
        return path if path in CACHE else None

    def _respond(self, send_body):
        key = self._resolve()
        if key is None:
            body = b"404 Not Found"
            self.send_response(404)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            if send_body:
                self.wfile.write(body)
            return

        raw, gz, etag, ctype = CACHE[key]

        # 对外目录要给网页类第三方应用直接 fetch 的能力（Cloudflare Pages 那边
        # 由 _headers 配同一条规则，自建部署也要一致，否则换部署方式就断）。
        cors = {"Access-Control-Allow-Origin": "*"} if key == "/catalog.json" else {}

        if self.headers.get("If-None-Match") == etag:
            self.send_response(304)
            self.send_header("ETag", etag)
            self.send_header("Vary", "Accept-Encoding")
            self.send_header("Content-Length", "0")
            for name, value in cors.items():
                self.send_header(name, value)
            self.end_headers()
            return

        accept = (self.headers.get("Accept-Encoding") or "").lower()
        use_gz = gz is not None and "gzip" in accept
        body = gz if use_gz else raw

        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Vary", "Accept-Encoding")
        self.send_header("ETag", etag)
        for name, value in cors.items():
            self.send_header(name, value)
        if use_gz:
            self.send_header("Content-Encoding", "gzip")
        # HTML 不缓存（每次回源验证），静态资源给长缓存 + ETag 协商
        if ctype.startswith("text/html"):
            self.send_header("Cache-Control", "no-cache")
        else:
            self.send_header("Cache-Control", "public, max-age=300, must-revalidate")
        self.end_headers()
        if send_body:
            self.wfile.write(body)

    def do_GET(self):
        if self._is_api():
            return self._proxy_api()
        self._respond(True)

    def do_HEAD(self):
        if self._is_api():
            return self._proxy_api()
        self._respond(False)

    def do_POST(self):
        if self._is_api():
            return self._proxy_api()
        self.send_error(405)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Allow", "GET,HEAD,POST,OPTIONS")
        self.send_header("Content-Length", "0")
        self.end_headers()

    # ---- /api/* ----
    def _is_api(self):
        return urlparse(self.path).path.startswith("/api/")

    def _proxy_api(self):
        """`/api/pile` 走本地共享缓存；其余接口原样反代（凭证仍在 CF KV，零迁移）。"""
        path = urlparse(self.path).path
        head = self.command == "HEAD"

        raw = b""
        n = self.headers.get("content-length")
        if n:
            try:
                raw = self.rfile.read(int(n))
            except ValueError:
                raw = b""

        if path.rstrip("/") == "/api/pile":
            try:
                body = json.loads(raw.decode("utf-8")) if raw else {}
            except Exception:
                body = {}
            status, payload = handle_pile(body)
            data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            if not head:
                self.wfile.write(data)
            return

        req = urllib.request.Request(
            UPSTREAM + self.path,
            data=raw if self.command in ("POST", "PUT", "PATCH") else None,
            method=self.command,
        )
        for h in ("content-type", "accept"):
            v = self.headers.get(h)
            if v:
                req.add_header(h, v)
        req.add_header("origin", UPSTREAM_ORIGIN)
        req.add_header("user-agent", UPSTREAM_UA)
        req.add_header("accept-encoding", "identity")
        try:
            with urllib.request.urlopen(req, timeout=UPSTREAM_TIMEOUT) as r:
                status, ctype, data = r.status, r.headers.get("content-type"), r.read()
        except urllib.error.HTTPError as e:
            status, ctype, data = e.code, (e.headers or {}).get("content-type"), (e.read() or b"")
        except Exception as e:
            _log("upstream %s failed: %s %s" % (path, type(e).__name__, e))
            data = json.dumps({"ok": False, "error": "upstream_unreachable"}).encode("utf-8")
            status, ctype = 502, "application/json; charset=utf-8"

        self.send_response(status)
        self.send_header("Content-Type", ctype or "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")   # 接口绝不能进静态缓存
        self.end_headers()
        if not head:
            self.wfile.write(data)

    def log_message(self, fmt, *args):
        """静态资源不记（一屏十几个，接口日志会被淹掉）；只记接口和错误。"""
        try:
            path = urlparse(self.path).path
            if not path.startswith("/api/") and not str(args[1] if len(args) > 1 else "").startswith("4"):
                return
        except Exception:
            pass
        sys.stderr.write("%s %s\n" % (self.address_string(), fmt % args))


class Server(ThreadingHTTPServer):
    daemon_threads = True

    def handle_error(self, request, client_address):
        """浏览器提前断连是常态（切页、abort、SPA 跳转），不要刷整屏 traceback。

        ⚠️ 必须盖在 **server** 上：断连是 `ThreadingMixIn.process_request_thread`
        捕获后调 server 的 `handle_error` 抛出来的，盖在 Handler 上不生效
        （第一版就是这么写错的，一轮本地测试刷出 5 万字符 traceback，
        真正的接口日志全被埋掉）。
        """
        exc = sys.exc_info()[1]
        if isinstance(exc, (ConnectionResetError, ConnectionAbortedError,
                            BrokenPipeError, socket.timeout)):
            return
        super().handle_error(request, client_address)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", default=os.path.dirname(os.path.abspath(__file__)),
                    help="站点根目录（默认本脚本所在目录）")
    ap.add_argument("--port", type=int, default=int(os.environ.get("PORT", "3000")))
    args = ap.parse_args()

    root = os.path.abspath(args.root)
    if not os.path.isdir(root):
        print("root 不存在: %s" % root, file=sys.stderr)
        return 2
    with CACHE_LOCK:
        load(root)
        add_catalog(root)

    srv = Server(("0.0.0.0", args.port), Handler)
    print("serving %s on 0.0.0.0:%d（上游 %s）" % (root, args.port, UPSTREAM), file=sys.stderr)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
