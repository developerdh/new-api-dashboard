#!/usr/bin/env node
// validate-tasks.mjs — 任务体系只读一致性校验（无副作用，不写任何文件）
// 运行：仓库根 `node docs/tasks/validate-tasks.mjs`
// 分级（对应 docs/tasks/AGENTS.md「一致性校验」）：
//   ERROR（阻断，收尾必须清零）：
//     E1 卡标题编号=文件名、编号唯一；E2 前置任务存在（在办∪完成索引∪归档段）且在办无环；
//     E3 看板指针指向在办卡或「—」、current 卡状态 todo/in_progress；
//     E4 三方状态一致（看板表=卡头部=卡续作区）；E5 在办表与在办卡双向覆盖；
//     E6 续作区存在且状态为枚举值；E7 骨架文件存在；E8 在办文档 markdown 链接指向不存在文件（产出清单预告文件除外）。
//   WARN（提示，逐条知悉）：
//     W1 在办目录存在 done 卡；W2 在办文档引用归档域具体文档；W3 本机绝对路径；
//     W4 单行超 600 字符；W5 完成索引主文件超 60 行；W6 遗留表行缺来源任务；
//     W7 done 卡无变更记录行 / 无对应执行报告。
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname, basename, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const TASKS = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(TASKS, '..', '..');
const ID_RE = /^(?:BE|FE|INF)-M\d-\d{2}$|^LO-\d+$/;
const STATUS = ['todo', 'in_progress', 'done', 'blocked'];
const errors = [], warns = [];
const err = (f, m) => errors.push(`ERROR ${rel(f)}: ${m}`);
const warn = (f, m) => warns.push(`WARN  ${rel(f)}: ${m}`);
const rel = (p) => relative(ROOT, p).replaceAll('\\', '/');
const read = (p) => readFileSync(p, 'utf8');

// ---------- 卡与文档收集 ----------
const skeleton = ['AGENTS.md', 'README.md', '_template.md', 'FEEDBACK.md', 'BACKLOG.md', 'COMPLETED.md', 'validate-tasks.mjs', 'leftover/README.md'];
for (const f of skeleton) if (!existsSync(join(TASKS, f))) err(join(TASKS, f), 'E7 骨架文件缺失');

const cards = []; // {file, id, titleId, headerStatus, zoneStatus, prereqs, changeRows}
const msDirs = existsSync(TASKS) ? readdirSync(TASKS).filter((d) => /^m\d+$/.test(d) && statSync(join(TASKS, d)).isDirectory()) : [];
for (const dir of [...msDirs, 'leftover']) {
  const d = join(TASKS, dir);
  for (const f of existsSync(d) ? readdirSync(d) : []) {
    if (!f.endsWith('.md') || f === 'README.md') continue;
    if (!/^(?:BE|FE|INF)-M\d-\d{2}|LO-\d+/.test(f.replace(/\.md$/, ''))) { warn(join(d, f), '文件名不符合编号族，未纳入校验'); continue; }
    parseCard(join(d, f));
  }
}

