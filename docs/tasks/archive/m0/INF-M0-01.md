# INF-M0-01 · 项目骨架初始化（Next.js+TS+Tailwind+shadcn/ui+Tremor+ECharts）

> 里程碑：M0 · 基础与脚手架 ｜ 类型：新增 ｜ 预估：1 人日 ｜ 复杂度：M ｜ 状态：done

## 目标
仓库内建成可 `pnpm dev` 启动的全栈骨架：Next.js App Router + TypeScript + Tailwind + shadcn/ui + Tremor + ECharts，目录结构符合方案 §10，`pnpm build`/`pnpm lint` 通过。

## 输入/必读文档
- [ ] `docs/方案.md` §1（技术栈表）、§10（项目结构）、§7.3（界面风格路线）
- [ ] 根 `AGENTS.md`（环境与命令 / git 约定，指针）
- [ ] `docs/tasks/README.md` §3（当前指针）

## 本任务关键口径摘要
- 包管理器 pnpm；Node ≥ 20。Next.js App Router，`src/` 目录，TypeScript strict。
- 依赖清单（方案 §1）：tailwindcss、shadcn/ui（初始化 + button/card/tabs/select/dialog/table/dropdown 基础件）、`@tremor/react`、`echarts`、`pg`、`kysely`、`zod`、`lru-cache`。Playwright 不在本卡装（BE-M3-03 按需引入）。
- 目录骨架按方案 §10 预建空模块：`src/app/{dashboard,users/[id],models,api}`、`src/server/{queries,services}`、`src/components/{charts,cards}`、`src/lib`、`src/types`、`scripts/`。
- `.env.example` 三变量：`DATABASE_URL`、`TZ=Asia/Shanghai`、`DASHBOARD_BASE_URL`（方案 §2.1/§11.1）；另加本体系占位 `ADMIN_TOKEN=`（BE-M0-04 定义用途）。
- 明暗主题 CSS 变量基础可先落 `globals.css`（完整切换逻辑归 FE-M2-01）。
- 图表封装不用第三方 React 包装库，直接 `echarts` + 自建 hook（减少依赖面）。

## 起点代码基线
仓库根仅：`docs/方案.md`、`AGENTS.md`、`README.md`、`.gitignore`、`docs/tasks/`（git 已初始化）。

## 承接点 · 遗留事项
无。

## 产出文件清单
- 新增：`package.json`、`pnpm-lock.yaml`、`pnpm-workspace.yaml`、`tsconfig.json`、`next.config.ts`、`eslint.config.mjs`、`.npmrc`、`components.json`、`vitest.config.mts`、`.env.example`、`src/**`（骨架目录 + layout/page/globals.css + `components/ui` 七个基础件 + `components/cards`、`server/{db,cache}` 占位）、`scripts/`
- 说明：Next 16 不再产出 `postcss.config.mjs`（Tailwind v4 经 `@tailwindcss/turbopack` loader 接入，见变更记录）
- 修改：根 `AGENTS.md`「环境与命令」节按实测命令校正；`README.md`「快速开始」节更新
- 占位路由：`/`（重定向到 `/dashboard`）、`/dashboard`、`/users/[id]`、`/models` 各放最小占位页

## 前置任务
无

## 实现阶段（检查点粒度）
- [x] 阶段 1：`pnpm dlx create-next-app@latest . --typescript --tailwind --eslint --app --src-dir`（TS strict）→ Next 16.4.0 / React 19.3.0 / Tailwind 4.3.3
- [x] 阶段 2：shadcn/ui init + 基础交互组件导入 → 环境无外网，`components.json` 手工落地 + 七个基础件源码手落（button/card/tabs/select/dialog/table/dropdown-menu）
- [x] 阶段 3：安装 `@tremor/react`、`echarts`、`pg`、`kysely`、`zod`、`lru-cache`（另 vitest + shadcn 依赖）
- [x] 阶段 4：按方案 §10 建目录骨架与占位路由页
- [x] 阶段 5：`.env.example` + npm scripts（dev/build/lint/typecheck/test，测试框架 vitest 随本卡接入 devDependency）
- [x] 阶段 6：`pnpm build`/`pnpm lint`/`pnpm dev` 三命令实测，回写根 `AGENTS.md` 与 `README.md`，走收尾

## 接口/契约变更
无（不涉及 `docs/方案.md` §4 API；vitest 作为 devDependency 属实现细节选型，不动方案技术栈表）。

