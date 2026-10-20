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
"""

import argparse
import gzip
import os
import sys
import threading
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

# 这几个文件不对外提供，免得被人下载去看实现
SELF_BLOCK = {"/serve_gzip.py"}


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
            if rel in SELF_BLOCK:          # 本文件不对外（请求会落到 404）
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

        if self.headers.get("If-None-Match") == etag:
            self.send_response(304)
            self.send_header("ETag", etag)
            self.send_header("Vary", "Accept-Encoding")
            self.send_header("Content-Length", "0")
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
        self._respond(True)

    def do_HEAD(self):
        self._respond(False)

    def log_message(self, fmt, *args):
        sys.stderr.write("%s %s\n" % (self.address_string(), fmt % args))


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

    srv = ThreadingHTTPServer(("0.0.0.0", args.port), Handler)
    print("serving %s on 0.0.0.0:%d" % (root, args.port), file=sys.stderr)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
