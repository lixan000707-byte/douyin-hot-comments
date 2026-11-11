/**
 * 抖音视频 + 评论批量抓取（CDP 直连 · 零依赖 · 不截图）
 *
 *   node dy_scrape.mjs <url|videoId>... [-o out.json] [--par 3] [--data-only]
 *
 * 原理
 *   视频数据 → Runtime.evaluate 读 DOM 文本（一次拿全，不截图）
 *   评论数据 → 注入 hook 捕获 /aweme/v1/web/comment/list 的签名 URL，
 *              复用该 URL 改 cursor 循环翻页，1~2 秒拿完全部一级评论
 *   多 tab 并行
 *
 * 输出字段
 *   video: videoId/title/desc/author/fans/digg/comment/collect/share/publishTime
 *   comments[]: cid/name/uid/text/like/replyTotal/ip/createTime/authorDigged/isPinned
 */
import fs from 'node:fs';
import path from 'node:path';
import { ensure, newTab, closeTab, probe, sweep, stats as statsLine } from '../lib/chrome.mjs';
import { workProfile, sizeMB } from '../lib/paths.mjs';

// ── 参数防呆：DY_CNT 不设时接口每页只返回 5 条，80 页翻满也才 400 条，
//    而且退出码仍是 0，看起来像抓成功了。这里强制兜底，避免「假全量」。
//    --data-only 不抓评论，DY_CNT 无意义，不提示。
if (!process.env.DY_CNT && !process.argv.includes('--data-only')) {
  const maxPage = parseInt(process.env.DY_MAXPAGE || '80', 10);
  if (maxPage > 20) {
    process.env.DY_CNT = '50';
    console.warn('[WARN] 未设置 DY_CNT：接口默认每页仅 5 条，翻满 ' + maxPage + ' 页也只有约 ' + (maxPage * 5) + ' 条。');
    console.warn('       已自动设为 DY_CNT=50（每页 50 条）。如需还原旧行为请显式设 DY_CNT=0。');
  }
}

// 评论抓取用 work profile，与登录态的搜索/达人分开端口：
// 共用一个端口时，先退出的浏览器还没关干净，后一个会「复用」到错误 profile 的实例，
// 表现为「页面正常但接口一个请求都不发」，极难定位。
const PORT = parseInt(
  process.env.DY_PORT || process.env.DY_PORT_COMMENT || '9335',
  10,
);
// 评论抓取不需要登录态（实测：全新空 profile 抓到 271 条 / 6 页 / hasMore=0）。
// 用独立 work profile：可以整目录删掉重建，不碰登录 cookie，也不让评论页缓存污染登录 profile。
const PROFILE = process.env.DY_PROFILE || workProfile();
const PROFILE_MAX_MB = parseInt(process.env.DY_PROFILE_MAX_MB || '300', 10);
// work 类 profile 可丢弃 → 超阈值直接整目录重建，比只清缓存干净。
// 若外部把 DY_PROFILE 指到登录 profile，默认只清缓存，避免把 cookie 删了。
const IS_WORK_PROFILE = /-work$/i.test(PROFILE) || PROFILE.includes('.top_profile');
const PROFILE_RESET = process.env.DY_PROFILE_RESET
  ? process.env.DY_PROFILE_RESET === '1'
  : IS_WORK_PROFILE;
const sleep = ms => new Promise(r => setTimeout(r, ms));

// 浏览器与 CDP 统一由 lib/chrome.mjs + lib/cdp.mjs 提供，
// 本文件不再自己起进程、不再自己拼 profile 路径。


/**
 * 纯数字 ID 无法预判是视频还是图文：先按 /video/ 试，报「数据无效」再回退 /note/。
 * 完整 URL 原样使用，绝不改写（外部批处理已按 aweme_type 分好流）。
 */
const buildUrls = s => /^\d+$/.test(s)
  ? [`https://www.douyin.com/video/${s}`, `https://www.douyin.com/note/${s}`]
  : [s];

// 输入预校验：非抖音域名根本不该进浏览器。
// 放进去的代价不只是它自己慢慢失败，而是它长时间占着同一个 Chrome，
// 把同批次的好链接一起拖慢（实测 5s → 31s）。
const DY_HOST = /^https?:\/\/([a-z0-9-]+\.)*(douyin\.com|iesdouyin\.com)(\/|$)/i;
const validInput = s => /^\d+$/.test(s) || DY_HOST.test(s);

