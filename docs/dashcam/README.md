# 提示词与响应采集（new-api-dashcam）

New API 自身不保存请求的提示词与模型返回，看板无法做内容级追溯。本目录记录补齐该能力的背景、设计、部署与决策依据。

采集点不在看板进程内，也不在 New API 进程内，而是一个独立的前置代理：它把请求与响应原样落成本地文件，看板只读这些文件。

## 文档索引

| 文档 | 职责 |
|---|---|
| [01-background.md](01-background.md) | 问题成因、New API 日志能力与扩展点的核验结论、环境约束 |
| [02-design.md](02-design.md) | 架构、存储布局、索引格式（含 token 字段）、截断与容量、看板读取约定 |
| [03-deployment.md](03-deployment.md) | 构建、systemd / Docker 部署、nginx 接入、故障行为、回滚 |
| [04-decisions.md](04-decisions.md) | 关键取舍与否决方案的理由（D1–D11） |
| [05-dashboard-plan.md](05-dashboard-plan.md) | 会话看板实施记录：偏差登记（D1–D6）、聚合与增量算法、翻页、token 链路、界面形态 |
| [06-performance-plan.md](06-performance-plan.md) | 采集性能与容量评估、风险证伪、改造专项决策（D-P1～D-P5）与实施设计（已裁决待实施） |

组件自身的构建与运行说明同时保留在 [`dashcam/README.md`](../../dashcam/README.md)，面向运维；本目录面向设计与长期维护。

## 实现状态

| 能力 | 状态 | 位置 |
|---|---|---|
| 请求 / 响应透传（含 SSE） | 已实现 | `dashcam/main.go` |
| 白名单路径落盘、其余放行 | 已实现 | `dashcam/capture.go` |
| 截断、gzip、每日 NDJSON 索引 | 已实现 | `dashcam/capture.go` |
| 会话键提取与会话聚合索引字段（`k`） | 已实现 | `dashcam/capture.go` |
| token 用量索引字段（`pt`/`ct`/`cc`/`cw`，D11） | 已实现（2026-11-14） | `dashcam/usage.go` |
| systemd / Docker 部署配套 | 已实现 | `dashcam/` |
| 非容器发布流水线 | 已实现 | `.github/workflows/release-dashcam.yml` |
| nginx failover 配置 | 已给出配置，待生产验证 | [03-deployment.md](03-deployment.md) §5 |
| 看板读取侧（列表 / 详情 / 归一化） | 已实现 | `src/server/dashcam/`、`src/app/api/dashcam/` |
| 会话聚合、线程增量、独立列表页 | 已实现 | `src/server/dashcam/thread.ts`、`src/app/(console)/users/[id]/sessions/` |
| token 用量展示（索引优先 + 读时水合兜底） | 已实现（2026-11-14） | `src/server/dashcam/usage.ts`、`src/components/dashcam/token-pair.tsx` |
| 用户详情「会话」区块 | 已实现 | `src/app/(console)/users/[id]/dashcam-*.tsx` |
| 过期数据清理 | **未实现** | 规划见 [02-design.md](02-design.md) §6.3、[06-performance-plan.md](06-performance-plan.md) §14 |
| 落盘异步化 + 资源围栏（D-P3） | **未实现（已裁决）** | 规划见 [06-performance-plan.md](06-performance-plan.md) §11 |
| 按调用方比例抽样（D-P2） | **未实现（已裁决）** | 规划见 [06-performance-plan.md](06-performance-plan.md) §12 |
| 段式打包（D-P5） | **未实现（已裁决）** | 规划见 [06-performance-plan.md](06-performance-plan.md) §13 |

## 一句话架构

```text
client ──► nginx ──┬──► new-api-dashcam:3090 ──► new-api:3000
                   │        └── data/dashcam/**（写）
                   └──► dashboard:3088 ─────────┘（只读）
```

代理不可用时，nginx 通过 `upstream backup` 回落直连 New API：只丢采集，不丢调用。
