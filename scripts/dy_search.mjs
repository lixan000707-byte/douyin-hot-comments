/**
 * 抖音关键词搜索抓取（全网，不限账号）
 *
 *   node dy_search.mjs "女裤" [--scroll 8] [-o out.json] [--headful]
 *
 * 路径：首页预热建立会话 → 站内跳转搜索页 → 拦截 search 接口 → 滚动加载更多
 * 说明：直接 navigate 到 /search 会命中验证码中间页，必须先访问首页再站内跳转
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CDP } from '../lib/cdp.mjs';
import { ensure, newTab, closeTab } from '../lib/chrome.mjs';
import { loginProfile } from '../lib/paths.mjs';

// ── 词级冷却账本：实测同一关键词 10 分钟内重复抓取会触发静默限流，
//    且失败征兆是「页面正常、接口不发请求」，极易被误判成「这个词没内容」。
//    用本地账本硬拦，比靠人记靠谱。
const __dir = path.dirname(fileURLToPath(import.meta.url));
const DATA_ROOT = process.env.DY_DATA_DIR || path.join(process.env.DY_ROOT || process.cwd(), 'dy_output');
const COOLDOWN_FILE = path.join(DATA_ROOT, '.kw_cooldown.json');
const COOLDOWN_MIN = parseInt(process.env.DY_KW_COOLDOWN_MIN || '10', 10);

function checkCooldown(kw) {
  try {
    const j = JSON.parse(fs.readFileSync(COOLDOWN_FILE, 'utf8'));
    const last = j[kw];
    if (!last) return { blocked: false };
    const mins = (Date.now() - last) / 60000;
    if (mins < COOLDOWN_MIN) {
      return { blocked: true, mins: +mins.toFixed(1), left: +(COOLDOWN_MIN - mins).toFixed(1) };
    }
  } catch {}
  return { blocked: false };
}

function markCooldown(kw) {
  try {
    let j = {};
    try { j = JSON.parse(fs.readFileSync(COOLDOWN_FILE, 'utf8')); } catch {}
    j[kw] = Date.now();
    fs.mkdirSync(path.dirname(COOLDOWN_FILE), { recursive: true });
    fs.writeFileSync(COOLDOWN_FILE, JSON.stringify(j, null, 2), 'utf8');
  } catch {}
}

const PORT = parseInt(process.env.DY_PORT || '9333', 10);
const PROFILE = process.env.DY_PROFILE || loginProfile();

const argv = process.argv.slice(2);
let KW = '', SCROLL = 8, outFile = '';
const HEADFUL = !process.env.DY_HEADLESS;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--scroll') SCROLL = parseInt(argv[++i], 10) || 8;
  else if (a === '-o') outFile = argv[++i];
  else if (a === '--headless') { /* 已默认有头 */ }
  else if (!a.startsWith('-') && !KW) KW = a;
}
if (!KW) { console.log('用法: node dy_search.mjs "关键词" [--scroll 8] [-o out.json]'); process.exit(1); }

const sleep = ms => new Promise(r => setTimeout(r, ms));
const f = (u, o = {}, ms = 8000) => fetch(u, { ...o, signal: AbortSignal.timeout(ms) });

// 浏览器与 CDP 由 lib/chrome.mjs + lib/cdp.mjs 统一管理