function sectionBody(content, titlePrefix) {
  const lines = content.split(/\r?\n/);
  const out = [];
  let on = false;
  for (const l of lines) {
    if (/^## /.test(l)) { on = l.slice(3).startsWith(titlePrefix); if (on) continue; }
    if (on) out.push(l);
  }
  return out.join('\n');
}

function parseCard(file) {
  const c = read(file);
  const first = c.split(/\r?\n/)[0] ?? '';
  const m = first.match(/^# (\S+) · (.+)$/);
  const titleId = m ? m[1] : null;
  const idFromFile = basename(file, '.md');
  if (!m) err(file, 'E1 首行标题不符合 `# <编号> · <名称>`');
  if (titleId && titleId !== idFromFile) err(file, `E1 标题编号 ${titleId} 与文件名 ${idFromFile} 不一致`);
  if (!ID_RE.test(idFromFile)) err(file, 'E1 编号不符合编号族');
  const headerM = c.match(/状态：(todo|in_progress|done|blocked)/);
  const zone = sectionBody(c, '续作区');
  const zoneM = zone.match(/^- 状态：(todo|in_progress|done|blocked)/m);
  if (!zone.trim()) err(file, 'E6 缺「续作区」章节');
  if (zoneM && !STATUS.includes(zoneM[1])) err(file, `E6 续作区状态非法：${zoneM[1]}`);
  const prereqSec = sectionBody(c, '前置任务');
  const prereqs = [...new Set(prereqSec.match(/(?:BE|FE|INF)-M\d-\d{2}|LO-\d+/g) ?? [])];
  const changeSec = sectionBody(c, '变更记录');
  const changeRows = changeSec.split(/\r?\n/).filter((l) => l.trim().startsWith('|') && !/^\|\s*日期/.test(l) && !/^\|[-\s|]+$/.test(l) && l.split('|').slice(1, -1).some((x) => x.trim())).length;
  cards.push({ file, id: idFromFile, headerStatus: headerM?.[1] ?? null, zoneStatus: zoneM?.[1] ?? null, prereqs, changeRows, content: c });
  for (const [i, l] of c.split(/\r?\n/).entries()) if (l.length > 600) warn(file, `W4 第 ${i + 1} 行超 600 字符（噪声信号）`);
  if (/(?:^|[\s'"`(=[<])[A-Za-z]:[\\/]/.test(c)) warn(file, 'W3 疑似本机绝对路径');
  const archRef = c.match(/(?:archive|reports)\/[^\s`)<]*\.(?:md|html)/g);
  if (archRef) warn(file, `W2 在办文档引用归档域具体文档：${archRef.slice(0, 3).join(' ')}`);
}

// ---------- 完成索引与归档段编号 ----------
const completedIds = new Set(), doneDates = new Map();
function tableIds(file, set) {
  if (!existsSync(file)) return;
  let n = 0;
  for (const l of read(file).split(/\r?\n/)) {
    const cells = l.trim().split('|').map((s) => s.trim());
    if (cells.length >= 4 && ID_RE.test(cells[1] ?? '')) { set.add(cells[1]); n++; if (cells[4]) doneDates.set(cells[1], cells[4]); }
  }
  return n;
}
const mainCompletedFile = join(TASKS, 'COMPLETED.md');
const mainRows = tableIds(mainCompletedFile, completedIds) ?? 0;
if (mainRows > 60) warn(mainCompletedFile, `W5 完成索引主文件 ${mainRows} 行 >60（滚动归档信号）`);
const archiveDir = join(TASKS, 'archive');
if (existsSync(archiveDir)) for (const f of readdirSync(archiveDir)) if (/^COMPLETED-m\d+\.md$/.test(f)) tableIds(join(archiveDir, f), completedIds);

// ---------- 看板解析 ----------
const boardFile = join(TASKS, 'README.md');
const inBoard = new Map(); // id -> status（在办表行）
const boardDup = [];
const pointers = {};
const lhRows = [];
if (existsSync(boardFile)) {
  const b = read(boardFile);
  for (const l of b.split(/\r?\n/)) {
    const pm = l.match(/\|\s*`(current_task|next_task)`\s*\|\s*([^|]+)\|/);
    if (pm) pointers[pm[1]] = pm[2].trim();
    if (l.trim().startsWith('|')) {
      const cells = l.trim().split('|').map((s) => s.trim()).slice(1, -1);
      if (cells.length >= 6 && ID_RE.test(cells[0])) { if (inBoard.has(cells[0])) boardDup.push(cells[0]); inBoard.set(cells[0], cells[5]); }
      if (cells.length >= 5 && /^LH-\d+$/.test(cells[0] ?? '')) lhRows.push({ id: cells[0], source: cells[2], row: l });
    }
  }
  for (const [i, l] of b.split(/\r?\n/).entries()) if (l.length > 600) warn(boardFile, `W4 第 ${i + 1} 行超 600 字符`);
  for (const f of ['FEEDBACK.md', 'BACKLOG.md', mainCompletedFile]) if (existsSync(f)) for (const [i, l] of read(f).split(/\r?\n/).entries()) if (l.length > 600) warn(f, `W4 第 ${i + 1} 行超 600 字符`);
}
for (const id of boardDup) err(boardFile, `E1 在办表编号重复：${id}`);
for (const r of lhRows) if (!r.source) warn(boardFile, `W6 遗留表 ${r.id} 缺来源任务`);

// ---------- E1 唯一 ----------
const seen = new Map();
for (const c of cards) { if (seen.has(c.id)) err(c.file, `E1 编号重复（与 ${rel(seen.get(c.id))}）`); else seen.set(c.id, c.file); }
for (const c of cards) if (completedIds.has(c.id)) err(c.file, `E1 编号同时在在办与完成索引：${c.id}`);

// ---------- E2 前置存在 + 无环 ----------
const inIds = new Set(cards.map((c) => c.id));
const known = new Set([...inIds, ...completedIds]);
for (const c of cards) for (const p of c.prereqs) {
  if (!known.has(p)) err(c.file, `E2 前置任务不存在：${p}`);
  if (p === c.id) err(c.file, `E2 前置含自身：${p}`);
}
{
  const edges = new Map(cards.map((c) => [c.id, c.prereqs.filter((p) => inIds.has(p))]));
  const state = new Map();
  const stack = [];
  const cyc = (id) => {
    if (state.get(id) === 1) { const i = stack.indexOf(id); err(join(TASKS), `E2 在办前置成环：${[...stack.slice(i), id].join(' → ')}`); return; }
    if (state.get(id) === 2) return;
    state.set(id, 1); stack.push(id);
    for (const n of edges.get(id) ?? []) cyc(n);
    stack.pop(); state.set(id, 2);
  };
  for (const id of edges.keys()) cyc(id);
}

// ---------- E3 指针 ----------
const norm = (v) => (v ?? '').match(/(?:BE|FE|INF)-M\d-\d{2}|LO-\d+/)?.[0] ?? ((v ?? '').includes('—') ? null : (v ?? null));
const cur = norm(pointers.current_task), nxt = norm(pointers.next_task);
if (!pointers.current_task) err(boardFile, 'E3 看板缺 current_task 指针');
for (const [k, v] of [['current_task', cur], ['next_task', nxt]]) {
  if (v !== null && !inIds.has(v)) err(boardFile, `E3 ${k} 指向不在办卡或「—」：${pointers[k]}`);
}
if (cur && inIds.has(cur)) {
  const card = cards.find((c) => c.id === cur);
  if (!['todo', 'in_progress'].includes(card?.zoneStatus ?? '')) err(boardFile, `E3 current 卡状态非 todo/in_progress：${cur}`);
}

// ---------- E4 三方一致 + E5 双向覆盖 ----------
for (const c of cards) {
  const bs = inBoard.get(c.id);
  if (bs === undefined) err(c.file, 'E5 卡存在但看板在办表无行');
  else if (bs !== c.headerStatus || bs !== c.zoneStatus) err(c.file, `E4 状态不一致：看板=${bs} 头部=${c.headerStatus} 续作区=${c.zoneStatus}`);
  if (!c.headerStatus) err(c.file, 'E6 头部缺合法状态行');
  if (c.zoneStatus && !STATUS.includes(c.zoneStatus)) err(c.file, `E6 续作区状态非法：${c.zoneStatus}`);
  if (c.zoneStatus === 'done') {
    warn(c.file, 'W1 在办目录存在 done 卡（应归档）');
    if (c.changeRows < 1) warn(c.file, 'W7 done 卡无变更记录行');
    if (!existsSync(join(TASKS, 'reports')) || !readdirSync(join(TASKS, 'reports')).some((f) => f.startsWith(`${c.id}-执行报告-`))) warn(c.file, `W7 done 卡缺执行报告：reports/${c.id}-执行报告-*.md`);
  }
}
for (const id of inBoard.keys()) if (!inIds.has(id)) err(boardFile, `E5 在办表行无对应卡：${id}`);

// ---------- E8 陈旧引用（markdown 链接）----------
const planned = new Set();
for (const c of cards.filter((x) => x.zoneStatus !== 'done')) for (const tok of sectionBody(c.content, '产出文件清单').match(/`([^`]+)`/g) ?? []) planned.add(tok.replaceAll('`', ''));
for (const f of [...cards.map((c) => c.file), boardFile, ...['FEEDBACK.md', 'BACKLOG.md', mainCompletedFile].map((x) => join(TASKS, x))]) {
  if (!existsSync(f)) continue;
  for (const mm of read(f).matchAll(/\[([^\]]*)\]\(([^)\s]+)\)/g)) {
    const h = mm[2];
    if (/^(https?:|#|mailto:)/.test(h) || h.includes('<') || h.includes('{')) continue;
    const target = resolve(dirname(f), decodeURIComponent(h.split('#')[0]));
    if (!existsSync(target) && !planned.has(h)) err(f, `E8 链接指向不存在文件：${h}`);
  }
}

// ---------- 输出 ----------
for (const l of errors) console.log(l);
for (const l of warns) console.log(l);
console.log(`校验完成：${errors.length} ERROR，${warns.length} WARN（在办卡 ${cards.length} 张，看板行 ${inBoard.size}，完成索引 ${completedIds.size}）`);
process.exit(errors.length ? 1 : 0);
