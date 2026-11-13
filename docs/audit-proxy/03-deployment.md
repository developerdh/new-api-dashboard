# 构建与部署

audit-proxy 的构建、部署、反向代理接入与回滚。设计依据见 [02-design.md](02-design.md)。

本目录只描述采集组件的部署；看板自身的构建与部署见 [../deployment.md](../deployment.md)。

## 1. 环境要求

| 项 | 要求 | 说明 |
|---|---|---|
| Go | 1.22+ | 仅构建期需要；运行时无依赖 |
| 目标平台 | linux/amd64、linux/arm64 | 静态链接，不依赖 libc |
| nginx | ≥ 1.13.4 | 需要 `upstream backup` 与 `$request_id` |
| 磁盘 | 见 §6.3 容量估算 | 建议独立挂载，避免与容器日志抢空间 |

发布产物为静态二进制，目标机不需要安装 Go 运行时、Node、Python 或任何共享库。

## 2. 构建

### 2.1 本地构建

```bash
cd audit-proxy
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 \
  go build -trimpath -ldflags="-s -w -X main.version=v0.1.0" -o audit-proxy .
```

| 产物 | 体积（实测） |
|---|---|
| `audit-proxy`（linux/amd64，`-s -w`） | 6.6 MB |

同一命令换 `GOARCH=arm64` 即可产出 arm64 版本，两条均已实测通过。

### 2.2 使用 Makefile

```bash
make vet      # go vet + gofmt 检查
make build    # 当前平台
make linux    # amd64 + arm64 输出到 dist/
make image    # 容器镜像
```

### 2.3 容器镜像（可选）

官方发布物是非容器包，镜像需自行构建，构建上下文**必须是 `audit-proxy/` 目录**（仓库根目录的 `.dockerignore` 已排除该目录）：

```bash
cd audit-proxy
docker build --build-arg VERSION=v0.1.0 -t new-api-audit-proxy:v0.1.0 .
```

### 2.4 发布流水线

`.github/workflows/release-audit-proxy.yml`，由 tag `audit-proxy-v*` 触发，与看板的 `v*` 流水线互不干扰。

| 步骤 | 内容 |
|---|---|
| 静态检查 | `go vet` + `gofmt -l` 必须为空 |
| 交叉编译 | linux/amd64、linux/arm64 |
| 打包 | 二进制 + `audit-proxy.service` + `audit-proxy.env.example` + `README.md` |
| 冒烟 | 在干净环境执行 `-version`，并断言 `file` 输出为 `statically linked` |
| 上传 | `*.tar.gz` 与 `SHA256SUMS` |

发布包解压即用，不含容器运行时依赖。

## 3. 配置

全部通过环境变量注入，无配置文件。完整样例见 `audit-proxy/audit-proxy.env.example`。

| 变量 | 默认 | 运维关注点 |
|---|---|---|
| `LISTEN` | `127.0.0.1:8090` | 裸机绑回环；容器内必须 `0.0.0.0:8090` |
| `UPSTREAM` | `http://127.0.0.1:3000` | Docker 场景指向 New API 容器名或 `host.docker.internal` |
| `AUDIT_DIR` | `./data/audit` | 必须可写；看板侧只读挂载同一目录 |
| `CAPTURE_PATHS` | 四个对话路径 | 新增协议时在此追加，其余路径直接放行 |
| `MAX_REQUEST_BYTES` / `MAX_RESPONSE_BYTES` | 128 MiB | 磁盘防御阈值 |
| `GZIP_THRESHOLD` | 64 KiB | `0` 关闭压缩，仅建议排障时使用 |

### 3.1 看板侧配置（读取）

看板不写审计目录，只需只读挂载与下列变量：

| 变量 | 默认 | 说明 |
|---|---|---|
| `AUDIT_DIR` | 空（功能关闭） | 与代理的 `AUDIT_DIR` 指向同一目录；留空时 `/api/audit/*` 返回 `available:false` |
| `AUDIT_TOKEN_HEADER_PREFIX` | `Bearer sk-` | 指纹重构前缀，必须与实际 Authorization 形态一致 |
| `AUDIT_MAX_WINDOW_DAYS` | 31 | 列表时间窗上限（天），超限直接 400 |
| `AUDIT_MAX_BLOB_BYTES` | 16 MiB | 单文件读取上限（解压后），超出截断并标注 |
| `AUDIT_RAW_PREVIEW_BYTES` | 256 KiB | 「原始报文」页签预览上限 |
| `AUDIT_CACHE_TTL_MS` | 30000 | 索引解析结果缓存 TTL |
| `AUDIT_INDEX_CACHE_MAX_ENTRIES` | 20000 | 超过该条数的日索引不缓存 |