(async () => {
  // 冷却检查必须在开浏览器之前，避免白白打请求
  const cd = checkCooldown(KW);
  if (cd.blocked && process.env.DY_FORCE !== '1') {
    console.error(`[COOLDOWN] 「${KW}」${cd.mins} 分钟前刚抓过，还需等 ${cd.left} 分钟。`);
    console.error(`           同一关键词短时间重复抓取会触发静默限流（页面正常但接口不发请求）。`);
    console.error(`           确实要重抓请设 DY_FORCE=1，或换关键词。`);
    process.exit(3);
  }
  const ver = await ensure({ port: PORT, profile: PROFILE, headless: !HEADFUL });
  const { cdp, targetId } = await newTab(PORT);
  console.log(`[chrome] ${ver.browser} port=${PORT}${ver.reused ? '（复用）' : ''}`);

  // 只登记 requestId，等整轮滚动结束再统一取 body。
  // 在 responseReceived 阶段取会撞上「响应体还没下载完」，大响应基本必失败。
  const hits = [];
  let bodyLost = 0;
  cdp.on('Network.responseReceived', (p) => {
    const u = p.response?.url || '';
    if (process.env.DY_DEBUG && /search|general/i.test(u)) {
      console.log('[net]', p.response.status, u.split('?')[0]);
    }
    if (/aweme\/v1\/web\/(general\/search|search\/item|search\/video|search\/single)/.test(u)) {
      hits.push(p.requestId);
    }
  });

  await cdp.send('Network.enable');
  try { await cdp.send('Network.setCacheDisabled', { cacheDisabled: true }); } catch {}

  const title = async () => {
    try {
      const t = await cdp.send('Runtime.evaluate', { expression: 'document.title', returnByValue: true });
      return t.result?.value || '';
    } catch { return ''; }
  };

  // ① 首页预热（直接进搜索页会命中验证码）
  console.log('[1/3] 打开首页预热…');
  await cdp.send('Page.navigate', { url: 'https://www.douyin.com/' });
  await sleep(7000);
  console.log('      标题: ' + await title());
  try {
    await cdp.send('Runtime.evaluate', { expression: 'window.scrollBy(0,600)' });
    await sleep(2000);
  } catch {}

  // ② 站内跳转搜索（模拟真人操作路径，避免直接 navigate 触发风控）
  console.log('[2/3] 站内跳转到搜索页: ' + KW);
  const searchUrl = `https://www.douyin.com/search/${encodeURIComponent(KW)}?type=video`;
  try {
    await cdp.send('Runtime.evaluate', { expression: `location.href=${JSON.stringify(searchUrl)}` });
  } catch {}
  await sleep(1500);
  // 等首屏搜索响应（最多 15 秒）。固定 sleep 会在网络慢时「滚过去了但接口还没回来」，
  // 实测出现过只拿到 16 条（正常 150+）的偶发失败
  for (let i = 0; i < 15; i++) {
    if (hits.length) break;
    await sleep(1000);
  }
  console.log('      标题: ' + await title());
  console.log('      搜索响应: ' + hits.length + ' 个');

  // ③ 滚动加载更多：连续 4 次滚动都没有新响应就提前收手（到底或卡住）
  console.log('[3/3] 滚动加载…');
  let noNew = 0, lastCount = hits.length;
  for (let i = 0; i < SCROLL; i++) {
    try {
      await cdp.send('Runtime.evaluate', { expression: 'window.scrollBy(0, window.innerHeight*1.6)' });
    } catch {}
    await sleep(2500);
    if (hits.length === lastCount) { noNew++; }
    else { noNew = 0; lastCount = hits.length; }
    if (noNew >= 4 && hits.length > 0) {
      console.log(`      连续 4 次无新响应，提前结束（第 ${i + 1} 轮）`);
      break;
    }
    if (i % 3 === 2) console.log(`      ${i + 1}/${SCROLL}  scroll  响应 ${hits.length} 个`);
  }
  await sleep(2000);

  // DOM 兜底
  let domLinks = [];
  try {
    const ev = await cdp.send('Runtime.evaluate', {
      expression: `(() => {
        const s = new Set();
        document.querySelectorAll('a[href*="/video/"]').forEach(a => {
          const m = a.href.match(/\\/video\\/(\\d{15,})/); if (m) s.add(m[1]);
        });
        (document.body.innerHTML.match(/\\/video\\/(\\d{15,})/g) || []).forEach(x => s.add(x.replace('/video/','')));
        return JSON.stringify([...s]);
      })()`,
      returnByValue: true,
    });
    domLinks = JSON.parse(ev.result?.value || '[]');
  } catch {}

  console.log(`\n[收集] 搜索接口响应 ${hits.length} 个 / DOM 链接 ${domLinks.length} 条`);

  // 解析接口
  const vids = new Map();
  for (const rid of hits) {
    let body;
    try {
      const g = await cdp.send('Network.getResponseBody', { requestId: rid });
      body = g.body;
      if (g.base64Encoded) body = Buffer.from(body, 'base64').toString('utf8');
    } catch { bodyLost++; continue; }
    let j; try { j = JSON.parse(body); } catch { continue; }
    const list = j.data || j.aweme_list || [];
    for (const item of list) {
      const aw = item.aweme_info || item.aweme || item;
      if (!aw || !aw.aweme_id || !aw.statistics) continue;
      const st = aw.statistics;
      if (!vids.has(aw.aweme_id)) {
        vids.set(aw.aweme_id, {
          videoId: aw.aweme_id,
          desc: (aw.desc || '').replace(/\s+/g, ' ').slice(0, 50),
          author: (aw.author || {}).nickname || '',
          digg: st.digg_count || 0,
          comment: st.comment_count || 0,
          collect: st.collect_count || 0,
          share: st.share_count || 0,
        });
      }
    }
  }

  const list = [...vids.values()].sort((a, b) => b.digg - a.digg);
  console.log(`[解析] 接口拿到 ${list.length} 条视频`);
  // 响应体被浏览器回收时必须说出来，否则「响应 20 个、解析 8 条」会被当成抖音没内容
  if (bodyLost) console.warn(`[WARN] ${bodyLost}/${hits.length} 个响应体已释放，结果可能不完整（可重跑一次）`);
  if (list.length) {
    console.log('\n  点赞'.padStart(10), '评论'.padStart(8), '  作者 | 标题');
    for (const v of list.slice(0, 20)) {
      console.log(String(v.digg).padStart(10), String(v.comment).padStart(8), `  ${v.author} | ${v.desc.slice(0, 30)}`);
    }
  }

  // 失败归因：三种情况处理方式完全不同，不能笼统报「没抓到」
  const pageTitle = await title();
  const isCaptcha = /验证码|安全验证|滑块/.test(pageTitle);
  const silentThrottle = !isCaptcha && hits.length === 0;      // 页面正常但数据接口一个都没发
  const emptyResult = !isCaptcha && hits.length > 0 && list.length === 0;  // 接口有响应但确实没内容
  const lowYield = list.length > 0 && list.length < 30;
  const outcome = isCaptcha ? 'CAPTCHA'
    : silentThrottle ? 'SILENT_THROTTLE'
    : emptyResult ? 'EMPTY_RESULT'
    : lowYield ? 'LOW_YIELD'
    : list.length ? 'OK' : 'NO_DATA';

  const abs = path.resolve(outFile || path.join(DATA_ROOT, `search_${KW}_${Date.now()}.json`));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, JSON.stringify({
    keyword: KW, scrapedAt: new Date().toISOString(), outcome,
    pageTitle, videos: list, domLinks,
    debug: { searchResponses: hits.length, domLinks: domLinks.length },
  }, null, 2), 'utf8');
  console.log(`\n[saved] ${abs}  [结果: ${outcome}]`);

  cdp.close();
  await closeTab(PORT, targetId);
  // 退出码：0 正常 / 3 数据偏少或不可用（需冷却重试）/ 4 被拦截或彻底失败
  const codeMap = { OK: 0, LOW_YIELD: 3, SILENT_THROTTLE: 3, EMPTY_RESULT: 3, CAPTCHA: 4, NO_DATA: 4 };
  const code = codeMap[outcome] ?? 4;
  const advice = {
    CAPTCHA: '命中验证码页 —— 直接访问搜索页才会这样，确认走的是「首页预热 + 站内跳转」路径',
    SILENT_THROTTLE: '静默限流 —— 页面标题正常但 search 接口一个都没发。该词 10 分钟内别重试，或换词',
    EMPTY_RESULT: '接口有响应但无视频 —— 关键词可能真的没内容，或搜索词过于生僻',
    LOW_YIELD: `只解析到 ${list.length} 条（正常 100+）—— 加载不完整或轻度限流，建议冷却后重试`,
    NO_DATA: '什么都没抓到',
  }[outcome];
  if (outcome === 'OK') {
    console.log(`[OK] ${list.length} 条视频（退出码 0）`);
  } else {
    console.error(`[${outcome}] ${advice}（退出码 ${code}）`);
  }
  // 无论成败都记账：失败也代表已经访问过这个词，短时间再试只会更糟
  markCooldown(KW);
  process.exit(code);
})().catch(e => { console.error('[FATAL]', e.message); process.exit(1); });
