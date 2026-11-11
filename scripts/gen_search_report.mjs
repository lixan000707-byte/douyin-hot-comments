/**
 * 搜索结果 + 高赞评论 → HTML 数据表（纯数据展示，不做分析）
 *
 *   node gen_search_report.mjs --search search_kuzi.json --comments kuzi_top12.json --kw 裤子 -o out.html
 *
 * 输入：
 *   --search    dy_search.mjs 产出的 JSON（含 keyword / videos[]）
 *   --comments  dy_top.mjs 产出的 JSON（含 results[].top[]）
 * 输出：单文件 HTML，白底细线，含「搜索概览 + 抓取汇总 + 各视频 TOP5」
 */
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
let searchFile = '', commentsFile = '', KW = '', outFile = '', TOPN = 5;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--search') searchFile = argv[++i];
  else if (a === '--comments') commentsFile = argv[++i];
  else if (a === '--kw') KW = argv[++i];
  else if (a === '-o') outFile = argv[++i];
  else if (a === '--top') TOPN = parseInt(argv[++i], 10) || 5;
}
if (!searchFile || !commentsFile || !outFile) {
  console.error('用法: node gen_search_report.mjs --search s.json --comments c.json --kw 关键词 -o out.html');
  process.exit(1);
}

const S = JSON.parse(fs.readFileSync(path.resolve(searchFile), 'utf8'));
const C = JSON.parse(fs.readFileSync(path.resolve(commentsFile), 'utf8'));
const kw = KW || S.keyword || '';
const videos = S.videos || [];
const results = C.results || [];
const esc = t => String(t == null ? '' : t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const okCount = results.filter(r => r.depthEnough).length;
const totalRows = results.reduce((s, r) => s + (r.fetchedRows || 0), 0);
const totalSec = results.reduce((s, r) => s + (r.scraped?.sec || 0), 0);

const dist = {
  gt10w: videos.filter(v => v.digg > 100000).length,
  w1_10: videos.filter(v => v.digg >= 10000 && v.digg <= 100000).length,
  k1_1w: videos.filter(v => v.digg >= 1000 && v.digg < 10000).length,
  lt1k: videos.filter(v => v.digg < 1000).length,
};

let h = '';
h += `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>抖音搜索「${esc(kw)}」· 数据表</title><style>
*{box-sizing:border-box}
body{margin:0;padding:36px 22px 70px;background:#fff;color:#1a1a1a;font-family:-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;font-size:13px;line-height:1.65}
.w{max-width:1180px;margin:0 auto}
h1{font-size:22px;font-weight:600;margin:0 0 6px}
.sub{color:#666;font-size:12px;margin-bottom:26px}
h2{font-size:15px;font-weight:600;margin:34px 0 10px;padding-left:9px;border-left:3px solid #1a1a1a}
table{width:100%;border-collapse:collapse;margin:4px 0 10px}
th{text-align:left;font-weight:600;color:#555;padding:8px 9px;border-bottom:1px solid #1a1a1a;white-space:nowrap;font-size:12px}
td{padding:7px 9px;border-bottom:1px solid #e8e8e8;vertical-align:top}
tr:last-child td{border-bottom:1px solid #d0d0d0}
.n{font-family:Consolas,monospace;text-align:right}
.ok{color:#0a7d3c;font-weight:600}
.meta{color:#888;font-size:11px}
.vtitle{font-weight:600;margin:0 0 4px}
.vmeta{color:#666;font-size:11px;margin-bottom:6px}
a{color:#0b5cad;text-decoration:none}
.stat{display:flex;gap:26px;flex-wrap:wrap;margin:10px 0 18px;font-size:12px}
.stat div span{font-family:Consolas,monospace;font-size:16px;font-weight:600;display:block;margin-top:1px}
</style></head><body><div class="w">`;

h += `<h1>抖音搜索「${esc(kw)}」· 视频与高赞评论数据</h1>`;
h += `<div class="sub">抓取时间 ${new Date().toLocaleString('zh-CN')}　|　工具 dy_search.mjs + dy_top.mjs</div>`;

h += `<div class="stat">
<div>搜索结果<span>${videos.length} 条</span></div>
<div>涉及账号<span>${new Set(videos.map(v => v.author)).size} 个</span></div>
<div>抓取视频<span>${results.length} 条（成功 ${okCount}）</span></div>
<div>一级评论<span>${totalRows.toLocaleString()} 条</span></div>
<div>总耗时<span>${totalSec.toFixed(0)}s</span></div>
</div>`;

h += `<h2>一、点赞分布</h2><table><thead><tr><th>区间</th><th class="n">视频数</th><th>占总量</th></tr></thead><tbody>`;
[['&gt;10 万赞', dist.gt10w], ['1 万 – 10 万', dist.w1_10], ['1 千 – 1 万', dist.k1_1w], ['&lt;1 千', dist.lt1k]].forEach(([k, n]) => {
  h += `<tr><td>${k}</td><td class="n">${n}</td><td>${videos.length ? (n / videos.length * 100).toFixed(1) : 0}%</td></tr>`;
});
h += `</tbody></table>`;

h += `<h2>二、搜索结果（点赞 TOP20）</h2><table><thead><tr><th>#</th><th>作者</th><th class="n">点赞</th><th class="n">评论</th><th class="n">收藏</th><th>标题</th><th>链接</th></tr></thead><tbody>`;
videos.slice(0, 20).forEach((v, i) => {
  h += `<tr><td class="n">${i + 1}</td><td>${esc(v.author)}</td><td class="n">${v.digg.toLocaleString()}</td><td class="n">${v.comment.toLocaleString()}</td><td class="n">${(v.collect || 0).toLocaleString()}</td><td>${esc((v.desc || '').slice(0, 34))}</td><td><a href="https://www.douyin.com/video/${v.videoId}" target="_blank">打开</a></td></tr>`;
});
h += `</tbody></table><div class="meta">完整 ${videos.length} 条见同名 CSV。</div>`;

h += `<h2>三、逐视频评论抓取（${results.length} 条视频）</h2><table><thead><tr><th>#</th><th>作者</th><th class="n">视频赞</th><th class="n">评论</th><th class="n">页数</th><th class="n">抓取条数</th><th class="n">耗时</th><th class="n">有效高赞&gt;10</th><th class="n">贴边%</th><th>深度</th></tr></thead><tbody>`;
results.forEach((r, i) => {
  h += `<tr><td class="n">${i + 1}</td><td>${esc(r.author)}</td><td class="n">${r.stat.digg.toLocaleString()}</td><td class="n">${r.stat.comment.toLocaleString()}</td><td class="n">${r.scraped.pages}</td><td class="n">${r.fetchedRows}</td><td class="n">${r.scraped.sec}s</td><td class="n">${r.effectiveHighLike}</td><td class="n">${r.positionRisk}%</td><td class="${r.depthEnough ? 'ok' : ''}">${r.depthEnough ? '✅' : '⚠️'}</td></tr>`;
});
h += `</tbody></table>`;

h += `<h2>四、各视频 TOP${TOPN} 评论</h2>`;
results.forEach((r, i) => {
  h += `<div style="margin:20px 0 6px"><div class="vtitle">${i + 1}. ${esc(r.author)}｜${esc((r.desc || '').slice(0, 40))}</div>`;
  h += `<div class="vmeta">赞 ${r.stat.digg.toLocaleString()}　评 ${r.stat.comment.toLocaleString()}　抓取 ${r.fetchedRows} 条 / ${r.scraped.pages} 页 / ${r.scraped.sec}s　有效高赞 ${r.effectiveHighLike} 条　<a href="${r.link}" target="_blank">视频链接</a></div>`;
  h += `<table><thead><tr><th style="width:34px">#</th><th class="n" style="width:68px">点赞</th><th>评论</th><th style="width:58px">地区</th><th class="n" style="width:52px">子回复</th></tr></thead><tbody>`;
  r.top.slice(0, TOPN).forEach(c => {
    h += `<tr><td class="n">${c.rank}</td><td class="n">${c.like.toLocaleString()}</td><td>${esc((c.text || '').replace(/\s+/g, ' ').slice(0, 56))}</td><td>${esc(c.ip)}</td><td class="n">${c.replyTotal}</td></tr>`;
  });
  h += `</tbody></table></div>`;
});

h += `</div></body></html>`;

const abs = path.resolve(outFile);
fs.mkdirSync(path.dirname(abs), { recursive: true });
fs.writeFileSync(abs, h, 'utf8');
console.log(`[saved] ${abs}  (${(h.length / 1024).toFixed(1)} KB)`);
console.log(`候选 ${videos.length} 条视频 → 抓取 ${results.length} 条视频的评论 / 过程中经过 ${totalRows} 条一级评论 / 报告内展示 TOP ${results.reduce((s, r) => s + (r.top || []).length, 0)} 条评价`);

// 空数据不能静默成功：报表看着"生成了"，其实是空的，下游会当成抓到了 0 条
const emptySearch = videos.length === 0;
const emptyComments = results.length === 0;
if (emptySearch) console.error('[WARN] 搜索结果为空 —— 检查 dy_search.mjs 输出（可能命中验证码页）');
if (emptyComments) console.error('[WARN] 评论数据为空 —— 检查 dy_top.mjs 输出');
const code = (emptySearch && emptyComments) ? 4 : (emptySearch || emptyComments) ? 3 : 0;
if (code) console.error(`[WARN] 报表数据不完整，退出码 ${code}`);
process.exit(code);
