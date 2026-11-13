# 提示词与响应采集（audit-proxy）

New API 自身不保存请求的提示词与模型返回，看板无法做内容级追溯。本目录记录补齐该能力的背景、设计、部署与决策依据。

采集点不在看板进程内，也不在 New API 进程内，而是一个独立的前置代理：它把请求与响应原样落成本地文件，看板只读这些文件。

## 文档索引

| 文档 | 职责 |
|---|---|
| [01-background.md](01-background.md) | 问题成因、New API 日志能力与扩展点的核验结论、环境约束 |
| [02-design.md](02-design.md) | 架构、存储布局、索引格式、截断与容量、看板读取约定 |
| [03-deployment.md](03-deployment.md) | 构建、systemd / Docker 部署、nginx 接入、故障行为、回滚 |
| [04-decisions.md](04-decisions.md) | 关键取舍与否决方案的理由 |

组件自身的构建与运行说明同时保留在 [`audit-proxy/README.md`](../../audit-proxy/README.md)，面向运维；本目录面向设计与长期维护。

## 实现状态

| 能力 | 状态 | 位置 |
|---|---|---|
| 请求 / 响应透传（含 SSE） | 已实现 | `audit-proxy/main.go` |
| 白名单路径落盘、其余放行 | 已实现 | `audit-proxy/capture.go` |
| 截断、gzip、每日 NDJSON 索引 | 已实现 | `audit-proxy/capture.go` |
| systemd / Docker 部署配套 | 已实现 | `audit-proxy/` |
| 非容器发布流水线 | 已实现 | `.github/workflows/release-audit-proxy.yml` |
| nginx failover 配置 | 已给出配置，待生产验证 | 本文档 §3.5 |
| 看板读取侧（列表 / 详情 / 归一化） | 已实现 | `src/server/audit/`、`src/app/api/audit/` |
| 用户详情「会话」区块 | 已实现 | `src/app/(console)/users/[id]/audit-*.tsx` |
| 过期数据清理 | **未实现** | 规划见 [02-design.md](02-design.md) §6.3 |

## 一句话架构

```text
client ──► nginx ──┬──► audit-proxy:8090 ──► new-api:3000
                   │        └── data/audit/**（写）
                   └──► dashboard:3088 ─────────┘（只读）
```

代理不可用时，nginx 通过 `upstream backup` 回落直连 New API：只丢采集，不丢调用。
