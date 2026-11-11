/**
 * depth_judge 判定逻辑单元测试（不联网）
 *
 *   node test_depth_judge.mjs
 *
 * 覆盖：到底/贴边/断崖/尾部衰减/抓取报错/空结果/评论数不足 N/全零赞/cid 缺失/字段缺失
 */
import { judgeDepth } from './depth_judge.mjs';

let pass = 0, fail = 0;
const cases = [];

function test(name, input, N, expect) {
  const r = judgeDepth(input, N);
  const got = { ok: r.ok, reason: r.reason };
  const okMatch = got.ok === expect.ok && (expect.reason ? got.reason === expect.reason : true);
  if (okMatch) { pass++; console.log(`  ✅ ${name}  → ${r.reason}`); }
  else {
    fail++;
    console.log(`  ❌ ${name}`);
    console.log(`      期望 ok=${expect.ok}${expect.reason ? ' reason=' + expect.reason : ''}`);
    console.log(`      实际 ok=${r.ok} reason=${r.reason}  (${r.detail || ''})`);
  }
  cases.push({ name, got, expect, detail: r.detail, risk: r.positionRisk, topMaxPos: r.topMaxPos });
}

// 构造：likes 数组 → comments；末尾 20 条决定 tailMax
const mk = (likes, extra = {}) => ({
  comments: likes.map((l, i) => ({ cid: 'c' + String(i).padStart(4, '0'), like: l, text: 't' + i })),
  commentHasMore: extra.hasMore,
  commentErr: extra.err === undefined ? null : extra.err,
  commentPages: extra.pages || 16,
  sec: 10,
});

console.log('\n=== 1. 已抓到底（hasMore=0）===');
// 20 条评论，最高第 19 条位置 → 即使贴边，到底了也算完整
test('20 条全部抓完，TOP10 最靠后在第 19 条',
  mk([100, 90, 80, 70, 60, 50, 40, 30, 20, 10, 1, 1, 1, 1, 1, 1, 1, 1, 5, 1], { hasMore: 0 }), 10,
  { ok: true, reason: 'REACHED_END' });

console.log('\n=== 2. 还有下一页 + 贴边（应判不足）===');
// 200 条，TOP10 里最靠后的在第 190 条（95%）
const closeLikes = [1000, 900, 800, 700, 600, 500, 400, 300, 200, 5];
const big1 = [];
for (let i = 0; i < 200; i++) big1.push(i === 189 ? 150 : (i < 10 ? closeLikes[i] : 1));
test('200 条、TOP10 末位在第 190 条、hasMore=1',
  mk(big1, { hasMore: 1 }), 10,
  { ok: false, reason: 'TOO_CLOSE_TO_EDGE' });

console.log('\n=== 3. 还有下一页 + 断崖（第 N 名 ≤2 赞，应通过）===');
// 100 条：前 2 条很高，第 10 名只有 1 赞
const dropLikes = [53275, 6074, 1, 1, 1, 1, 1, 1, 1, 1];
const big2 = [];
for (let i = 0; i < 100; i++) big2.push(i < 10 ? dropLikes[i] : (i % 3));
test('断崖分布 53275→6074→1，第10名=1 赞，hasMore=1',
  mk(big2, { hasMore: 1 }), 10,
  { ok: true, reason: 'LOW_THRESHOLD' });

console.log('\n=== 4. 还有下一页 + 尾部衰减（应通过）===');
// 300 条，第 10 名 800 赞，最后 20 条最高只有 5 赞
const big3 = [];
for (let i = 0; i < 300; i++) big3.push(i < 10 ? (1000 - i * 20) : (i > 280 ? 5 : 100));
test('第10名=720 赞、尾部最高 5 赞，hasMore=1',
  mk(big3, { hasMore: 1 }), 10,
  { ok: true, reason: 'TAIL_DECAYED' });

console.log('\n=== 5. 还有下一页 + 尾部仍接近门槛（应判不足）===');
const big4 = [];
for (let i = 0; i < 300; i++) big4.push(i < 10 ? (1000 - i * 20) : (i > 280 ? 700 : 100));
test('第10名=820 赞、尾部最高 700 赞，hasMore=1',
  mk(big4, { hasMore: 1 }), 10,
  { ok: false, reason: 'NEED_DEEPER' });

console.log('\n=== 6. 评论抓取报错（绝不能判足够）===');
test('commentErr="CODE:8"，comments 为空',
  { comments: [], commentHasMore: undefined, commentErr: 'CODE:8', commentPages: 1, sec: 3 }, 10,
  { ok: false, reason: 'COMMENT_ERROR' });

console.log('\n=== 7. 抓到 0 条评论 ===');
test('comments=[]，hasMore=0',
  mk([], { hasMore: 0 }), 10,
  { ok: false, reason: 'NO_COMMENTS' });

console.log('\n=== 8. commentHasMore 字段缺失（异常）===');
test('comments 有 100 条但 hasMore=undefined',
  mk(new Array(100).fill(5), { hasMore: undefined }), 10,
  { ok: false, reason: 'UNKNOWN_HAS_MORE' });

console.log('\n=== 9. 评论数少于 N（只有 3 条）===');
test('3 条评论、hasMore=0',
  mk([50, 30, 10], { hasMore: 0 }), 10,
  { ok: true, reason: 'REACHED_END' });
test('3 条评论、hasMore=1（数据矛盾，应判不足）',
  mk([50, 30, 10], { hasMore: 1 }), 10,
  { ok: false }); // 具体 reason 不限，任何「不足」结论都算对

console.log('\n=== 10. 全部 0 赞（除少数）===');
test('全部 0 赞、hasMore=1',
  mk(new Array(100).fill(0), { hasMore: 1 }), 10,
  { ok: true, reason: 'LOW_THRESHOLD' });

console.log('\n=== 11. cid 缺失导致定位失败 ===');
const noCid = { comments: new Array(100).fill(0).map((_, i) => ({ cid: i < 5 ? undefined : 'c' + i, like: 100 - i })), commentHasMore: 1, commentErr: null, commentPages: 3, sec: 5 };
test('部分 cid 为 undefined、hasMore=1',
  noCid, 10,
  { ok: false, reason: 'CID_MISSING' });

console.log('\n=== 12. 最小深度兜底（尾部衰减不能作为唯一依据）===');
// 真实反例：5 页 248 条，尾部最高赞很低（看似衰减），但第 448 条其实藏着 1508 赞的评论
const shallow = [];
for (let i = 0; i < 248; i++) shallow.push(i < 5 ? [18578, 4070, 2707, 1310, 667][i] : (i > 228 ? 2 : 20));
test('只抓 5 页、尾部最高 2 赞、第10名 20 赞（看似衰减，实则应加深）',
  mk(shallow, { hasMore: 1, pages: 5 }), 5,
  { ok: false, reason: 'BELOW_MIN_DEPTH' });

// 同样数据但抓够 15 页 → 应该放行
test('抓够 15 页、同样衰减特征（应通过）',
  mk(shallow, { hasMore: 1, pages: 15 }), 5,
  { ok: true, reason: 'TAIL_DECAYED' });

console.log('\n' + '='.repeat(60));
console.log(`通过 ${pass} / 失败 ${fail} / 共 ${pass + fail}`);
if (fail) {
  console.log('\n失败用例明细：');
  cases.filter(c => c.got.ok !== c.expect.ok || (c.expect.reason && c.got.reason !== c.expect.reason))
    .forEach(c => console.log(`  · ${c.name}: 实际 ${c.got.ok}/${c.got.reason} — ${c.detail || ''}`));
}
process.exit(fail ? 1 : 0);
