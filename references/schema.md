# 跨机数据规范（字段不许改）

> 入库脚本按字段名直取。改名、改类型、把 `null` 写成 `0`，都会废掉已采集的数据。

## `*_posts.json`（达人主页）

```json
{
  "at": "2026-11-10T07:20:00.000Z",
  "results": [{
    "ok": true,
    "secUid": "MS4wLjABAAAA...",
    "url": "https://www.douyin.com/user/MS4w...",
    "author": "昵称",
    "err": null,
    "pages": 3,
    "hasMore": true,
    "apiHits": 1,
    "total": 21,
    "source": "api",
    "profile": {
      "nickname": "昵称",
      "douyinId": "71847017050",
      "fans": 29034,
      "totalFavorited": 3824403,
      "ipLocation": "湖南",
      "awemeCount": 296
    },
    "identityCheck": { "api": "昵称", "page": "昵称", "ok": true, "warning": null },
    "posts": [],
    "sec": 5.4
  }]
}
```

### `posts[]` 每条

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | string | 作品 ID（纯数字字符串） |
| `desc` | string | 文案原文，可空 |
| `createTime` | int | **epoch 秒**，不是字符串、不是毫秒 |
| `isTop` | 0/1 | 是否置顶 |
| `type` | int | 0/4 = 视频，2/68 = 图文 |
| `digg` | int\|null | 点赞 |
| `comment` | int\|null | 评论数 |
| `collect` | int\|null | 收藏 |
| `share` | int\|null | 转发 |

**缺就写 `null`，不要补 `0`。** 0 会被当真实值参与计算，null 会被跳过。

### 三个口径字段不能删

`posts` 数组长度、`hasMore`、首末 `createTime` 之差（换算 `window_days`）：

- `window_days >= 15` → 可用于「近 15 天窗口」分析
- `< 15` → 只能算「最近 N 条」，单独统计

## `*_top.json`（视频 + 评价）

| 层级 | 字段 |
|---|---|
| 顶层 | `scrapedAt` / `target` / `finalPages` / `results` |
| `results[]` | `videoId` / `desc` / `link` |
| `results[]` | `stat.{digg,comment,collect,share}` |
| `results[]` | `scraped.{rows,pages,hasMore,sec}` |
| `results[]` | `tierRule.{tier,label,minLike}` / `qualifiedCount` |
| `results[]` | `top[]`（`rank/cid/like/text/name/ip/replyTotal/createTime/qualified`） |

**`cid` 是全局唯一评论 ID**，用它去重，重复跑不会翻倍。

## 编号不是身份

`H001` / `L001` / `X001` 只是批次内序号。认人只认 `sec_uid`。
