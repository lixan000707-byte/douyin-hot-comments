/**
 * 按「视频点赞区间」统计「评价点赞分布」
 *
 *   node dy_range_stats.mjs                        # 默认读 index_all_comments.csv
 *   node dy_range_stats.mjs --comments xxx.csv -o out.csv
 *   node dy_range_stats.mjs --detail               # 额外导出带区间标签的评价明细
 *
 * 解决的问题：不同点赞量级的视频，评论区里高赞评价有多少条、单条多少赞 —— 完全不同。
 * 输出：视频区间 × 评价点赞档位 的交叉统计 + 每区间最高评价。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve((process.env.DY_ROOT || process.cwd()));
const DATA_ROOT = process.env.DY_DATA_DIR || path.join(ROOT, 'dy_output');

const argv = process.argv.slice(2);
let csvIn = path.join(DATA_ROOT, 'index_all_comments.csv');
let csvOut = '';
let wantDetail = false;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--comments') csvIn = path.resolve(argv[++i]);
  else if (argv[i] === '-o') csvOut = path.resolve(argv[++i]);
  else if (argv[i] === '--detail') wantDetail = true;
}
if (!fs.existsSync(csvIn)) {
  console.error('[FATAL] 找不到评论明细 CSV：' + csvIn);
  console.error('        先跑：node dy_rebuild_index.mjs --include-test --comments-csv');
  process.exit(4);
}

// ---------- 解析 CSV ----------
function parseLine(l) {
  const o = []; let c = '', q = false;
  for (let i = 0; i < l.length; i++) {
    const ch = l[i];
    if (ch === '"') { if (q && l[i + 1] === '"') { c += '"'; i++; } else q = !q; }
    else if (ch === ',' && !q) { o.push(c); c = ''; }
    else c += ch;
  }
  o.push(c);
  return o;
}

const lines = fs.readFileSync(csvIn, 'utf8').replace(/^\ufeff/, '').split('\n').filter(Boolean);
const head = parseLine(lines[0]);
const idx = {
  vid: head.indexOf('视频ID'), author: head.indexOf('视频作者'),
  vdigg: head.indexOf('视频点赞'), vcmt: head.indexOf('视频评论数'),
  kw: head.indexOf('来源关键词'), rank: head.indexOf('评价排名'),
  like: head.indexOf('评价点赞'), text: head.indexOf('评价内容'),
  name: head.indexOf('评价者'), ip: head.indexOf('地区'),
  reply: head.indexOf('子回复数'), cid: head.indexOf('cid'),
};
for (const [k, v] of Object.entries(idx)) {
  if (v < 0) { console.error(`[FATAL] CSV 缺少列：${k}`); process.exit(4); }
}

const recs = lines.slice(1).map(l => {
  const r = parseLine(l);
  return {
    vid: r[idx.vid], author: r[idx.author], vdigg: +r[idx.vdigg] || 0,
    vcmt: +r[idx.vcmt] || 0, kw: r[idx.kw], rank: +r[idx.rank] || 0,
    like: +r[idx.like] || 0, text: r[idx.text], name: r[idx.name],
    ip: r[idx.ip], reply: r[idx.reply], cid: r[idx.cid],
  };
});
console.log(`[读取] ${recs.length} 条评价 / ${new Set(recs.map(r => r.vid)).size} 条视频`);

// ---------- 区间定义（可按需调整）----------
const VIDEO_RANGES = [
  [0, 1000, '<1千'],
  [1000, 5000, '1千-5千'],
  [5000, 10000, '5千-1万'],
  [10000, 50000, '1万-5万'],
  [50000, 100000, '5万-10万'],
  [100000, 500000, '10万-50万'],
  [500000, 1000000, '50万-100万'],
  [1000000, Infinity, '≥100万'],
];
const LIKE_TIERS = [1000, 500, 100, 50, 10];

// ---------- 交叉统计 ----------
const stats = [];
for (const [lo, hi, label] of VIDEO_RANGES) {
  const inR = recs.filter(r => r.vdigg >= lo && r.vdigg < hi);
  const vids = new Set(inR.map(r => r.vid));
  if (!inR.length) {
    stats.push({ label, lo, hi, videos: 0, comments: 0, perVideo: 0, tiers: {}, maxLike: 0, maxText: '' });
    continue;
  }
  const tiers = {};
  for (const t of LIKE_TIERS) tiers[t] = inR.filter(r => r.like >= t).length;
  const top = inR.reduce((a, b) => (b.like > a.like ? b : a), inR[0]);
  stats.push({
    label, lo, hi,
    videos: vids.size, comments: inR.length,
    perVideo: +(inR.length / vids.size).toFixed(1),
    tiers, maxLike: top.like,
    maxText: (top.text || '').slice(0, 30), maxAuthor: top.author,
  });
}

// ---------- 控制台输出 ----------
const W = 11;
console.log('');
console.log('视频区间'.padEnd(W) + '视频数'.padStart(7) + '评价数'.padStart(7) + '每视频'.padStart(7)
  + LIKE_TIERS.map(t => ('≥' + t).padStart(8)).join('') + '最高评价赞'.padStart(12));
console.log('-'.repeat(W + 7 + 7 + 7 + LIKE_TIERS.length * 8 + 12));
for (const s of stats) {
  if (!s.videos) { console.log(s.label.padEnd(W) + String(0).padStart(7) + '   （无样本）'); continue; }
  console.log(
    s.label.padEnd(W)
    + String(s.videos).padStart(7)
    + String(s.comments).padStart(7)
    + String(s.perVideo).padStart(7)
    + LIKE_TIERS.map(t => String(s.tiers[t]).padStart(8)).join('')
    + String(s.maxLike.toLocaleString()).padStart(12),
  );
}
const tv = new Set(recs.map(r => r.vid)).size;
console.log('-'.repeat(W + 7 + 7 + 7 + LIKE_TIERS.length * 8 + 12));
console.log('合计'.padEnd(W) + String(tv).padStart(7) + String(recs.length).padStart(7)
  + LIKE_TIERS.map(t => String(recs.filter(r => r.like >= t).length).padStart(8)).join(''));

// ---------- 占比视图（更好读）----------
console.log('\n各区间内「评价点赞 ≥10」占该区间评价数的比例：');
for (const s of stats) {
  if (!s.videos) continue;
  const pct = s.comments ? (s.tiers[10] / s.comments * 100) : 0;
  const bar = '█'.repeat(Math.round(pct / 2));
  console.log(`  ${s.label.padEnd(11)} ${pct.toFixed(1).padStart(5)}%  ${bar}`);
}

// ---------- 导出 CSV ----------
const outPath = csvOut || path.join(path.dirname(csvIn), 'range_stats.csv');
const rows = [[
  '视频区间', '区间下限', '区间上限', '视频数', '评价数', '平均每视频评价数',
  ...LIKE_TIERS.map(t => `评价≥${t}赞条数`),
  ...LIKE_TIERS.map(t => `评价≥${t}赞占比%`),
  '最高评价点赞', '最高评价所属视频',
]];
for (const s of stats) {
  rows.push([
    s.label, s.lo, s.hi === Infinity ? '' : s.hi, s.videos, s.comments, s.perVideo,
    ...LIKE_TIERS.map(t => s.tiers[t] ?? 0),
    ...LIKE_TIERS.map(t => s.comments ? +((s.tiers[t] || 0) / s.comments * 100).toFixed(2) : 0),
    s.maxLike || '', s.videos ? s.maxAuthor : '',
  ]);
}
const csv = '\ufeff' + rows.map(r => r.map(x => /[,"]/.test(String(x)) ? '"' + String(x).replace(/"/g, '""') + '"' : x).join(',')).join('\n');
fs.writeFileSync(outPath, csv, 'utf8');
console.log('\n[saved] ' + path.relative(ROOT, outPath));

// ---------- 可选：带区间标签的评价明细 ----------
if (wantDetail) {
  const detailPath = outPath.replace(/range_stats\.csv$/, 'range_comments_detail.csv');
  const drows = [['视频区间', ...head]];
  const labelOf = d => {
    const hit = VIDEO_RANGES.find(([lo, hi]) => d >= lo && d < hi);
    return hit ? hit[2] : '(越界)';
  };
  for (const l of lines.slice(1)) {
    const r = parseLine(l);
    drows.push([labelOf(+r[idx.vdigg] || 0), ...r]);
  }
  const dcsv = '\ufeff' + drows.map(r => r.map(x => /[,"]/.test(String(x)) ? '"' + String(x).replace(/"/g, '""') + '"' : x).join(',')).join('\n');
  fs.writeFileSync(detailPath, dcsv, 'utf8');
  console.log('[saved] ' + path.relative(ROOT, detailPath));
}
