/**
 * 生成抖音抓取结果 HTML 报告（与 Excel 同口径）
 *
 *   node gen_result_html.mjs [输出路径]
 *
 * 数据：data/douyin/index_all.json + index_all_comments.csv
 * 规则：6 档分层阈值（见 lib/quality.mjs）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ruleFor, gradeQuality, GRADE_ADVICE } from '../lib/quality.mjs';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve((process.env.DY_ROOT || process.cwd()));
const DATA_ROOT = process.env.DY_DATA_DIR || path.join(ROOT, 'dy_output');
const IDX = path.join(DATA_ROOT, 'index_all.json');
const CMT = path.join(DATA_ROOT, 'index_all_comments.csv');
const STAMP = new Date().toISOString().slice(0, 10).replace(/-/g, '');
const OUT = process.argv[2] || path.join(DATA_ROOT, `抖音抓取结果_视频与评价_${STAMP}.html`);

// ── 读数据 ──
const idx = JSON.parse(fs.readFileSync(IDX, 'utf8'));
const videos = idx.videos.filter(v => v.fetchedComments > 0);

function parseCsv(text) {
  const lines = text.replace(/^\ufeff/, '').split('\n').filter(Boolean);
  const head = lines[0].split(',');
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const out = []; let c = '', q = false;
    for (let j = 0; j < lines[i].length; j++) {
      const ch = lines[i][j];
      if (ch === '"') { if (q && lines[i][j + 1] === '"') { c += '"'; j++; } else q = !q; }
      else if (ch === ',' && !q) { out.push(c); c = ''; }
      else c += ch;
    }
    out.push(c);
    rows.push(out);
  }
  return rows.map(r => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ''])));
}

const cmts = parseCsv(fs.readFileSync(CMT, 'utf8'));
const byVid = new Map();
for (const c of cmts) {
  if (!byVid.has(c['视频ID'])) byVid.set(c['视频ID'], []);
  byVid.get(c['视频ID']).push(c);
}

const esc = t => String(t ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// ── 聚合 ──
const totalCmt = videos.reduce((s, v) => s + v.fetchedComments, 0);
let totalPass = 0;
const tiers = new Map();
for (const v of videos) {
  const rule = ruleFor(v.digg);
  const list = byVid.get(v.videoId) || [];
  const passed = list.filter(c => +c['评价点赞'] >= rule.minLike);
  totalPass += passed.length;
  const k = rule.label;
  if (!tiers.has(k)) tiers.set(k, { rule, videos: [], cmts: 0, passed: 0, withPass: 0, maxLike: 0 });
  const t = tiers.get(k);
  t.videos.push(v);
  t.cmts += list.length;
  t.passed += passed.length;
  if (passed.length) t.withPass++;
  t.maxLike = Math.max(t.maxLike, ...list.map(c => +c['评价点赞']), 0);
}

const order = ['<5千', '5千-1万', '1万-5万', '5万-10万', '10万-50万', '≥50万'];
const t0 = (videos.map(v => v.capturedAt).filter(Boolean).sort()[0] || '').slice(0, 19);
const t1 = (videos.map(v => v.capturedAt).filter(Boolean).sort().pop() || '').slice(0, 19);

// ── 生成 HTML ──
let h = '';
h += `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>抖音抓取结果 · 视频与评价</title><style>
*{box-sizing:border-box}
body{margin:0;padding:36px 22px 90px;background:#fff;color:#1a1a1a;font-family:-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;font-size:13px;line-height:1.7}
.w{max-width:1220px;margin:0 auto}
h1{font-size:23px;font-weight:600;margin:0 0 6px}
.sub{color:#666;font-size:12px;margin-bottom:24px}
h2{font-size:15px;font-weight:600;margin:34px 0 10px;padding-left:9px;border-left:3px solid #1a1a1a}
table{width:100%;border-collapse:collapse;margin:4px 0 10px}
th{text-align:left;font-weight:600;color:#555;padding:8px 9px;border-bottom:1px solid #1a1a1a;white-space:nowrap;font-size:12px}
td{padding:7px 9px;border-bottom:1px solid #e8e8e8;vertical-align:top}
tr:last-child td{border-bottom:1px solid #d0d0d0}
.n{font-family:Consolas,monospace;text-align:right}
.ok{color:#0a7d3c;font-weight:600}
.warn{color:#b45309;font-weight:600}
.bad{color:#b91c1c;font-weight:600}
.stats{display:flex;gap:30px;flex-wrap:wrap;margin:12px 0 20px;font-size:12px}
.stats div span{display:block;font-family:Consolas,monospace;font-size:20px;font-weight:600;margin-top:2px}
details{border:1px solid #e5e5e5;margin:6px 0;padding:0}
details[open]{border-color:#1a1a1a}
summary{padding:9px 12px;cursor:pointer;font-size:12.5px;list-style:none;display:flex;gap:10px;align-items:center;flex-wrap:wrap}
summary::-webkit-details-marker{display:none}
summary:hover{background:#fafafa}
summary .idx{font-family:Consolas,monospace;color:#888;min-width:32px}
summary .author{font-weight:600;min-width:110px}
summary .meta{color:#666;font-family:Consolas,monospace;font-size:11.5px}
.badge{font-size:11px;padding:1px 6px;border:1px solid #ccc;border-radius:2px;color:#666}
.badge.g1{border-color:#0a7d3c;color:#0a7d3c}
.badge.g2{border-color:#0b5cad;color:#0b5cad}
.badge.g3{border-color:#b45309;color:#b45309}
.badge.g4{border-color:#b91c1c;color:#b91c1c}
.inner{padding:0 12px 12px}
.inner table{margin:0}
.note{color:#888;font-size:11px;margin-top:6px}
.tierbar{font-family:Consolas,monospace;font-size:11px}
</style></head><body><div class="w">`;

h += `<h1>抖音抓取结果 · 视频与评价</h1>`;
h += `<div class="sub">抓取时间 ${esc(t0)} ~ ${esc(t1)}　|　分层阈值规则：6 档（按视频点赞定单条评价门槛）</div>`;

// 概览
h += `<div class="stats">
<div>视频数<span>${videos.length}</span></div>
<div>评价总数<span>${totalCmt.toLocaleString()}</span></div>
<div>达标评价<span>${totalPass.toLocaleString()}</span></div>
<div>达标率<span>${(totalPass / totalCmt * 100).toFixed(1)}%</span></div>
<div>平均每视频评价<span>${(totalCmt / videos.length).toFixed(1)}</span></div>
</div>`;
h += `<div class="note">评价为每条视频按点赞降序抓取的前 20 条一级评论（不足 20 条则全取）；覆盖平台评论总量约 1.2%。抖音不公开播放量。</div>`;

// 分层汇总
h += `<h2>一、分层汇总</h2><table><thead><tr>
<th>视频层次</th><th>评价阈值</th><th class="n">视频数</th><th class="n">评价数</th>
<th class="n">达标条数</th><th class="n">达标率</th><th class="n">有达标视频</th><th class="n">最高评价赞</th>
</tr></thead><tbody>`;
for (const k of order) {
  const t = tiers.get(k);
  if (!t) continue;
  h += `<tr>
<td><b>${k}</b></td><td>≥${t.rule.minLike}</td>
<td class="n">${t.videos.length}</td><td class="n">${t.cmts}</td>
<td class="n">${t.passed}</td>
<td class="n">${(t.passed / t.cmts * 100).toFixed(1)}%</td>
<td class="n">${t.withPass}/${t.videos.length}</td>
<td class="n">${t.maxLike.toLocaleString()}</td></tr>`;
}
h += `<tr><td><b>合计</b></td><td>—</td><td class="n"><b>${videos.length}</b></td>
<td class="n"><b>${totalCmt.toLocaleString()}</b></td><td class="n"><b>${totalPass}</b></td>
<td class="n"><b>${(totalPass / totalCmt * 100).toFixed(1)}%</b></td><td class="n">—</td><td class="n">—</td></tr>`;
h += `</tbody></table>`;

// 分层说明
h += `<h2>二、规则说明</h2><table><thead><tr><th>视频层次</th><th>单条评价最低点赞</th><th>含义</th></tr></thead><tbody>`;
const meanings = {
  '<5千': '视频热度低，评价 5 赞即视为有效',
  '5千-1万': '起步区间，门槛 10 赞',
  '1万-5万': '主力区间，门槛 20 赞',
  '5万-10万': '中高热度，门槛 50 赞',
  '10万-50万': '爆款区间，门槛 100 赞',
  '≥50万': '头部爆款，门槛 500 赞',
};
for (const k of order) {
  const t = tiers.get(k);
  if (!t) continue;
  h += `<tr><td><b>${k}</b></td><td class="n">≥ ${t.rule.minLike}</td><td>${meanings[k] || ''}</td></tr>`;
}
h += `</tbody></table>`;

// 视频明细
h += `<h2>三、视频明细（按视频点赞降序，点击展开评价）</h2>`;
const sorted = [...videos].sort((a, b) => b.digg - a.digg);
sorted.forEach((v, i) => {
  const rule = ruleFor(v.digg);
  const list = (byVid.get(v.videoId) || []).slice().sort((a, b) => +b['评价点赞'] - +a['评价点赞']);
  const passed = list.filter(c => +c['评价点赞'] >= rule.minLike);
  const g = gradeQuality(passed.length);
  const gCls = { 充足: 'g1', 一般: 'g2', 偏弱: 'g3', 极弱: 'g4' }[g];
  h += `<details><summary>
<span class="idx">${i + 1}</span>
<span class="author">${esc(v.author)}</span>
<span class="meta">${v.digg.toLocaleString()} 赞 · ${v.comment.toLocaleString()} 评</span>
<span class="meta">阈值 ≥${rule.minLike}</span>
<span class="badge ${gCls}">${g} · 达标 ${passed.length} 条</span>
<span class="meta" style="color:#999">${esc((v.desc || '').slice(0, 40))}</span>
</summary><div class="inner">`;

  if (!passed.length) {
    h += `<div class="note" style="padding:8px 0">该视频评论区没有 ≥${rule.minLike} 赞的评价（抓取 ${list.length} 条，最高 ${list.length ? list[0]['评价点赞'] : 0} 赞）—— ${GRADE_ADVICE[g]}</div>`;
  } else {
    h += `<table><thead><tr><th style="width:36px">#</th><th class="n" style="width:70px">评价点赞</th>
<th>评价内容</th><th style="width:90px">评价者</th><th style="width:56px">地区</th>
<th class="n" style="width:60px">子回复</th></tr></thead><tbody>`;
    for (const c of passed) {
      h += `<tr><td class="n">${c['评价排名']}</td><td class="n">${(+c['评价点赞']).toLocaleString()}</td>
<td>${esc((c['评价内容'] || '').slice(0, 90))}</td>
<td>${esc(c['评价者'])}</td><td>${esc(c['地区'])}</td>
<td class="n">${c['子回复数']}</td></tr>`;
    }
    h += `</tbody></table>`;
    if (passed.length < list.length) {
      h += `<div class="note">另有 ${list.length - passed.length} 条评价低于阈值 ${rule.minLike} 赞，未列出</div>`;
    }
  }
  h += `</div></details>`;
});

h += `</div></body></html>`;

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, h, 'utf8');
console.log(`[saved] ${OUT}`);
console.log(`  视频 ${videos.length} 条 / 评价 ${totalCmt} 条 / 达标 ${totalPass} 条`);
console.log(`  文件 ${(h.length / 1024 / 1024).toFixed(2)} MB`);
