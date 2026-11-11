/**
 * 从抖音首页推荐流捞爆款视频（用于取「高点赞」测试样本）
 *
 *   node dy_find_hot.mjs [--scroll 12] [-o out.json]
 *
 * 原理：打开 douyin.com 首页 → 拦截页面自己发的 tab/feed 响应 → 解析 aweme_list
 *      推荐流天然是热门内容，滚动若干次即可收集一批高赞视频
 * 说明：搜索页（/search）会弹验证码，此脚本走首页推荐流绕开
 */
import fs from 'node:fs';
import path from 'node:path';
import { ensure, newTab, closeTab } from '../lib/chrome.mjs';
import { loginProfile } from '../lib/paths.mjs';

const PORT = parseInt(process.env.DY_PORT || '9333', 10);
const PROFILE = process.env.DY_PROFILE || loginProfile();

const argv = process.argv.slice(2);
let SCROLL = 12, outFile = '';
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--scroll') SCROLL = parseInt(argv[++i], 10) || 12;
  else if (argv[i] === '-o') outFile = argv[++i];
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const f = (u, o = {}, ms = 6000) => fetch(u, { ...o, signal: AbortSignal.timeout(ms) });

// 浏览器与 CDP 由 lib/chrome.mjs + lib/cdp.mjs 统一管理


(async () => {
  const ver = await ensure({ port: PORT, profile: PROFILE, headless: !!process.env.DY_HEADLESS });
  const { cdp, targetId } = await newTab(PORT);
  console.log(`[chrome] ${ver.browser} port=${PORT}${ver.reused ? '（复用）' : ''}`);
  await cdp.send('Network.enable');
  try { await cdp.send('Network.setCacheDisabled', { cacheDisabled: true }); } catch {}

  const feedReqs = [];
  cdp.on('Network.responseReceived', (p) => {
    const u = p.response?.url || '';
    if (process.env.DY_DEBUG && /aweme|api/.test(u)) console.log('[net]', p.response.status, u.split('?')[0]);
    if (/\/aweme\/v1\/web\/tab\/feed|\/aweme\/v1\/web\/module\/feed|\/aweme\/v1\/web\/feed/.test(u)) {
      feedReqs.push(p.requestId);
    }
  });

  await cdp.send('Page.navigate', { url: 'https://www.douyin.com/' });
  await sleep(6000);
  try {
    const t = await cdp.send('Runtime.evaluate', { expression: 'document.title', returnByValue: true });
    console.log('[page]', t.result?.value);
  } catch {}

  // 滚动加载更多
  for (let i = 0; i < SCROLL; i++) {
    try {
      await cdp.send('Runtime.evaluate', { expression: 'window.scrollBy(0, window.innerHeight*1.8)' });
    } catch {}
    await sleep(2200);
    if (i % 4 === 3) console.log(`[scroll] ${i + 1}/${SCROLL}  已捕获 feed 响应 ${feedReqs.length} 个`);
  }
  await sleep(2000);

  console.log(`[收集] feed 响应 ${feedReqs.length} 个`);

  // 备用通道：feed 接口没触发时，直接从 DOM 提取已渲染的视频链接
  let domLinks = [];
  try {
    const ev = await cdp.send('Runtime.evaluate', {
      expression: `(() => {
        const s = new Set();
        document.querySelectorAll('a[href*="/video/"]').forEach(a => {
          const m = a.href.match(/\\/video\\/(\\d{15,})/);
          if (m) s.add(m[1]);
        });
        // 兜底：扫全页文本里的 video 链接
        const m2 = document.body.innerHTML.match(/\\/video\\/(\\d{15,})/g) || [];
        m2.forEach(x => s.add(x.replace('/video/','')));
        return JSON.stringify([...s]);
      })()`,
      returnByValue: true,
    });
    domLinks = JSON.parse(ev.result?.value || '[]');
  } catch (e) { console.log('[dom] 提取失败', e.message); }
  console.log(`[dom] 页面渲染出的视频链接 ${domLinks.length} 条`);
  if (domLinks.length) console.log('      前 8 条: ' + domLinks.slice(0, 8).join(', '));

  const vids = new Map();
  for (const rid of feedReqs) {
    let body;
    try {
      const g = await cdp.send('Network.getResponseBody', { requestId: rid });
      body = g.body;
      if (g.base64Encoded) body = Buffer.from(body, 'base64').toString('utf8');
    } catch { continue; }
    let j; try { j = JSON.parse(body); } catch { continue; }
    const list = j.aweme_list || j.data || [];
    for (const item of list) {
      const aw = item.aweme_info || item;
      if (!aw || !aw.aweme_id || !aw.statistics) continue;
      const st = aw.statistics;
      if (!vids.has(aw.aweme_id)) {
        vids.set(aw.aweme_id, {
          videoId: aw.aweme_id,
          desc: (aw.desc || '').replace(/\s+/g, ' ').slice(0, 36),
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
  console.log(`\n[结果] 共 ${list.length} 条视频，按点赞降序 TOP20：`);
  console.log('  点赞'.padStart(10), '评论'.padStart(8), '  作者 | 标题');
  for (const v of list.slice(0, 20)) {
    console.log(String(v.digg).padStart(10), String(v.comment).padStart(8), `  ${v.author} | ${v.desc}`);
  }

  const abs = path.resolve(outFile || path.join(DATA_ROOT, 'find_hot.json'));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, JSON.stringify({ scrapedAt: new Date().toISOString(), videos: list, domLinks }, null, 2), 'utf8');
  console.log(`\n[saved] ${abs}`);

  await closeTab(PORT, targetId);
  cdp.close();
  process.exit(0);
})().catch(e => { console.error('[FATAL]', e.message); process.exit(1); });
