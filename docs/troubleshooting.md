# 常见问题排查

按「看到的现象」索引。每条给出原因、处理与验证方法；涉及命令的地方假设容器名为 `new-api-dashboard`，按实际替换。

## 症状索引

| 现象 | 跳到 |
|---|---|
| 登录报 `403 invalid_origin`／`请求来源不被允许` | [1](#1-登录报-403-invalid_origin) |
| 经反向代理/IP 打不开页面，但本机 `curl 127.0.0.1:3088` 正常 | [2](#2-经反向代理打不开页面) |
| 改了 nginx 配置但不生效，`nginx -t` 却通过 | [3](#3-改了-nginx-配置却不生效) |
| `/api/health` 返回 503，`db.status = down` | [4](#4-health-503且-dbstatus--down) |
| `/api/health` 返回 503，`schema.missing` 非空 | [5](#5-health-503且-schemamissing-非空) |
| 页面能打开但样式全丢／图表空白 | [6](#6-页面能开但样式或图表空白) |
| 服务端快照报错或生成的文件为空 | [7](#7-快照失败) |
| 登录成功后立刻跳回登录页 | [8](#8-登录后立刻掉回登录页) |
| `docker build` 依赖安装极慢甚至超时 | [9](#9-镜像构建依赖安装极慢) |
| 解压 tar.gz 报 `Cannot create symlink` | [10](#10-解压发布包报-cannot-create-symlink) |
| Windows 上 `pnpm dev` 报找不到 Next.js 包 | [11](#11-windows-上-pnpm-dev-失败) |
| 容器 `unhealthy` 但页面能访问 | [12](#12-容器-unhealthy-但页面可访问) |

## 通用自检

```bash
# 服务自身（绕过代理）
curl -s http://127.0.0.1:3088/api/health | jq

# 谁在监听、绑的哪个地址
ss -lntp | grep -E ':(80|443|3088)\s'

# 容器发布到宿主机的端口
docker ps --format '{{.Names}}\t{{.Ports}}\t{{.Status}}'

# nginx 实际加载了哪些 server 块（打印的是磁盘配置，不代表进程内存状态）
nginx -T 2>/dev/null | grep -nE '^# configuration file|listen |server_name|proxy_set_header'

# nginx 错误日志（reload 失败只写这里，命令行是静默的）
tail -30 /var/log/nginx/error.log
```

---

## 1. 登录报 403 invalid_origin

**现象**

```
{"ok":false,"error":{"code":"invalid_origin","message":"请求来源不被允许"}}
```

**原因**

登录接口有同源校验：仅当请求带 `Origin` 头且与站点自身的 origin 不一致时才拒绝。产生不一致的常见原因有两个，且常叠加：

1. **0.1.0 及更早版本的缺陷**：校验直接使用 `new URL(request.url).origin`，而 Next.js 在 Route Handler 中把它解析为**服务端监听地址**（`http://localhost:<PORT>`），忽略 `Host` 头。因此只有本地 `localhost` 直连能通过，经 IP／域名／反向代理访问一律 403。**升级到 0.1.1 及以上即可修复。**
2. **反向代理转发的 `Host` 丢了端口**：nginx 的 `$host` 会剥掉端口，导致站点 origin 与浏览器不一致。必须用 `$http_host`。

**处理**

```bash
# 确认版本（低于 0.1.1 先升级）
curl -s http://127.0.0.1:3088/api/health | jq .version
```

升级后在 nginx 中核对三个头：

```nginx
proxy_set_header Host $http_host;                     # 必须带端口
proxy_set_header X-Forwarded-Host $http_host;          # 若上游还有其他代理，一并透传
proxy_set_header X-Forwarded-Proto $scheme;            # http / https
```

**验证**（`<IP>`、端口换成实际值；返回 401 表示来源校验已通过，只剩账号密码问题）

```bash
IP=10.0.0.5
curl -s -o /dev/null -w "%{http_code}\n" -X POST http://$IP:13088/api/auth/login \
  -H 'content-type: application/json' -H "Origin: http://$IP:13088" \
  -d '{"username":"x","password":"y"}'
```

## 2. 经反向代理打不开页面

**现象**：`curl 127.0.0.1:3088` 正常，但浏览器访问 `http://<IP>/` 超时或落到别的站点。

**原因**

- 容器只绑定回环（`127.0.0.1:3088:3088`，推荐做法），外部无入口，nginx 未正确接管；
- nginx 的 `listen` 端口与容器发布端口冲突，导致 nginx 起不来（见第 3 条）；
- 用 IP 访问时命中了别的 `default_server`。

**处理**

```bash
ss -lntp | grep -E ':(80|443)\s'      # 确认 nginx 在监听对外端口
nginx -T 2>/dev/null | grep -B2 -A2 default_server
```

`proxy_pass` 必须指向**容器发布的端口**，不要指向 nginx 自己：

```nginx
location / {
    proxy_pass http://127.0.0.1:3088;   # 容器端口
}
```

## 3. 改了 nginx 配置却不生效

**现象**：文件已改、`nginx -t` 通过、`nginx -T` 也能看到新内容，但行为没变。

**原因**

`nginx -T` 打印的是**磁盘上的配置**，不是进程内存里的。若 `reload` 时新 worker `bind` 失败，master 会放弃本次 reload，继续用旧 worker 运行，而命令行**没有任何输出**。典型触发：`listen` 的端口已被 docker-proxy 占用。

**处理**

```bash
nginx -t && nginx -s reload
tail -20 /var/log/nginx/error.log | grep -E 'bind|emerg|reload'
```

出现 `bind() to 0.0.0.0:3088 failed (98: Address already in use)` 即为此因。Linux 下通配地址会独占整个端口：`0.0.0.0:3088` 与 `127.0.0.1:3088` **互斥**，两者只能存在一个。要么把容器改到别的宿主端口，要么让 nginx 换端口。

## 4. health 503，且 db.status = down

```json
{"ok":false,"db":{"status":"down","error":{"code":"..."}}}
```

**排查顺序**

1. 容器内能否连通：`docker exec -it new-api-dashboard node -e "fetch('http://127.0.0.1:3088/api/health').then(r=>r.text()).then(console.log)"`
2. 从容器访问数据库：把 `DATABASE_URL` 的主机换成 IP 直接 `psql` 验证端口与账号
3. 检查 `pg_hba.conf` 是否允许该来源网段；云数据库需加白名单
4. 检查连接串是否包含特殊字符未编码（`#`、`@`、`/` 必须 percent-encode）

## 5. health 503，且 schema.missing 非空

```json
{"ok":false,"schema":{"ok":false,"missing":["users.display_name","logs.type"]}}
```

**原因**：New API 的表结构与看板查询依赖的列不一致（版本差异）。

**处理**：按 `missing` 逐项对照 [db-schema-notes.md](db-schema-notes.md)；确认是版本不匹配则升级 New API 或使用适配版本。**不要**为了消除报错去改表结构——本项目只读。

## 6. 页面能开但样式或图表空白

**原因**：反向代理拦了 `/_next/static/*` 或 `/api/*`，或用 `alias` 配错路径。

**处理**：让 `location /` 完整透传，不要再加拦截规则；确认浏览器 Network 里静态资源是 200 而非 404/403。

## 7. 快照失败

**原因**：默认 `runner` 镜像不含 chromium；或快照目录权限不足。

**处理**

- 需要快照能力时使用 `runner-snapshot` 镜像变体；
- 挂载目录属主必须是容器内的 uid（`1001`）：

```bash
sudo chown -R 1001:1001 /opt/new-api-dashboard/data/snapshots
```

## 8. 登录后立刻掉回登录页

| 原因 | 处理 |
|---|---|
| 多实例未配置统一的 `DASHBOARD_SESSION_SECRET` | 显式设置同一个强随机值 |
| 服务器时间偏差过大（会话有时效） | 校准 NTP |
| 反代丢弃 Cookie | 确认透传 `Cookie` 头；HTTPS 下确认 `X-Forwarded-Proto: https`，否则 Cookie 无 `Secure`、行为可能不一致 |

## 9. 镜像构建依赖安装极慢

**原因**：`registry.npmjs.org` 在国内链路下可能低至 10–20 KiB/s。

**处理**

```bash
docker build --build-arg NPM_REGISTRY=https://registry.npmmirror.com -t new-api-dashboard:<tag> .
```

实测从「卡住数分钟」降到约 44 秒。

## 10. 解压发布包报 Cannot create symlink

```
tar: Cannot create symlink to '/home/runner/work/...': Operation not permitted
```

**原因**：0.1.0 的发布包残留了指向构建机绝对路径的符号链接，包不可用。

**处理**：升级到 0.1.1 及以上的发布包；自行打包时用 `pnpm release:pack`（脚本会物化符号链接并断言）。

## 11. Windows 上 pnpm dev 失败

**现象**：`Could not find the Next.js package (next/package.json)`。

**处理**

```bash
pnpm config set node-linker hoisted --location project
```

写入的 `.npmrc` 已被 `.gitignore` 排除。

## 12. 容器 unhealthy 但页面可访问

**原因**：healthcheck 硬编码请求 `http://127.0.0.1:3088/api/health`。若改了容器内的 `PORT`，健康检查仍打 3088，判定失败。

**处理**：保持容器内端口为 `3088`，只在宿主机侧换映射端口（`-p 13088:3088`）。

---

## 反向代理配置要点

完整示例见 [nginx.example.conf](nginx.example.conf)。必须透传的头：

| 头 | 值 | 缺失后果 |
|---|---|---|
| `Host` | `$http_host`（含端口） | 影响同源判定与生成的绝对链接；用 `$host` 会丢端口 |
| `X-Forwarded-Proto` | `$scheme` | 会话 Cookie 不带 `Secure`；HTTPS 部署下不安全 |
| `X-Forwarded-For` | `$proxy_add_x_forwarded_for` | 审计与限流拿不到真实来源 IP |
| `X-Forwarded-Host` | `$http_host` | 多级代理时对外主机名失真 |

其他注意：

- 不要把 nginx 的 `listen` 端口与容器发布端口设成同一个值；
- 反向代理层不要缓存 `/api/*`（响应已带 `no-store`，但某些代理会忽略）；
- 静态资源 `/_next/static/` 可长缓存，文件名带内容哈希；
- 上 HTTPS 后无需改应用配置，`$scheme` 会自动传递。
