/**
 * dy_account.mjs — 达人主页层：账号信息 + 作品列表 + 每条作品指标
 *
 *   node dy_account.mjs <secUid|主页URL>... [-o out.json|outdir] [--pages 8]
 *                       [--expect 昵称] [--allow-dom] [--resume]
 *                       [--sweep-every 10] [--breaker 5] [--no-sweep]
 *
 * 这是技能原先缺的那一半：视频+评论只覆盖「内容」，达人主页覆盖「人」。
 *
 * 三层数据源（按可靠性排序）
 *   1. iesdouyin /web/api/v2/user/info/  → 身份四件套（无需登录）
 *   2. CDP 嗅探 /aweme/v1/web/aweme/post/ + /user/profile/other/
 *   3. DOM 作品网格兜底（默认关闭：拿不到指标的数据不进库）
 *
 * 输出字段严格遵循 09_交接_B机/02_数据规范.md：
 *   profile.fans / posts[].digg / posts[].createTime（epoch 秒）
 *   缺值写 null，绝不写 0 —— 0 会参与统计，把中位数拉低。
 */
import fs from 'node:fs';
import path from 'node:path';
import { ensure, newTab, closeTab, restart, probe, sweep, stats } from '../lib/chrome.mjs';
import { sniff } from '../lib/cdp.mjs';
import { loginProfile, sizeMB } from '../lib/paths.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (a, b) => a + Math.random() * (b - a);

// ---------- 参数 ----------
const argv = process.argv.slice(2);
let outArg = '';
let maxPages = 8;
let expectName = null;
let allowDom = false;
let resume = false;
let sweepEvery = 10;
let breaker = 5;
let noSweep = false;
// 达人层用登录 profile，评论层用 work profile。
// 两者若共用同一端口，先退出的浏览器还没关干净，后一个就会「复用」到错误 profile 的实例，
// 表现为作品接口一个请求都不发、抓到 0 条。所以默认分端口。
let port = parseInt(
  process.env.DY_PORT_ACCOUNT || (process.env.DY_PORT ? process.env.DY_PORT : '9334'),
  10,
);
const targets = [];

for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '-o') outArg = argv[++i];
  else if (a === '--pages') maxPages = parseInt(argv[++i], 10) || 8;
  else if (a === '--expect') expectName = argv[++i] || null;
  else if (a === '--allow-dom') allowDom = true;
  else if (a === '--resume') resume = true;
  else if (a === '--sweep-every') sweepEvery = parseInt(argv[++i], 10) || 10;
  else if (a === '--breaker') breaker = parseInt(argv[++i], 10) || 5;
  else if (a === '--no-sweep') noSweep = true;
  else if (a === '--port') port = parseInt(argv[++i], 10) || port;
  else if (a.startsWith('-')) { console.error('未知参数: ' + a); process.exit(1); }
  else targets.push(a);
}

if (!targets.length) {
  console.log('用法: node dy_account.mjs <secUid|主页URL>... [-o out.json|outdir] [--pages 8] [--resume]');
  console.log('  单账号 -o 写文件；多账号 -o 视为目录，每账号一个 <secUid>_posts.json');
  process.exit(1);
}

const PROFILE = process.env.DY_PROFILE || loginProfile();
const DATA_ROOT = process.env.DY_DATA_DIR || path.join(process.env.DY_ROOT || process.cwd(), 'dy_output');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36';

