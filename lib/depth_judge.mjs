/**
 * 抓取深度判定（从 dy_top.mjs 抽出的纯函数，便于单元测试）
 *
 * 输入：dy_scrape.mjs 单条 result
 * 输出：判定结果 + 各中间量（便于排查）
 *
 * 判定原则（按优先级）：
 *   0) 评论抓取本身报错 / 一条都没抓到 → 判定失败（不能因为「没数据」就说「够了」）
 *   1) hasMore=0 → 一级评论已全部抓完，位置再靠后也完整 → 通过
 *   2) 还有下一页时：
 *      a) TOP N 最靠后那条位于抓取量 85% 之后 → 贴边，判定不足
 *      b) 第 N 名已低到 2 赞以下 → 后面不可能有更高的 → 通过
 *      c) 尾部最高赞 < 第 N 名门槛的 30% → 热度已衰减 → 通过
 *      否则 → 判定不足
 */
export function judgeDepth(result, N) {
  const all = result.comments || [];
  const hasMore = result.commentHasMore;
  const err = result.commentErr || null;

  const sorted = [...all].sort((a, b) => (b.like - a.like) || String(a.cid).localeCompare(String(b.cid)));
  const top = sorted.slice(0, N);

  const nthLike = sorted.length >= N ? sorted[N - 1].like : null;
  const tiedAtNth = nthLike === null ? 0 : sorted.filter(c => c.like === nthLike).length;
  const effectiveHighLike = sorted.filter(c => c.like > 10).length;

  const boundary = sorted.length >= N ? sorted[N - 1].like : null;
  const lastRows = all.slice(-Math.min(all.length, 20));
  const tailMax = lastRows.length ? Math.max(...lastRows.map(c => c.like)) : 0;

  const positions = top.map(c => all.findIndex(x => x.cid === c.cid) + 1);
  const topMaxPos = positions.length ? Math.max(...positions) : 0;
  const positionRisk = +((topMaxPos / Math.max(all.length, 1)) * 100).toFixed(0);

  // 致命情况优先：抓取失败 / 空结果 / 状态未知，绝不能判「足够」
  if (err) {
    return { ok: false, reason: 'COMMENT_ERROR', detail: err, top, topMaxPos, positionRisk, boundary, tailMax, nthLike, tiedAtNth, effectiveHighLike };
  }
  if (!all.length) {
    return { ok: false, reason: 'NO_COMMENTS', detail: '抓到 0 条一级评论', top, topMaxPos, positionRisk, boundary, tailMax, nthLike, tiedAtNth, effectiveHighLike };
  }
  // hasMore 必须是明确布尔：undefined/null 代表抓取状态未知（接口异常、进程被中断），
  // 不能默认当成 false —— 否则会把「没抓完也不知道」当成「已经抓完」
  if (hasMore !== 0 && hasMore !== 1 && hasMore !== true && hasMore !== false) {
    return { ok: false, reason: 'UNKNOWN_HAS_MORE', detail: `commentHasMore=${JSON.stringify(hasMore)}，抓取状态未知`, top, topMaxPos, positionRisk, boundary, tailMax, nthLike, tiedAtNth, effectiveHighLike };
  }
  // cid 缺失会让「TOP N 在序列中的位置」算不出来，贴边检测失效 —— 直接判异常。
  // 注意不能只靠 findIndex(-1) 判断：cid 为 undefined 时会误匹配到另一条同样缺失 cid 的记录
  if (top.length && top.some(c => c.cid === undefined || c.cid === null || c.cid === '')) {
    return { ok: false, reason: 'CID_MISSING', detail: 'TOP N 中有评论缺少 cid，无法定位其抓取位置', top, topMaxPos, positionRisk, boundary, tailMax, nthLike, tiedAtNth, effectiveHighLike };
  }
  if (top.length && positions.some(p => p <= 0)) {
    return { ok: false, reason: 'CID_MISSING', detail: 'TOP N 中有评论在抓取序列里定位不到（cid 不匹配）', top, topMaxPos, positionRisk, boundary, tailMax, nthLike, tiedAtNth, effectiveHighLike };
  }

  // 已抓到底
  if (!hasMore) {
    return { ok: true, reason: 'REACHED_END', detail: 'hasMore=0，一级评论已抓完', top, topMaxPos, positionRisk, boundary, tailMax, nthLike, tiedAtNth, effectiveHighLike };
  }

  // 最小深度兜底：实测高赞评论可能被排到很后面（TOP5 的第 5 名在第 448 条），
  // 这种情况下尾部照样是低赞，TAIL_DECAYED 会误判通过。所以少于 MIN_PAGES 一律判不足。
  const pages = result.commentPages || 0;
  const MIN_PAGES = parseInt(process.env.DY_MIN_PAGES || '15', 10);
  if (pages < MIN_PAGES) {
    return {
      ok: false, reason: 'BELOW_MIN_DEPTH',
      detail: `仅抓 ${pages} 页，低于最小深度 ${MIN_PAGES} 页（高赞可能藏在更深处）`,
      top, topMaxPos, positionRisk, boundary, tailMax, nthLike, tiedAtNth, effectiveHighLike,
    };
  }

  // 还有下一页：先看是否贴边
  if (topMaxPos / Math.max(all.length, 1) > 0.85) {
    return { ok: false, reason: 'TOO_CLOSE_TO_EDGE', detail: `TOP${N} 最靠后一条在第 ${topMaxPos} 条 / 共 ${all.length} 条（${positionRisk}%），且还有下一页`, top, topMaxPos, positionRisk, boundary, tailMax, nthLike, tiedAtNth, effectiveHighLike };
  }

  if (boundary !== null && boundary <= 2) {
    return { ok: true, reason: 'LOW_THRESHOLD', detail: `第 ${N} 名仅 ${boundary} 赞，后续不可能更高`, top, topMaxPos, positionRisk, boundary, tailMax, nthLike, tiedAtNth, effectiveHighLike };
  }

  if (boundary !== null && tailMax < boundary * 0.3) {
    return { ok: true, reason: 'TAIL_DECAYED', detail: `尾部最高 ${tailMax} 赞 < 门槛 ${boundary} 的 30%`, top, topMaxPos, positionRisk, boundary, tailMax, nthLike, tiedAtNth, effectiveHighLike };
  }

  return { ok: false, reason: 'NEED_DEEPER', detail: `尾部最高 ${tailMax} 赞仍接近门槛 ${boundary} 赞，可能还有更高评论`, top, topMaxPos, positionRisk, boundary, tailMax, nthLike, tiedAtNth, effectiveHighLike };
}