// ---------------- 注入脚本：截获评论接口 + 主动翻页 ----------------
const HOOK = `(function(){
  if (window.__dyHooked) return;
  window.__dyHooked = true;
  window.__cmts = [];
  window.__detail = null;
  const keepC = u => u && /\\/aweme\\/v1\\/web\\/comment\\/list\\//.test(u);
  const keepD = u => u && /\\/aweme\\/v1\\/web\\/aweme\\/detail\\//.test(u);
  const push = (u, j) => { try { window.__cmts.push({ u, d: j }); } catch(e){} };
  const of = window.fetch;
  window.fetch = function(){
    const a = arguments;
    const u = typeof a[0] === 'string' ? a[0] : (a[0] && a[0].url);
    return of.apply(this, a).then(res => {
      if (keepC(u)) { try { res.clone().json().then(j => push(u, j)).catch(()=>{}); } catch(e){} }
      if (keepD(u)) { try { res.clone().json().then(j => { window.__detail = j; }).catch(()=>{}); } catch(e){} }
      return res;
    });
  };
  const oo = XMLHttpRequest.prototype.open, os = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function(m, u){ this.__u = u; return oo.apply(this, arguments); };
  XMLHttpRequest.prototype.send = function(){
    this.addEventListener('load', function(){
      const u = this.__u;
      if (keepC(u)) { try { push(u, JSON.parse(this.responseText)); } catch(e){} }
      if (keepD(u)) { try { window.__detail = JSON.parse(this.responseText); } catch(e){} }
    });
    return os.apply(this, arguments);
  };

  const mapC = c => ({
    cid: c.cid,
    name: (c.user && c.user.nickname) || '',
    uid: (c.user && c.user.uid) || null,
    text: c.text || '',
    like: c.digg_count || 0,
    replyTotal: c.reply_comment_total || 0,
    ip: c.ip_label || '',
    createTime: c.create_time || null,
    authorDigged: !!c.is_author_digged,
    isPinned: !!(c.stick_position && c.stick_position > 0),
    subReplies: (c.reply_comment || []).map(r => ({
      cid: r.cid, name: (r.user && r.user.nickname) || '', text: r.text || '',
      like: r.digg_count || 0, ip: r.ip_label || '', authorDigged: !!r.is_author_digged,
    })),
  });

  // 用 seed URL 改 cursor 翻页
  window.__pageAll = async function(maxN, maxPage, cnt, extra){
    maxN = maxN || 500; maxPage = maxPage || 80;
    const seed = (window.__cmts[0] || {}).u;
    if (!seed) return { err: 'NO_SEED' };
    const seen = new Set(); const out = [];
    let cursor = 0, hasMore = 1, pages = 0;
    while (hasMore && pages++ < maxPage && out.length < maxN) {
      let u = seed.replace(/([?&])cursor=\\d+/, '$1cursor=' + cursor);
      if (cnt) u = u.replace(/([?&])count=\\d+/, '$1count=' + cnt);
      if (extra) u = u + extra;
      let j;
      try { j = await (await fetch(u, { credentials: 'include' })).json(); }
      catch (e) { return { err: 'FETCH:' + e.message, total: out.length, rows: out }; }
      if (j.status_code !== 0) return { err: 'CODE:' + j.status_code, total: out.length, rows: out };
      const list = j.comments || [];
      let added = 0;
      for (const c of list) if (!seen.has(c.cid)) { seen.add(c.cid); out.push(mapC(c)); added++; }
      hasMore = j.has_more; cursor = j.cursor;
      if (!added) break;
    }
    return { total: out.length, hasMore, pages, rows: out };
  };
})();`;

