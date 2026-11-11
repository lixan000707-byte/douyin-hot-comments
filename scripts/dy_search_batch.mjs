/**
 * 多关键词批量搜索（串行，词间自动冷却）
 *
 *   node dy_search_batch.mjs 女装 显瘦 牛仔裤 阔腿裤 微胖穿搭 [-o out.json] [--scroll 16]
 *
 * 说明：
 *  - 抖音网页端不公开播放量（接口无 play_count 字段），热度只能用点赞/评论衡量
 *  - 每个词内部复用 dy_search.mjs 的「首页预热 + 站内跳转」路径，避开验证码
 *  - 词与词之间冷却 8 秒，降低风控概率
 *  - 任一关键词失败不中断整体，结果里标记 status
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);

let SCROLL = 16, outFile = '';
const words = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--scroll') SCROLL = parseInt(argv[++i], 10) || 16;
  else if (a === '-o') outFile = argv[++i];
  else if (!a.startsWith('-')) words.push(a);
}
if (!words.length) {
  console.log('用法: node dy_search_batch.mjs 词1 词2 词3 ... [-o out.json] [--scroll 16]');
  process.exit(1);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const tmpDir = path.join(DATA_ROOT, 'dy_test_20261108');
fs.mkdirSync(tmpDir, { recursive: true });

const summary = [];
// 单次搜索：返回 stat；结果偏少或失败时由调用方决定是否重试
function runOnce(kw, idx, attempt, force = false) {
  const tmp = path.join(tmpDir, `_batch_${Date.now()}_${idx}_a${attempt}.json`);
  const r = spawnSync(process.execPath, [
    path.join(__dir, 'dy_search.mjs'), kw, '--scroll', String(SCROLL), '-o', tmp,
  ], {
    stdio: 'inherit',
    // 重试要绕过 dy_search 的词级冷却账本，否则自己把自己拦住
    env: force ? { ...process.env, DY_FORCE: '1' } : process.env,
  });

  const stat = { keyword: kw, status: 'FAIL', videos: 0, maxDigg: 0, over10w: 0, over1w: 0, medianDigg: 0, topVideo: null };
  if (!fs.existsSync(tmp)) { stat.error = '无输出文件'; return stat; }
  try {
    const j = JSON.parse(fs.readFileSync(tmp, 'utf8'));
    const v = j.videos || [];
    const diggs = v.map(x => x.digg).sort((a, b) => b - a);
    Object.assign(stat, {
      status: r.status === 0 ? 'OK' : `EXIT_${r.status}`,
      videos: v.length,
      accounts: new Set(v.map(x => x.author)).size,
      maxDigg: diggs[0] || 0,
      over10w: v.filter(x => x.digg > 100000).length,
      over1w: v.filter(x => x.digg >= 10000).length,
      medianDigg: diggs.length ? diggs[Math.floor(diggs.length / 2)] : 0,
      totalDigg: diggs.reduce((s, x) => s + x, 0),
      topVideo: v[0] ? { videoId: v[0].videoId, author: v[0].author, digg: v[0].digg, comment: v[0].comment, desc: (v[0].desc || '').slice(0, 30) } : null,
    });
    const keep = path.join(tmpDir, `search_${kw}_${Date.now()}_a${attempt}.json`);
    fs.renameSync(tmp, keep);
    stat.file = path.basename(keep);
  } catch (e) { stat.error = e.message; }
  return stat;
}

for (let i = 0; i < words.length; i++) {
  const kw = words[i];
  console.log(`\n${'='.repeat(60)}`);
  console.log(`[${i + 1}/${words.length}] 搜索「${kw}」`);
  console.log('='.repeat(60));

  let stat = runOnce(kw, i, 1);
  console.log(`  → ${stat.status} | 视频 ${stat.videos} 条 | 最高赞 ${stat.maxDigg.toLocaleString()}`);

  // 失败或结果偏少（<30 条）自动重试一次
  if (stat.status !== 'OK' || stat.videos < 30) {
    // 命中验证码（EXIT_4）时 5 秒必死，必须长冷却：实测连续搜索 3 词以上就会升级风控
    const wait = stat.status === 'EXIT_4' ? 120 : 20;
    console.log(`  ⚠️ 结果偏少或失败（${stat.status}），${wait} 秒后重试一次…`);
    await sleep(wait * 1000);
    const retry = runOnce(kw, i, 2, true);
    console.log(`  → 重试 ${retry.status} | 视频 ${retry.videos} 条 | 最高赞 ${retry.maxDigg.toLocaleString()}`);
    if (retry.videos > stat.videos || retry.status === 'OK') { retry.retried = true; stat = retry; }
  }

  summary.push(stat);
  if (i < words.length - 1) {
    // 词间冷却：实测 8 秒会连续触发验证码（5 词里 3 词挂），45 秒才稳
    const cooldown = process.env.DY_COOLDOWN ? parseInt(process.env.DY_COOLDOWN, 10) : 45;
    console.log(`  冷却 ${cooldown} 秒…`);
    await sleep(cooldown * 1000);
  }
}

// 汇总输出
console.log(`\n${'='.repeat(72)}`);
console.log('汇总（按最高点赞降序）');
console.log('='.repeat(72));
console.log('关键词'.padEnd(12), '视频数'.padStart(7), '账号'.padStart(6), '最高赞'.padStart(10), '中位赞'.padStart(9), '>10万'.padStart(6), '>1万'.padStart(6), '  TOP1 作者');
const sorted = [...summary].sort((a, b) => b.maxDigg - a.maxDigg);
for (const s of sorted) {
  console.log(
    (s.keyword || '').padEnd(12),
    String(s.videos).padStart(7),
    String(s.accounts || 0).padStart(6),
    String(s.maxDigg).padStart(10),
    String(s.medianDigg).padStart(9),
    String(s.over10w).padStart(6),
    String(s.over1w).padStart(6),
    '  ' + (s.topVideo ? `${s.topVideo.author} | ${s.topVideo.desc}` : '—'),
  );
}

const ok = summary.filter(s => s.status === 'OK').length;
console.log(`\n成功 ${ok}/${summary.length}`);

const abs = path.resolve(outFile || path.join(tmpDir, `batch_${Date.now()}.json`));
fs.writeFileSync(abs, JSON.stringify({ scrapedAt: new Date().toISOString(), scroll: SCROLL, summary }, null, 2), 'utf8');
console.log('[saved] ' + abs);
process.exit(ok === summary.length ? 0 : (ok ? 3 : 4));
