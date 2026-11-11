/**
 * 抖音抓取结果 HTML（完全照 xhs-keyword-top10 的报告结构）
 *
 *   node gen_report_xhs_style.mjs [输出路径]
 *
 * 结构对应关系：
 *   小红书                      →  抖音
 *   笔记(视频/图文)              →  视频
 *   笔记赞 / 藏 / 评 / 转        →  视频赞 / 藏 / 评 / 转
 *   【原文 ↗】                   →  【视频 ↗】
 *   阈值 ≥50 赞（笔记 3-10万）   →  阈值 ≥X 赞（视频 X万）
 *   达标 N 条 / 复验 100%        →  达标 N 条 / 质量等级
 *   抓到 80 条评论 / 7 页        →  抓到 N 条 / M 页
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ruleFor, gradeQuality } from '../lib/quality.mjs';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve((process.env.DY_ROOT || process.cwd()));
const DATA_ROOT = process.env.DY_DATA_DIR || path.join(ROOT, 'dy_output');
const STAMP = new Date().toISOString().slice(0, 10).replace(/-/g, '');
const OUT = process.argv[2] || path.join(DATA_ROOT, `抖音抓取结果_小红书样式_${STAMP}.html`);

// ── 读视频级数据 + scraped 信息 ──
const idx = JSON.parse(fs.readFileSync(path.join(DATA_ROOT, 'index_all.json'), 'utf8'));

// 从原始 comments 文件补 pages / hasMore
const scrapedMap = new Map();
(function scan(d) {
  if (!fs.existsSync(d)) return;
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) { scan(p); continue; }
    const m = e.name.match(/^(\d{15,})\.json$/);
    if (!m) continue;
    try {
      const j = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (!scrapedMap.has(m[1])) scrapedMap.set(m[1], { scraped: j.scraped || {}, stat: j.stat || {} });
    } catch {}
  }
})(DATA_ROOT);

const videos = idx.videos.filter(v => v.fetchedComments > 0);

// ── 读评价明细 ──
function parseCsv(text) {
  const lines = text.replace(/^\ufeff/, '').split('\n').filter(Boolean);
  const head = lines[0].split(',');
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const o = []; let c = '', q = false;
    for (let j = 0; j < lines[i].length; j++) {
      const ch = lines[i][j];
      if (ch === '"') { if (q && lines[i][j + 1] === '"') { c += '"'; j++; } else q = !q; }
      else if (ch === ',' && !q) { o.push(c); c = ''; }
      else c += ch;
    }
    o.push(c);
    rows.push(Object.fromEntries(head.map((h, k) => [h, o[k] ?? ''])));
  }
  return rows;
}
const cmts = parseCsv(fs.readFileSync(path.join(DATA_ROOT, 'index_all_comments.csv'), 'utf8'));
const byVid = new Map();
for (const c of cmts) {
  if (!byVid.has(c['视频ID'])) byVid.set(c['视频ID'], []);
  byVid.get(c['视频ID']).push(c);
}

const esc = t => String(t ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const num = n => (+n || 0).toLocaleString();
const cn = n => {
  n = +n || 0;
  if (n >= 10000) return (n / 10000).toFixed(1).replace(/\.0$/, '') + '万';
  return String(n);
};

// ── 汇总 ──
const totalCmt = videos.reduce((s, v) => s + v.fetchedComments, 0);
let totalPass = 0;
for (const v of videos) {
  const th = ruleFor(v.digg).minLike;
  totalPass += (byVid.get(v.videoId) || []).filter(c => +c['评价点赞'] >= th).length;
}
const times = videos.map(v => v.capturedAt).filter(Boolean).sort();
const now = new Date().toLocaleString('zh-CN', { hour12: false });

// ── HTML ──
let h = '';
h += `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>抖音女装裤类 · 分层抓取 · 视频与高赞评价</title><style>
  * { box-sizing: border-box; }
  body { margin:0; padding:36px 22px 70px; background:#fff; color:#1a1a1a;
    font-family:-apple-system,"Segoe UI","Microsoft YaHei",sans-serif; font-size:14px; line-height:1.7; }
  .wrap { max-width:1160px; margin:0 auto; }
  h1 { font-size:24px; font-weight:600; margin:0 0 6px; }
  .sub { color:#666; font-size:13px; margin-bottom:22px; }
  .kpi { display:flex; gap:12px; flex-wrap:wrap; border:1px solid #1a1a1a; padding:14px 18px; margin-bottom:24px; }
  .kpi div { flex:1; min-width:110px; }
  .kpi .k { color:#666; font-size:12px; }
  .kpi .v { font-family:Consolas,monospace; font-size:18px; font-weight:600; }
  details.note { border-top:1px solid #d0d0d0; padding:12px 0; }
  details.note[open] { padding-bottom:18px; }
  summary { cursor:pointer; display:flex; align-items:center; gap:9px; list-style:none; flex-wrap:wrap; padding:4px 0; }
  summary::-webkit-details-marker { display:none; }
  summary::before { content:"▸"; color:#999; font-size:12px; }
  details[open] summary::before { content:"▾"; }
  .rank { font-family:Consolas,monospace; border:1px solid #1a1a1a; width:22px; height:22px;
    display:inline-flex; align-items:center; justify-content:center; font-size:12px; font-weight:600; }
  .ntype { font-size:11px; padding:0 6px; border:1px solid; }
  .ntype.v { border-color:#0a5d8c; color:#0a5d8c; }
  .ntitle { font-weight:600; font-size:14.5px; }
  .nmetric { color:#666; font-size:12.5px; font-family:Consolas,monospace; }
  .jump { font-size:11px; padding:0 8px; border:1px solid #0a5d8c; color:#0a5d8c;
    text-decoration:none; font-family:Consolas,monospace; white-space:nowrap; }
  .jump:hover { background:#0a5d8c; color:#fff; }
  .vbadge { font-size:11px; padding:0 7px; border:1px solid; margin-left:auto; font-family:Consolas,monospace; }
  .v-ok { color:#0a7d3c; border-color:#0a7d3c; }
  .v-mid { color:#b45309; border-color:#b45309; }
  .v-bad { color:#b91c1c; border-color:#b91c1c; }
  .empty { color:#999; font-size:12.5px; padding:14px 9px; }
  .meta { display:flex; gap:16px; flex-wrap:wrap; color:#666; font-size:12px;
    padding:8px 0 10px 30px; font-family:Consolas,monospace; }
  .meta .warn { color:#b45309; }
  .meta .cid { color:#bbb; margin-left:auto; }
  table { width:calc(100% - 30px); border-collapse:collapse; font-size:13px; margin-left:30px; }
  th { text-align:left; font-weight:600; color:#555; padding:7px 9px; border-bottom:1px solid #1a1a1a; white-space:nowrap; }
  td { padding:7px 9px; border-bottom:1px solid #ececec; vertical-align:top; }
  .num { font-family:Consolas,monospace; white-space:nowrap; }
  .b { font-weight:600; }
  .loc { color:#999; font-size:11px; margin-left:5px; }
  .foot { color:#666; font-size:12px; margin-top:26px; border-top:1px solid #e0e0e0; padding-top:12px; }
  .rule { border:1px solid #e0e0e0; padding:12px 16px; margin:0 0 24px; font-size:12.5px; }
  .rule b { font-family:Consolas,monospace; }
</style></head><body><div class="wrap">`;

h += `<h1>「抖音女装裤类」· 分层抓取 · 视频与高赞评价</h1>`;
h += `<div class="sub">生成时间 ${esc(now)}　·　抓取时间 ${esc((times[0] || '').slice(0, 19))} ~ ${esc((times[times.length - 1] || '').slice(0, 19))}　·　口径 分 6 档按视频点赞定评价门槛</div>`;

// KPI
h += `<div class="kpi">
<div><div class="k">视频数</div><div class="v">${videos.length}</div></div>
<div><div class="k">评价条数</div><div class="v">${num(totalCmt)}</div></div>
<div><div class="k">达标评价</div><div class="v">${num(totalPass)}</div></div>
<div><div class="k">达标率</div><div class="v">${(totalPass / totalCmt * 100).toFixed(1)}%</div></div>
<div><div class="k">分层档数</div><div class="v">6</div></div>
</div>`;

// 规则说明
h += `<div class="rule">分层阈值：${[
  ['<5千', 5], ['5千–1万', 10], ['1万–5万', 20], ['5万–10万', 50], ['10万–50万', 100], ['≥50万', 500],
].map(([k, v]) => `${k} <b>≥${v}</b>`).join('　·　')}</div>`;

// 视频列表
const sorted = [...videos].sort((a, b) => b.digg - a.digg);
sorted.forEach((v, i) => {
  const rule = ruleFor(v.digg);
  const list = (byVid.get(v.videoId) || []).slice().sort((a, b) => +b['评价点赞'] - +a['评价点赞']);
  const passed = list.filter(c => +c['评价点赞'] >= rule.minLike);
  const g = gradeQuality(passed.length);
  const gCls = g === '充足' ? 'v-ok' : g === '极弱' ? 'v-bad' : 'v-mid';
  const meta0 = scrapedMap.get(v.videoId) || {};
  const sc = meta0.scraped || {};
  const st = meta0.stat || {};
  const pages = sc.pages || 0;
  const hasMore = sc.hasMore;

  h += `<details class="note"><summary>
<span class="rank">${i + 1}</span>
<span class="ntype v">视频</span>
<span class="ntitle">${esc(v.author)}</span>
<span class="nmetric">${cn(v.digg)}赞 · 藏 ${st.collect == null ? '—' : cn(st.collect)} · 评 ${cn(v.comment)} · 转 ${st.share == null ? '—' : cn(st.share)}</span>
<a class="jump" href="https://www.douyin.com/video/${esc(v.videoId)}" target="_blank">视频 ↗</a>
<span class="vbadge ${gCls}">达标 ${passed.length} 条 · ${g}</span>
</summary>`;

  h += `<div class="meta">
<span>阈值 ≥${rule.minLike} 赞（视频 ${rule.label}）</span>
<span>抓到 ${list.length} 条评论${pages ? ` / ${pages} 页` : ''}</span>
<span>停止 ${hasMore === 0 ? 'reached_end（已抓完）' : (pages ? 'has_more（已取前 N 条）' : 'unknown')}</span>
<span>质量 ${g}</span>
<span class="cid">${esc(v.videoId)}</span>
</div>`;

  if (!passed.length) {
    h += `<div class="empty">该视频评论区没有 ≥${rule.minLike} 赞的评价（抓到 ${list.length} 条，最高 ${list.length ? num(list[0]['评价点赞']) : 0} 赞）</div>`;
  } else {
    h += `<table><thead><tr><th style="width:34px">#</th><th style="width:76px">赞</th>
<th style="width:72px">占赞比</th><th>评价内容</th><th style="width:120px">评价者</th>
<th style="width:82px">时间</th><th style="width:56px">子回复</th></tr></thead><tbody>`;
    for (const c of passed) {
      const pct = v.digg ? (+c['评价点赞'] / v.digg * 100).toFixed(3) + '%' : '—';
      h += `<tr><td class="num">${c['评价排名']}</td>
<td class="num b">${num(c['评价点赞'])}</td>
<td class="num">${pct}</td>
<td>${esc(c['评价内容'] || '')}</td>
<td>${esc(c['评价者'])}<span class="loc">${esc(c['地区'])}</span></td>
<td class="num">${esc(c['评价发布时间'])}</td>
<td class="num">${c['子回复数']}</td></tr>`;
    }
    h += `</tbody></table>`;
  }
  h += `</details>`;
});

h += `<div class="foot">
共 ${videos.length} 条视频 · ${num(totalCmt)} 条评价 · 达标 ${num(totalPass)} 条（${(totalPass / totalCmt * 100).toFixed(1)}%）<br>
评价为每条视频按点赞降序抓取的前 20 条一级评论（不足 20 条则全取），覆盖平台评论总量约 1.2%，非全量。<br>
抖音不公开播放量；「占赞比」= 单条评价点赞 ÷ 该视频点赞。
</div>`;

h += `</div></body></html>`;

fs.writeFileSync(OUT, h, 'utf8');
console.log(`[saved] ${OUT}`);
console.log(`  视频 ${videos.length} / 评价 ${totalCmt} / 达标 ${totalPass}`);
console.log(`  文件 ${(h.length / 1024).toFixed(0)} KB`);