const secOf = (s) => (String(s).includes('/user/') ? String(s).split('/user/')[1].split(/[?#]/)[0] : String(s));
const clean = targets.map(secOf).filter(Boolean);
if (!clean.length) { console.error('[FATAL] 没有可解析的 secUid'); process.exit(1); }

// 输出：单账号 = 文件；多账号 = 目录
const single = clean.length === 1 && /\.json$/i.test(outArg || '');
const OUT_DIR = single
  ? path.dirname(path.resolve(outArg))
  : path.resolve(outArg || DATA_ROOT);
const ERR_DIR = path.join(OUT_DIR, '_errors');
fs.mkdirSync(OUT_DIR, { recursive: true });

const outFileFor = (sec) => (single ? path.resolve(outArg) : path.join(OUT_DIR, `${sec}_posts.json`));

// ---------- 小工具 ----------
function parseCount(s) {
  if (s == null) return null;
  if (typeof s === 'number') return s;
  const t = String(s).replace(/[,，\s]/g, '');
  const m = t.match(/(\d+(?:\.\d+)?)(万|w|W)?/);
  if (!m) return null;
  return Math.round(parseFloat(m[1]) * (m[2] ? 10000 : 1));
}

async function waitReady(cdp, { timeout = 28000, minText = 300 } = {}) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try {
      const st = await cdp.eval('({r:document.readyState,t:(document.body&&document.body.innerText||"").length})');
      if (st.r !== 'loading' && st.t >= minText) return true;
    } catch {}
    await sleep(800);
  }
  return false;
}

/** 主页头部字段：RENDER_DATA 优先，DOM 正则兜底 */
async function readProfile(cdp) {
  return cdp.eval(`(() => {
    const out = {};
    const el = document.querySelector('#RENDER_DATA');
    if (el) {
      try {
        const j = JSON.parse(decodeURIComponent(el.textContent));
        const walk = (o, d) => {
          if (!o || typeof o !== 'object' || d > 12) return;
          for (const [k, v] of Object.entries(o)) {
            if (v && typeof v === 'object') walk(v, d + 1);
            else {
              if (k === 'followerCount' && out.fans == null) out.fans = v;
              if (k === 'totalFavorited' && out.likes == null) out.likes = v;
              if (k === 'uniqueId' && !out.douyinId) out.douyinId = v;
              if (k === 'nickname' && !out.nickname) out.nickname = v;
              if (k === 'ipLocation' && !out.ip) out.ip = v;
              if (k === 'awemeCount' && out.awemeCount == null) out.awemeCount = v;
            }
          }
        };
        walk(j, 0);
      } catch (e) {}
    }
    const t = (document.body && document.body.innerText) || '';
    const pick = (re) => { const m = t.match(re); return m ? m[1].trim() : null; };
    out.nickname ||= pick(/([^\\n]{2,30})的抖音/);
    out.fans ??= pick(/粉丝[\\s:：]*([\\d.]+\\s*万?)/);
    out.likes ??= pick(/获赞[\\s:：]*([\\d.]+\\s*万?)/);
    out.douyinId ||= pick(/抖音号[\\s:：]*([\\w.\\-]+)/);
    out.ip ||= pick(/IP属地[\\s:：]*([^\\s\\n]{2,8})/);
    out.title = document.title;
    out.bodyLen = t.length;
    return out;
  })()`);
}

/** 身份接口：不依赖浏览器，失败不阻断（粉丝数还有 profile/other 兜底） */
async function fetchIdentity(secUid) {
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(`https://www.iesdouyin.com/web/api/v2/user/info/?sec_uid=${secUid}`,
        { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(12000) });
      const txt = await r.text();
      if (!txt || txt[0] !== '{') throw new Error(`空响应/非 JSON（HTTP ${r.status}）`);
      const u = JSON.parse(txt).user_info || {};
      return {
        nickname: u.nickname || null,
        douyinId: u.unique_id || null,
        totalFavorited: parseCount(u.total_favorited),
        awemeCount: u.aweme_count ?? null,
      };
    } catch (e) {
      if (i === 2) return { error: String(e.message || e) };
      await sleep(1500 * (i + 1));
    }
  }
}