const EXTRACT_VIDEO = `(() => {
  // 优先用页面自己请求的 aweme/detail 接口（字段最全、数字最准）
  const d = window.__detail && (window.__detail.aweme_detail || (window.__detail.aweme_details || [])[0]);
  if (d) {
    const s = d.statistics || {};
    const au = d.author || {};
    const ctime = d.create_time ? new Date(d.create_time * 1000) : null;
    const pad = n => String(n).padStart(2, '0');
    return JSON.stringify({
      src: 'api',
      awemeType: 'video',
      videoId: d.aweme_id || null,
      desc: d.desc || '',
      publishTime: ctime ? ctime.getFullYear() + '-' + pad(ctime.getMonth() + 1) + '-' + pad(ctime.getDate()) + ' ' + pad(ctime.getHours()) + ':' + pad(ctime.getMinutes()) : null,
      createTime: d.create_time || null,
      author: au.nickname || null,
      authorId: au.unique_id || null,
      fans: au.follower_count ?? null,
      totalLike: au.total_favorited ?? null,
      digg: s.digg_count ?? null,
      comment: s.comment_count ?? null,
      collect: s.collect_count ?? null,
      share: s.share_count ?? null,
      durationMs: (d.video && d.video.duration) || null,
      hashtags: (d.text_extra || []).map(x => x.hashtag_name).filter(Boolean),
      music: (d.music && d.music.title) || null,
    });
  }
  // 图文（/note/）：页面根本不请求 aweme/detail，__detail 永远是 null，
  // 也没有 detail-video-info 这个节点。但四项统计的 data-e2e 和视频页完全一样，
  // 评论同样走 comment/list，所以图文能抓全，只是发布时间拿不到（页面里没有 create_time）。
  const noteBox = document.querySelector('[data-e2e="note-detail"]');
  if (noteBox) {
    const pick = s => { const e = document.querySelector(s); return e ? (e.innerText || '') : null; };
    const toNum = s => { if (!s) return null;
      const m = s.replace(/[,\\s]/g, '').match(/([\\d.]+)\\s*([w万])?/);
      if (!m) return null; let n = parseFloat(m[1]); if (m[2]) n *= 10000; return Math.round(n); };
    const boxText = noteBox.innerText || '';
    const mFan = boxText.match(/粉丝\\s*([\\d.]+)\\s*([w万]?)/);
    const mLik = boxText.match(/获赞\\s*([\\d.]+)\\s*([w万]?)/);
    const a = noteBox.querySelector('a[href*="/user/"]');
    const name = a ? (a.innerText || '').trim().replace(/作者$/, '').trim() : null;
    const sec = a ? ((a.getAttribute('href') || '').match(/\\/user\\/([^?]+)/) || [])[1] || null : null;
    const title = (document.title || '').replace(/\\s*-\\s*抖音$/, '').trim();
    return JSON.stringify({
      src: 'dom-note',
      awemeType: 'note',
      videoId: (location.pathname.match(/\\/(?:note|video)\\/(\\d+)/) || [])[1] || null,
      desc: title,
      publishTime: null,
      createTime: null,
      author: name,
      authorId: sec,
      fans: toNum(mFan && mFan[1] + (mFan[2] || '')),
      totalLike: toNum(mLik && mLik[1] + (mLik[2] || '')),
      digg: toNum(pick('[data-e2e="video-player-digg"]')),
      comment: toNum(pick('[data-e2e="feed-comment-icon"]')),
      collect: toNum(pick('[data-e2e="video-player-collect"]')),
      share: toNum(pick('[data-e2e="video-player-share"]')),
      durationMs: null,
      hashtags: (title.match(/#[^\\s#]+/g) || []).map(x => x.slice(1)),
      music: null,
    });
  }
  // 兜底：读 DOM
  const q = s => document.querySelector(s);
  const txt = s => { const e = q(s); return e ? e.innerText.trim() : null; };
  const num = s => { const e = q(s); if (!e) return null;
    const m = (e.innerText || '').replace(/[,\\s]/g, '').match(/([\\d.]+)\\s*([w万])?/);
    if (!m) return null; let n = parseFloat(m[1]); if (m[2]) n *= 10000; return Math.round(n); };
  const info = (txt('[data-e2e="detail-video-info"]') || '').split('\\n').map(s => s.trim()).filter(Boolean);
  const u = (txt('[data-e2e="user-info"]') || '').replace(/\\n/g, ' ');
  const toN = s => { if (!s) return null; const m = s.match(/([\\d.]+)\\s*([w万])?/); if (!m) return null;
    let n = parseFloat(m[1]); if (m[2]) n *= 10000; return Math.round(n); };
  const mFan = u.match(/粉丝\\s*([\\d.]+\\s*[w万]?)/), mLik = u.match(/获赞\\s*([\\d.]+\\s*[w万]?)/);
  return JSON.stringify({
    src: 'dom',
    awemeType: 'video',
    videoId: (location.pathname.match(/video\\/(\\d+)/) || [])[1] || null,
    title: document.title.replace(/\\s*-\\s*抖音$/, '').trim(),
    desc: info[0] || null,
    publishTime: (txt('[data-e2e="detail-video-publish-time"]') || '').replace('发布时间：', '') || null,
    author: u.split('粉丝')[0].trim() || null,
    fans: toN(mFan && mFan[1]), totalLike: toN(mLik && mLik[1]),
    digg: num('[data-e2e="video-player-digg"]'),
    comment: num('[data-e2e="feed-comment-icon"]'),
    collect: num('[data-e2e="video-player-collect"]'),
    share: num('[data-e2e="video-player-share"]'),
  });
})()`;