## 验收标准（含验证命令）
- [x] `pnpm build`、`pnpm lint` 通过（build exit 0，7/7 路由；lint exit 0；另 `pnpm typecheck`、`pnpm test` 通过）
- [x] `pnpm dev` 启动，`/` 跳转 `/dashboard` 显示占位页（行为判据：HTTP 200 + 页面标题）→ `/`、`/dashboard`、`/models`、`/users/1` 均 200 且标题正确
- [x] `package.json` 依赖覆盖方案 §1 清单（除 Playwright）；目录树与方案 §10 一致
- [x] 联调点：无

## 收尾动作 checklist（完成时逐项执行）
1. 代码 + 构建通过（命令见验收标准）
2. 变更记录 + 续作区同步（done；断点备注清空或收敛进变更记录）
3. 遗留登记：承接上游遗留闭合（看板遗留表删行）；本任务向前产出 → 看板遗留表 open + 受影响卡承接点
4. 回流：需改 `docs/方案.md` → 对话中输出《回流说明》交用户决策，变更记录留一行结论
5. 写执行报告 `reports/INF-M0-01-执行报告-<日期>.md`（终点文档，他文不引用）
6. 归档：本卡移入 `archive/m0/`；`COMPLETED.md` 登记一行
7. 滚动归档检查（M0 段是否满足收口条件）
8. 同步看板：指针推进；在办表移除本行；遗留表同步
9. `node docs/tasks/validate-tasks.mjs` ERROR 清零

## 风险/阻塞
- Tremor 仍为 beta 版本，与 React 19/Next 15 可能存在 peer 依赖冲突：优先最新 `@tremor/react`，冲突时以 pnpm overrides 解决并在本卡变更记录留一行结论；不可用 Tailwind v3 回退除非 v4 集成受阻（受阻属口径偏差，评估后按回流处理）。
- create-next-app 需联网拉模板；离线环境先暂停并在续作区置 blocked。

---

## 续作区（检查点更新：开始/中断/完成各写一次）

> 覆盖式更新：只保留当前断点，旧断点收敛进变更记录，不堆叠时间线。

- 阶段进度：完成（6/6）
- 断点备注：无（遗留与承接点见变更记录、看板遗留表）
- 状态：done
- 更新时间：2026-10-09

## 变更记录
| 日期 | 变更 | 说明 |
|---|---|---|
| 2026-10-08 | 建卡 | 按方案 §1/§10/§12 路线图第 3 步拆解立项 |
| 2026-10-09 | 骨架落地 | Next 16.4.0（TS strict/App Router/src）+ shadcn/ui 基础件 + Tremor/ECharts/pg/Kysely/Zod/lru-cache/vitest 在位；`pnpm build`/`lint`/`typecheck`/`test` 与 `/`→`/dashboard` 跳转实测通过 |
| 2026-10-09 | 环境口径 | Next 16 不产出 `postcss.config.mjs`（Tailwind v4 经 `@tailwindcss/turbopack` loader）；无外网环境用 `next/font/google` 会阻断构建，改用系统字体栈 |
| 2026-10-09 | 依赖冲突结论 | `@tremor/react` 3.18.7 peer 声明 `react ^18`，以 `pnpm.peerDependencyRules.allowedVersions` 放行 React 19（`pnpm.overrides` 无法改写 peer 范围），未回退 React/Tailwind 版本 |
| 2026-10-09 | 安装布局 | Turbopack 无法解析 pnpm 默认 isolated 布局的 junction（`Could not find the Next.js package`），固定 `.npmrc` `node-linker=hoisted` |
| 2026-10-09 | 遗留 → LH-01 | `@tremor/react` 的 `tremor-*`/`dark-tremor-*` 主题 token 需在 Tailwind v4 下用 `@theme` 映射，交 FE-M2-01（承接点已登记） |
| 2026-10-09 | 遗留/回流 → LH-02 | 方案 §8.1 的 `chart.exportToHTML` 经核验不存在于 echarts 5.6/6.1（可用 `renderToSVGString`/`getDataURL`），待回流审批，交 FE-M3-02（承接点已登记） |

## 红线

机制红线见本目录 `AGENTS.md`；仓库级红线（只读数据库、不改 `docs/方案.md`、敏感配置）见根 `AGENTS.md`。
