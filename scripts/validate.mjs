/**
 * validate.mjs — 产物字段校验（跨机交付前的最后一道闸）
 *
 *   node validate.mjs <json...> [--json] [--strict]
 *
 * 校验依据：references/schema.md（与 09_交接_B机/02_数据规范.md 同源）
 * 自动识别两类文件：
 *   results[].posts  → 达人主页（*_posts.json）
 *   results[].top    → 视频+评价（*_top.json）
 *
 * 退出码：0 通过 / 1 有 ERROR / 3 只有 WARN（--strict 时 WARN 也算 3）
 *
 * 为什么需要它：字段写错不会当场报错，要等 A 机入库时才炸；
 * 到那时 459 个账号已经跑完，返工成本比现在校验高一个数量级。
 */
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const JSON_OUT = argv.includes('--json');
const STRICT = argv.includes('--strict');
const files = argv.filter((a) => !a.startsWith('-'));

if (!files.length) {
  console.log('用法: node validate.mjs <json...> [--json] [--strict]');
  console.log('  校验 results[].posts（达人）与 results[].top（视频+评价）两类产物');
  process.exit(1);
}

const isInt = (v) => typeof v === 'number' && Number.isFinite(v) && Math.floor(v) === v;
const isStr = (v) => typeof v === 'string';
const isNull = (v) => v === null || v === undefined;
const SEC_MIN = 1_000_000_000;      // 2001
const SEC_MAX = 2_000_000_000;      // 2033

/** 秒级时间戳；毫秒会被 SEC_MAX 拦住 */
function checkCreateTime(v) {
  if (isNull(v)) return null;
  if (!isInt(v)) return `createTime 必须是整数（epoch 秒），当前是 ${typeof v}`;
  if (v > 1e11) return `createTime=${v} 看起来是毫秒，规范要求 epoch 秒`;
  if (v < SEC_MIN || v > SEC_MAX) return `createTime=${v} 超出合理范围（应为 epoch 秒）`;
  return null;
}

function checkNullableInt(v) {
  if (isNull(v)) return null;
  if (!isInt(v)) return `应为整数或 null，当前是 ${typeof v}`;
  if (v < 0) return `不应为负数（${v}）`;
  return null;
}

class Report {
  constructor(file) { this.file = file; this.issues = []; this.stats = {}; }
  err(p, m) { this.issues.push({ level: 'ERROR', path: p, msg: m }); }
  warn(p, m) { this.issues.push({ level: 'WARN', path: p, msg: m }); }
  get errors() { return this.issues.filter((i) => i.level === 'ERROR').length; }
  get warns() { return this.issues.filter((i) => i.level === 'WARN').length; }
}

