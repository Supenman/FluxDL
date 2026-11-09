# FluxDL B 站下载变慢：根因定位与修复建议

> **材料与口径**：本次以你上传的 `FluxDL-0.3.6-Full-Source.zip`、`FluxDL-0.3.9-Source.zip` 为准；二者已与本地归档 `archive-0.3.6` / `archive-0.3.9` 逐文件比对，94 / 107 个有效文件、**0 差异**。当前环境无 GitHub 认证（匿名 `repos/Supenman/FluxDL` 返回 404，`gh` 未登录，旧 PAT 已删），故**未能直接调用 API 复核线上 Release 元数据**；但源码资产内容与归档一致，足以支撑版本间代码对比。
>
> **状态**：证据链已闭合，修复方案待拍板。

---

## 一、一句话结论

**不是 0.3.9 升级造成的。** 0.3.6 → 0.3.9 期间，FluxDL 对 B 站的下载链路——命令参数、任务类型、随包 `yt-dlp.exe` 二进制——逐字节完全一致；而那条被写进注释、声称用来「绕开 web 端 ~120 KB/s 单连接限速」的 `--extractor-args bilibili:player_client=tv,app`，经证实是**把 YouTube 的参数误用到了 B 站上，从上线第一天起就是死参数**。

因此「之前流畅、现在慢」的变量不在 FluxDL 版本里，只可能在外部：**B 站服务端对匿名 web `playurl` 接口 / CDN 的限速策略随时间收紧**，或**运行时 `yt-dlp.exe` 被自动更新后提取器行为改变**。抖音和普通直链之所以仍然流畅，是因为它们走 A 档 aria2 多连接，压根不经过 yt-dlp 这条慢通道。

---

## 二、证据链（已坐实）

| 对比项 | 0.3.6 | 0.3.9 | 判定 |
|---|---|---|---|
| 随包 `yt-dlp.exe` SHA | `f5389d36…` | `f5389d36…`（0.3.7 / 0.3.8 亦同） | 四版同一个二进制 |
| `media.rs` B 站命令构造 | `bv*+ba/b` + `--concurrent-fragments 4` + `bilibili:player_client=tv,app` | 逐字相同 | 无变化 |
| `aria2_suits_url()` | `!is_bilibili(url)` | 相同 | B 站一直被排除在 aria2 外 |
| `Engine::add` 对 `TaskKind::Media` | 默认关 aria2 | 相同 | B 站一直单连接 / 少分片 |
| 扩展主按钮（B 站整页） | `kind:"media"` | `kind:"media"` | 入口未变 |
| 探针 `NOISE_EXT` / `SEGMENT_EXT` / `looksLikeMedia()` | — | 关键过滤规则逐字一致 | 未新增「抓 B 站直链」能力 |
| 上传源码包 vs 本地归档 | 94 文件 0 差异 | 107 文件 0 差异 | 无夹带 |
| 两包内部全量 diff | — | 仅新增 13、改动 28 | 改动集中在抖音 / A 档可靠性 / 速度显示 / 文档 |

补充：`CONCURRENT_FRAGMENTS` 由 4 提到 8 的独立实测包已交付并经你真机验证**无效**，该试探改动已回退，未提交、未发版。

---

## 三、决定性新发现：`player_client=tv,app` 是死参数

读取随包 `yt-dlp 2026.10.26` 的 zipapp（1046 个 `.py`）：

- `player_client` 在全包只出现 **4 次，全部在 `yt_dlp/extractor/youtube/_video.py`** —— 它是 **YouTube** 提取器的参数；
- `yt_dlp/extractor/bilibili.py` 中 `_configuration_arg()` 只读取**一个** key：`prefer_multi_flv`（测试时筛选 flv 格式，与客户端切换无关）；`player_client` 出现 **0 次**，`client=` / `platform=tv` / `platform=android` 均为 0 次；
- `_configuration_arg` 的实现（`common.py:4032`）只是从 `params['extractor_args'][ie_key][key]` 取值，**没有 key 白名单校验**：

```python
def _configuration_arg(self, key, default=NO_DEFAULT, *, ie_key=None, casesense=False):
    ie_key = ie_key if isinstance(ie_key, str) else (ie_key or self).ie_key()
    val = traverse_obj(self._downloader.params, ('extractor_args', ie_key.lower(), key))
    if val is None:
        return [] if default is NO_DEFAULT else default
    return list(val) if casesense else [x.lower() for x in val]
```

 → 传入 `bilibili:player_client=tv,app` 会被**静默存下、永不读取，连警告都不报**。

**也就是说：FluxDL 从来没有真正切换过 B 站客户端，一直用默认 web `playurl` 接口（`fnval=4048`）。** 注释里「绕开 web 端最严的单连接限速」是一厢情愿。这也同时说明「之前流畅」不可能靠它——两版都无效。

---

## 四、为什么「之前快、现在慢」

既然 FluxDL 侧两版完全等价，随时间变化的只剩外部：

