/**
 * 抖音分层阈值规则（定稿 · 2026-11-09 业务确认）
 *
 * 核心规则：视频点赞越高，要求单条评价的点赞也越高。
 * 这是业务侧定的分层阈值，不是从数据反推的建议值。
 *
 * 实测达标情况（252 条视频 / 11,508 条评价）见文件末尾注释。
 */

// ── 六档阈值规则（定稿）──────────────────────────────
// 左闭右开 [min, max)
export const TIER_RULE = [
  { tier: 'F', min: 0,      max: 5000,     minLike: 5,   label: '<5千' },
  { tier: 'E', min: 5000,   max: 10000,    minLike: 10,  label: '5千–1万' },
  { tier: 'D', min: 10000,  max: 50000,    minLike: 20,  label: '1万–5万' },
  { tier: 'C', min: 50000,  max: 100000,   minLike: 50,  label: '5万–10万' },
  { tier: 'B', min: 100000, max: 500000,   minLike: 100, label: '10万–50万' },
  { tier: 'A', min: 500000, max: Infinity, minLike: 500, label: '≥50万' },
];

/** 取视频所属档位规则 */
export function ruleFor(videoDigg) {
  return TIER_RULE.find(r => videoDigg >= r.min && videoDigg < r.max) || TIER_RULE[TIER_RULE.length - 1];
}

/** 该视频要求的「单条评价最低点赞」 */
export function qualifiedThreshold(videoDigg) {
  return ruleFor(videoDigg).minLike;
}

/** 单条评价是否达标（按该视频所属档位的阈值判定） */
export function isQualified(commentLike, videoDigg) {
  return commentLike >= qualifiedThreshold(videoDigg);
}

/**
 * 从一组评价里筛出达标的
 * @param {Array<{like:number}>} comments
 * @param {number} videoDigg 该视频的点赞数
 * @returns {Array} 达标的评价（保持原顺序，调用方负责排序）
 */
export function filterQualified(comments, videoDigg) {
  const th = qualifiedThreshold(videoDigg);
  return comments.filter(c => (c.like || 0) >= th);
}

// ── 质量分级（按达标条数，用于判断这条视频值不值得做结论）──
/**
 * 切分点 8/3/1 与小红书技能一致
 * @param {number} qualifiedCount 该视频达标的评价条数
 */
export function gradeQuality(qualifiedCount) {
  if (qualifiedCount >= 8) return '充足';
  if (qualifiedCount >= 3) return '一般';
  if (qualifiedCount >= 1) return '偏弱';
  return '极弱';
}

export const GRADE_ADVICE = {
  充足: '可直接做结论',
  一般: '可用，但样本偏薄',
  偏弱: '结论需谨慎，建议补样本',
  极弱: '无达标评价，建议换视频',
};

// ── 实测基准（2026-11-09 · 252 条视频 / 11,508 条评价）──
// ┌──────────┬──────┬──────┬────────┬────────┬──────────┬────────┐
// │ 层次      │ 阈值 │ 视频 │ 评价数 │ 达标数 │ 达标率    │ 有达标视频│
// ├──────────┼──────┼──────┼────────┼────────┼──────────┼────────┤
// │ <5千      │ ≥5   │  66  │   860  │    49  │   5.7%   │  22/66 │
// │ 5千–1万   │ ≥10  │  37  │ 1,055  │   122  │  11.6%   │  34/37 │
// │ 1万–5万   │ ≥20  │  54  │ 2,348  │   323  │  13.8%   │  46/54 │
// │ 5万–10万  │ ≥50  │  29  │ 2,404  │   190  │   7.9%   │  29/29 │
// │ 10万–50万 │ ≥100 │  59  │ 4,731  │   535  │  11.3%   │  58/59 │
// │ ≥50万     │ ≥500 │   7  │   110  │    69  │  62.7%   │   7/7  │
// ├──────────┼──────┼──────┼────────┼────────┼──────────┼────────┤
// │ 合计      │  —   │ 252  │11,508  │ 1,288  │  11.2%   │        │
// └──────────┴──────┴──────┴────────┴────────┴──────────┴────────┘
