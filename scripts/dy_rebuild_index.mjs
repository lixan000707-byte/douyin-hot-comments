/**
 * 重建抖音数据总索引（跨所有批次 / 层级）
 *
 *   node dy_rebuild_index.mjs                  # 只扫 data/douyin（正式数据）
 *   node dy_rebuild_index.mjs --include-test   # 连同 data/dy_test_20261108 历史测试数据
 *   node dy_rebuild_index.mjs --csv            # 额外导出视频清单 CSV
 *
 * 背景：tiered 脚本每次运行会覆盖自己的 index.json，导致历史层级信息丢失。
 *      本脚本扫全盘重算，输出一份不受单次运行影响的总索引。
 *
 * 去重规则：同一 videoId 出现在多处时，保留「评论条数最多」的那份，并记录所有来源。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve((process.env.DY_ROOT || process.cwd()));
const DATA_ROOT = process.env.DY_DATA_DIR || path.join(ROOT, 'dy_output');

const argv = process.argv.slice(2);
const INCLUDE_TEST = argv.includes('--include-test');
const WANT_CSV = argv.includes('--csv');
const WANT_COMMENTS_CSV = argv.includes('--comments-csv');
const oIdx = argv.indexOf('-o');
const OUT = oIdx > 0 ? path.resolve(argv[oIdx + 1]) : path.join(DATA_ROOT, 'index_all.json');

const SCAN_ROOTS = [DATA_ROOT];
if (INCLUDE_TEST) SCAN_ROOTS.push(path.join(ROOT, 'data', 'dy_test_20261108'));

// ---------- 扫描 ----------
const records = new Map();   // videoId -> {..., sources:[]}
let filesScanned = 0, filesParsed = 0;

function record(r, filePath, extra = {}) {
  const id = r.videoId || (r.video && r.video.videoId);
  if (!id) return;
  const top = r.top || r.comments || [];
  const stat = r.stat || (r.video ? {
    digg: r.video.digg, comment: r.video.comment,
    collect: r.video.collect, share: r.video.share,
  } : {});
  const item = {
    videoId: id,
    author: r.author || (r.video && r.video.author) || '',
    desc: r.desc || (r.video && r.video.desc) || '',
    digg: stat.digg || 0,
    comment: stat.comment || 0,
    collect: stat.collect || 0,
    share: stat.share || 0,
    fetchedComments: top.length,
    depthEnough: r.depthEnough !== undefined ? r.depthEnough : null,
    effectiveHighLike: r.effectiveHighLike !== undefined ? r.effectiveHighLike : null,
    keyword: r.keyword || extra.keyword || '',
    tier: extra.tier || r.tier || '',
    capturedAt: r.capturedAt || extra.capturedAt || '',
    sources: [path.relative(ROOT, filePath).replace(/\\/g, '/')],
    _top: top,   // 评论明细，仅用于导出评论级 CSV，不写进索引
  };

  const cur = records.get(id);
  if (!cur) { records.set(id, item); return; }
  // 保留评论更多的那份，但来源要合并
  const sources = [...new Set([...cur.sources, ...item.sources])];
  if (item.fetchedComments > cur.fetchedComments) {
    item.sources = sources;
    // 补齐空字段
    if (!item.keyword && cur.keyword) item.keyword = cur.keyword;
    if (!item.tier && cur.tier) item.tier = cur.tier;
    records.set(id, item);
  } else {
    cur.sources = sources;
    if (!cur.keyword && item.keyword) cur.keyword = item.keyword;
    if (!cur.tier && item.tier) cur.tier = item.tier;
  }
}

function walk(dir) {
  if (!fs.existsSync(dir)) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (/node_modules|_pipeline_\d+/.test(p)) continue;   // 跳过流水线中间目录
      walk(p);
      continue;
    }
    if (!e.name.endsWith('.json')) continue;
    if (e.name.startsWith('index')) continue;              // 索引本身不算数据
    filesScanned++;
    let j;
    try { j = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { continue; }
    filesParsed++;

    // 从路径推断 tier（如 .../T1_超10万/comments/xxx.json）与批次
    const rel = path.relative(ROOT, p).replace(/\\/g, '/');
    const tierMatch = rel.match(/\/(T\d+_[^/]+)\/comments\//);
    const tier = tierMatch ? tierMatch[1] : '';
    const batchMatch = rel.match(/\/(tiered_\d+|library)\//);
    const batch = batchMatch ? batchMatch[1] : (rel.includes('dy_test_') ? 'test' : '');

    if (Array.isArray(j.results)) {
      for (const r of j.results) if (r && r.ok !== false) record(r, p, { tier, batch });
    } else if (j.videoId && (j.top || j.comments)) {
      record(j, p, { tier, batch });
    }
  }
}

console.log('扫描范围：');
for (const r of SCAN_ROOTS) console.log('  ' + path.relative(ROOT, r) || r);
console.log('');

for (const r of SCAN_ROOTS) walk(r);

// ---------- 聚合 ----------
const all = [...records.values()];
const TIERS = [
  [1000000, '≥100万'],
  [100000, '10万-100万'],
  [10000, '1万-10万'],
  [1000, '1千-1万'],
  [0, '<1千'],
];
const byTier = {};
for (let i = 0; i < TIERS.length; i++) {
  const lo = TIERS[i][0];
  const hi = i === 0 ? Infinity : TIERS[i - 1][0];
  const list = all.filter(v => v.digg >= lo && v.digg < hi);
  byTier[TIERS[i][1]] = {
    videos: list.length,
    comments: list.reduce((s, v) => s + v.fetchedComments, 0),
    maxDigg: list.length ? Math.max(...list.map(v => v.digg)) : 0,
  };
}

const byKeyword = {};
for (const v of all) {
  const k = v.keyword || '(未标注)';
  if (!byKeyword[k]) byKeyword[k] = { videos: 0, comments: 0, maxDigg: 0 };
  byKeyword[k].videos++;
  byKeyword[k].comments += v.fetchedComments;
  byKeyword[k].maxDigg = Math.max(byKeyword[k].maxDigg, v.digg);
}

const byBatch = {};
for (const v of all) {
  // 从 sources 第一条推断批次
  const src = v.sources[0] || '';
  const m = src.match(/(tiered_\d+|library|dy_test_\d+|matrix_\d+|top5_\d+)/);
  const b = m ? m[1] : (src.endsWith('.json') && !src.includes('/comments/') ? '旧版单文件' : 'unknown');
  if (!byBatch[b]) byBatch[b] = { videos: 0, comments: 0 };
  byBatch[b].videos++;
  byBatch[b].comments += v.fetchedComments;
}

const deepOk = all.filter(v => v.depthEnough === true).length;
const judged = all.filter(v => v.depthEnough !== null).length;

const index = {
  builtAt: new Date().toISOString(),
  scope: INCLUDE_TEST ? '抖音女装相关（含历史测试数据）' : '抖音女装相关（正式数据）',
  summary: {
    videos: all.length,
    comments: all.reduce((s, v) => s + v.fetchedComments, 0),
    avgCommentsPerVideo: all.length ? +(all.reduce((s, v) => s + v.fetchedComments, 0) / all.length).toFixed(1) : 0,
    depthEnoughRate: judged ? +(deepOk / judged * 100).toFixed(1) : null,
    filesScanned,
    filesParsed,
  },
  byDiggTier: byTier,
  byKeyword,
  byBatch,
  videos: all
    .sort((a, b) => b.digg - a.digg)
    .map(v => ({
      videoId: v.videoId, author: v.author, desc: v.desc.slice(0, 60),
      digg: v.digg, comment: v.comment, fetchedComments: v.fetchedComments,
      effectiveHighLike: v.effectiveHighLike,
      keyword: v.keyword, tier: v.tier,
      depthEnough: v.depthEnough, capturedAt: v.capturedAt,
      sources: v.sources,
    })),
};

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(index, null, 2), 'utf8');

// ---------- CSV ----------
let csvPath = '';
if (WANT_CSV) {
  const rows = [['视频ID', '作者', '标题', '视频点赞', '视频评论数', '已抓评论', '有效高赞>10', '来源关键词', '层级', '深度判定', '抓取时间']];
  for (const v of index.videos) {
    rows.push([
      v.videoId, v.author, (v.desc || '').replace(/[\r\n]+/g, ' ').replace(/,/g, '，'),
      v.digg, v.comment, v.fetchedComments, v.effectiveHighLike ?? '',
      v.keyword || '', v.tier || '',
      v.depthEnough === null ? '' : (v.depthEnough ? '足够' : '不足'),
      v.capturedAt || '',
    ]);
  }
  const csv = '\ufeff' + rows.map(r => r.map(x => /[,"]/.test(String(x)) ? '"' + String(x).replace(/"/g, '""') + '"' : x).join(',')).join('\n');
  csvPath = OUT.replace(/\.json$/, '_videos.csv');
  fs.writeFileSync(csvPath, csv, 'utf8');
}

// ---------- 评论级明细 CSV（一行一条评价）----------
let commentsCsvPath = '';
if (WANT_COMMENTS_CSV) {
  const rows = [[
    '视频ID', '视频作者', '视频点赞', '视频评论数', '来源关键词',
    '评价排名', '评价点赞', '占视频赞%', '评价内容', '评价者', '地区',
    '子回复数', '评价发布时间', 'cid', '抓取时间',
  ]];
  let n = 0;
  for (const v of index.videos) {
    const rec = records.get(v.videoId);
    const top = (rec && rec._top) || [];
    top.forEach((c, i) => {
      rows.push([
        v.videoId, v.author, v.digg, v.comment, v.keyword || '',
        c.rank || i + 1, c.like ?? '', v.digg ? +(c.like / v.digg * 100).toFixed(3) : '',
        (c.text || '').replace(/[\r\n]+/g, ' ').replace(/,/g, '，'),
        c.name || '', c.ip || '', c.replyTotal ?? '',
        c.createTime ? new Date(c.createTime * 1000).toISOString().slice(0, 10) : '',
        c.cid || '', v.capturedAt || '',
      ]);
      n++;
    });
  }
  const csv = '\ufeff' + rows.map(r => r.map(x => /[,"]/.test(String(x)) ? '"' + String(x).replace(/"/g, '""') + '"' : x).join(',')).join('\n');
  commentsCsvPath = OUT.replace(/\.json$/, '_comments.csv');
  fs.writeFileSync(commentsCsvPath, csv, 'utf8');
  console.log(`[评论明细] ${n} 条评价 → ${path.relative(ROOT, commentsCsvPath)}`);
}

// ---------- 摘要 ----------
console.log('='.repeat(62));
console.log(`扫描文件 ${filesScanned} 个，解析成功 ${filesParsed} 个`);
console.log(`视频总数 ${index.summary.videos} 条　评论 ${index.summary.comments} 条　平均 ${index.summary.avgCommentsPerVideo} 条/视频`);
if (index.summary.depthEnoughRate !== null) console.log(`深度足够率 ${index.summary.depthEnoughRate}%`);
console.log('');
console.log('按点赞量级：');
for (const [k, v] of Object.entries(byTier)) {
  console.log(`  ${k.padEnd(12)} ${String(v.videos).padStart(4)} 视频　${String(v.comments).padStart(5)} 评论　最高 ${v.maxDigg.toLocaleString()}`);
}
console.log('');
console.log('按关键词（视频数降序）：');
const kws = Object.entries(byKeyword).sort((a, b) => b[1].videos - a[1].videos);
for (const [k, v] of kws) {
  console.log(`  ${k.padEnd(12)} ${String(v.videos).padStart(4)} 视频　${String(v.comments).padStart(5)} 评论`);
}
console.log('');
console.log('按批次：');
for (const [k, v] of Object.entries(byBatch).sort((a, b) => b[1].videos - a[1].videos)) {
  console.log(`  ${k.padEnd(16)} ${String(v.videos).padStart(4)} 视频　${String(v.comments).padStart(5)} 评论`);
}
console.log('');
console.log(`[saved] ${path.relative(ROOT, OUT)}`);
if (csvPath) console.log(`[saved] ${path.relative(ROOT, csvPath)}`);