1. **（最可能）B 站服务端限速收紧**：未登录 web 端 `playurl` 返回的 DASH CDN 直链，单连接带宽被压到 ~120–300 KB/s；yt-dlp 原生下载对分片流实际并发度很低（音轨常单连接跑到底），总吞吐直接等于单连接限速。`--concurrent-fragments 8` 无效也印证瓶颈是「单连接被限」而非「分片数不够」。
2. **运行时 yt-dlp 漂移**：`auto_update_yt_dlp` 默认 `true`，启动后台 `update_if_stale()` 会就地替换随包 `yt-dlp.exe` 并留 `.bak`。真机运行时版本可能已不同于随包版本，B 站提取器行为随之变化。该机制 0.3.6 / 0.3.9 一致，但它是**跨版本的真实时间变量**。
3. 用户侧网络出口 / 运营商变化（次要）。

> 沙箱内匿名请求 B 站返回 `HTTP 412`，无法复现真实速度，故第 1、2 条为高置信推断而非沙箱实测，需真机日志坐实。

---

## 五、为什么抖音、普通直链不受影响

| 通道 | 0.3.9 处理 | 实际下载引擎 | 结果 |
|---|---|---|---|
| 抖音作品页 | `douyin.rs` 解析移动端详情接口拿直链 → `TaskKind::Http` | A 档 aria2 `-x16 -s16 -k4M` 多连接 | 流畅 |
| 普通文件 / 直链 | `TaskKind::Http` | A 档 aria2 多连接 | 流畅 |
| **B 站整页** | `TaskKind::Media`，`Media` 默认关 aria2 | **yt-dlp 原生下载** | **慢** |

**慢的是 yt-dlp 这条通道，不是 FluxDL 的下载引擎本身。** 抖音在 0.3.9 已经示范了正确解法。

---

## 六、已排除的假设

- 随包 yt-dlp 版本不同 → 四版同一 SHA，排除
- B 站 yt-dlp 参数变化 → 逐字一致，排除
- 入口 `kind` 在 media / http 间变化 → 一致，排除
- 探针不再抓 B 站直链 → 规则一致，排除
- 分片并发不够 → 4→8 真机无效，排除
- A 档 HTTP 引擎退化 → 抖音 / 直链流畅，排除

---

## 七、修复方案

| 方案 | 有效性 | 工程量 | 风险 | 建议 |
|---|---|---|---|---|
| A. 继续调分片并发 | 已证伪 | — | — | ❌ 放弃 |
| B. 修 / 换 `player_client` 参数 | 当前 yt-dlp 的 B 站提取器**不提供**客户端切换参数，改了也无效 | 小 | 与 B 站风控军备竞赛，不稳 | ❌ 放弃 |
| C. 钉死 / 关闭 yt-dlp 自动更新 | 只消除版本漂移，不解决限速 | 小 | 低 | ⭕ 辅助措施 |
| D. **B 站直链解析接 A 档 aria2**（照抖音做） | **直击瓶颈** | 中 | 中（DASH 音视频合并、直链 referer 鉴权、失效重试） | ✅ **推荐** |

方案 D 的技术前提已验证：`bilibili.py:76-106` 正是从 playurl 响应里取真实 CDN 直链——

```python
audios = traverse_obj(play_info, ('dash', (None, 'dolby'), 'audio', ..., {dict}))
'url': traverse_obj(audio, 'baseUrl', 'base_url', 'url'),
'url': traverse_obj(video, 'baseUrl', 'base_url', 'url'),
} for video in traverse_obj(play_info, ('dash', 'video', ...)))
```

即 `play_info['dash']['video'/'audio'][*]['baseUrl']`。把这两条直链分别交给 A 档 `-x16` 多连接下载，再用随包 ffmpeg 合并成 mp4 即可。现成条件：`douyin.rs` 的「解析 → 转 `TaskKind::Http`」路径可复用，A 档 aria2 引擎、随包 `ffmpeg.exe` / `ffmpeg` 均已就位。这是唯一能复现抖音「流畅」的架构路径。

---

## 八、下一步

**需要你拍板**：是否按方案 D 做 B 站直链解析接 A 档引擎？这属架构改动、不是轻量 patch，我会先出设计再动代码。

同时，若方便提供真机三项信息，可把第四节两条推断坐实：

1. 便携版目录下 `yt-dlp.exe` 旁是否存在 `yt-dlp.exe.bak`（有 = 自动更新发生过）；
2. 一个可复现的 BV 号 + 任务日志里的实际速度；
3. 同页面「本页资源」里若出现 `.m4s` / `.mp4` 直链，用 A 档下载是否明显更快。

> 另：GitHub 线上 Release 元数据若要直接复核，需要你提供一个新的 PAT 或连接 GitHub 连接器。

---

## 九、本次清理

- 已回退 `dev` 分支上未提交的 `CONCURRENT_FRAGMENTS: 8` 试探改动，`git status` 干净，常量复原为 `4`。
- frag8 实测包保留在 `/workspace/fluxdl-frag8-test/`（**未发布**，未写入 `update-manifest.json`，正式版 `/workspace/fluxdl-dist/` 未受影响）。
