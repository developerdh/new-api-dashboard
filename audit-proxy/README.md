# audit-proxy

把经过 new-api 的对话请求与响应落成本地文件，供看板按 trace 读取。

## 设计边界

| 做 | 不做 |
|---|---|
| 透传请求与响应（含 SSE） | 不解析 JSON、不做协议归一化（由看板读取侧负责） |
| 白名单路径的请求/响应原样落盘 | 不采集图片、音频、文件等二进制接口 |
| 落盘失败只降级采集 | 绝不因为采集失败中断转发 |
| 零第三方依赖、静态编译 | 不连数据库、不回调看板、不依赖任何外部服务 |

结论：它是关键路径上的组件，但失效面被压到最小——最坏情况是丢采集，不丢业务。

## 部署拓扑

```
client ──► nginx ──┬──► audit-proxy:8090 ──► new-api:3000
                   │        └── data/audit/**（写）
                   └──► dashboard:3088 ─────────┘（只读）
```

nginx 侧建议把代理设为 upstream 主节点、new-api 设为 backup，代理不可用时自动降级为直连（见下方配置）。

## 落盘结构

```
$AUDIT_DIR/
├─ blobs/
│  └─ 2026-11-13/              # 按天分目录，便于整目录清理
│     └─ 3f9a1c7b22d4/         # token 指纹（sha256 前 12 位），等价于调用方维度
│        ├─ <trace>.req[.gz]
│        └─ <trace>.res[.gz]
└─ index/
   └─ 2026-11-13.ndjson        # 当天索引，追加写
```

说明：

- 代理**拿不到 user_id**（new-api 不透传），因此用 `sha256(Authorization)` 前 12 位作为调用方维度。看板读取时用该指纹反查 token → user。
- 文件名固定为 `<trace>.req` / `<trace>.res`，是否带 `.gz` 由索引里的 `qz` / `rz` 决定，不要猜。
- 大文件用流式 gzip，内存不随体积增长。

### 索引行

一天一个 NDJSON，每行一个请求，字段刻意用短名：

| 字段 | 含义 |
|---|---|
| `t` | trace id（与 nginx `X-Trace-Id` 一致） |
| `u` | token 指纹（目录名） |
| `d` | 开始时间（RFC3339Nano） |
| `p` | 请求路径 |
| `m` | 模型（只从请求体前 8 KB 提取，非解析） |
| `s` | HTTP 状态码 |
| `st` | 是否流式 |
| `ms` | 总耗时 |
| `ft` | 首字节耗时（无输出时为 0） |
| `rq` / `rs` | 请求 / 响应落盘字节数（截断后的实际值） |
| `qz` / `rz` | 对应文件是否 gzip |
| `tr` | 截断位掩码：1=请求截断，2=响应截断 |
| `e` | 上游错误（成功时为空） |
| `ip` | 客户端 IP |

## 配置

| 变量 | 默认 | 说明 |
|---|---|---|
| `LISTEN` | `127.0.0.1:8090` | 监听地址；容器内用 `0.0.0.0:8090` |
| `UPSTREAM` | `http://127.0.0.1:3000` | new-api 地址 |
| `AUDIT_DIR` | `./data/audit` | 产物根目录，必须可写 |
| `CAPTURE_PATHS` | 四个对话路径 | 逗号分隔，精确匹配；`*` 为全采集（不推荐） |
| `MAX_REQUEST_BYTES` | `134217728`（128 MiB） | 请求落盘上限，超出截断并置 `tr` 位 |
| `MAX_RESPONSE_BYTES` | `134217728` | 响应落盘上限 |
| `GZIP_THRESHOLD` | `65536` | 超过则压缩；`0` 关闭 |
| `UPSTREAM_HEADER_TIMEOUT` | `300s` | 等待上游响应头，不含 body |

内存占用与 body 大小无关：请求/响应都是边转发边写盘，常驻约为每请求 64 KiB 缓冲。

## 构建

```bash
# 本机直接跑
go build -o audit-proxy .

# 交叉编译（发布产物即此命令）
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 \
  go build -trimpath -ldflags="-s -w -X main.version=v0.1.0" -o audit-proxy .
```

