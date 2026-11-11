/**
 * 方案自检：检查「流程方案」与「实际代码」是否一致
 *
 *   node audit_scheme.mjs
 *
 * 检查维度：
 *   1. 核心脚本完整性 —— 方案里列的脚本是否都存在
 *   2. 参数一致性     —— 各脚本同类参数默认值是否冲突
 *   3. 调用链完整性   —— 谁调谁，被调方是否存在
 *   4. 废弃脚本阻断   —— 是否仍会误用
 *   5. 路径可移植性   —— 是否还有未解耦的硬编码
 *   6. 库导出完整性   —— lib 里的函数是否被正确引用
 *   7. 产出路径规范   —— 报告是否散落根目录
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(process.env.DY_ROOT || process.cwd());

const results = [];
const add = (level, name, detail) => results.push({ level, name, detail });
const P = 'PASS', W = 'WARN', F = 'FAIL';

const read = f => { try { return fs.readFileSync(resolveP(f), 'utf8'); } catch { return null; } };
const LIBDIR = path.join(__dir, '..', 'lib');
const resolveP = f => f.startsWith('lib/') ? path.join(LIBDIR, f.slice(4)) : path.join(__dir, f);
const exists = f => fs.existsSync(resolveP(f));

console.log('='.repeat(72));
console.log('抖音抓取流程 · 方案自检');
console.log('='.repeat(72));

// ── 1. 核心脚本完整性 ──
const CORE = {
  'dy_scrape.mjs': '底层抓取（视频详情 + 评论翻页）',
  'dy_top.mjs': '单视频 TOP N 评论 + 深度判定 + 复检',
  'dy_account.mjs': '达人主页（资料 + 作品列表 + 每条指标）',
  'dy_search.mjs': '关键词搜索',
  'dy_pipeline.mjs': '端到端（keyword / hot）',
  'dy_tiered_scrape.mjs': '分层抽样抓取',
  'dy_build_library.mjs': '按词批量建库',
  'dy_find_hot.mjs': '首页推荐流取链接',
  'lib/platform.mjs': '唯一平台判断',
  'lib/paths.mjs': '路径解析',
  'lib/cdp.mjs': 'CDP 协议 + 响应嗅探',
  'lib/chrome.mjs': '浏览器生命周期 + profile 治理',
  'lib/depth_judge.mjs': '深度判定纯函数',
  'lib/quality.mjs': '6 档阈值 + 质量分级',
  'lib/test_depth_judge.mjs': '判定逻辑单元测试',
  'gen_report_xhs_style.mjs': '报告（小红书样式）',
  'gen_result_html.mjs': '报告（分组样式）',
  'gen_result_xlsx.py': 'Excel 多表',
  'gen_ledger.py': '追加式台账',
  'dy_rebuild_index.mjs': '总索引重建',
  'dy_range_stats.mjs': '区间统计',
  'healthcheck.mjs': '环境自检',
  'smoke.mjs': '视频/评论/达人三类验收',
};
const missing = Object.keys(CORE).filter(f => !exists(f));
if (missing.length) add(F, '核心脚本完整性', `缺失：${missing.join(', ')}`);
else add(P, '核心脚本完整性', `${Object.keys(CORE).length} 个核心脚本齐全`);

// ── 2. 参数一致性 ──
const nDefaults = {};
for (const f of ['dy_top.mjs', 'dy_pipeline.mjs', 'dy_tiered_scrape.mjs', 'dy_build_library.mjs']) {
  const s = read(f);
  if (!s) continue;
  const m = s.match(/(?:let N = |let PER = |N = |PER = )(\d+)/) || s.match(/PER = parseInt\(argv\[\+\+i\], 10\) \|\| (\d+)/);
  if (m) nDefaults[f] = +m[1];
}
const nVals = [...new Set(Object.values(nDefaults))];
if (nVals.length === 1) add(P, '--n 默认值一致', `统一 ${nVals[0]}（${Object.keys(nDefaults).length} 个脚本）`);
else add(W, '--n 默认值不一致', Object.entries(nDefaults).map(([k, v]) => `${k}=${v}`).join(' '));

// 页数默认
const topSrc = read('dy_top.mjs') || '';
if (/MAX_PAGES_PER_RUN = 20/.test(topSrc)) add(P, '页数上限', 'dy_top 固定 20 页');
else add(W, '页数上限', '未找到 MAX_PAGES_PER_RUN = 20');

// ── 3. 调用链完整性 ──
const CALLERS = ['dy_pipeline.mjs', 'dy_tiered_scrape.mjs', 'dy_build_library.mjs', 'dy_search_batch.mjs', 'dy_top.mjs'];
const broken = [];
for (const f of CALLERS) {
  const s = read(f);
  if (!s) continue;
  const callees = [...s.matchAll(/['"](dy_[a-z_]+\.mjs|gen_[a-z_]+\.mjs)['"]/g)].map(m => m[1]);
  for (const c of new Set(callees)) if (!exists(c)) broken.push(`${f} → ${c}`);
}
if (broken.length) add(F, '调用链完整性', `断链：${broken.join('; ')}`);
else add(P, '调用链完整性', `${CALLERS.length} 个调用方的下游脚本都存在`);

// ── 4. 废弃脚本阻断 ──
for (const dead of ['dy_top_comments.mjs', 'dy_find_big.mjs']) {
  if (!exists(dead)) continue;
  const s = read(dead);
  if (/DY_ALLOW_DEPRECATED/.test(s)) add(P, `废弃阻断 ${dead}`, '已加运行时拦截');
  else add(F, `废弃阻断 ${dead}`, '未加拦截，存在误用风险');
}

// ── 5. 路径可移植性 ──
const allScripts = fs.readdirSync(__dir).filter(f => f.endsWith('.mjs'));
const hardcoded = [];
for (const f of allScripts) {
  const s = read(f);
  if (!s) continue;
  // 未包 DY_ROOT 的 ../../ 硬编码
  const matches = [...s.matchAll(/path\.join\(__dir, '\.\.', '\.\.'[^)]*\)/g)];
  for (const m of matches) {
    // 前面 60 字符内含 DY_ROOT 说明已被环境变量包裹，不算硬编码
    const before = s.slice(Math.max(0, m.index - 60), m.index);
    if (!/DY_ROOT/.test(before) && !/DY_ROOT/.test(m[0])) hardcoded.push(`${f}: ${m[0].slice(0, 50)}`);
  }
}
if (hardcoded.length) add(W, '路径可移植性', `${hardcoded.length} 处未解耦：${hardcoded.slice(0, 3).join(' | ')}`);
else add(P, '路径可移植性', '全部支持 DY_ROOT 覆盖');

// ── 6. 库导出被引用 ──
for (const [lib, fns] of [['lib/depth_judge.mjs', ['judgeDepth']], ['lib/quality.mjs', ['ruleFor', 'gradeQuality']]]) {
  const refs = allScripts.filter(f => {
    const s = read(f);
    return s && s.includes(lib.replace('lib/', './lib/')) && s !== read(lib);
  });
  if (refs.length) add(P, `${lib} 被引用`, `${refs.length} 个脚本：${refs.slice(0, 4).join(', ')}`);
  else add(W, `${lib} 被引用`, '无脚本引用（可能是死代码）');
}

// ── 7. 产出路径 ──
const rootFiles = fs.readdirSync(ROOT).filter(f => /\.(html|xlsx)$/.test(f));
const today = rootFiles.filter(f => /2026110[89]/.test(f));
if (rootFiles.length > 30) add(W, '产出路径', `根目录有 ${rootFiles.length} 个 html/xlsx（建议统一到 reports/）`);
else add(P, '产出路径', `根目录 ${rootFiles.length} 个产物`);

// ── 8. 脚本说明规范（首行是否为命令用法）──
let undocumented = 0;
for (const f of allScripts) {
  const s = read(f);
  if (!s) continue;
  if (!/^\s*\/\*\*/.test(s)) undocumented++;
}
if (undocumented > 5) add(W, '脚本说明规范', `${undocumented}/${allScripts.length} 个脚本缺文件头注释`);
else add(P, '脚本说明规范', `${allScripts.length - undocumented}/${allScripts.length} 有文件头`);

// ── 输出 ──
console.log('');
for (const r of results) {
  const icon = r.level === P ? '✅' : r.level === W ? '⚠️ ' : '❌';
  console.log(`${icon} ${r.name}  —  ${r.detail}`);
}
const f = results.filter(r => r.level === F).length;
const w = results.filter(r => r.level === W).length;
console.log('');
console.log('='.repeat(72));
console.log(`结果：通过 ${results.length - f - w} / 警告 ${w} / 失败 ${f}`);
if (f) {
  console.log('\n失败项（必须修）：');
  results.filter(r => r.level === F).forEach(r => console.log('  · ' + r.name + '：' + r.detail));
}
if (w) {
  console.log('\n警告项（建议修）：');
  results.filter(r => r.level === W).forEach(r => console.log('  · ' + r.name + '：' + r.detail));
}
console.log('='.repeat(72));
process.exit(f ? 4 : w ? 3 : 0);
