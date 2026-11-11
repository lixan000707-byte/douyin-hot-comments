/**
 * 抖音「单视频最高赞评论」抓取 —— 自动加深，不赌固定页数
 *
 *   node dy_top.mjs <videoId|url>... [--n 20] [--pages 20] [--verify] [-o out.json] [--md out.md]
 *
 * 为什么不能固定页数（实测反例）：
 *   同一条 68,639 评论的视频，TOP5 的第 5 名落在第 448 条（第 11 页），
 *   10 页（440 条）就差一点够不着；而另一些小视频 5 页就抓到底。
 *   抖音评论区是「热度混合排序」，不是严格点赞降序，任何固定页数都可能不够。
 *
 * 策略（业务规定）：
 *   单次最多抓 20 页；没抓到底（hasMore=1）就重新加载视频页再抓一次
 *   单视频最多抓 2 次，取"抓到底 / 条数更多"的那次结果
 *
 * 判定逻辑见 lib/depth_judge.mjs（12 例单元测试）
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { judgeDepth } from '../lib/depth_judge.mjs';
import { ruleFor } from '../lib/quality.mjs';

const __dir = path.dirname(fileURLToPath(import.meta.url));

// ---------- 参数 ----------
const argv = process.argv.slice(2);
const DATA_ROOT = process.env.DY_DATA_DIR || path.join(process.env.DY_ROOT || process.cwd(), 'dy_output');
let N = 20, PAGES = 0, outFile = '', mdFile = '', VERIFY = false;
const inputs = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--n') N = parseInt(argv[++i], 10) || 10;
  else if (a === '--pages') PAGES = parseInt(argv[++i], 10) || 0;
  else if (a === '-o') outFile = argv[++i];
  else if (a === '--md') mdFile = argv[++i];
  else if (a === '--verify') VERIFY = true;
  else if (a.startsWith('-')) { console.error('未知参数: ' + a); process.exit(1); }
  else inputs.push(a);
}
if (!inputs.length) {
  console.log('用法: node dy_top.mjs <videoId|url>... [--n 20] [--pages 20] [--verify] [-o out.json] [--md out.md]');
  console.log('  单次最多 20 页；没抓到底会重新加载页面再抓一次（最多两次）；--verify 时第二遍用于复检');
  process.exit(1);
}

// 起手页数：保守起点，不够会自动加深（所以不必调得太激进）
// 页数上限：固定 20 页（业务规定）。小视频会因 hasMore=0 提前结束，不会浪费
const MAX_PAGES_PER_RUN = 20;
if (!PAGES) PAGES = MAX_PAGES_PER_RUN;
const MAX_ATTEMPTS = 2;   // 单视频最多抓两次（业务规定）

const SCRAPE = path.join(__dir, 'dy_scrape.mjs');
const failedList = [];

// ---------- 抓一批 ----------
function scrapeBatch(ids, pages) {
  const tmp = path.join(DATA_ROOT, `.dy_top_tmp_${Date.now()}_${pages}.json`);
  // 每页实测 40~50 条；MAXN 留足余量，避免「页数够了却被条数上限截断」
  const MAXN = Math.max(pages * 50 + 60, N * 10);
  const env = {
    ...process.env,
    DY_CNT: '50',
    DY_MAXPAGE: String(pages),
    DY_MAXN: String(MAXN),
    DY_WATCHDOG: process.env.DY_WATCHDOG || '300000',
    DY_ITEM_TIMEOUT: process.env.DY_ITEM_TIMEOUT || '180000',
  };
  const r = spawnSync(process.execPath, [SCRAPE, ...ids, '-o', tmp], { env, stdio: 'inherit' });
  if (!fs.existsSync(tmp)) {
    console.error('[FATAL] 抓取未产出结果文件，退出码 ' + r.status);
    return null;
  }
  const raw = JSON.parse(fs.readFileSync(tmp, 'utf8'));
  fs.unlinkSync(tmp);
  for (const x of (raw.results || [])) if (!x.ok) failedList.push({ input: x.input, error: x.error });
  return raw;
}

// ---------- 结果整形 ----------
function buildResults(raw) {
  return (raw.results || []).filter(x => x.ok).map(x => {
    const j = judgeDepth(x, N);
    const rows = (x.comments || []).length;
    // 该视频所属档位的评价门槛（6 档规则见 lib/quality.mjs）
    const rule = ruleFor(x.video.digg);
    return {
      videoId: x.video.videoId,
      desc: (x.video.desc || '').replace(/\s+/g, ' ').slice(0, 40),
      author: x.video.author,
      link: `https://www.douyin.com/video/${x.video.videoId}`,
      stat: { digg: x.video.digg, comment: x.video.comment, collect: x.video.collect, share: x.video.share },
      scraped: { rows, pages: x.commentPages, hasMore: x.commentHasMore, sec: x.sec },
      depthEnough: j.ok,
      depthReason: j.reason,
      depthDetail: j.detail,
      effectiveHighLike: j.effectiveHighLike,
      nthLike: j.nthLike,
      tiedAtNth: j.tiedAtNth,
      topMaxPos: j.topMaxPos,
      fetchedRows: rows,
      positionRisk: j.positionRisk,
      // 分层阈值：该视频所属档位 + 达标条数
      tierRule: { tier: rule.tier, label: rule.label, minLike: rule.minLike },
      qualifiedCount: j.top.filter(c => c.like >= rule.minLike).length,
      top: j.top.map((c, i) => ({
        rank: i + 1,
        cid: c.cid,
        like: c.like,
        text: c.text,
        name: c.name,
        ip: c.ip,
        replyTotal: c.replyTotal,
        createTime: c.createTime,
        likePctOfVideo: x.video.digg ? +(c.like / x.video.digg * 100).toFixed(2) : 0,
        // 该评论在抓取序列中的位置（第几条）—— 事后核验深度是否贴边
        streamPos: (x.comments || []).findIndex(y => y.cid === c.cid) + 1,
        // 是否达到该视频档位的评价门槛
        qualified: c.like >= rule.minLike,
      })),
    };
  });
}

// ---------- 主流程：抓 20 页 →（复检 或 未抓到底重抓）最多两次 ----------
console.log(`[dy_top] 目标 TOP${N}，单次最多 ${PAGES} 页，${inputs.length} 条视频，单视频最多抓 ${MAX_ATTEMPTS} 次${VERIFY ? '（复检模式）' : ''}`);

let pages = PAGES;
let attemptUsed = 1;
const raw0 = scrapeBatch(inputs, pages);
if (!raw0) process.exit(1);
let results = buildResults(raw0);
let verifyReport = null;

const NO_RETRY = ['COMMENT_ERROR', 'NO_COMMENTS', 'UNKNOWN_HAS_MORE', 'CID_MISSING'];
const notDone = results.filter(r => r.scraped.hasMore === 1 && !NO_RETRY.includes(r.depthReason));
// --verify：对所有视频做第二遍；否则只重抓未抓到底的
const targets = VERIFY ? results.map(r => r.videoId) : notDone.map(r => r.videoId);

if (MAX_ATTEMPTS >= 2 && targets.length) {
  const label = VERIFY ? '复检' : '重抓';
  const why = VERIFY ? '全部视频做第二遍' : `${targets.length} 条未抓到底（hasMore=1）`;
  console.log(`\n[${label}] ${why}，重新加载视频页再抓 ${pages} 页…`);

  const raw2 = scrapeBatch(targets, pages);
  if (raw2) {
    const second = buildResults(raw2);
    attemptUsed = 2;

    // 复检：逐视频比对「达标评价」的 cid 集合
    if (VERIFY) {
      verifyReport = results.map(r1 => {
        const r2 = second.find(x => x.videoId === r1.videoId);
        const s1 = new Set(r1.top.filter(c => c.qualified).map(c => c.cid));
        const s2 = new Set((r2?.top || []).filter(c => c.qualified).map(c => c.cid));
        const inter = [...s1].filter(c => s2.has(c)).length;
        const union = new Set([...s1, ...s2]).size;
        return {
          videoId: r1.videoId,
          qualified1: s1.size,
          qualified2: s2.size,
          overlap: union ? +(inter / union * 100).toFixed(1) : 100,   // Jaccard
          onlyIn1: s1.size - inter,
          onlyIn2: s2.size - inter,
          stable: union ? (inter / union) >= 0.7 : true,
        };
      });
      const avg = verifyReport.reduce((s, v) => s + v.overlap, 0) / verifyReport.length;
      const unstable = verifyReport.filter(v => !v.stable).length;
      console.log(`       复检平均重合率 ${avg.toFixed(1)}%（Jaccard）｜${unstable} 条低于 70%`);
    }

    // 取更好的结果（先看是否抓到底，再看抓到条数）
    const map = new Map(results.map(r => [r.videoId, r]));
    let improved = 0;
    for (const nr of second) {
      const old = map.get(nr.videoId);
      if (!old) { map.set(nr.videoId, nr); improved++; continue; }
      const better =
        (!nr.scraped.hasMore && old.scraped.hasMore) ||
        (!!nr.scraped.hasMore === !!old.scraped.hasMore && nr.fetchedRows > old.fetchedRows);
      if (better) { map.set(nr.videoId, nr); improved++; }
    }
    results = [...map.values()];
    if (!VERIFY) console.log(`       重抓后 ${improved}/${second.length} 条有改善`);

    // 把复检信息挂到每条结果上
    if (verifyReport) {
      const vm = new Map(verifyReport.map(v => [v.videoId, v]));
      results = results.map(r => ({ ...r, verify: vm.get(r.videoId) || null }));
    }
  }
}
// ---------- 控制台输出 ----------
console.log('\n' + '='.repeat(78));
for (const v of results) {
  console.log(`\n【${v.author}】${v.desc}`);
  console.log(`  ${v.link}`);
  console.log(`  赞 ${v.stat.digg} / 评 ${v.stat.comment} / 藏 ${v.stat.collect} / 转 ${v.stat.share}`);
  console.log(`  抓取 ${v.scraped.rows} 条 / ${v.scraped.pages} 页 / ${v.scraped.sec}s / 深度${v.depthEnough ? '足够 ✅' : '不足 ⚠️'} [${v.depthReason}]`);
  const posWarn = v.positionRisk > 85 && v.scraped.hasMore;
  console.log(`  TOP${v.top.length} 最靠后一条位于第 ${v.topMaxPos} 条（抓取量 ${v.positionRisk}%${posWarn ? ' ⚠️ 贴边且有下一页' : v.scraped.hasMore ? '' : '，已抓到底'}）`);
  console.log(`  达标(≥${v.tierRule.minLike}赞) ${v.qualifiedCount} 条 / 档位 ${v.tierRule.label}${v.verify ? `｜复检重合 ${v.verify.overlap}%` : ''}`);
  console.log(`  有效高赞(>10赞) ${v.effectiveHighLike} 条${v.tiedAtNth > 1 ? `　⚠️ 第${v.top.length}名与另外 ${v.tiedAtNth - 1} 条并列 ${v.nthLike} 赞，末位排名无区分度` : ''}`);
  console.log(`  ${'排名'.padEnd(4)}${'点赞'.padStart(7)}  ${'子回复'.padStart(5)}  地区    评论内容`);
  for (const c of v.top) {
    const t = (c.text || '').replace(/\s+/g, ' ').slice(0, 40);
    console.log(`  #${String(c.rank).padEnd(3)}${String(c.like).padStart(7)}  ${String(c.replyTotal).padStart(5)}  ${(c.ip || '—').padEnd(6)}  ${t}`);
  }
}
console.log('\n' + '='.repeat(78));

// ---------- 落盘 ----------
const payload = {
  scrapedAt: new Date().toISOString(),
  target: N,
  startPages: PAGES,
  finalPages: pages,
  attempts: attemptUsed,
  verify: verifyReport,
  totalSec: results.reduce((s, r) => s + (r.scraped.sec || 0), 0),
  results,
  failed: failedList,
};
const outAbs = path.resolve(outFile || path.join(DATA_ROOT, `top${N}_${Date.now()}.json`));
fs.mkdirSync(path.dirname(outAbs), { recursive: true });
fs.writeFileSync(outAbs, JSON.stringify(payload, null, 2), 'utf8');
console.log('[saved] ' + outAbs);

// ---------- Markdown ----------
if (mdFile) {
  const lines = [
    `# 抖音单视频最高赞评论 TOP${N}`, '',
    `抓取时间：${new Date().toLocaleString('zh-CN')}　|　起手 ${PAGES} 页 → 最终 ${pages} 页${pages > PAGES ? '（自动加深）' : ''}`, '',
  ];
  for (const v of results) {
    lines.push(`## ${v.author}｜${v.desc}`, '');
    lines.push(`- 视频：${v.link}`);
    lines.push(`- 数据：赞 ${v.stat.digg}　评 ${v.stat.comment}　藏 ${v.stat.collect}　转 ${v.stat.share}`);
    lines.push(`- 抓取：${v.scraped.rows} 条 / ${v.scraped.pages} 页 / ${v.scraped.sec}s / 深度${v.depthEnough ? '足够' : '可能不足'}（${v.depthReason}）`);
    lines.push(`- TOP${v.top.length} 分布深度：最靠后一条在第 ${v.topMaxPos} 条（占抓取量 ${v.positionRisk}%）`);
    lines.push(`- 有效高赞（>10 赞）：${v.effectiveHighLike} 条${v.tiedAtNth > 1 ? `；第 ${v.top.length} 名与另外 ${v.tiedAtNth - 1} 条并列 ${v.nthLike} 赞，末位排名无区分度` : ''}`);
    lines.push('', '| # | 点赞 | 占视频赞 | 评论内容 | 地区 | 子回复 | cid |', '|---|---|---|---|---|---|---|');
    for (const c of v.top) {
      const t = (c.text || '').replace(/\s+/g, ' ').replace(/\|/g, '\\|').slice(0, 60);
      lines.push(`| ${c.rank} | ${c.like} | ${c.likePctOfVideo}% | ${t} | ${c.ip || '—'} | ${c.replyTotal} | \`${c.cid}\` |`);
    }
    lines.push('');
  }
  const mdAbs = path.resolve(mdFile);
  fs.mkdirSync(path.dirname(mdAbs), { recursive: true });
  fs.writeFileSync(mdAbs, lines.join('\n'), 'utf8');
  console.log('[saved] ' + mdAbs);
}

// ---------- 退出码 ----------
const bad = results.filter(v => !v.depthEnough).length;
if (bad) {
  console.log(`[WARN] ${bad} 条视频深度判定不通过（已尝试加深到 ${pages} 页）：`);
  for (const v of results.filter(x => !x.depthEnough)) {
    console.log(`        ${v.videoId} ${v.author} → ${v.depthReason}：${v.depthDetail || ''}`);
  }
}
if (failedList.length) console.log(`[WARN] ${failedList.length} 条视频抓取失败（不存在/被删/私密/评论受限）`);

const problem = bad + failedList.length;
const code = problem === 0 ? 0 : (problem >= inputs.length ? 4 : 3);
if (code) console.error(`[WARN] ${problem}/${inputs.length} 条异常，退出码 ${code}`);
process.exit(code);
