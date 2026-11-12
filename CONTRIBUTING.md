# 贡献指南

## 环境准备

| 项 | 版本 |
|---|---|
| Node.js | ≥ 22（`package.json` 的 `engines` 强制） |
| pnpm | 10.34.5（`packageManager` 固定，`corepack enable` 即可） |
| PostgreSQL | 16 兼容，用于本地演示库 |

```bash
pnpm install
cp .env.example .env      # 填写 DATABASE_URL
```

**Windows 额外一步**：Next.js 16 的 Turbopack 无法解析 pnpm 默认 isolated 布局，需切换为 hoisted：

```bash
pnpm config set node-linker hoisted --location project
```

该设置写入本地 `.npmrc`，已被 `.gitignore` 排除。

## 常用命令

| 命令 | 用途 |
|---|---|
| `pnpm dev` | 开发服务器（3088） |
| `pnpm build` | 生产构建（先清空 `.next`） |
| `pnpm lint` / `pnpm typecheck` / `pnpm test` | 提交前必跑 |
| `pnpm clean` | 清空 `.next` |
| `pnpm release:pack` | 生成本地发布包（需先 build） |

没有真实 New API 库时，可用演示数据开发：

```bash
docker compose --profile demo up -d --build
# .env: DATABASE_URL=postgres://demo:demo@demo-db:5432/new_api_demo
```

## 提交规范

提交信息格式：`<type>(<scope>): <subject>`

- `type`：`feat` `fix` `docs` `refactor` `chore` `test`
- `scope` 可选，如 `api` `dashboard` `charts` `db` `seed`
- 主题用祈使句、不加句号；正文说明「为什么」而非「改了什么」

单一主分支 `main`，小步提交。请勿提交 `.env`、`node_modules/`、`.next/`、`.npmrc`、`dist/`、快照产物。

## 代码红线

1. **只读数据库**：不写入、不执行 DDL、不改 schema；所有查询必须参数化。
2. **依赖约束**：不引入 Redis、Python；缓存只用进程内 `lru-cache`（上限 1GB）。
3. **分层**：聚合在服务端（`src/server/queries`），前端只负责展示。
4. **方案先行**：涉及口径、契约、目录结构的变更，先改 `docs/方案.md` 并在 PR 中说明。
5. **schema 依赖**：新增查询引用新列时，同步更新 `src/server/schema.ts`、`src/server/schema-check.ts` 的 `REQUIRED_COLUMNS` 与 `docs/db-schema-notes.md`。

## 测试要求

- 新增或修改查询、服务、纯函数时，补充对应单测（`src/**/*.test.ts`）。
- 修改访问控制相关代码时，同步更新 `src/server/__tests__/security.test.ts`。
- 提交前本地跑通：`pnpm lint && pnpm typecheck && pnpm test && pnpm build`。

## Pull Request

1. Fork 后基于 `main` 建分支，命名如 `feat/inactive-users`、`fix/chart-colors`。
2. PR 描述写清：动机、改动范围、影响的接口或口径、验证方式（含截图）。
3. CI 必须通过（lint / typecheck / test / build 四项）。
4. 涉及数据库口径的改动，请附上验证 SQL 与结果。

## 发布

发布由维护者执行：更新 `CHANGELOG.md` 与 `package.json` 的 `version`，打 `v<version>` tag。Release 工作流会校验 tag 与版本一致，构建并上传 `tar.gz` 与校验和。

## 安全

漏洞请勿公开提 issue，走 [SECURITY.md](SECURITY.md) 的私密报告渠道。
