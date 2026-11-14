# new-api-dashcam 快速开始

从下载到接入 nginx 的最短路径。只写步骤与各配置的作用；原理与取舍见 [README.md](README.md) 与 [docs/dashcam/](../docs/dashcam/README.md)。

## 1. 下载并解压

从 GitHub Releases 下载对应平台的发布包（linux/amd64 或 linux/arm64）：

```bash
tar -xzf new-api-dashcam_v0.1.0_linux_amd64.tar.gz
cd new-api-dashcam_v0.1.0_linux_amd64
```

包内含二进制 `new-api-dashcam`、systemd unit、环境变量样例与 README。需要自行构建时在仓库内执行 `make linux`（输出到 `dist/`）。

## 2. 安装并启动（systemd，裸机推荐）

```bash
useradd --system --no-create-home --shell /usr/sbin/nologin new-api-dashcam 2>/dev/null || true
install -d -o new-api-dashcam -g new-api-dashcam -m 750 /var/lib/new-api-dashboard/dashcam
install -m 0755 new-api-dashcam /opt/dashcam/new-api-dashcam
install -m 0644 new-api-dashcam.service /etc/systemd/system/
install -m 0640 -o root -g new-api-dashcam dashcam.env.example /etc/dashcam.env
```

编辑 `/etc/dashcam.env`，确认这三个值（其余用默认即可）：

```bash
LISTEN=127.0.0.1:3090                      # 监听地址；nginx 同机时绑回环即可
UPSTREAM=http://127.0.0.1:3000             # new-api 地址
DASHCAM_DIR=/var/lib/new-api-dashboard/dashcam # 采集产物目录，必须可写
```

启动：

```bash
systemctl daemon-reload
systemctl enable --now new-api-dashcam
```

## 3. 验证

```bash
curl -s http://127.0.0.1:3090/healthz      # 返回 {"ok":true,"version":...} 即存活

curl -s http://127.0.0.1:3090/v1/chat/completions \
  -H "Authorization: Bearer sk-test" -H "Content-Type: application/json" \
  -H "X-Trace-Id: 0123456789abcdef0123456789abcdef" \
  -d '{"model":"gpt-4o-mini","stream":true,"messages":[{"role":"user","content":"hi"}]}'

find /var/lib/new-api-dashboard/dashcam/blobs -name '0123456789abcdef*'
tail -1 /var/lib/new-api-dashboard/dashcam/index/$(date +%F).ndjson
```

第二条请求走的就是代理：能拿到响应且 `blobs/` 出现对应文件、`index/` 追加了一行，说明采集已生效。

## 4. 接入 nginx

在业务 nginx 中把代理设为主节点、new-api 设为 backup：

```nginx
upstream llm_backend {
    server 127.0.0.1:3090 max_fails=2 fail_timeout=10s;   # new-api-dashcam
    server 127.0.0.1:3000 backup;                         # 直连兜底
    keepalive 64;
}

location /v1/ {
    proxy_pass http://llm_backend;
    proxy_http_version 1.1;
    proxy_set_header Connection "";
    proxy_set_header Host $http_host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Trace-Id $request_id;
    add_header       X-Trace-Id $request_id always;

    proxy_next_upstream error timeout http_502 http_503 http_504;
    proxy_request_buffering on;
    proxy_buffering off;        # SSE 必需
    proxy_read_timeout 600s;
    proxy_send_timeout 600s;
}
```

`nginx -t && nginx -s reload` 后，代理不可用会自动回落直连：只丢采集，不丢调用。

## 5. 让看板读到数据

```bash
# 裸机部署：看板运行用户加入 new-api-dashcam 组，获得记录目录的组读权限
usermod -aG new-api-dashcam <看板运行用户>
```

看板环境变量指向同一目录（看板侧只读）：

```bash
DASHCAM_DIR=/var/lib/new-api-dashboard/dashcam
```

## Docker 方式（可选）

```bash
cd dashcam
cp dashcam.env.example .env
# 编辑 .env：容器内 LISTEN 必须改为 0.0.0.0:3090，否则宿主机端口映射不通
docker compose -f docker-compose.example.yml up -d --build
curl -s http://127.0.0.1:3090/healthz
```

与看板共部署时，把服务定义并入看板的 `docker-compose.yml`，两侧挂同一目录：

```yaml
services:
  dashcam:
    image: new-api-dashcam:v0.1.0
    volumes: ["./data/dashcam:/app/data/dashcam"]
    ports: ["127.0.0.1:3090:3090"]
    restart: unless-stopped

  dashboard:
    volumes:
      - ./data/snapshots:/app/data/snapshots
      - ./data/dashcam:/app/data/dashcam:ro   # 只读：从挂载层保证看板不写入
```

两个注意点：

- `UPSTREAM` 按拓扑选：new-api 在同一 compose 用 `http://new-api:3000`；在宿主机用 `http://host.docker.internal:3000`，并给代理加 `extra_hosts: ["host.docker.internal:host-gateway"]`。
- 看板侧还需环境变量 `DASHCAM_DIR=/app/data/dashcam`，`API/监控` 页面才会启用（见 [03-deployment.md §3.1/§4.2](../docs/dashcam/03-deployment.md)）。

## 配置一览

| 变量 | 默认 | 作用 |
|---|---|---|
| `LISTEN` | `127.0.0.1:3090` | 监听地址；容器内需 `0.0.0.0:3090` |
| `UPSTREAM` | `http://127.0.0.1:3000` | new-api 地址 |
| `DASHCAM_DIR` | `./data/dashcam` | 采集产物根目录，必须可写 |
| `CAPTURE_PATHS` | 四个对话路径 | 采集哪些路径，其余请求直接放行不落盘 |
| `MAX_REQUEST_BYTES` / `MAX_RESPONSE_BYTES` | 128 MiB | 单次请求/响应落盘上限，超出截断 |
| `GZIP_THRESHOLD` | 64 KiB | 超过该字节数的产物压缩落盘；`0` 关闭 |
| `UPSTREAM_HEADER_TIMEOUT` | `300s` | 等待上游响应头的时限（不含 body） |
