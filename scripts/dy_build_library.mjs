/**
 * 抖音资料库构建：从已有搜索结果批量抓视频评论，汇聚成结构化资料库
 *
 *   node dy_build_library.mjs --top 10 --n 20
 *   node dy_build_library.mjs --keywords 女裤 裤子 --top 10 --n 20
 *   node dy_build_library.mjs --dry-run          # 只看会抓多少条，不实际抓
 *
 * 设计原则：只抓数据，不做质量判定、不卡点赞阈值。
 *   评论一律按点赞降序取前 N 条，原样落盘，后续分析再决定怎么筛。
 *
 * 资料库结构（data/douyin/library/）：
 *   index.json            总索引：关键词 / 视频数 / 评论条数 / 抓取时间
 *   videos.json           所有视频去重汇总（含来源关键词、点赞、评论数）
 *   comments/<videoId>.json   每条视频的评论（TOP N）
 *   by_keyword/<词>.json  按关键词分组（视频 + 评论合并）
 *
 * 分批策略：每批 5 条视频，批间隔 20 秒，避免短时间大量请求
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve((process.env.DY_ROOT || path.resolve((process.env.DY_ROOT || process.cwd()))));
const DATA_ROOT = process.env.DY_DATA_DIR || path.join(ROOT, 'dy_output');

const LIB = path.join(DATA_ROOT, 'library');
const SRC = path.join(ROOT, 'data', 'dy_test_20261108');   // 已有搜索结果来源

// ---------- 参数 ----------
const argv = process.argv.slice(2);
let TOP = 10, PER = 20, BATCH = 5, COOLDOWN = 20, dryRun = false;
let keywords = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--top') TOP = parseInt(argv[++i], 10) || 10;
  else if (a === '--n') PER = parseInt(argv[++i], 10) || 20;
  else if (a === '--batch') BATCH = parseInt(argv[++i], 10) || 5;
  else if (a === '--cooldown') COOLDOWN = parseInt(argv[++i], 10) || 20;
  else if (a === '--dry-run') dryRun = true;
  else if (a === '--keywords') { while (argv[i + 1] && !argv[i + 1].startsWith('-')) keywords.push(argv[++i]); }
  else if (!a.startsWith('-')) keywords.push(a);
}

const sleepSync = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// ---------- 收集已有搜索结果 ----------
function loadSearchSources() {
  const files = fs.readdirSync(SRC).filter(f => /^search_.*\.json$/.test(f) || f === 'dbg_new.json' || f === 'diag_banskirt.json');
  const byKw = new Map();
  for (const f of files) {
    let j;
    try { j = JSON.parse(fs.readFileSync(path.join(SRC, f), 'utf8')); } catch { continue; }
    if (!j.videos || !j.videos.length) continue;
    const kw = j.keyword || f.replace(/^search_|\.json$/g, '');
    const cur = byKw.get(kw);
    // 同一个词保留视频最多的那份
    if (!cur || j.videos.length > cur.videos.length) byKw.set(kw, { file: f, videos: j.videos });
  }
  return byKw;
}

const sources = loadSearchSources();
if (!sources.size) {
  console.error('[FATAL] 没找到可用的搜索结果，请先跑 dy_search.mjs');
  process.exit(4);
}

const useKws = keywords.length ? keywords.filter(k => sources.has(k)) : [...sources.keys()];
const missing = keywords.filter(k => !sources.has(k));
if (missing.length) console.warn(`[WARN] 没有这些词的搜索结果，跳过：${missing.join(' ')}`);
if (!useKws.length) { console.error('[FATAL] 没有可用的关键词'); process.exit(4); }

// ---------- 规划抓取清单 ----------
const plan = [];        // [{kw, videoId, author, digg, comment, desc}]
const seen = new Set();
for (const kw of useKws) {
  const vids = [...sources.get(kw).videos].sort((a, b) => b.digg - a.digg);
  let picked = 0;
  for (const v of vids) {
    if (picked >= TOP) break;
    // 同一视频可能出现在多个关键词下，只抓一次（记录首个来源词）
    if (seen.has(v.videoId)) { picked++; continue; }
    seen.add(v.videoId);
    plan.push({ kw, videoId: v.videoId, author: v.author, digg: v.digg, comment: v.comment, desc: (v.desc || '').slice(0, 50) });
    picked++;
  }
}

console.log(`[规划] 关键词 ${useKws.length} 个，计划抓 ${plan.length} 条视频的评论（每条 TOP${PER}）`);
for (const kw of useKws) {
  const n = plan.filter(p => p.kw === kw).length;
  console.log(`   ${kw.padEnd(10)} ${sources.get(kw).videos.length} 条可选 → 取 ${n} 条`);
}

if (dryRun) {
  console.log('\n[dry-run] 只规划不执行。去掉 --dry-run 开始抓取。');
  process.exit(0);
}

// ---------- 建库 ----------
fs.mkdirSync(path.join(LIB, 'comments'), { recursive: true });
fs.mkdirSync(path.join(LIB, 'by_keyword'), { recursive: true });

// 已抓过的跳过（支持断点续抓）
function alreadyDone(videoId) {
  const p = path.join(LIB, 'comments', `${videoId}.json`);
  if (!fs.existsSync(p)) return false;
  try {
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    return (j.top || []).length > 0;
  } catch { return false; }
}

const todo = plan.filter(p => !alreadyDone(p.videoId));
const skipped = plan.length - todo.length;
console.log(`\n[续抓] 已完成 ${skipped} 条，本次待抓 ${todo.length} 条`);

const t0 = Date.now();
let okCount = 0, failCount = 0;

for (let i = 0; i < todo.length; i += BATCH) {
  const batch = todo.slice(i, i + BATCH);
  const batchNo = Math.floor(i / BATCH) + 1;
  const totalBatch = Math.ceil(todo.length / BATCH);
  console.log(`\n── 批次 ${batchNo}/${totalBatch}（${batch.length} 条）──`);

  const tmpOut = path.join(LIB, `_tmp_batch_${Date.now()}.json`);
  const r = spawnSync(process.execPath, [
    path.join(__dir, 'dy_top.mjs'),
    ...batch.map(b => b.videoId),
    '--n', String(PER),
    '-o', tmpOut,
  ], { stdio: 'inherit' });

  if (fs.existsSync(tmpOut)) {
    const j = JSON.parse(fs.readFileSync(tmpOut, 'utf8'));
    for (const res of (j.results || [])) {
      const meta = batch.find(b => b.videoId === res.videoId) || {};
      const record = {
        videoId: res.videoId,
        keyword: meta.kw || '',
        author: res.author,
        desc: res.desc,
        link: res.link,
        stat: res.stat,
        scraped: res.scraped,
        depthEnough: res.depthEnough,
        depthReason: res.depthReason,
        effectiveHighLike: res.effectiveHighLike,
        top: res.top,
        capturedAt: new Date().toISOString(),
      };
      fs.writeFileSync(path.join(LIB, 'comments', `${res.videoId}.json`), JSON.stringify(record, null, 2), 'utf8');
      okCount++;
    }
    failCount += (j.failed || []).length;
    fs.unlinkSync(tmpOut);
  } else {
    failCount += batch.length;
    console.error(`  [WARN] 批次 ${batchNo} 未产出结果`);
  }

  if (i + BATCH < todo.length) {
    console.log(`  冷却 ${COOLDOWN}s…`);
    sleepSync(COOLDOWN * 1000);
  }
}

// ---------- 重建索引 ----------
console.log('\n[索引] 重建资料库索引…');
const commentFiles = fs.readdirSync(path.join(LIB, 'comments')).filter(f => f.endsWith('.json'));
const records = [];
for (const f of commentFiles) {
  try { records.push(JSON.parse(fs.readFileSync(path.join(LIB, 'comments', f), 'utf8'))); } catch {}
}

// videos.json（去重汇总）
const videos = records.map(r => ({
  videoId: r.videoId, keyword: r.keyword, author: r.author, desc: r.desc,
  digg: r.stat.digg, comment: r.stat.comment, collect: r.stat.collect, share: r.stat.share,
  fetchedComments: (r.top || []).length, effectiveHighLike: r.effectiveHighLike,
}));
fs.writeFileSync(path.join(LIB, 'videos.json'), JSON.stringify(videos, null, 2), 'utf8');

// by_keyword（按词分组）
const byKw = new Map();
for (const r of records) {
  const kw = r.keyword || '未分类';
  if (!byKw.has(kw)) byKw.set(kw, []);
  byKw.get(kw).push(r);
}
for (const [kw, list] of byKw) {
  fs.writeFileSync(path.join(LIB, 'by_keyword', `${kw}.json`), JSON.stringify({
    keyword: kw, videoCount: list.length,
    totalComments: list.reduce((s, r) => s + (r.top || []).length, 0),
    videos: list,
  }, null, 2), 'utf8');
}

// index.json
const totalComments = records.reduce((s, r) => s + (r.top || []).length, 0);
const index = {
  builtAt: new Date().toISOString(),
  scope: '女装相关关键词（抖音）',
  keywords: [...byKw.keys()].map(kw => {
    const list = byKw.get(kw);
    return {
      keyword: kw,
      videos: list.length,
      comments: list.reduce((s, r) => s + (r.top || []).length, 0),
      maxDigg: Math.max(...list.map(r => r.stat.digg)),
    };
  }).sort((a, b) => b.maxDigg - a.maxDigg),
  summary: {
    videos: records.length,
    comments: totalComments,
    avgCommentsPerVideo: records.length ? +(totalComments / records.length).toFixed(1) : 0,
    depthEnoughRate: records.length ? +(records.filter(r => r.depthEnough).length / records.length * 100).toFixed(1) : 0,
  },
  paths: {
    videos: 'videos.json',
    comments: 'comments/<videoId>.json',
    byKeyword: 'by_keyword/<关键词>.json',
  },
};
fs.writeFileSync(path.join(LIB, 'index.json'), JSON.stringify(index, null, 2), 'utf8');

// ---------- 摘要 ----------
const sec = ((Date.now() - t0) / 1000).toFixed(1);
console.log(`\n${'='.repeat(60)}`);
console.log(`资料库构建完成｜耗时 ${sec}s｜本次成功 ${okCount} 条，失败 ${failCount} 条`);
console.log(`  视频总数  ${records.length}`);
console.log(`  评论总数  ${totalComments}`);
console.log(`  平均每视频 ${index.summary.avgCommentsPerVideo} 条`);
console.log(`  深度足够率 ${index.summary.depthEnoughRate}%`);
console.log(`\n关键词覆盖：`);
for (const k of index.keywords) {
  console.log(`  ${k.keyword.padEnd(10)} ${String(k.videos).padStart(3)} 视频 / ${String(k.comments).padStart(4)} 评论 / 最高赞 ${k.maxDigg.toLocaleString()}`);
}
console.log(`\n目录：${LIB}`);
process.exit(failCount > okCount ? 4 : failCount ? 3 : 0);
