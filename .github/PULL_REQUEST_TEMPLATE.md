## 动机

<!-- 为什么要做这个改动？解决什么问题？ -->

## 改动内容

<!-- 逐条列出。涉及接口/口径变化时明确说明 -->

## 影响范围

- [ ] 统计口径（`docs/方案.md`）
- [ ] 数据库 schema 依赖（`src/server/schema.ts`、`schema-check.ts`、`docs/db-schema-notes.md`）
- [ ] 接口契约
- [ ] 访问控制
- [ ] 仅前端样式 / 文档

## 验证方式

<!-- 跑过的命令与结果；前端改动附截图 -->

```
pnpm lint && pnpm typecheck && pnpm test && pnpm build
```

## 自检

- [ ] 未提交 `.env`、`.next/`、`dist/`、快照产物
- [ ] 新增/修改的查询与服务有对应单测
- [ ] 涉及口径变更时已更新 `docs/方案.md` 与 `docs/db-schema-notes.md`
- [ ] 无硬编码凭据、内网地址或真实用户数据