// ---------- 达人主页 ----------
function validatePosts(rep, j) {
  if (!Array.isArray(j.results)) return rep.err('$', '缺少 results 数组');

  rep.stats.accounts = j.results.length;

  j.results.forEach((r, ri) => {
    const at = `results[${ri}]`;
    if (typeof r.ok !== 'boolean') rep.err(`${at}.ok`, '必须是布尔值');
    if (!isStr(r.secUid) || !r.secUid) rep.err(`${at}.secUid`, '必须是非空字符串');
    if (!isStr(r.url) || !r.url.includes('/user/')) rep.err(`${at}.url`, '缺少用户主页 URL');
    if (!isNull(r.err) && !isStr(r.err)) rep.err(`${at}.err`, '必须是字符串或 null');

    for (const k of ['pages', 'apiHits', 'total']) {
      if (!isInt(r[k])) rep.err(`${at}.${k}`, `必须是整数，当前 ${typeof r[k]}`);
    }
    // 历史数据用 0/1，规范示例写 true：两种都认，但不许是字符串
    if (!isNull(r.hasMore) && ![0, 1, true, false].includes(r.hasMore)) {
      rep.err(`${at}.hasMore`, `必须是 0/1（或 true/false），当前 ${JSON.stringify(r.hasMore)}`);
    }
    if (!['api', 'dom', 'none'].includes(r.source)) rep.err(`${at}.source`, `只能是 api/dom/none，当前 ${r.source}`);

    // profile
    const p = r.profile;
    if (!p || typeof p !== 'object') {
      rep.err(`${at}.profile`, '缺少 profile 对象');
    } else {
      for (const k of ['nickname', 'douyinId', 'ipLocation']) {
        if (!isNull(p[k]) && !isStr(p[k])) rep.err(`${at}.profile.${k}`, '必须是字符串或 null');
      }
      for (const k of ['fans', 'totalFavorited', 'awemeCount']) {
        const e = checkNullableInt(p[k]);
        if (e) rep.err(`${at}.profile.${k}`, e);
      }
      if (isStr(p.ipLocation) && /^IP属地/.test(p.ipLocation)) {
        rep.warn(`${at}.profile.ipLocation`, `含前缀「${p.ipLocation}」，入库前应去掉「IP属地：」`);
      }
      if (p.fans === 0) rep.warn(`${at}.profile.fans`, '为 0：确认是真 0 还是把 null 写成了 0');
    }

    // identityCheck
    const ic = r.identityCheck;
    if (!ic || typeof ic !== 'object') rep.err(`${at}.identityCheck`, '缺少身份校验对象');
    else if (typeof ic.ok !== 'boolean') rep.err(`${at}.identityCheck.ok`, '必须是布尔值');

    // posts
    if (!Array.isArray(r.posts)) { rep.err(`${at}.posts`, '必须是数组'); return; }
    const ids = new Set();
    let allZero = 0;
    r.posts.forEach((post, pi) => {
      const pat = `${at}.posts[${pi}]`;
      if (!isStr(post.id) || !/^\d+$/.test(post.id)) rep.err(`${pat}.id`, '必须是纯数字字符串');
      else if (ids.has(post.id)) rep.err(`${pat}.id`, `重复作品 ID ${post.id}`);
      else ids.add(post.id);

      if (!isNull(post.desc) && !isStr(post.desc)) rep.err(`${pat}.desc`, '必须是字符串');
      const te = checkCreateTime(post.createTime);
      if (te) rep.err(`${pat}.createTime`, te);
      if (![0, 1].includes(post.isTop)) rep.err(`${pat}.isTop`, '必须是 0 或 1');
      if (!isInt(post.type)) rep.err(`${pat}.type`, '必须是整数（0/4 视频，2/68 图文）');
      for (const k of ['digg', 'comment', 'collect', 'share']) {
        const e = checkNullableInt(post[k]);
        if (e) rep.err(`${pat}.${k}`, e);
      }
      if (post.digg === 0 && post.comment === 0 && post.collect === 0 && post.share === 0) allZero++;
    });

    // 四项全 0 大概率是把 null 补成了 0，这是明令禁止的。
    // 单条全 0 可能是真小号，只提醒；成片全 0 直接判错。
    if (allZero >= 5 && allZero / r.posts.length >= 0.3) {
      rep.err(`${at}.posts`, `${allZero}/${r.posts.length} 条四项指标全为 0，疑似把 null 写成了 0`);
    } else if (allZero) {
      rep.warn(`${at}.posts`, `${allZero}/${r.posts.length} 条四项指标全为 0，确认是小号还是 null 被补成 0`);
    }
    if (r.total !== r.posts.length) {
      rep.warn(`${at}.total`, `total=${r.total} 与 posts 长度 ${r.posts.length} 不一致`);
    }
  });
}