// ---------- 单账号 ----------
async function scrapeAccount(secUid, identity) {
  const t0 = Date.now();
  const url = `https://www.douyin.com/user/${secUid}`;
  const items = new Map();
  let apiHits = 0;
  let pages = 0;
  let hasMore = null;
  let author = null;
  let blocked = false;
  let apiAuthor = null;
  let apiUser = null;

  const { cdp, targetId } = await newTab(port);
  let offPost = null;
  let offProfile = null;
  try {
    await cdp.send('Network.enable');
    // 缓存必须禁：走缓存时作品接口根本不发请求，嗅探器只能干等（第二次抓同一账号必空）
    await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });

    offPost = sniff(cdp, '/aweme/v1/web/aweme/post/', (j) => {
      apiHits++;
      pages++;
      if (j.has_more != null) hasMore = j.has_more;
      if (j.status_code && j.status_code !== 0) blocked = true;
      const first = (j.aweme_list || [])[0];
      if (first?.author && !apiAuthor) apiAuthor = first.author;
      for (const aw of j.aweme_list || []) {
        const st = aw.statistics || {};
        if (!items.has(aw.aweme_id)) {
          author ||= aw.author?.nickname || null;
          items.set(String(aw.aweme_id), {
            id: String(aw.aweme_id),
            desc: aw.desc || '',
            createTime: aw.create_time,
            isTop: aw.is_top ? 1 : 0,
            type: aw.aweme_type ?? 0,
            digg: st.digg_count ?? null,
            comment: st.comment_count ?? null,
            collect: st.collect_count ?? null,
            share: st.share_count ?? null,
          });
        }
      }
    });

    offProfile = sniff(cdp, '/aweme/v1/web/user/profile/other/', (j) => {
      const u = j.user || j.user_info || null;
      if (u && !apiUser) apiUser = u;
    });

    await cdp.send('Page.navigate', { url });
    await sleep(rand(2000, 3000));
    const ready = await waitReady(cdp, { timeout: 28000, minText: 300 });
    if (!ready) console.log('  ⚠ 页面未在 28s 内渲染完（可能验证码/限流）');

    const profileEarly = await readProfile(cdp);

    // 点「作品」页签：内联文本可能是「作品 128」「作品\n128」，用前缀匹配
    const clickWorksTab = async () => {
      try {
        return await cdp.eval(`(() => {
          const t = [...document.querySelectorAll('div,span,a')]
            .filter(e => e.children.length === 0 && /^作品/.test((e.innerText||'').trim()));
          if (t[0]) { t[0].click(); return 'ok'; }
          return 'no-tab';
        })()`);
      } catch { return 'err'; }
    };

    // 主页是内部滚动容器，只改 scrollTop 常常触发不了懒加载；
    // 真实滚轮事件才稳（与 dy_scrape 的做法一致）
    const scrollOnce = async () => {
      try {
        await cdp.send('Input.dispatchMouseEvent', {
          type: 'mouseWheel', x: 640, y: 700, deltaX: 0, deltaY: 1200, pointerType: 'mouse',
        });
      } catch {}
      try {
        await cdp.eval(`(() => {
          const box = document.querySelector('[data-e2e="user-post-list"]')
                   || document.querySelector('[data-e2e="scroll-list"]')
                   || document.scrollingElement;
          if (box) box.scrollTop = box.scrollHeight;
          window.scrollTo(0, document.body.scrollHeight);
        })()`);
      } catch {}
    };

    await clickWorksTab();
    await sleep(rand(1500, 2200));

    // 零结果：忽略缓存重载一轮（A07）。重载后必须重新点页签，
    // 否则页面回到默认 tab，作品接口永远不会发请求。
    for (let round = 0; round < 2 && items.size === 0; round++) {
      if (round > 0) {
        console.log('  第一轮零结果，忽略缓存重载…');
        await cdp.send('Page.reload', { ignoreCache: true });
        await sleep(rand(5000, 7000));
        await waitReady(cdp, { timeout: 20000, minText: 300 });
        await clickWorksTab();
        await sleep(rand(1200, 1800));
      }
      for (let i = 0; i < maxPages * 3; i++) {
        const before = items.size;
        await scrollOnce();
        await sleep(rand(1300, 2100));
        if (items.size === before) break;
      }
    }

    // DOM 兜底：默认关闭（无指标的数据不进库）
    let domFallback = 0;
    let domRejected = null;
    const pageNameNow = (await cdp.eval('document.title')).replace(/的抖音.*$/, '').trim();
    const idName = identity.nickname || '';
    if (items.size === 0 && !allowDom) {
      domRejected = '未启用 DOM 兜底（--allow-dom 才开）：无点赞/评论指标的数据不进库';
    } else if (items.size === 0) {
      if (idName && pageNameNow !== idName) {
        domRejected = `页面标题「${pageNameNow}」≠ 接口昵称「${idName}」，拒绝 DOM 兜底`;
      } else {
        const dom = await cdp.eval(`(() => {
          const box = document.querySelector('[data-e2e="user-post-list"]')
                   || document.querySelector('[data-e2e="scroll-list"]')
                   || document.querySelector('ul[class*="list"]');
          if (!box) return { err: 'no-grid', items: [] };
          const out = [];
          for (const a of box.querySelectorAll('a[href*="/video/"], a[href*="/note/"]')) {
            const m = (a.getAttribute('href') || '').match(/\\/(video|note)\\/(\\d+)/);
            if (!m) continue;
            const li = a.closest('li') || a.parentElement;
            const txt = (li && li.innerText || '').split('\\n').map(s => s.trim()).filter(Boolean);
            out.push({ id: m[2], kind: m[1], lines: txt.slice(0, 2) });
          }
          return { err: null, items: out };
        })()`);
        if (dom.err) domRejected = `找不到作品网格容器（${dom.err}）`;
        else {
          const uniq = new Map();
          for (const d of dom.items) if (!uniq.has(d.id)) uniq.set(d.id, d);
          for (const [id, d] of uniq) {
            items.set(id, {
              id,
              desc: (d.lines.find((x) => !/^[\d.]+万?$/.test(x)) || '').slice(0, 120),
              createTime: null,
              isTop: 0,
              type: d.kind === 'note' ? 2 : 0,
              digg: null, comment: null, collect: null, share: null,
            });
            domFallback++;
          }
        }
      }
    }

    const profileLate = await readProfile(cdp);
    const domProfile = {};
    for (const k of new Set([...Object.keys(profileEarly), ...Object.keys(profileLate)])) {
      domProfile[k] = profileEarly[k] ?? profileLate[k];
    }

    const pageName = (domProfile.nickname || (domProfile.title || '').replace(/的抖音.*$/, '') || '').trim();
    // IP 属地接口有时直接返回「IP属地：福建」，入库前统一去前缀
    const cleanIp = (v) => {
      if (!v) return null;
      const s = String(v).replace(/^IP属地\s*[:：]?\s*/, '').trim();
      return s || null;
    };

    let nameWarn = null;
    if (expectName && identity.nickname && identity.nickname !== expectName) {
      nameWarn = `昵称已变：表内「${expectName}」→ 当前「${identity.nickname}」`;
    }
    if (identity.nickname && pageName && identity.nickname !== pageName) {
      nameWarn = (nameWarn ? nameWarn + '；' : '') + `接口与页面昵称不一致（${identity.nickname} / ${pageName}）`;
    }

    const posts = [...items.values()].sort((x, y) => (y.createTime || 0) - (x.createTime || 0));
    const notes = [];
    if (posts.length === 0) {
      let diag = null;
      try {
        diag = await cdp.eval(
          '({u:location.href,t:document.title,n:(document.body&&document.body.innerText||"").length,' +
          'x:(document.body&&document.body.innerText||"").replace(/\\s+/g," ").slice(0,90)})');
      } catch {}

      const bodyLen = diag?.n || 0;
      // 先按正文长度判，别把「账号失效」一律说成「登录态失效」——
      // 实测假 sec_uid 的页面只有 500 多字，报登录问题会把人带偏。
      if (bodyLen > 0 && bodyLen < 1200) {
        notes.push(`页面正文仅 ${bodyLen} 字（账号失效 / 私域 / 被降级），不是登录问题`);
      } else if (blocked) {
        notes.push('接口返回非 0 status_code：触发风控');
      } else if (apiHits === 0) {
        notes.push('作品接口未发出请求：登录态失效或页面被风控降级');
      }
      if (domRejected) notes.push(domRejected);
      if (diag) notes.push(`现场: ${diag.t || '(无标题)'} | 文本${diag.n}字 | ${diag.x}`);
    }
    if (domFallback) notes.push(`${domFallback} 条来自 DOM 兜底，无点赞/评论等指标`);

    const ok = posts.length > 0;

    return {
      ok,
      secUid,
      url,
      author: author || identity.nickname || pageName || null,
      err: notes.join('；') || null,
      pages,
      hasMore,
      apiHits,
      total: posts.length,
      source: apiHits > 0 ? 'api' : (domFallback ? 'dom' : 'none'),
      profile: {
        nickname: apiUser?.nickname || apiAuthor?.nickname || identity.nickname || pageName || null,
        douyinId: apiUser?.unique_id || apiAuthor?.unique_id || identity.douyinId || domProfile.douyinId || null,
        fans: apiUser?.follower_count ?? apiAuthor?.follower_count ?? parseCount(domProfile.fans),
        totalFavorited: apiUser?.total_favorited ?? apiAuthor?.total_favorited ?? identity.totalFavorited ?? parseCount(domProfile.likes),
        ipLocation: cleanIp(apiUser?.ip_location || apiAuthor?.ip_location || domProfile.ip),
        awemeCount: apiUser?.aweme_count ?? apiAuthor?.aweme_count ?? identity.awemeCount ?? parseCount(domProfile.awemeCount),
      },
      // 昵称会改，sec_uid 不会：校验降级为 warning，不中止（A11）
      identityCheck: { api: identity.nickname, page: pageName || author || identity.nickname || null, ok: true, warning: nameWarn },
      posts,
      sec: +((Date.now() - t0) / 1000).toFixed(1),
    };
  } finally {
    try { offPost?.(); offProfile?.(); } catch {}
    cdp.close();
    await closeTab(port, targetId);
  }
}