const SCROLL_JS = `(() => {
  const box = document.querySelector('[data-e2e="comment-list"]');
  if (box && box.scrollHeight > box.clientHeight) {
    box.scrollTop = box.scrollHeight;
    box.dispatchEvent(new Event('scroll', { bubbles: true }));
  }
  window.scrollBy(0, 3000);
  return 1;
})()`;

// ---------------- 抓一条 ----------------
// 真实滚轮事件（JS dispatchEvent 常常触发不了懒加载）
async function seedComments(cdp, chk, rounds) {
  for (let i = 0; i < rounds; i++) {
    chk();
    try {
      await cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseWheel', x: 640, y: 700, deltaX: 0, deltaY: 900, pointerType: 'mouse',
      });
    } catch {}
    try { await cdp.eval(SCROLL_JS); } catch {}
    await sleep(800);
    try { if ((await cdp.eval('(window.__cmts||[]).length')) > 0) return true; } catch {}
  }
  return false;
}

async function scrapeOnce(url, { retry, dataOnly, st }) {
  // 取消令牌：上层超时后置 true，本函数必须在下一个检查点退出，
  // 否则 Promise.race 只是不再等它，它仍在后台开 tab、占浏览器
  const chk = () => { if (st && st.cancelled) throw new Error('已取消（单条超时）'); };
  let lastErr = null;

  for (let attempt = 0; attempt <= retry; attempt++) {
    chk();
    const { cdp, targetId } = await newTab(PORT);
    try {
      // hook 必须在导航前注入
      await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: HOOK });
      // 禁缓存：页面走缓存时接口不发请求，嗅探器只能干等（同一视频第二次抓必空）
      try { await cdp.send('Network.enable'); } catch {}
      try { await cdp.send('Network.setCacheDisabled', { cacheDisabled: true }); } catch {}
      await cdp.send('Page.navigate', { url });

      let ready = false;
      // 全新 profile 首次访问抖音要建会话，实测首屏要 15–20s；
      // 正常复用实例 2–3s 就绪，轮询不会白等，所以超时给足。
      for (let i = 0; i < 75; i++) {
        chk();
        await sleep(250);
        try {
          if (await cdp.eval(`!!(window.__detail
          || document.querySelector('[data-e2e="detail-video-info"]')
          || (document.querySelector('[data-e2e="note-detail"]')
              && document.querySelector('[data-e2e="video-player-digg"]')
              && document.querySelector('[data-e2e="feed-comment-icon"]')))`)) { ready = true; break; }
        } catch {}
      }
      if (!ready) throw new Error('页面未加载完成');

      const video = JSON.parse(await cdp.eval(EXTRACT_VIDEO));

      // 有效性校验：视频不存在 / 被删 / 私密时，抖音仍会返回一个空壳页面，
      // 字段全 null 但流程不报错。必须在这里拦下来，否则定时任务会长期静默成功。
      const hasData = video.digg !== null && video.digg !== undefined;
      if (!hasData) {
        throw new Error(`数据无效（视频不存在/已删除/私密?）videoId=${video.videoId || '未知'}`);
      }
      if (!video.videoId) {
        throw new Error('未取到 videoId');
      }

      let cm = { total: 0, rows: [], hasMore: null, pages: 0, err: null };
      if (!dataOnly) {
        let seeded = await seedComments(cdp, chk, 10);

        // 缓存兜底：首轮一个评论接口都没发出 → 忽略缓存重载再试
        if (!seeded) {
          try { await cdp.send('Page.reload', { ignoreCache: true }); } catch {}
          await sleep(2500);
          seeded = await seedComments(cdp, chk, 6);
        }

        if (!seeded) {
          cm.err = 'NO_SEED';
        } else {
          const MAXN = parseInt(process.env.DY_MAXN || '800', 10);
          const MAXPAGE = parseInt(process.env.DY_MAXPAGE || '80', 10);
          const CNT = parseInt(process.env.DY_CNT || '0', 10);
          const EXTRA = process.env.DY_EXTRA || '';
          const raw = await cdp.eval(`window.__pageAll(${MAXN}, ${MAXPAGE}, ${CNT}, ${JSON.stringify(EXTRA)}).then(o => JSON.stringify(o))`, 180000);
          cm = JSON.parse(raw);
          if (cm.err && !cm.rows) cm.rows = [];
        }
      }

      return {
        video,
        commentCount: cm.total || 0,
        comments: cm.rows || [],
        commentHasMore: cm.hasMore,
        commentPages: cm.pages,
        commentErr: cm.err || null,
      };
    } catch (e) {
      lastErr = e.message;
      // 确定性失败（视频不存在/已删除/私密）重试没有任何意义，
      // 只会让这条坏链接继续占着浏览器，把同批次的好链接一起拖慢
      if (/数据无效|未取到 videoId|已取消/.test(lastErr)) break;
      await sleep(1000);
    } finally {
      cdp.close();
      await closeTab(PORT, targetId);
    }
  }
  throw new Error(lastErr || '未知失败');
}

