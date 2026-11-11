/**
 * 抖音端到端抓取：热门视频 / 关键词视频 → 各自的热门评价 → 报表
 *
 *   node dy_pipeline.mjs hot                          # 首页推荐流热门视频
 *   node dy_pipeline.mjs hot --top 6 --n 10
 *   node dy_pipeline.mjs keyword "牛仔裤"               # 指定关键词
 *   node dy_pipeline.mjs keyword "牛仔裤" --top 6 --n 10
 *
 * 通用参数：
 *   --top N      抓几条视频（默认 6）
 *   --n N        每条视频抓几条热门评价（默认 10）
 *   --scroll N   首页模式滚动轮数 / 关键词模式滚动轮数（默认 14）
 *   --min-comment N  跳过评论数低于此值的视频（默认 5，避免白跑）
 *   --out-dir DIR    产物目录（默认 工作区根目录）
 *   --no-report  只抓数据，不出报表
 *
 * 两条链路的差别：
 *   关键词模式：dy_search 直接给完整视频列表（含点赞/评论数）
 *   热门模式：dy_find_hot 只能从首页 DOM 拿到视频链接，必须再批量抓一次详情才有指标
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve((process.env.DY_ROOT || process.cwd()));
const DATA_ROOT = process.env.DY_DATA_DIR || path.join(ROOT, 'dy_output');

// ---------- 参数 ----------
const argv = process.argv.slice(2);
const mode = (argv[0] || '').toLowerCase();
if (!['hot', 'keyword'].includes(mode)) {
  console.log(`用法:
  node dy_pipeline.mjs hot                        # 热门视频（首页推荐流）
  node dy_pipeline.mjs hot --top 6 --n 10
  node dy_pipeline.mjs keyword "牛仔裤"            # 指定关键词
  node dy_pipeline.mjs keyword "牛仔裤" --top 6

通用参数: --top N  --n N  --scroll N  --min-comment N  --out-dir DIR  --no-report`);
  process.exit(1);
}

let TOP = 6, PER = 20, SCROLL = 14, MIN_COMMENT = 5, noReport = false, keyword = '';
// 默认落到 data/douyin/out/，不再往根目录堆报告（根目录已经有 15 个抖音报告了）
let outDir = DATA_ROOT;
for (let i = 1; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--top') TOP = parseInt(argv[++i], 10) || 6;
  else if (a === '--n') PER = parseInt(argv[++i], 10) || 20;
  else if (a === '--scroll') SCROLL = parseInt(argv[++i], 10) || 14;
  else if (a === '--min-comment') MIN_COMMENT = parseInt(argv[++i], 10) || 0;
  else if (a === '--out-dir') outDir = path.resolve(argv[++i]);
  else if (a === '--no-report') noReport = true;
  else if (!a.startsWith('-') && mode === 'keyword' && !keyword) keyword = a;
}
if (mode === 'keyword' && !keyword) {
  console.error('[FATAL] keyword 模式必须给关键词，例如：node dy_pipeline.mjs keyword "牛仔裤"');
  process.exit(1);
}

const ts = Date.now();
const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
const workDir = path.join(DATA_ROOT, `_pipeline_${ts}`);
fs.mkdirSync(workDir, { recursive: true });
fs.mkdirSync(outDir, { recursive: true });

const label = mode === 'keyword' ? keyword : '热门推荐';
const t0 = Date.now();
const stage = (k, msg) => console.log(`\n${'─'.repeat(60)}\n[${k}] ${msg}\n${'─'.repeat(60)}`);
// 同步 sleep：整条链路是 spawnSync 串起来的，用不了 await
const sleepSync = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function run(script, args, env = {}) {
  const r = spawnSync(process.execPath, [path.join(__dir, script), ...args], {
    stdio: 'inherit',
    env: { ...process.env, ...env },
  });
  return r.status;
}

// ---------- ① 拿视频列表 ----------
stage('1/4', mode === 'keyword' ? `搜索关键词「${keyword}」` : '抓取首页推荐流热门视频');

let videos = [];
if (mode === 'keyword') {
  const out = path.join(workDir, 'search.json');
  const code = run('dy_search.mjs', [keyword, '--scroll', String(SCROLL), '-o', out]);
  if (!fs.existsSync(out)) { console.error('[FATAL] 搜索未产出数据'); process.exit(4); }
  const j = JSON.parse(fs.readFileSync(out, 'utf8'));
  videos = (j.videos || []).map(v => ({ ...v }));
  console.log(`[汇总] 搜索到 ${videos.length} 条视频，状态 ${j.outcome || '?'}`);
  if (code !== 0 && !videos.length) { console.error('[FATAL] 搜索失败且无数据'); process.exit(code); }
  if (code !== 0) console.warn(`[WARN] 搜索返回码 ${code}（数据偏少或受限）`);

  // 按词限流是常态：只拿到十几条时不能直接用，否则 TOP N 的质量断崖
  if (videos.length < 30 && process.env.DY_NO_RETRY !== '1') {
    console.log(`\n[重试] 只拿到 ${videos.length} 条（正常 100+），45 秒后重试一次…`);
    sleepSync(45000);
    const out2 = path.join(workDir, 'search_retry.json');
    // DY_FORCE=1 绕过 dy_search 自己的词级冷却账本
    run('dy_search.mjs', [keyword, '--scroll', String(SCROLL), '-o', out2], { DY_FORCE: '1' });
    if (fs.existsSync(out2)) {
      const j2 = JSON.parse(fs.readFileSync(out2, 'utf8'));
      const v2 = (j2.videos || []).map(v => ({ ...v }));
      if (v2.length > videos.length) {
        console.log(`[重试] 拿到 ${v2.length} 条（首次 ${videos.length} 条），采用重试结果`);
        videos = v2;
      } else {
        console.log(`[重试] 仍只有 ${v2.length} 条，沿用原结果`);
      }
    }
  }
} else {
  // 首页推荐流：先拿链接，再批量补详情
  const hotFile = path.join(workDir, 'hot_links.json');
  const code = run('dy_find_hot.mjs', ['--scroll', String(SCROLL), '-o', hotFile]);
  if (!fs.existsSync(hotFile)) { console.error('[FATAL] 首页抓取未产出数据'); process.exit(4); }
  const hj = JSON.parse(fs.readFileSync(hotFile, 'utf8'));
  let links = [...new Set([...(hj.domLinks || [])])];
  console.log(`[汇总] 首页拿到 ${links.length} 条视频链接（推荐流是随机样本，不是全站榜单）`);

  // 推荐流每次内容不同：链接太少时再抓一轮并合并，能显著扩大候选池
  if (links.length < 25 && process.env.DY_NO_RETRY !== '1') {
    console.log(`\n[重试] 链接偏少（${links.length} 条），再抓一轮并合并…`);
    sleepSync(8000);
    const hotFile2 = path.join(workDir, 'hot_links2.json');
    run('dy_find_hot.mjs', ['--scroll', String(SCROLL), '-o', hotFile2]);
    if (fs.existsSync(hotFile2)) {
      const hj2 = JSON.parse(fs.readFileSync(hotFile2, 'utf8'));
      const before = links.length;
      links = [...new Set([...links, ...(hj2.domLinks || [])])];
      console.log(`[重试] 新增 ${links.length - before} 条，候选池 ${links.length} 条`);
    }
  }

  if (!links.length) {
    console.error('[FATAL] 首页没有拿到任何视频链接 —— 可能命中验证码或页面未加载');
    process.exit(4);
  }

  stage('2/4', `批量抓详情补指标（${links.length} 条，只抓视频数据不抓评论）`);
  const detailFile = path.join(workDir, 'hot_detail.json');
  run('dy_scrape.mjs', [...links, '--data-only', '--par', '3', '-o', detailFile]);
  if (!fs.existsSync(detailFile)) { console.error('[FATAL] 批量详情未产出数据'); process.exit(4); }
  const dj = JSON.parse(fs.readFileSync(detailFile, 'utf8'));
  videos = (dj.results || []).filter(x => x.ok).map(x => ({
    videoId: x.video.videoId,
    desc: (x.video.desc || '').replace(/\s+/g, ' ').slice(0, 50),
    author: x.video.author,
    digg: x.video.digg,
    comment: x.video.comment,
    collect: x.video.collect,
    share: x.video.share,
  }));
  console.log(`[汇总] 成功拿到 ${videos.length} 条视频指标`);
}

// ---------- 挑选 TOP N ----------
if (mode === 'hot') stage('3/4', `按点赞排序，挑出 TOP${TOP}`);
else stage('2/4', `按点赞排序，挑出 TOP${TOP}`);

videos.sort((a, b) => b.digg - a.digg);
const eligible = videos.filter(v => (v.comment || 0) >= MIN_COMMENT);
const skipped = videos.length - eligible.length;
const picked = eligible.slice(0, TOP);

console.log(`[候选] 共 ${videos.length} 条，评论数 ≥${MIN_COMMENT} 的 ${eligible.length} 条${skipped ? `（跳过 ${skipped} 条评论过少的）` : ''}`);
console.log(`[入选] TOP${picked.length}：`);
for (const [i, v] of picked.entries()) {
  console.log(`  ${i + 1}. ${String(v.digg).padStart(9)} 赞  ${String(v.comment).padStart(7)} 评  @${v.author} | ${(v.desc || '').slice(0, 34)}`);
}
if (!picked.length) { console.error('[FATAL] 没有可选视频'); process.exit(4); }

// 写一份 search 结构的 JSON，供报表生成器复用
const searchLike = {
  keyword: label,
  scrapedAt: new Date().toISOString(),
  source: mode === 'keyword' ? 'keyword_search' : 'home_feed',
  videos,
};
const searchJson = path.join(workDir, 'videos.json');
fs.writeFileSync(searchJson, JSON.stringify(searchLike, null, 2), 'utf8');

// ---------- 抓热门评价 ----------
stage(mode === 'keyword' ? '3/4' : '4/4', `抓这 ${picked.length} 条视频的热门评价（每条 TOP${PER}）`);
const commentsJson = path.join(workDir, 'comments.json');
const mdFile = path.join(outDir, `抖音_${mode === 'keyword' ? keyword : '热门'}_评价明细_${stamp}.md`);
const cCode = run('dy_top.mjs', [
  ...picked.map(v => v.videoId), '--n', String(PER), '-o', commentsJson, '--md', mdFile,
]);

// 把关键 JSON 复制到产物目录，方便直接追加台账
const commentsOut = path.join(outDir, `抖音_${mode === 'keyword' ? keyword : '热门'}_comments_${stamp}.json`);
try { fs.copyFileSync(commentsJson, commentsOut); } catch {}

// ---------- 出报表 ----------
let htmlFile = '';
let csvFile = '';
if (!noReport && fs.existsSync(commentsJson)) {
  stage(mode === 'keyword' ? '4/4' : '完成', '生成报表');
  htmlFile = path.join(outDir, `抖音_${mode === 'keyword' ? keyword : '热门'}_抓取报告_${stamp}.html`);
  run('gen_search_report.mjs', [
    '--search', searchJson, '--comments', commentsJson, '--kw', label, '-o', htmlFile,
  ]);

  // 顺手导一份评论明细 CSV（报表生成器只出 HTML）
  try {
    const C = JSON.parse(fs.readFileSync(commentsJson, 'utf8'));
    const rows = [['视频序号', '作者', '视频ID', '视频点赞', '视频评论', '排名', '评价点赞', '评价内容', '地区', '子回复', 'cid']];
    (C.results || []).forEach((r, i) => {
      (r.top || []).forEach(c => {
        rows.push([
          i + 1, r.author, r.videoId, r.stat.digg, r.stat.comment,
          c.rank, c.like,
          (c.text || '').replace(/[\r\n]+/g, ' ').replace(/,/g, '，'),
          c.ip || '', c.replyTotal, c.cid,
        ]);
      });
    });
    const csv = '\ufeff' + rows.map(r => r.map(x => /[,"]/.test(String(x)) ? '"' + String(x).replace(/"/g, '""') + '"' : x).join(',')).join('\n');
    csvFile = path.join(outDir, `抖音_${mode === 'keyword' ? keyword : '热门'}_评价数据_${stamp}.csv`);
    fs.writeFileSync(csvFile, csv, 'utf8');
  } catch (e) { console.warn('[WARN] CSV 导出失败: ' + e.message); }
}

// ---------- 收尾摘要 ----------
const sec = ((Date.now() - t0) / 1000).toFixed(1);
console.log(`\n${'='.repeat(60)}`);
console.log(`完成｜${label}｜${picked.length} 条视频 × TOP${PER} 评价｜总耗时 ${sec}s`);
console.log(`  视频列表  ${searchJson}`);
if (fs.existsSync(commentsJson)) console.log(`  评价数据  ${commentsJson}`);
if (mdFile) console.log(`  明细 Markdown  ${mdFile}`);
if (csvFile) console.log(`  明细 CSV       ${csvFile}`);
if (htmlFile) console.log(`  报表           ${htmlFile}`);
console.log(`  中间数据  ${workDir}`);

const cFail = cCode !== 0;
if (cFail) console.log(`\n[WARN] 评价抓取返回码 ${cCode}（部分视频深度不足或抓取失败，详见上方日志）`);
process.exit(cFail ? 3 : 0);
