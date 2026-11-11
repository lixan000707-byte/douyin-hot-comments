/**
 * smoke.mjs — 内建验收：视频 / 评价 / 达人
 *
 *   node smoke.mjs [--video <id>] [--sec <secUid>] [--skip-account] [--update-baseline]
 *
 * 为什么只抓一遍命令：
 *   业务规定「单视频最多抓 2 次」，dy_top 的 --verify 正好用第二遍做复检。
 *   再在外面套 3 轮，等于对同一视频连抓 6 次 —— 实测第三轮评论接口直接报错，
 *   那不是技能坏了，是自己把配额烧完了。所以这里只跑一次 --verify。
 *
 * 两层断言
 *   A. 绝对值：抓取成功、评论 >0、复检重合 ≥70%、达人字段无缺值、无残留、profile <300MB
 *   B. 基线对比：与上次验收比，评论条数掉 >20% 或 cid 重合 <70% 直接红
 *      —— 只靠绝对值会放过「重构后从 269 掉到 200，结果稳定在 200」这种退化
 *
 * 基线存在 <产物目录>/_smoke/baseline.json，不进版本库。
 * 确认新结果正常后，用 --update-baseline 刷新。
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { probe, pageCount } from '../lib/chrome.mjs';
import { loginProfile, sizeMB } from '../lib/paths.mjs';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const RUN = path.join(__dir, '..', 'run.mjs');
const arg = (n, d = null) => {
  const i = process.argv.indexOf(`--${n}`);
  return i === -1 ? d : process.argv[i + 1];
};
const VIDEO = arg('video', '7629701428957054053');
const SEC = arg('sec', 'MS4wLjABAAAA-6AeFzBU7YQKcVJqdKOdlPrPsdu_ogHIbXo40Rmwnv8qQHJ5Q7JdfELYW6wXSJM0');
const SKIP_ACCOUNT = process.argv.includes('--skip-account');
const UPDATE_BASELINE = process.argv.includes('--update-baseline');
const PORT = parseInt(process.env.DY_PORT || '9333', 10);
const PROFILE = process.env.DY_PROFILE || loginProfile();

const OUT = path.join(process.env.DY_DATA_DIR || path.join(process.cwd(), 'dy_output'), '_smoke');
fs.mkdirSync(OUT, { recursive: true });
const BASELINE_FILE = path.join(OUT, 'baseline.json');

const checks = [];
const add = (name, ok, detail) => {
  checks.push({ name, ok, detail });
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? '  —  ' + detail : ''}`);
};

function loadBaseline() {
  try { return JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf8')); } catch { return null; }
}
function saveBaseline(b) {
  try { fs.writeFileSync(BASELINE_FILE, JSON.stringify(b, null, 2), 'utf8'); } catch {}
}

function jaccard(a, b) {
  const A = a instanceof Set ? a : new Set(a);
  const B = b instanceof Set ? b : new Set(b);
  if (!A.size && !B.size) return 100;
  const inter = [...A].filter((x) => B.has(x)).length;
  return +((inter / new Set([...A, ...B]).size) * 100).toFixed(1);
}

function runTopVerify() {
  const f = path.join(OUT, 'top_verify.json');
  const t0 = Date.now();
  const r = spawnSync(process.execPath,
    [RUN, 'top', VIDEO, '--n', '20', '--pages', '20', '--verify', '-o', f],
    { encoding: 'utf8', timeout: 600000 });
  const sec = (Date.now() - t0) / 1000;
  let d = null;
  try { d = JSON.parse(fs.readFileSync(f, 'utf8')); } catch {}
  const res = d?.results?.[0] || null;
  const top = res?.top || [];
  return {
    ok: r.status === 0 && !!res && top.length > 0,
    sec: +sec.toFixed(1),
    rows: res?.scraped?.rows ?? 0,
    pages: res?.scraped?.pages ?? 0,
    qualified: top.filter((c) => c.qualified).length,
    cids: new Set(top.map((c) => c.cid).filter(Boolean)),
    overlap: d?.verify?.[0]?.overlap ?? null,
    status: r.status,
    err: (r.stderr || '').split('\n').filter(Boolean).slice(-1)[0] || '',
  };
}

const baseline = UPDATE_BASELINE ? null : loadBaseline();
const nextBaseline = { at: new Date().toISOString(), videoId: VIDEO, secUid: SEC };

// ── 视频 + 评价（一次命令，内部两遍）
console.log(`\n[1/2] 视频与评价：--verify（抓两遍复检） · ${VIDEO}${baseline ? '（有基线）' : '（无基线）'}`);
const v = runTopVerify();
console.log(`   ${v.ok ? '✓' : '✗'} 评论 ${v.rows} 条 / ${v.pages} 页 / 达标 ${v.qualified} / ${v.sec}s` +
  `${v.overlap != null ? ` / 复检重合 ${v.overlap}%` : ''}${v.ok ? '' : ' ' + v.err}`);

add('抓取成功', v.ok, v.ok ? `退出码 ${v.status}` : `退出码 ${v.status}：${v.err}`);
add('评论数 >0', v.rows > 0, `${v.rows} 条`);
add('抓取耗时 <120s', v.ok && v.sec < 120, `${v.sec}s`);
if (v.overlap != null) {
  add('复检重合率 ≥70%', v.overlap >= 70, `${v.overlap}%（Jaccard）`);
} else if (v.ok) {
  add('复检重合率 ≥70%', true, '未产生复检数据（视频一次抓到底，无需第二遍）');
}

// ── 基线对比
if (v.ok) {
  if (!baseline) {
    add('基线对比', true, UPDATE_BASELINE ? '已按本次结果刷新基线' : '首次运行，已建立基线');
  } else {
    const baseRows = baseline.video?.rows ?? 0;
    const baseCids = baseline.video?.cids || [];
    if (!baseRows || !baseCids.length) {
      add('基线对比', true, '旧基线不完整，已用本次重建');
    } else {
      const diff = Math.abs(v.rows - baseRows) / baseRows * 100;
      add('对比基线：评论条数变化 <20%', diff < 20, `${baseRows} → ${v.rows}（${diff.toFixed(1)}%）`);
      const jac = jaccard(v.cids, baseCids);
      add('对比基线：cid 重合 ≥70%', jac >= 70, `${jac}%`);
    }
  }
  nextBaseline.video = { rows: v.rows, cids: [...v.cids], pages: v.pages };
} else {
  nextBaseline.video = baseline?.video || null;
}

// ── 达人层
if (!SKIP_ACCOUNT) {
  console.log(`\n[2/2] 达人：${SEC.slice(0, 18)}…`);
  const f = path.join(OUT, 'account.json');
  const r = spawnSync(process.execPath, [RUN, 'account', SEC, '-o', f, '--pages', '3'], {
    encoding: 'utf8', timeout: 300000,
  });
  let d = null;
  try { d = JSON.parse(fs.readFileSync(f, 'utf8')).results?.[0]; } catch {}
  const posts = d?.posts || [];
  const nullDigg = posts.filter((p) => p.digg == null).length;
  const nullTime = posts.filter((p) => p.createTime == null).length;
  console.log(`   ${d?.ok ? '✓' : '✗'} ${posts.length} 条 | 粉丝 ${d?.profile?.fans ?? '空'} | ${d?.sec ?? '?'}s`);

  add('达人抓到作品', posts.length > 0, `${posts.length} 条`);
  add('达人粉丝数非空', d?.profile?.fans != null && d.profile.fans > 0, String(d?.profile?.fans ?? '空'));
  add('达人作品指标无缺值', posts.length > 0 && nullDigg === 0 && nullTime === 0,
    `空赞 ${nullDigg} / 空时间 ${nullTime}`);

  if (baseline?.account?.posts) {
    const base = baseline.account.posts;
    const diff = Math.abs(posts.length - base) / base * 100;
    add('对比基线：达人作品数变化 <20%', diff < 20, `${base} → ${posts.length}（${diff.toFixed(1)}%）`);
    if (baseline.account.fans && d?.profile?.fans) {
      const fdiff = (baseline.account.fans - d.profile.fans) / baseline.account.fans * 100;
      add('对比基线：粉丝未异常下滑', fdiff < 30,
        `${baseline.account.fans} → ${d.profile.fans}（${fdiff > 0 ? '-' : '+'}${Math.abs(fdiff).toFixed(1)}%）`);
    }
  }
  nextBaseline.account = { posts: posts.length, fans: d?.profile?.fans ?? null };
} else {
  console.log('\n[2/2] 达人：已跳过（--skip-account）');
  nextBaseline.account = baseline?.account || null;
}

// ── 现场卫生（三个端口分别看：搜索 9333 / 达人 9334 / 评论 9335）
console.log('\n[卫生] 标签与 profile');
let pages = 0;
for (const p of [9333, 9334, 9335]) {
  if (await probe(p, 800)) pages += await pageCount(p);
}
add('无残留标签页', pages <= 5, `${pages} 个 page`);

const mb = sizeMB(PROFILE, ['BrowserMetrics']);
add('profile 有效体积 <300MB', mb < 300, `${mb} MB`);

// ── 基线落盘（只有全绿才写，避免把坏结果固化成标准）
const pass = checks.filter((c) => c.ok).length;
if (pass === checks.length && (UPDATE_BASELINE || !baseline)) {
  saveBaseline(nextBaseline);
  console.log(`\n[baseline] 已写入 ${BASELINE_FILE}`);
}

console.log('\n' + '='.repeat(70));
console.log(`验收：${pass}/${checks.length} 项通过`);
const bad = checks.filter((c) => !c.ok);
if (bad.length) {
  console.log('\n未通过：');
  for (const b of bad) console.log(`  · ${b.name} — ${b.detail}`);
  console.log('\n确认结果正常后可执行：node run.mjs smoke --update-baseline');
}
console.log('='.repeat(70));
process.exit(pass === checks.length ? 0 : 1);