async function scrapeOne(input, { retry = 1, dataOnly = false, st = null } = {}) {
  const t0 = Date.now();
  let lastErr = null;
  for (const url of buildUrls(input)) {
    try {
      const r = await scrapeOnce(url, { retry, dataOnly, st });
      return { ok: true, sec: +((Date.now() - t0) / 1000).toFixed(1), ...r };
    } catch (e) {
      lastErr = e.message;
      // 只有「数据无效」值得换 /note/ 再试；超时/取消换地址只是多耗一次导航
      if (!/数据无效/.test(lastErr)) break;
    }
  }
  return { ok: false, input, sec: +((Date.now() - t0) / 1000).toFixed(1), error: lastErr };
}

// ---------------- main ----------------
const argv = process.argv.slice(2);
let outFile = 'dy_scrape_out.json', par = 3, dataOnly = false;
const inputs = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '-o') outFile = argv[++i];
  else if (argv[i] === '--par') par = parseInt(argv[++i], 10) || 3;
  else if (argv[i] === '--data-only') dataOnly = true;
  else if (argv[i].startsWith('-')) {
    // 未知参数必须报错，否则会被当成 URL 塞进抓取列表，最后报"页面未加载完成"，
    // 让人以为是抖音的问题
    console.error(`未知参数: ${argv[i]}`);
    console.error('用法: node dy_scrape.mjs <url|videoId>... [-o out.json] [--par 3] [--data-only]');
    process.exit(1);
  }
  else inputs.push(argv[i]);
}
if (!inputs.length) {
  console.log('用法: node dy_scrape.mjs <url|videoId>... [-o out.json] [--par 3] [--data-only]');
  process.exit(1);
}

// 非抖音输入在开浏览器之前就剔掉，绝不占用抓取实例
const rejects = inputs.filter(u => !validInput(u));
const valid = inputs.filter(validInput);
if (rejects.length) {
  console.error(`[WARN] ${rejects.length} 条输入不是抖音链接，已跳过：`);
  for (const r of rejects) console.error(`        ${r}`);
}
if (!valid.length) {
  console.error('[FATAL] 没有一条可抓的抖音链接');
  process.exit(4);
}

const t0 = Date.now();

// 全局看门狗：任何情况下都不允许脚本无限挂起（定时任务的底线）
const WATCHDOG_MS = parseInt(process.env.DY_WATCHDOG || '180000', 10);
const PER_ITEM_MS = parseInt(process.env.DY_ITEM_TIMEOUT || '70000', 10);

// 清理必须在所有退出路径上执行：正常结束、超时、Ctrl+C、未捕获异常。
// 漏一条路径，就会留下一个 Chrome。
let watchdog = null;
// 浏览器进程由 lib/chrome.mjs 的退出钩子统一回收，这里只管看门狗
const cleanup = () => { if (watchdog) clearTimeout(watchdog); };
process.on('exit', cleanup);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => { console.error(`\n[FATAL] 收到 ${sig}，退出`); cleanup(); process.exit(130); });
}
process.on('uncaughtException', e => { console.error('[FATAL] 未捕获异常:', e?.message || e); cleanup(); process.exit(1); });
process.on('unhandledRejection', e => { console.error('[FATAL] 未处理 rejection:', e?.message || e); cleanup(); process.exit(1); });