// ---------- 主流程 ----------
const identityCache = new Map();
console.log(`[account] ${clean.length} 个账号 | profile ${PROFILE} | 每 ${sweepEvery} 个重启 | 熔断 ${breaker}`);

// 启动前治理 profile：此时浏览器没起，删缓存不会碰到文件锁。
// 运行中删会被句柄挡住，rm 静默失败——看着修了，其实一点没清。
if (!(await probe(port))) {
  await sweep({ port, profile: PROFILE, maxMB: 300, reset: false, log: true });
}
try {
  const ver = await ensure({ port, profile: PROFILE });
  console.log(`[chrome] ${ver.browser} port=${port}${ver.reused ? '（复用）' : ''}`);
} catch (e) {
  console.error('[FATAL] ' + e.message);
  process.exit(4);
}

const tAll = Date.now();
const summary = [];
let consecFail = 0;

for (let i = 0; i < clean.length; i++) {
  const sec = clean[i];
  const outFile = outFileFor(sec);
  const tag = `[${i + 1}/${clean.length}] ${sec.slice(0, 18)}…`;

  if (resume && fs.existsSync(outFile)) {
    try {
      const old = JSON.parse(fs.readFileSync(outFile, 'utf8')).results?.[0];
      if (old?.ok) {
        console.log(`${tag} 跳过（已完成，${old.total} 条）`);
        summary.push({ secUid: sec, ok: true, total: old.total, skipped: true });
        continue;
      }
    } catch {}
  }

  let r;
  try {
    if (!identityCache.has(sec)) identityCache.set(sec, await fetchIdentity(sec));
    r = await scrapeAccount(sec, identityCache.get(sec));
  } catch (e) {
    const msg = String(e?.message || e);
    r = { ok: false, secUid: sec, url: `https://www.douyin.com/user/${sec}`, author: null, err: msg, pages: 0, hasMore: null, apiHits: 0, total: 0, source: 'none', profile: {}, identityCheck: { ok: true, warning: null }, posts: [], sec: 0 };
    // 错误原文落盘：控制台只留一行，排障时才不用靠猜（A14）
    try {
      fs.mkdirSync(ERR_DIR, { recursive: true });
      fs.writeFileSync(path.join(ERR_DIR, `${sec}.log`),
        `at=${new Date().toISOString()}\nsecUid=${sec}\nprofile=${PROFILE}\n\n${e?.stack || msg}\n`, 'utf8');
    } catch {}
  }

  const payload = { at: new Date().toISOString(), results: [r] };
  const tmp = outFile + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8');
  fs.renameSync(tmp, outFile);

  if (r.ok) {
    consecFail = 0;
    console.log(`${tag} ✓ ${r.total} 条 | ${r.profile.nickname || '?'} 粉丝 ${r.profile.fans ?? '?'} | 来源 ${r.source} | ${r.sec}s`);
  } else {
    consecFail++;
    console.log(`${tag} ✗ ${String(r.err || '零结果').slice(0, 120)}`);
  }
  summary.push({ secUid: sec, ok: r.ok, total: r.total, fans: r.profile?.fans ?? null, source: r.source, sec: r.sec });

  stats({
    tag: 'stats',
    account: i + 1,
    elapsed: (Date.now() - tAll) / 1000,
    profileMB: sizeMB(PROFILE, ['BrowserMetrics']),
    posts: r.total,
    extra: `ok=${r.ok}`,
  });

  // 连续失败熔断：底层故障时继续跑只是白耗时间（A12）
  if (consecFail >= breaker) {
    console.log(`\n⛔ 连续 ${consecFail} 个失败，熔断停止（已抓到的都保留）`);
    break;
  }

  // 每 N 个账号重启浏览器 + 清缓存：profile 涨到几百 MB 后 Chrome 会假死，报错像风控（A04）
  if (!noSweep && (i + 1) % sweepEvery === 0 && i + 1 < clean.length) {
    console.log(`  —— 已跑 ${i + 1} 个，重启浏览器并清缓存 ——`);
    try {
      await restart({ port, profile: PROFILE, maxMB: 300, reset: false });
    } catch (e) {
      console.log(`  ⚠ 重启失败：${e.message}（下一轮会再试）`);
    }
  }

  if (i < clean.length - 1) await sleep(rand(800, 1800));
}

fs.writeFileSync(path.join(OUT_DIR, '_summary.json'),
  JSON.stringify({ at: new Date().toISOString(), profile: PROFILE, total: summary.length, summary }, null, 2), 'utf8');

const okN = summary.filter((x) => x.ok).length;
console.log(`\n[done] ${okN}/${summary.length} 成功 | 总耗时 ${((Date.now() - tAll) / 1000).toFixed(0)}s`);
console.log(`[saved] ${single ? path.resolve(outArg) : OUT_DIR}`);
process.exit(okN === summary.length ? 0 : okN ? 3 : 4);
