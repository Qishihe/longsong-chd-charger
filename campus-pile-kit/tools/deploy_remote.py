#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""把 dist-cloudflare 推到自建服务器（IP 直连，无域名）。

用法：
  CHD_SSH_PASS='...' python tools/deploy_remote.py [--dry]

做的事：
  1. 本地打包 dist-cloudflare（去掉 _worker.js / _routes.json / _headers，
     这三个只有 Cloudflare 认）；
  2. SFTP 传到 /tmp，远端解压到 /var/www/chd.new，再原子换到 /var/www/chd；
  3. 上传 tools/nginx-chd.conf → /etc/nginx/sites-available/chd 并软链；
  4. nginx -t 过了才 reload；失败就把旧目录换回去（不 reload）。

🔴 密码只从环境变量读，不写进任何文件。
"""
import io
import os
import sys
import tarfile

import paramiko

HOST = os.environ.get('CHD_SSH_HOST', '192.140.173.156')
PORT = int(os.environ.get('CHD_SSH_PORT', '22'))
USER = os.environ.get('CHD_SSH_USER', 'root')
PASS = os.environ.get('CHD_SSH_PASS', '')

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # campus-pile-kit
DIST = os.path.join(ROOT, 'dist-cloudflare')
CONF = os.path.join(ROOT, 'tools', 'nginx-chd.conf')

SKIP = {'_worker.js', '_routes.json', '_headers'}
REMOTE_SITE = '/var/www/chd'
REMOTE_TGZ = '/tmp/chd-site.tgz'
REMOTE_CONF = '/etc/nginx/sites-available/chd'


def pack():
    """把站点打成 tar.gz，只留真正要静态发布的文件。"""
    buf = io.BytesIO()
    names = sorted(os.listdir(DIST))
    with tarfile.open(fileobj=buf, mode='w:gz', compresslevel=6) as tf:
        for name in names:
            if name in SKIP:
                continue
            path = os.path.join(DIST, name)
            tf.add(path, arcname=name)
    data = buf.getvalue()
    print('打包 %d 个条目 → %.1f MB（原始 %.1f MB）'
          % (len(names) - len([n for n in names if n in SKIP]),
             len(data) / 1048576.0,
             sum(os.path.getsize(os.path.join(dp, f))
                 for dp, _, fs in os.walk(DIST) for f in fs) / 1048576.0))
    return data


def run(cli, cmd, quiet=False):
    stdin, stdout, stderr = cli.exec_command(cmd, timeout=180)
    out = stdout.read().decode('utf-8', 'replace')
    err = stderr.read().decode('utf-8', 'replace')
    rc = stdout.channel.recv_exit_status()
    if not quiet and out.strip():
        print(out.rstrip())
    if err.strip():
        print('[stderr] ' + err.rstrip())
    return rc, out


def main():
    if not PASS:
        print('缺少 CHD_SSH_PASS')
        return 2
    if not os.path.isdir(DIST):
        print('没有 dist-cloudflare，先跑 make_cloudflare.py')
        return 2

    dry = '--dry' in sys.argv
    payload = pack()

    cli = paramiko.SSHClient()
    cli.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    cli.connect(HOST, port=PORT, username=USER, password=PASS,
                timeout=20, banner_timeout=25, auth_timeout=25,
                look_for_keys=False, allow_agent=False)

    # 1) 传包
    tr = cli.get_transport()
    sftp = paramiko.SFTPClient.from_transport(tr)
    print('上传中…')
    with sftp.file(REMOTE_TGZ, 'wb') as f:
        f.write(payload)
    print('上传完成 %.1f MB' % (len(payload) / 1048576.0))
    sftp.close()

    if dry:
        print('--dry：只传包，不动站点')
        cli.close()
        return 0

    # 2) 解压 + 原子切换（先 .new，成功了再挪走旧的）
    run(cli, 'set -e; rm -rf %s.new; mkdir -p %s.new; '
             'tar xzf %s -C %s.new; '
             'rm -rf %s.old; if [ -d %s ]; then mv %s %s.old; fi; '
             'mv %s.new %s; ls %s | wc -l'
             % (REMOTE_SITE, REMOTE_SITE, REMOTE_TGZ, REMOTE_SITE,
                REMOTE_SITE, REMOTE_SITE, REMOTE_SITE, REMOTE_SITE,
                REMOTE_SITE, REMOTE_SITE, REMOTE_SITE))

    # 3) 配置：内容一样就不覆盖，免得每次都触发 reload
    with open(CONF, 'r', encoding='utf-8') as fh:
        conf_text = fh.read()
    sftp2 = paramiko.SFTPClient.from_transport(tr)
    sftp2.putfo(io.BytesIO(conf_text.encode('utf-8')), '/tmp/chd.nginx.conf')
    sftp2.close()
    rc, out = run(cli, 'set -e; '
                       'if cmp -s /tmp/chd.nginx.conf %s; then echo CONF_SAME; '
                       'else install -m 644 /tmp/chd.nginx.conf %s; echo CONF_UPDATED; fi; '
                       'ln -sfn %s /etc/nginx/sites-enabled/chd; '
                       'rm -f /etc/nginx/sites-enabled/default /etc/nginx/sites-enabled/zz-probe'
                       % (REMOTE_CONF, REMOTE_CONF, REMOTE_CONF))

    # 4) nginx -t 过了才 reload；不过就回滚目录
    rc, out = run(cli, 'nginx -t 2>&1')
    if rc != 0:
        print('✗ nginx 配置不合法，回滚站点目录，不 reload')
        # 只有真的存在上一版才回滚；首次部署没有 .old，别把刚传的站点删了
        run(cli, 'if [ -d %s.old ]; then rm -rf %s; mv %s.old %s; fi'
                 % (REMOTE_SITE, REMOTE_SITE, REMOTE_SITE, REMOTE_SITE))
        cli.close()
        return 3

    run(cli, 'systemctl reload nginx && echo NGINX_RELOADED')
    run(cli, 'rm -f %s' % REMOTE_TGZ)
    cli.close()
    print('\n完成：http://%s/' % HOST)
    return 0


if __name__ == '__main__':
    sys.exit(main())