watchdog = setTimeout(() => {
  console.error(`\n[FATAL] 全局超时 ${WATCHDOG_MS / 1000}s，强制退出（多为网络或抖音无响应）`);
  process.exit(2);
}, WATCHDOG_MS);
watchdog.unref?.();

try {
  // 启动前治理 profile：此时浏览器还没起，删缓存不会遇到文件锁。
  // 运行中删会被句柄挡住，rm 静默失败——看着修了，其实一点没清。
  if (!(await probe(PORT))) {
    await sweep({ port: PORT, profile: PROFILE, maxMB: PROFILE_MAX_MB, reset: PROFILE_RESET, log: false });
  }
  const ver = await ensure({ port: PORT, profile: PROFILE });
  console.log(`[chrome] ${ver.browser}  port=${PORT}${ver.reused ? '（复用）' : ''}`);
} catch (e) {
  console.error('[FATAL] ' + e.message);
  cleanup();
  process.exit(1);
}

// 单条超时必须同时通知 scrapeOne 自己退出。只 race 不取消的话，
// 被"超时"的那条还在后台开 tab、占浏览器，并行度越高越乱。
const withTimeout = (fn, ms, label) => {
  const st = { cancelled: false };
  return Promise.race([
    fn(st),
    new Promise((_, rej) => setTimeout(() => { st.cancelled = true; rej(new Error('单条超时:' + label)); }, ms)),
  ]);
};
const results = rejects.map(u => ({
  ok: false, input: u, sec: 0,
  error: '非抖音链接（只支持 douyin.com 域名或纯数字 videoId）',
}));
for (let i = 0; i < valid.length; i += par) {
  const batch = valid.slice(i, i + par);
  results.push(...await Promise.all(batch.map(u =>
    withTimeout(st => scrapeOne(u, { dataOnly, st }), PER_ITEM_MS, u)
      .catch(e => ({ ok: false, input: u, sec: Math.round(PER_ITEM_MS / 1000), error: e.message }))
  )));
}

console.log(`\n[done] ${((Date.now() - t0) / 1000).toFixed(1)}s | ${results.length} 条 | 并行 ${par}${dataOnly ? ' | 仅数据' : ''}`);
statsLine({
  account: results.length,
  elapsed: (Date.now() - t0) / 1000,
  profileMB: sizeMB(PROFILE, ['BrowserMetrics']),
  posts: results.filter(r => r.ok).length,
  extra: `failed=${results.filter(r => !r.ok).length}`,
});
for (const r of results) {
  if (!r.ok) { console.log(`  ❌ ${r.input}  ${r.error} (${r.sec}s)`); continue; }
  const v = r.video;
  const pct = v.comment ? Math.round(r.commentCount / v.comment * 100) : 0;
  console.log(`  ✅ ${v.videoId} @${v.author} | 赞${v.digg} 评${v.comment} 藏${v.collect} 转${v.share} | 一级评论 ${r.commentCount} 条(含子回复约${pct}%) | ${r.sec}s${r.commentErr ? ' ⚠️' + r.commentErr : ''}`);
}

const payload = { scrapedAt: new Date().toISOString(), totalSec: +((Date.now() - t0) / 1000).toFixed(1), results };
const outAbs = path.resolve(outFile);
fs.mkdirSync(path.dirname(outAbs), { recursive: true });
// 原子写：进程在写盘中途被杀时，绝不能留下半截 JSON，
// 否则下游读到损坏文件会当成"抓到 0 条"
const tmpOut = outAbs + '.tmp';
fs.writeFileSync(tmpOut, JSON.stringify(payload, null, 2), 'utf8');
fs.renameSync(tmpOut, outAbs);
console.log(`\n[saved] ${outAbs}`);

// 退出码语义：定时任务最先看的是退出码，不是日志
//   0 = 全部成功   3 = 部分失败   4 = 全部失败
const failed = results.filter(r => !r.ok).length;
const code = failed === 0 ? 0 : (failed === results.length ? 4 : 3);
if (failed) console.error(`[WARN] ${failed}/${results.length} 条失败，退出码 ${code}`);
cleanup();
process.exit(code);