指纹反查需要一次数据库授权（只读，不建表、不写数据）：

```sql
GRANT SELECT ON tokens TO <dashboard_readonly>;
```

缺权限时读取侧降级：列表返回 `lookupError`，界面提示"无法反查 token 指纹"，不报 500。

## 4. 部署

### 4.1 systemd（裸机）

```bash
useradd --system --no-create-home --shell /usr/sbin/nologin audit
install -d -o audit -g audit -m 750 /var/lib/new-api-dashboard/audit

install -m 0755 audit-proxy /opt/audit-proxy/audit-proxy
install -m 0644 audit-proxy.service /etc/systemd/system/
install -m 0640 -o root -g audit audit-proxy.env.example /etc/audit-proxy.env

systemctl daemon-reload
systemctl enable --now audit-proxy
```

unit 已包含加固项：`ProtectSystem=strict`、`PrivateTmp`、`NoNewPrivileges`，且 `ReadWritePaths` 只放审计目录。

看板进程只需读权限：

```bash
usermod -aG audit <看板运行用户>
```

### 4.2 Docker

```bash
cd audit-proxy
cp audit-proxy.env.example .env
docker compose -f docker-compose.example.yml up -d --build
```

与看板共部署时，把服务并入根 `docker-compose.yml`，两侧挂同一目录：

```yaml
services:
  audit-proxy:
    image: new-api-audit-proxy:v0.1.0
    volumes: ["./data/audit:/app/data/audit"]
    ports: ["127.0.0.1:8090:8090"]
    restart: unless-stopped

  dashboard:
    volumes:
      - ./data/snapshots:/app/data/snapshots
      - ./data/audit:/app/data/audit:ro
```

`:ro` 是刻意的：从挂载层保证看板不写入，与“只读数据库”的红线一致。

上游地址的两种写法：

| 拓扑 | `UPSTREAM` | 附加配置 |
|---|---|---|
| New API 在同一 compose | `http://new-api:3000` | 无 |
| New API 在宿主机 | `http://host.docker.internal:3000` | `extra_hosts: ["host.docker.internal:host-gateway"]` |

### 4.3 部署形态组合

| 采集组件 | 看板 | 共享方式 |
|---|---|---|
| systemd | systemd / pm2 | 同一目录 + `audit` 组读权限 |
| 容器 | 容器 | bind mount，看板 `:ro` |
| systemd | 容器 | bind mount 到容器内 |

代理与看板的部署方式互不约束。

## 5. nginx 接入

### 5.1 主配置

```nginx
upstream llm_backend {
    server 127.0.0.1:8090 max_fails=2 fail_timeout=10s;   # audit-proxy
    server 127.0.0.1:3000 backup;                          # 直连兜底
    keepalive 64;
}

location /v1/ {
    proxy_pass http://llm_backend;
    proxy_http_version 1.1;
    proxy_set_header Connection "";
    proxy_set_header Host $http_host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;

    # 与采集索引共用同一 trace
    proxy_set_header X-Trace-Id $request_id;
    add_header       X-Trace-Id $request_id always;

    proxy_next_upstream error timeout http_502 http_503 http_504;
    proxy_request_buffering on;

    proxy_buffering off;        # SSE 必需
    proxy_read_timeout 600s;
    proxy_send_timeout 600s;
}
```

### 5.2 参数说明

| 参数 | 作用 | 不设的后果 |
|---|---|---|
| `backup` | 代理不可用时回落直连 | 代理异常直接导致业务中断 |
| `proxy_buffering off` | 关闭响应缓冲 | 流式响应被整段缓冲，首字延迟显著上升 |
| `proxy_request_buffering on` | 保留请求体以便重试 | 带 body 的 POST 无法切换到 backup |
| `proxy_set_header X-Trace-Id` | 代理与 nginx 日志共用 trace | 采集数据无法与访问日志对齐 |
| `add_header X-Trace-Id ... always` | 客户端可见 trace | 用户报障时无法定位到具体请求 |

### 5.3 双 upstream 的语义

nginx 仅对**连接阶段失败**与**响应头阶段失败**执行重试；一旦开始向客户端发送响应体，就不再切换。因此：

- 代理未启动、端口未监听 → 自动切换，业务无感。
- 转发中途失败 → 该请求失败，不重试（重试会导致上游重复计费）。

这是设计上的已知取舍，见 [02-design.md](02-design.md) §3。

### 5.4 部署顺序

