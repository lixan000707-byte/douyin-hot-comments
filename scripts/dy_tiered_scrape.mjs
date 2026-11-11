/**
 * 抖音分层抓取：按视频点赞区间分三个任务，各抓指定条数
 *
 *   node dy_tiered_scrape.mjs --keywords 女裤 裤子 牛仔裤
 *   node dy_tiered_scrape.mjs --keywords 女裤 裤子 牛仔裤 --dry-run
 *
 * 默认三个区间（可用 --tier 覆盖，格式 min,max,count，max 用 inf 表示无上限）：
 *   T1  点赞 > 100,000        抓 3 条
 *   T2  点赞 10,000 – 100,000 抓 5 条
 *   T3  点赞    500 –  10,000 抓 5 条
 *
 * 数据来源：已有搜索结果（data/dy_test_20261108/search_*.json），不重新搜，省风控。
 * 输出：data/douyin/tiered_<日期>/ 下按 T1/T2/T3 分目录，各自带 comments/ 与 videos.json
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve((process.env.DY_ROOT || process.cwd()));
const DATA_ROOT = process.env.DY_DATA_DIR || path.join(ROOT, 'dy_output');
const SRC = path.join(ROOT, 'data', 'dy_test_20261108');

// ---------- 参数 ----------
const argv = process.argv.slice(2);
let PER = 20, BATCH = 5, COOLDOWN = 15, dryRun = false, RANDOM = false, MERGE = false, EXCLUDE_DONE = false, SEED = 0;
let keywords = [];
const tiers = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--n') PER = parseInt(argv[++i], 10) || 20;
  else if (a === '--batch') BATCH = parseInt(argv[++i], 10) || 5;
  else if (a === '--cooldown') COOLDOWN = parseInt(argv[++i], 10) || 15;
  else if (a === '--dry-run') dryRun = true;
  else if (a === '--random') RANDOM = true;
  else if (a === '--merge') MERGE = true;
  else if (a === '--exclude-done') EXCLUDE_DONE = true;
  else if (a === '--seed') SEED = parseInt(argv[++i], 10) || 0;
  else if (a === '--tier') {
    const parts = argv[++i].split(',');
    if (parts.length !== 3) { console.error('[FATAL] --tier 格式: min,max,count'); process.exit(1); }
    tiers.push({
      min: parseInt(parts[0], 10),
      max: parts[1].toLowerCase() === 'inf' ? Infinity : parseInt(parts[1], 10),
      count: parseInt(parts[2], 10),
    });
  }
  else if (a === '--keywords') { while (argv[i + 1] && !argv[i + 1].startsWith('-')) keywords.push(argv[++i]); }
  else if (!a.startsWith('-')) keywords.push(a);
}

if (!tiers.length) {
  tiers.push({ min: 100000, max: Infinity, count: 3, name: 'T1_超10万' });
  tiers.push({ min: 10000, max: 100000, count: 5, name: 'T2_1万到10万' });
  tiers.push({ min: 500, max: 10000, count: 5, name: 'T3_500到1万' });
} else {
  tiers.forEach((t, i) => { t.name = `T${i + 1}_${t.min}-${t.max === Infinity ? 'inf' : t.max}`; });
}

if (!keywords.length) {
  console.log('用法: node dy_tiered_scrape.mjs --keywords 女裤 裤子 牛仔裤 [--dry-run]');
  console.log('默认区间: >10万抓3条 / 1-10万抓5条 / 500-1万抓5条');
  process.exit(1);
}

const sleepSync = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// 按档位决定每条视频抓几条评价：低量级评论稀疏，抓满 20 条也多是零赞
function nForTier(t) {
  if (t.min >= 10000) return PER;                 // 1万以上：抓满
  if (t.min >= 5000) return Math.min(PER, 15);    // 5千-1万：15 条
  return Math.min(PER, 10);                       // 5千以下：10 条
}
const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
const OUT = path.join(DATA_ROOT, `tiered_${stamp}`);

// ---------- 读搜索结果 ----------
function loadSource(kw) {
  const files = fs.readdirSync(SRC).filter(f => /^search_.*\.json$/.test(f) || f === 'dbg_new.json' || f === 'diag_banskirt.json');
  let best = null;
  for (const f of files) {
    let j;
    try { j = JSON.parse(fs.readFileSync(path.join(SRC, f), 'utf8')); } catch { continue; }
    if (!j.videos || !j.videos.length) continue;
    const k = j.keyword || f.replace(/^search_|\.json$/g, '');
    if (k !== kw) continue;
    if (!best || j.videos.length > best.videos.length) best = j;
  }
  return best;
}

// ---------- 按区间选视频 ----------
const usedIds = new Set();   // 跨区间/跨关键词去重
const plan = new Map();      // tierName -> [video]
for (const t of tiers) plan.set(t.name, []);

const report = [];

// 已抓过的 videoId（扫描 data/douyin 下所有 <videoId>.json），用于避免重复抓
function loadDone() {
  const done = new Set();
  const scan = d => {
    if (!fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { scan(p); continue; }
      const m = e.name.match(/^(\d{15,})\.json$/);
      if (m) done.add(m[1]);
    }
  };
  scan(DATA_ROOT);
  return done;
}
const doneIds = EXCLUDE_DONE ? loadDone() : new Set();
if (EXCLUDE_DONE) console.log(`[排除] 已有 ${doneIds.size} 条视频抓过，本次跳过`);

// 可复现随机（同一个 seed 抽同一批）
function shuffle(arr, seed) {
  const a = [...arr];
  let s = (seed || Date.now()) >>> 0;
  const rnd = () => { s = (Math.imul(s, 1103515245) + 12345) >>> 0; return s / 4294967296; };
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

if (MERGE) {
  // 合并所有词的候选池，每个区间总共只取 count 条（而不是每词各取）
  const poolAll = [];
  for (const kw of keywords) {
    const src = loadSource(kw);
    if (!src) { console.warn(`[WARN] 没有「${kw}」的搜索结果，跳过`); continue; }
    for (const v of src.videos) poolAll.push({ ...v, keyword: kw });
  }
  const uniq = [...new Map(poolAll.map(v => [v.videoId, v])).values()]
    .filter(v => (v.comment || 0) > 0 && !doneIds.has(v.videoId));
  console.log(`[合并池] ${keywords.length} 个词去重后 ${uniq.length} 条可用视频`);

  for (const t of tiers) {
    const pool = uniq.filter(v => v.digg >= t.min && v.digg < t.max && !usedIds.has(v.videoId));
    const ordered = RANDOM ? shuffle(pool, SEED) : [...pool].sort((a, b) => b.digg - a.digg);
    const picked = ordered.slice(0, t.count);
    for (const p of picked) usedIds.add(p.videoId);
    plan.set(t.name, picked);
    report.push({ kw: '(合并池)', tier: t.name, pool: pool.length, picked: picked.length, need: t.count });
  }
} else {
  for (const kw of keywords) {
    const src = loadSource(kw);
    if (!src) { console.error(`[WARN] 没有「${kw}」的搜索结果，跳过`); continue; }
    const vids = [...src.videos]
      .filter(v => (v.comment || 0) > 0 && !doneIds.has(v.videoId))  // 没评论 / 已抓过的跳过
      .sort((a, b) => b.digg - a.digg);

    for (const t of tiers) {
      const pool = vids.filter(v => v.digg >= t.min && v.digg < t.max && !usedIds.has(v.videoId));
      const ordered = RANDOM ? shuffle(pool, SEED) : pool;
      const picked = ordered.slice(0, t.count);
      for (const p of picked) {
        usedIds.add(p.videoId);
        plan.get(t.name).push({ ...p, keyword: kw });
      }
      report.push({ kw, tier: t.name, pool: pool.length, picked: picked.length, need: t.count });
    }
  }
}

// ---------- 规划输出 ----------
console.log(`[来源] 已有搜索结果（不重新搜索）`);
console.log(`[关键词] ${keywords.join(' / ')}`);
console.log('');
for (const t of tiers) {
  const list = plan.get(t.name);
  console.log(`${t.name}  区间 ${t.min} – ${t.max === Infinity ? '∞' : t.max}  目标 ${t.count} 条  实际选出 ${list.length} 条`);
  for (const v of list) {
    console.log(`    ${String(v.digg).padStart(8)} 赞  ${String(v.comment).padStart(6)} 评  [${v.keyword}] @${v.author}`);
  }
}
console.log('');
console.log('按词分布：');
for (const r of report) {
  const flag = r.picked < r.need ? ` ⚠️ 不足（池中仅 ${r.pool} 条可用）` : '';
  console.log(`  ${r.kw.padEnd(8)} ${r.tier.padEnd(14)} 候选 ${String(r.pool).padStart(3)} → 取 ${r.picked}/${r.need}${flag}`);
}

const total = [...plan.values()].reduce((s, l) => s + l.length, 0);
console.log(`\n[合计] ${total} 条视频 × TOP${PER} 评论`);

if (!total) { console.error('[FATAL] 没有选出任何视频'); process.exit(4); }
if (dryRun) { console.log('\n[dry-run] 只规划不执行。'); process.exit(0); }

// ---------- 执行抓取 ----------
fs.mkdirSync(OUT, { recursive: true });
const startedAt = new Date().toISOString();
let okAll = 0, failAll = 0;

for (const t of tiers) {
  const list = plan.get(t.name);
  if (!list.length) { console.log(`\n[${t.name}] 无候选，跳过`); continue; }
  const tierDir = path.join(OUT, t.name);
  const cmtDir = path.join(tierDir, 'comments');
  fs.mkdirSync(cmtDir, { recursive: true });

  console.log(`\n${'='.repeat(58)}`);
  const tierN = nForTier(t);
  console.log(`[${t.name}] 抓取 ${list.length} 条视频的评论（每条 TOP${tierN}）`);
  console.log('='.repeat(58));

  for (let i = 0; i < list.length; i += BATCH) {
    const batch = list.slice(i, i + BATCH);
    const bn = Math.floor(i / BATCH) + 1, bt = Math.ceil(list.length / BATCH);
    console.log(`\n  ── ${t.name} 批次 ${bn}/${bt}（${batch.length} 条）──`);

    const tmp = path.join(tierDir, `_tmp_${Date.now()}.json`);
    spawnSync(process.execPath, [
      path.join(__dir, 'dy_top.mjs'),
      ...batch.map(b => b.videoId),
      '--n', String(tierN), '-o', tmp,
    ], { stdio: 'inherit' });

    if (fs.existsSync(tmp)) {
      const j = JSON.parse(fs.readFileSync(tmp, 'utf8'));
      for (const res of (j.results || [])) {
        const meta = batch.find(b => b.videoId === res.videoId) || {};
        fs.writeFileSync(path.join(cmtDir, `${res.videoId}.json`), JSON.stringify({
          videoId: res.videoId,
          tier: t.name,
          keyword: meta.keyword || '',
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
        }, null, 2), 'utf8');
        okAll++;
      }
      failAll += (j.failed || []).length;
      fs.unlinkSync(tmp);
    } else {
      failAll += batch.length;
    }
    if (i + BATCH < list.length) { console.log(`    冷却 ${COOLDOWN}s…`); sleepSync(COOLDOWN * 1000); }
  }

  // 该层 index
  const files = fs.readdirSync(cmtDir).filter(f => f.endsWith('.json'));
  const recs = files.map(f => JSON.parse(fs.readFileSync(path.join(cmtDir, f), 'utf8')));
  fs.writeFileSync(path.join(tierDir, 'videos.json'), JSON.stringify(recs.map(r => ({
    videoId: r.videoId, keyword: r.keyword, author: r.author, desc: r.desc,
    digg: r.stat.digg, comment: r.stat.comment, collect: r.stat.collect, share: r.stat.share,
    fetchedComments: (r.top || []).length, effectiveHighLike: r.effectiveHighLike,
  })), null, 2), 'utf8');
  fs.writeFileSync(path.join(tierDir, 'index.json'), JSON.stringify({
    tier: t.name, range: [t.min, t.max === Infinity ? null : t.max], target: t.count,
    videos: recs.length,
    comments: recs.reduce((s, r) => s + (r.top || []).length, 0),
    keywords: [...new Set(recs.map(r => r.keyword))],
    builtAt: new Date().toISOString(),
  }, null, 2), 'utf8');
}

// ---------- 总索引 ----------
const summary = [];
for (const t of tiers) {
  const idx = path.join(OUT, t.name, 'index.json');
  if (fs.existsSync(idx)) summary.push(JSON.parse(fs.readFileSync(idx, 'utf8')));
}
fs.writeFileSync(path.join(OUT, 'index.json'), JSON.stringify({
  startedAt, finishedAt: new Date().toISOString(),
  keywords, commentPerVideo: PER,
  tiers: summary,
  totalVideos: summary.reduce((s, x) => s + x.videos, 0),
  totalComments: summary.reduce((s, x) => s + x.comments, 0),
}, null, 2), 'utf8');

console.log(`\n${'='.repeat(58)}`);
console.log(`分层抓取完成｜成功 ${okAll} 条，失败 ${failAll} 条`);
for (const s of summary) {
  console.log(`  ${s.tier.padEnd(14)} ${String(s.videos).padStart(2)} 视频 / ${String(s.comments).padStart(4)} 评论  关键词: ${s.keywords.join(',')}`);
}
console.log(`\n目录：${OUT}`);
process.exit(failAll > okAll ? 4 : failAll ? 3 : 0);