产物是静态链接单文件（约 6.6 MB），不依赖 libc，也不需要安装 Go 运行时。

### 镜像（可选）

```bash
# 上下文必须是本目录，不能用仓库根目录
docker build --build-arg VERSION=v0.1.0 -t new-api-audit-proxy:v0.1.0 .
```

或直接用 `docker-compose.example.yml`。

## 部署

### systemd（裸机）

```bash
install -d -o audit -g audit -m 750 /var/lib/new-api-dashboard/audit

install -m 0755 audit-proxy /opt/audit-proxy/audit-proxy
install -m 0644 audit-proxy.service /etc/systemd/system/
install -m 0640 -o root -g audit audit-proxy.env.example /etc/audit-proxy.env
# 按实际环境改 /etc/audit-proxy.env

useradd --system --no-create-home --shell /usr/sbin/nologin audit 2>/dev/null || true
chown -R audit:audit /var/lib/new-api-dashboard/audit

systemctl daemon-reload
systemctl enable --now audit-proxy
systemctl status audit-proxy
journalctl -u audit-proxy -f
```

看板侧只需读权限：

```bash
usermod -aG audit <看板运行用户>
```

### Docker

```bash
cp audit-proxy.env.example .env
docker compose -f docker-compose.example.yml up -d --build
curl -s http://127.0.0.1:8090/healthz
```

与看板共部署时，把服务定义并入根 `docker-compose.yml`，两侧挂同一份 `../data/audit`：

```yaml
services:
  audit-proxy:
    image: new-api-audit-proxy:v0.1.0
    volumes: ["./data/audit:/app/data/audit"]
    ports: ["127.0.0.1:8090:8090"]

  dashboard:
    volumes:
      - ./data/audit:/app/data/audit:ro
```

`:ro` 是刻意的：从挂载层面保证看板不写入。

## nginx 接入

```nginx
upstream llm_backend {
    server 127.0.0.1:8090 max_fails=2 fail_timeout=10s;   # 代理
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
    # 让代理与 nginx 日志共用同一个 trace id
    proxy_set_header X-Trace-Id $request_id;

    proxy_next_upstream error timeout http_502 http_503 http_504;
    proxy_request_buffering on;   # 重试需要；默认即开

    proxy_buffering off;          # SSE 必须有
    proxy_read_timeout 600s;
    proxy_send_timeout 600s;

    add_header X-Trace-Id $request_id always;
}
```

要点：

- `backup` 让代理不可用时自动直连 new-api，业务只丢采集，不丢调用。
- `proxy_buffering off` 不可省，否则流式响应会被 nginx 缓冲。
- 代理会透传 `X-Trace-Id`，客户端响应头里也有同名值，排障时可以直接对上。

## 故障行为

| 场景 | 表现 | 业务影响 |
|---|---|---|
| 代理未启动 | nginx 2 次失败后切 backup | 无（丢采集） |
| 审计目录不可写 | 启动仍成功，采集日志报 `audit_dir_unavailable` | 无 |
| 磁盘写满 | 该请求采集失败，`capture_write_failed` | 无 |
| 上游不可达 | 返回 502 JSON | 有（与直连表现一致） |
| 转发中途崩溃 | 该请求失败且无法重试 | 有（唯一残余风险） |

## 验证

```bash
# 存活
curl -s http://127.0.0.1:8090/healthz

# 灌一条并确认落盘
curl -s http://127.0.0.1:8090/v1/chat/completions \
  -H "Authorization: Bearer sk-test" -H "Content-Type: application/json" \
  -H "X-Trace-Id: 0123456789abcdef0123456789abcdef" \
  -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"hi"}]}'

ls -R $AUDIT_DIR/blobs | tail -5
tail -1 $AUDIT_DIR/index/$(date +%F).ndjson | jq .

# failover：停掉代理后确认 nginx 仍能直连
systemctl stop audit-proxy && curl -sI https://<你的域名>/v1/models
```

## 已知限制

- 一次请求落两个文件 + 一行索引。日均 5 千请求约 1.1 万文件/天，需配保留策略按日期目录清理。
- 索引按天切分，跨天查询要读多个文件。
- 客户端断开时可能只落盘半截响应，靠索引 `tr` 位区分截断与正常结束。