1. 建目录、装二进制、启动代理，`curl /healthz` 通过。
2. 单独验证采集：直接访问 `127.0.0.1:8090` 发一次请求，确认落盘。
3. 修改 nginx upstream，`nginx -t` 通过后 reload。
4. 观察 `error.log` 是否出现代理连接失败，确认 failover 生效。

## 6. 验证

### 6.1 存活与采集

```bash
curl -s http://127.0.0.1:8090/healthz

curl -s http://127.0.0.1:8090/v1/chat/completions \
  -H "Authorization: Bearer sk-test" \
  -H "Content-Type: application/json" \
  -H "X-Trace-Id: 0123456789abcdef0123456789abcdef" \
  -d '{"model":"gpt-4o-mini","stream":true,"messages":[{"role":"user","content":"hi"}]}'

find "$AUDIT_DIR/blobs" -name '0123456789abcdef*' -type f
tail -1 "$AUDIT_DIR/index/$(date +%F).ndjson"
```

### 6.2 关键用例

开发机 + 假上游实测结果，部署后应逐项复现：

| 用例 | 期望 |
|---|---|
| SSE 透传 | 客户端按块收到，`ft`（首字节耗时）为毫秒级，无整段缓冲 |
| 内容落盘 | `.req` 与 `.res` 内容与收发一致，索引 `m` / `st` / `s` 正确 |
| 请求截断 | 将 `MAX_REQUEST_BYTES` 调小后，`rq` 等于上限、`tr=1`，但**客户端收到完整响应** |
| 压缩 | 调小 `GZIP_THRESHOLD` 后产物为 `.gz`、`qz`/`rz` 为 `true`，解压后字节数一致 |
| 上游不可达 | 返回 502 JSON，索引记录 `s=502` 与 `e` 错误串 |
| 非白名单路径 | 请求成功但 `blobs/` 无新增文件 |

### 6.3 failover 验证

```bash
systemctl stop audit-proxy        # 或 docker stop
curl -sI https://<域名>/v1/models
systemctl start audit-proxy
```

停掉代理期间请求应正常返回；`error.log` 出现 connect refused，`fail_timeout` 到期后自动恢复走代理。

## 7. 容量与清理

| 项 | 估算 |
|---|---|
| 每请求文件 | 2 |
| 每天文件 | 约 1.1 万（按 5.6k 请求/天） |
| 每年文件 | 约 400 万 |
| 索引 | 约 1.1 MB/天 |

必须按日期目录清理。建议保留 90 天：

```bash
# 清理脚本尚未实现，此为手工参考命令；执行前先 dry-run
find "$AUDIT_DIR/blobs" -maxdepth 1 -type d -mtime +90 -print
find "$AUDIT_DIR/index" -maxdepth 1 -type f -mtime +90 -print
```

清理任务必须与看板的保留口径一致，且需要同时清理 `.tmp` 残留（采集中断会留下临时文件）。

## 8. 回滚

| 动作 | 影响 |
|---|---|
| 还原 nginx upstream（去掉 8090 主节点） | 立即回到直连，代理可停可留 |
| 停止代理进程 | 依赖 failover 兜底，业务无感 |
| 降级代理版本 | 产物格式向后兼容（目录与索引字段只增不改），旧数据仍可读 |
| 删除采集数据 | 只影响历史追溯，不影响看板统计（统计走 PostgreSQL） |

采集数据不在数据库中，回滚不涉及任何 schema 或数据迁移。

## 9. 已知问题

| 问题 | 影响 | 处理 |
|---|---|---|
| 转发中途崩溃不可重试 | 该请求失败 | 设计取舍，见 [02-design.md](02-design.md) §3 |
| 上游拨号失败时请求体不落盘 | 索引 `rq=0` | 不影响排障，`e` 字段含完整错误 |
| 代理无法获知 `user_id` | 目录按调用方指纹分组 | 看板按 `tokens.key` 反查，见 [02-design.md](02-design.md) §4.2 |
| 客户端断开可能留下半截响应 | 正文不完整 | 索引 `tr` 位与 `s` 可辅助判断 |
| 清理脚本未实现 | 长期运行磁盘持续增长 | 见 §7，需人工或外部定时任务 |
| 看板缺少 `tokens` 读权限 | 会话列表为空并提示"无法反查指纹" | 按 §3.1 授权；无权限时降级，不报 500 |
| 指纹前缀与调用方不一致 | 该 token 的会话全部查不到（漏配，不会错配） | 核对 `AUDIT_TOKEN_HEADER_PREFIX` |
| nginx failover 未经生产验证 | 首次上线存在未知行为 | 按 §5.4 顺序灰度，先观察 error.log |