// ---------- 视频 + 评价 ----------
function validateTop(rep, j) {
  if (!Array.isArray(j.results)) return rep.err('$', '缺少 results 数组');
  rep.stats.videos = j.results.length;

  j.results.forEach((r, ri) => {
    const at = `results[${ri}]`;
    if (!isStr(r.videoId) || !r.videoId) rep.err(`${at}.videoId`, '必须是非空字符串');
    if (!r.stat || typeof r.stat !== 'object') rep.err(`${at}.stat`, '缺少 stat 对象');
    else {
      for (const k of ['digg', 'comment', 'collect', 'share']) {
        const e = checkNullableInt(r.stat[k]);
        if (e) rep.err(`${at}.stat.${k}`, e);
      }
    }
    if (!r.scraped || typeof r.scraped !== 'object') rep.err(`${at}.scraped`, '缺少 scraped 对象');
    else {
      for (const k of ['rows', 'pages']) {
        if (!isInt(r.scraped[k])) rep.err(`${at}.scraped.${k}`, '必须是整数');
      }
      if (!isNull(r.scraped.hasMore) && ![0, 1, true, false].includes(r.scraped.hasMore)) {
        rep.err(`${at}.scraped.hasMore`, '必须是 0/1 或 null');
      }
    }
    if (!r.tierRule || !isInt(r.tierRule.minLike)) rep.err(`${at}.tierRule`, '缺少 minLike');
    if (!isInt(r.qualifiedCount)) rep.err(`${at}.qualifiedCount`, '必须是整数');

    if (!Array.isArray(r.top)) { rep.err(`${at}.top`, '必须是数组'); return; }
    const cids = new Set();
    r.top.forEach((c, ci) => {
      const cat = `${at}.top[${ci}]`;
      if (!isStr(c.cid) || !c.cid) rep.err(`${cat}.cid`, '必须是非空字符串（全局唯一评论 ID）');
      else if (cids.has(c.cid)) rep.err(`${cat}.cid`, `重复 cid ${c.cid}`);
      else cids.add(c.cid);

      if (!isInt(c.rank)) rep.err(`${cat}.rank`, '必须是整数');
      const le = checkNullableInt(c.like);
      if (le) rep.err(`${cat}.like`, le);
      if (!isNull(c.text) && !isStr(c.text)) rep.err(`${cat}.text`, '必须是字符串');
      if (typeof c.qualified !== 'boolean') rep.err(`${cat}.qualified`, '必须是布尔值');
      if (!isNull(c.ip) && !isStr(c.ip)) rep.err(`${cat}.ip`, '必须是字符串或 null');
    });

    const qualified = r.top.filter((c) => c.qualified).length;
    if (isInt(r.qualifiedCount) && qualified !== r.qualifiedCount) {
      rep.warn(`${at}.qualifiedCount`, `声明 ${r.qualifiedCount}，实际 qualified=true 的有 ${qualified}`);
    }
  });
}

// ---------- 主流程 ----------
const reports = [];
for (const f of files) {
  const abs = path.resolve(f);
  const rep = new Report(abs);
  if (!fs.existsSync(abs)) { rep.err('$', '文件不存在'); reports.push(rep); continue; }
  let j;
  try {
    j = JSON.parse(fs.readFileSync(abs, 'utf8'));
  } catch (e) {
    rep.err('$', 'JSON 解析失败：' + e.message);
    reports.push(rep);
    continue;
  }
  const first = j?.results?.[0];
  if (first && Array.isArray(first.posts)) validatePosts(rep, j);
  else if (first && Array.isArray(first.top)) validateTop(rep, j);
  else rep.err('$', '无法识别文件类型：既没有 results[].posts，也没有 results[].top');
  reports.push(rep);
}

const totalErr = reports.reduce((s, r) => s + r.errors, 0);
const totalWarn = reports.reduce((s, r) => s + r.warns, 0);

if (JSON_OUT) {
  console.log(JSON.stringify({
    files: reports.map((r) => ({
      file: r.file, stats: r.stats, errors: r.errors, warns: r.warns, issues: r.issues,
    })),
    summary: { files: reports.length, errors: totalErr, warns: totalWarn },
  }, null, 2));
} else {
  for (const r of reports) {
    const mark = r.errors ? '❌' : r.warns ? '⚠️ ' : '✅';
    const extra = Object.entries(r.stats).map(([k, v]) => `${k}=${v}`).join(' ');
    console.log(`${mark} ${path.basename(r.file)}${extra ? '  —  ' + extra : ''}`);
    for (const i of r.issues) {
      // WARN 在非 strict 下也打印，但不影响退出码
      console.log(`     ${i.level === 'ERROR' ? '✗' : '·'} ${i.path}  ${i.msg}`);
    }
  }
  console.log(`\n汇总：${reports.length} 个文件 / ${totalErr} 个错误 / ${totalWarn} 个警告`);
}

process.exit(totalErr ? 1 : totalWarn ? 3 : 0);
