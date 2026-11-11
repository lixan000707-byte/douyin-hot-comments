#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
抖音抓取台账（追加式）

用法：
    python tools/douyin/gen_ledger.py <抓取结果.json> [更多json...]
    python tools/douyin/gen_ledger.py --input a.json --ledger 抓取台账.xlsx

设计：
    · 台账累积保存，每次运行追加新批次，绝不覆盖历史
    · Sheet「批次汇总」每个批次一行
    · Sheet「达标评价」每条达标评价一行（按批次累积）
    · 同一批次号重复运行时跳过（防重复追加）

输入：dy_top.mjs 的输出 JSON（含 results[].tierRule / qualifiedCount / top[].qualified / verify）
"""
import json
import os
import sys
from datetime import datetime
from openpyxl import Workbook, load_workbook
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
from openpyxl.utils import get_column_letter

ROOT = os.environ.get('DY_ROOT') or os.getcwd()
DATA_ROOT = os.environ.get('DY_DATA_DIR') or os.path.join(ROOT, 'dy_output')
DEFAULT_LEDGER = os.path.join(DATA_ROOT, '抓取台账.xlsx')

# ── 样式 ──
HEAD_FILL = PatternFill('solid', fgColor='1A1A1A')
HEAD_FONT = Font(color='FFFFFF', bold=True, size=10)
BODY_FONT = Font(size=10)
THIN = Side(style='thin', color='D9D9D9')
BORDER = Border(left=THIN, right=THIN, top=THIN, bottom=THIN)

SUMMARY_HEAD = ['批次号', '追加时间', '抓取时间', '视频数', '评价数', '达标数',
                '达标率', '复检重合率', '深度不足数', '来源文件']
DETAIL_HEAD = ['批次号', '视频层次', '该档阈值', '视频ID', '视频作者', '视频点赞',
               '评价排名', '评价点赞', '评价内容', '评价者', '地区', '子回复数', 'cid']


def init_ledger(path):
    wb = Workbook()
    ws1 = wb.active
    ws1.title = '批次汇总'
    ws1.append(SUMMARY_HEAD)
    ws2 = wb.create_sheet('达标评价')
    ws2.append(DETAIL_HEAD)
    for ws in (ws1, ws2):
        for c in ws[1]:
            c.fill = HEAD_FILL
            c.font = HEAD_FONT
            c.alignment = Alignment(horizontal='center', vertical='center')
            c.border = BORDER
        ws.freeze_panes = 'A2'
        ws.row_dimensions[1].height = 22
    ws1.column_dimensions['A'].width = 22
    for col in ['B', 'C']:
        ws1.column_dimensions[col].width = 20
    for col in ['D', 'E', 'F', 'G', 'H', 'I']:
        ws1.column_dimensions[col].width = 12
    ws1.column_dimensions['J'].width = 42
    for col, w in zip('ABCDEFGHIJKLM', [22, 11, 10, 21, 16, 11, 9, 9, 56, 18, 8, 9, 21]):
        ws2.column_dimensions[col].width = w
    wb.save(path)
    return wb


def style_new_rows(ws, start_row):
    for row in ws.iter_rows(min_row=start_row):
        for c in row:
            c.font = BODY_FONT
            c.border = BORDER


def existing_batches(wb):
    ws = wb['批次汇总']
    return {str(r[0]) for r in ws.iter_rows(min_row=2, values_only=True) if r[0]}


def append_batch(wb, data, src_path):
    ws1 = wb['批次汇总']
    ws2 = wb['达标评价']

    scraped_at = data.get('scrapedAt') or datetime.now().isoformat()
    batch_id = 'B' + scraped_at.replace('-', '').replace(':', '').replace('T', '_')[:15]

    if batch_id in existing_batches(wb):
        print(f'  [跳过] 批次 {batch_id} 已存在')
        return None

    results = [r for r in (data.get('results') or []) if r.get('top') is not None]
    total_cmt = sum(r.get('fetchedRows', 0) for r in results)
    total_pass = sum(r.get('qualifiedCount', 0) for r in results)
    depth_bad = sum(1 for r in results if not r.get('depthEnough', True))

    verifies = [r['verify']['overlap'] for r in results if r.get('verify')]
    verify_avg = f'{sum(verifies) / len(verifies):.1f}%' if verifies else '—'

    r1_before = ws1.max_row
    ws1.append([
        batch_id,
        datetime.now().strftime('%Y-%m-%d %H:%M:%S'),
        scraped_at[:19].replace('T', ' '),
        len(results),
        total_cmt,
        total_pass,
        f'{total_pass / total_cmt * 100:.1f}%' if total_cmt else '0.0%',
        verify_avg,
        depth_bad,
        os.path.basename(src_path),
    ])
    style_new_rows(ws1, r1_before + 1)

    r2_before = ws2.max_row
    n = 0
    for r in results:
        rule = r.get('tierRule') or {}
        for c in r.get('top') or []:
            if not c.get('qualified'):
                continue
            ws2.append([
                batch_id, rule.get('label', ''), f"≥{rule.get('minLike', '')}",
                r.get('videoId', ''), r.get('author', ''), r.get('stat', {}).get('digg', 0),
                c.get('rank', ''), c.get('like', ''),
                (c.get('text') or '')[:80].replace('\n', ' '),
                c.get('name', ''), c.get('ip', ''), c.get('replyTotal', ''), c.get('cid', ''),
            ])
            n += 1
    if n:
        style_new_rows(ws2, r2_before + 1)

    print(f'  [追加] 批次 {batch_id}｜{len(results)} 视频 / {total_cmt} 评价 / 达标 {total_pass}｜复检 {verify_avg}')
    return batch_id


def main():
    args = sys.argv[1:]
    ledger = DEFAULT_LEDGER
    inputs = []
    i = 0
    while i < len(args):
        a = args[i]
        if a == '--ledger':
            ledger = os.path.abspath(args[i + 1]); i += 2
        elif a == '--input':
            inputs.append(args[i + 1]); i += 2
        else:
            inputs.append(a); i += 1

    if not inputs:
        print('用法：python tools/douyin/gen_ledger.py <抓取结果.json> [...]')
        print('      python tools/douyin/gen_ledger.py --ledger 路径.xlsx --input a.json')
        sys.exit(1)

    missing = [p for p in inputs if not os.path.exists(p)]
    if missing:
        print('[FATAL] 文件不存在：' + ', '.join(missing))
        sys.exit(4)

    if os.path.exists(ledger):
        wb = load_workbook(ledger)
        print(f'[台账] 已存在，追加模式：{ledger}')
        # 兼容旧版台账（缺 sheet 时补建）
        for name, head in (('批次汇总', SUMMARY_HEAD), ('达标评价', DETAIL_HEAD)):
            if name not in wb.sheetnames:
                ws = wb.create_sheet(name)
                ws.append(head)
    else:
        wb = init_ledger(ledger)
        print(f'[台账] 新建：{ledger}')

    added = 0
    for p in inputs:
        try:
            with open(p, encoding='utf-8') as f:
                data = json.load(f)
        except Exception as e:
            print(f'  [跳过] {os.path.basename(p)}：{e}')
            continue
        if append_batch(wb, data, p):
            added += 1

    wb.save(ledger)
    ws1 = wb['批次汇总']
    ws2 = wb['达标评价']
    print(f'\n[保存] {ledger}')
    print(f'  批次汇总：{ws1.max_row - 1} 个批次（本次新增 {added}）')
    print(f'  达标评价：{ws2.max_row - 1} 条（累积）')


if __name__ == '__main__':
    main()
