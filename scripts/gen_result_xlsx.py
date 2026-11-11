#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
抖音抓取结果导出 Excel（视频 + 评价）
依据：data/douyin/index_all_with_test.json（视频级）、index_all_with_test_comments.csv（评价级）
规则：6 档分层阈值（业务定稿 2026-11-09）

用法：python tools/douyin/gen_result_xlsx.py [输出路径]
"""
import csv
import json
import os
import sys
from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
from openpyxl.utils import get_column_letter

ROOT = os.environ.get('DY_ROOT') or os.getcwd()
DATA_ROOT = os.environ.get('DY_DATA_DIR') or os.path.join(ROOT, 'dy_output')
IDX = os.path.join(DATA_ROOT, 'index_all.json')
CMT = os.path.join(DATA_ROOT, 'index_all_comments.csv')
STAMP = __import__('datetime').date.today().strftime('%Y%m%d')
OUT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(DATA_ROOT, f'抖音抓取结果_视频与评价_{STAMP}.xlsx')

# ── 分层阈值规则（6 档，左闭右开）──
RULE = [
    (0, 5000, 5, '<5千'),
    (5000, 10000, 10, '5千-1万'),
    (10000, 50000, 20, '1万-5万'),
    (50000, 100000, 50, '5万-10万'),
    (100000, 500000, 100, '10万-50万'),
    (500000, float('inf'), 500, '≥50万'),
]


def rule_for(digg):
    for lo, hi, th, label in RULE:
        if lo <= digg < hi:
            return label, th
    return RULE[-1][3], RULE[-1][2]


def grade(cnt):
    if cnt >= 8:
        return '充足'
    if cnt >= 3:
        return '一般'
    if cnt >= 1:
        return '偏弱'
    return '极弱'


# ── 样式 ──
HEAD_FILL = PatternFill('solid', fgColor='1A1A1A')
HEAD_FONT = Font(color='FFFFFF', bold=True, size=10)
BODY_FONT = Font(size=10)
THIN = Side(style='thin', color='D9D9D9')
BORDER = Border(left=THIN, right=THIN, top=THIN, bottom=THIN)
CENTER = Alignment(horizontal='center', vertical='center')
LEFT = Alignment(horizontal='left', vertical='center', wrap_text=False)


def style_sheet(ws, widths, numeric_cols=()):
    """表头样式 + 列宽 + 冻结 + 边框"""
    for i, w in enumerate(widths, start=1):
        ws.column_dimensions[get_column_letter(i)].width = w
    for c in ws[1]:
        c.fill = HEAD_FILL
        c.font = HEAD_FONT
        c.alignment = CENTER
        c.border = BORDER
    ws.freeze_panes = 'A2'
    ws.row_dimensions[1].height = 22
    for row in ws.iter_rows(min_row=2):
        for c in row:
            c.font = BODY_FONT
            c.border = BORDER
            if c.column in numeric_cols:
                c.alignment = Alignment(horizontal='right', vertical='center')
            else:
                c.alignment = LEFT


# ── 读数据 ──
with open(IDX, encoding='utf-8') as f:
    idx = json.load(f)
videos = [v for v in idx['videos'] if v.get('fetchedComments', 0) > 0]

rows = []
with open(CMT, encoding='utf-8-sig', newline='') as f:
    for r in csv.DictReader(f):
        rows.append(r)

# 按视频聚合评价
by_vid = {}
for r in rows:
    by_vid.setdefault(r['视频ID'], []).append(r)

def _time_range(vs):
    ts = [v.get('capturedAt') for v in vs if v.get('capturedAt')]
    if not ts:
        return '未记录（索引中无 capturedAt）'
    return f"{min(ts)[:19]} ~ {max(ts)[:19]}"


wb = Workbook()

# ══════════ Sheet 1 · 总览 ══════════
ws = wb.active
ws.title = '总览'
total_cmt = sum(v['fetchedComments'] for v in videos)
total_pass = 0
for v in videos:
    th = rule_for(v['digg'])[1]
    total_pass += sum(1 for c in by_vid.get(v['videoId'], []) if int(c['评价点赞']) >= th)

overview = [
    ('数据来源', '抖音 · 女装裤类关键词搜索 + 首页推荐流 + 分层抽样'),
    ('抓取时间范围', _time_range(videos)),
    ('视频数（有评价明细）', len(videos)),
    ('评价总数', total_cmt),
    ('达标评价数', total_pass),
    ('达标率', f'{total_pass / total_cmt * 100:.1f}%'),
    ('平均每视频评价数', f'{total_cmt / len(videos):.1f}'),
    ('分层规则', '6 档，按视频点赞定单条评价点赞门槛（见「分层汇总」）'),
    ('', ''),
    ('说明 1', '评价为每条视频按点赞降序抓取的前 20 条一级评论（不足 20 条则全取）'),
    ('说明 2', '「达标」= 单条评价点赞 ≥ 该视频所属档位的门槛'),
    ('说明 3', '抖音不公开播放量，热度以视频点赞与评价点赞衡量'),
    ('说明 4', '抓取覆盖率约 1.2%（评价数 ÷ 平台评论总数），非全量评论'),
]
ws.append(['项目', '内容'])
for k, v in overview:
    ws.append([k, v])
style_sheet(ws, [26, 92])
for row in ws.iter_rows(min_row=2, max_col=1):
    row[0].font = Font(size=10, bold=True)

# ══════════ Sheet 2 · 分层汇总 ══════════
ws = wb.create_sheet('分层汇总')
ws.append(['视频层次', '评价阈值', '视频数', '评价数', '达标条数', '达标率',
           '有达标视频', '平均每视频达标', '最高评价赞'])
for lo, hi, th, label in RULE:
    inr = [v for v in videos if lo <= v['digg'] < hi]
    if not inr:
        ws.append([label, f'≥{th}', 0, 0, 0, '0.0%', '0/0', 0, 0])
        continue
    cmts = [c for v in inr for c in by_vid.get(v['videoId'], [])]
    passed = [c for c in cmts if int(c['评价点赞']) >= th]
    with_pass = sum(1 for v in inr if any(int(c['评价点赞']) >= th for c in by_vid.get(v['videoId'], [])))
    max_like = max((int(c['评价点赞']) for c in cmts), default=0)
    ws.append([
        label, f'≥{th}', len(inr), len(cmts), len(passed),
        f'{len(passed) / len(cmts) * 100:.1f}%' if cmts else '0.0%',
        f'{with_pass}/{len(inr)}',
        round(len(passed) / len(inr), 1), max_like,
    ])
ws.append(['合计', '—', len(videos), total_cmt, total_pass,
           f'{total_pass / total_cmt * 100:.1f}%', '—', round(total_pass / len(videos), 1), ''])
style_sheet(ws, [12, 10, 8, 9, 10, 9, 12, 15, 12], numeric_cols=(3, 4, 5, 8, 9))
for c in ws[ws.max_row]:
    c.font = Font(size=10, bold=True)

# ══════════ Sheet 3 · 视频清单 ══════════
ws = wb.create_sheet('视频清单')
ws.append(['视频层次', '该档阈值', '视频ID', '作者', '标题', '视频点赞', '平台评论数',
           '抓到评价数', '达标条数', '质量等级', '最高评价赞', '抓取时间'])
for v in sorted(videos, key=lambda x: -x['digg']):
    label, th = rule_for(v['digg'])
    cmts = by_vid.get(v['videoId'], [])
    passed = sum(1 for c in cmts if int(c['评价点赞']) >= th)
    max_like = max((int(c['评价点赞']) for c in cmts), default=0)
    ws.append([
        label, f'≥{th}', v['videoId'], v['author'], (v['desc'] or '')[:60],
        v['digg'], v['comment'], v['fetchedComments'], passed, grade(passed),
        max_like, (v['capturedAt'] or '')[:19],
    ])
style_sheet(ws, [11, 10, 21, 16, 46, 11, 12, 11, 9, 9, 11, 20],
            numeric_cols=(6, 7, 8, 9, 11))

# ══════════ Sheet 4 · 达标评价 ══════════
ws = wb.create_sheet('达标评价')
ws.append(['视频层次', '该档阈值', '视频ID', '视频作者', '视频点赞', '评价排名',
           '评价点赞', '评价内容', '评价者', '地区', '子回复数', 'cid'])
vid_meta = {v['videoId']: v for v in videos}
cnt = 0
for v in sorted(videos, key=lambda x: -x['digg']):
    label, th = rule_for(v['digg'])
    for c in sorted(by_vid.get(v['videoId'], []), key=lambda x: -int(x['评价点赞'])):
        like = int(c['评价点赞'])
        if like < th:
            continue
        ws.append([label, f'≥{th}', v['videoId'], v['author'], v['digg'],
                   int(c['评价排名']), like, (c['评价内容'] or '')[:80],
                   c['评价者'], c['地区'], c['子回复数'], c['cid']])
        cnt += 1
style_sheet(ws, [11, 10, 21, 16, 11, 9, 9, 56, 18, 8, 9, 21],
            numeric_cols=(5, 6, 7, 11))

# ══════════ Sheet 5 · 全部评价 ══════════
ws = wb.create_sheet('全部评价')
ws.append(['视频层次', '该档阈值', '是否达标', '视频ID', '视频作者', '视频点赞',
           '评价排名', '评价点赞', '评价内容', '评价者', '地区', '子回复数', 'cid'])
allc = 0
for v in sorted(videos, key=lambda x: -x['digg']):
    label, th = rule_for(v['digg'])
    for c in sorted(by_vid.get(v['videoId'], []), key=lambda x: -int(x['评价点赞'])):
        like = int(c['评价点赞'])
        ws.append([label, f'≥{th}', '是' if like >= th else '否', v['videoId'], v['author'],
                   v['digg'], int(c['评价排名']), like, (c['评价内容'] or '')[:80],
                   c['评价者'], c['地区'], c['子回复数'], c['cid']])
        allc += 1
style_sheet(ws, [11, 10, 8, 21, 16, 11, 9, 9, 56, 18, 8, 9, 21],
            numeric_cols=(6, 7, 8, 12))

wb.save(OUT)
print(f'[saved] {OUT}')
print(f'  Sheet 总览      : 7 项概况 + 4 条口径说明')
print(f'  Sheet 分层汇总  : 6 档 × 9 列')
print(f'  Sheet 视频清单  : {len(videos)} 行 × 12 列')
print(f'  Sheet 达标评价  : {cnt} 行 × 12 列')
print(f'  Sheet 全部评价  : {allc} 行 × 13 列')
