/**
 * FluxDL 链接捕获扩展 — MV3 service worker
 *
 * 设计要点：
 * 1) 自动接管：浏览器一旦开始下载 http(s) 资源就无条件交给桌面端。
 *    不再有「扩展名白名单 / 最小体积 / 分组开关」这类接管范围限制。
 * 2) 资源嗅探：监听所有响应头，把页面上真正可下载的媒体与文件收集起来，
 *    按标签页缓存，弹窗里像 IDM 一样列出来供点选。
 * 3) 流媒体站点：m4s / m3u8 / mpd 分片本身不能直接下，标记为「本页有视频」，
 *    交给桌面端内置 yt-dlp 解析整个页面（B 站、YouTube 等）。
 */
const API = "http://127.0.0.1:35917";
const TOKEN = "fluxdl-local-v1";
const MENU_LINK = "fluxdl-download-link";
const MENU_MEDIA = "fluxdl-download-media";

const DEFAULT_SETTINGS = { autoCapture: true };
const MAX_RESOURCES = 48;

// 注意：下面两个正则只用于「弹窗里显示哪些资源」，不是接管范围。
const FILE_EXT = /\.(mp4|m4v|mkv|webm|avi|mov|flv|wmv|mpg|mpeg|m2ts|mp3|m4a|aac|flac|wav|ogg|opus|wma|ape|zip|rar|7z|tar|gz|bz2|xz|zst|tgz|txz|iso|dmg|img|exe|msi|msix|appx|apk|deb|rpm|pkg|pdf|doc|docx|xls|xlsx|ppt|pptx|epub|mobi|azw3|rtf|odt|bin|dat)(?:[?#]|$)/i;
const STREAM_EXT = /\.(m4s|m3u8|mpd)(?:[?#]|$)/i;
// 探针链路专用：与 page-probe.js 的 SEGMENT_EXT 逐字一致。分片 / 密钥不是完整
// 视频，探针不下发，background 也不得把这类 URL 收进「本页资源」。
// 不能改 classify()：webRequest 看到的真实 .m4s 请求仍需标记「本页有视频」(stream)，
// 那是另一条链路；这里只约束 probeResources 消息。
const PROBE_SEGMENT_EXT = /\.(m4s|ts|m2ts|key)(?:[?#]|$)/i;
// 只列国内站点：与桌面端 `looks_like_media` 保持一致。
// 国外站点不做特殊适配，页面上嗅到的直链仍会作为普通下载发送。
const VIDEO_HOSTS = [
  "bilibili.com", "b23.tv", "douyin.com", "iesdouyin.com",
  "kuaishou.com", "xiaohongshu.com", "xhslink.com", "weibo.com",
  "iqiyi.com", "youku.com", "mgtv.com", "v.qq.com",
  "music.163.com", "zhihu.com", "ixigua.com", "acfun.cn",
];

function headerValue(headers, name) {
  if (!Array.isArray(headers)) return "";
  const hit = headers.find(
    (h) => h && h.name && h.name.toLowerCase() === name,
  );
  return hit ? String(hit.value || "") : "";
}

// 完整容器直链：CDN 上的视频 / 音频整文件，按普通下载处理，不交给 yt-dlp。
// 规则须与 Rust is_direct_media_file、前端 isDirectMediaFile 保持一致；
// 分片清单 .m3u8 / .mpd / .m4s 不在其中，仍需 yt-dlp 合并。
const DIRECT_MEDIA_EXT = /\.(mp4|m4v|mkv|webm|mov|flv|avi|ts|mp3|m4a|aac|flac|wav|ogg|opus)(?:[?#]|$)/i;

function isDirectMediaFile(url) {
  return DIRECT_MEDIA_EXT.test(String(url).split(/[?#]/)[0]);
}

/**
 * 该网页链接是否无法交给 yt-dlp 整页解析。
 * 0.3.4 真机截图：快手 /new-reco、抖音 /jingxuan 这类首页、发现页、精选页
 * 被当成「本页视频」发送，yt-dlp 一律报 Unsupported URL。
 * 内置解析器（2026.10.26）没有任何快手 / Kwai 提取器，这条路是关闭的。
 */
function isUnsupportedPage(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  const host = u.hostname.toLowerCase();
  const path = u.pathname.toLowerCase();
  // 快手：内置视频解析器确实没有 Kuaishou / Kwai 提取器，放行只会得到
  // Unsupported URL 的失败任务；配任何凭证也救不了没有提取器的站点。
  const isKs =
    host === "kuaishou.com" || host.endsWith(".kuaishou.com") ||
    host === "kwai.com" || host.endsWith(".kwai.com");
  if (isKs) return true;

  // 抖音作品页：桌面端 Engine::add 会用免 Cookie 的移动端详情接口把页面解析成
  // 无水印直链再下载，不需要登录态、不需要配置任何凭证。这里不再把抖音一律判
  // 成 unsupported，让弹窗主按钮与右键菜单把 /video/<id>、v.douyin.com 短链
  // 作为 media 任务发给桌面端；引擎侧 media_page_blocker 同步放行（只拦快手与
  // 纯首页），两侧一致。

  // 明显的聚合页：首页、发现页、推荐页、精选页（无具体视频 id）。
  // 抖音带 modal_id 的精选页由引擎从 modal_id 提取作品 ID 解析，不算聚合页。
  const hasModalId = /[?&]modal_id=\d+/i.test(url);
  const AGGREGATE = /^\/?$|^\/(jingxuan|discover|new-reco|hot|feed|recommend|explore|home|index|user|profile)(\/|$)/i;
  return AGGREGATE.test(path) && !hasModalId;
}

function isVideoPage(url) {
  if (!/^https?:/i.test(url) || isDirectMediaFile(url)) return false;
  try {
    const host = new URL(url).hostname.toLowerCase();
    const inList = VIDEO_HOSTS.some((h) => host === h || host.endsWith("." + h));
    return inList && !isUnsupportedPage(url);
  } catch {
    return false;
  }
}

/** 页面不支持整页解析时，给弹窗一句可操作指引；支持时返回空串。 */
function pageHint(url) {
  if (!/^https?:/i.test(url) || isDirectMediaFile(url) || isVideoPage(url)) return "";
  try {
    const host = new URL(url).hostname.toLowerCase();
    const inList = VIDEO_HOSTS.some((h) => host === h || host.endsWith("." + h));
    if (!inList) return "";
    const isKs =
      host === "kuaishou.com" || host.endsWith(".kuaishou.com") ||
      host === "kwai.com" || host.endsWith(".kwai.com");
    if (isKs) {
      return "内置解析器不支持快手网页链接。请在下方「本页资源」中选择视频直链下载；若列表为空，说明该页面只提供分片流，需打开单个视频页或换用其它来源。";
    }
    const isDouyin =
      host === "douyin.com" || host.endsWith(".douyin.com") ||
      host === "iesdouyin.com" || host.endsWith(".iesdouyin.com");
    if (isDouyin) {
      // 抖音详情页由桌面端免 Cookie 解析，这里只剩「聚合页（无视频 id）」会走到。
      return "这是抖音的聚合页（首页 / 精选 / 发现），不是单个视频详情页。请打开要下载的那个视频、复制详情页链接（或分享短链）重试，桌面端会自动解析下载、无需配置 Cookie。也可在下方「本页资源」里选择视频直链。";
    }
    return "这是站点首页 / 发现页 / 精选页，不是单个视频详情页，无法整页解析。请打开要下载的那个视频再试，或在下方「本页资源」中选择视频直链。";
  } catch {
    return "";
  }
}

/**
 * 从「本页资源」里挑出最可能是主视频的直链。
 *
 * 用于「整页解析不可用」的页面：快手（内置解析器无提取器）、抖音聚合页、
 * 站点首页等。抖音**详情页**由桌面端免 Cookie 解析（走 kind:"media"），但这些
 * 页面仍需靠扩展嗅探到的 video/mp4 整文件直链下载。真机截图里快手「本页资源」
 * 有两条 video/mp4（20.1 MB / 11.4 MB），用户不必手动点列表 —— 主按钮直接按
 * 「视频 mime 或容器扩展名 → 体积降序」选一条，作为普通下载发送（显式
 * kind:"http"，桌面端按 CDN 直链走 HTTP 任务，不会误判成 Media）。
 */
const VIDEO_CONTAINER_EXT = /\.(mp4|m4v|mkv|webm|mov|flv|avi|ts)(?:[?#]|$)/i;

function isVideoResource(rec) {
  const url = String((rec && rec.url) || "");
  const mime = String((rec && rec.mime) || "").toLowerCase();
  return /^video\//.test(mime) || VIDEO_CONTAINER_EXT.test(url.split(/[?#]/)[0]);
}

function bestVideoResource(resources) {
  const list = (Array.isArray(resources) ? resources : []).filter((r) => {
    const url = String((r && r.url) || "");
    return /^https?:/i.test(url) && !STREAM_EXT.test(url) && isVideoResource(r);
  });
  // 正片通常体积最大；体积未知（0）排在有明确体积的后面，但仍可作为兜底。
  // 次级键：探针上报的记录没有响应头、体积全是 0，若只按体积排序就等于让
  // addResource 的 LIFO 插入顺序决定主按钮目标 —— 最后上报的播放 API
  // （aweme/.../play/?mime_type=video_mp4）会压过明确的 .mp4 容器直链。
  // 体积相同时优先「URL path 带容器扩展名」的直链，保证选择确定且更可下载。
  const rank = (r) => (VIDEO_CONTAINER_EXT.test(String((r && r.url) || "").split(/[?#]/)[0]) ? 0 : 1);
  // 结构化解析给出的「正片」是页面接口明确指定的那条，比按体积猜更可信；
  // 没有该标记时（webRequest / 通用探针）行为与原来完全一致。
  const primaryRank = (r) => (r && r.primary ? 0 : 1);
  list.sort((a, b) => {
    const byPrimary = primaryRank(a) - primaryRank(b);
    if (byPrimary !== 0) return byPrimary;
    const bySize = (Number(b.size) || 0) - (Number(a.size) || 0);
    return bySize !== 0 ? bySize : rank(a) - rank(b);
  });
  return list[0] || null;
}

function nameFromUrl(url) {
  try {
    const u = new URL(url);
    return decodeURIComponent(u.pathname.split("/").pop() || "") || u.hostname;
  } catch {
    return String(url).slice(0, 80);
  }
}

/**
 * 结构化解析条目的文件名：优先用页面作品标题（YunX 的 VideoParseResult 思路），
 * 附上作者与清晰度，保证 .mp4 后缀。清理 Windows / POSIX 非法字符与控制字符，
 * 避免把页面文案直接当文件名时写出非法路径。
 */
function mediaFileName(rec) {
  const clean = (v, n) => String(v || "")
    .replace(/[\x00-\x1f\x7f]/g, "")
    .replace(/[\\/:*?"<>|]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, n);
  const title = clean(rec.title, 80);
  const author = clean(rec.author, 32);
  const ratio = clean(rec.ratio, 16);
  if (!title) return nameFromUrl(rec.url);
  const parts = [title];
  if (author) parts.push(author);
  if (ratio) parts.push(ratio);
  return `${parts.join(" - ")}.mp4`;
}

function nameFromDisposition(cd) {
  const star = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(cd);
  if (star) {
    try {
      return decodeURIComponent(star[1].trim().replace(/^"|"$/g, ""));
    } catch {
      return star[1].trim();
    }
  }
  const plain = /filename\s*=\s*"?([^";]+)"?/i.exec(cd);
  return plain ? plain[1].trim() : "";
}

/** 判定一个响应：流媒体分片 / 可下载文件 / 忽略 */
function classify(url, headers) {
  const mime = headerValue(headers, "content-type")
    .split(";")[0]
    .trim()
    .toLowerCase();
  const cd = headerValue(headers, "content-disposition");

  // 0.3.6：PWA manifest / 站点配置等不是可下载资源。真机截图里
  // manifest.webmanifest（486 B，application/vnd.*）曾被下面的 application
  // 规则误收进「本页资源」列表。只影响列表展示，不影响自动接管浏览器下载。
  if (
    /\.(webmanifest|manifest|json|map)(\?|#|$)/i.test(url) &&
    !/attachment/i.test(cd) &&
    !/^(video|audio)\//.test(mime)
  ) {
    return null;
  }

  // DASH / HLS 分片与清单：不列为文件，只标记「本页有视频」。
  if (
    STREAM_EXT.test(url) ||
    /^(application\/dash\+xml|application\/vnd\.apple\.mpegurl|application\/x-mpegurl|audio\/mpegurl)$/.test(
      mime,
    )
  ) {
    return "stream";
  }
  if (/^(video|audio)\//.test(mime) || FILE_EXT.test(url)) return "file";
  if (/attachment/i.test(cd)) return "file";
  if (
    /^application\//.test(mime) &&
    /(zip|rar|7z|octet-stream|pdf|msword|vnd\.|x-iso|x-tar|x-gzip|x-bzip|x-xz|epub|android)/.test(
      mime,
    )
  ) {
    return "file";
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * 0.3.7 候选：MAIN-world 探针上报的资源
 *
 * webRequest 只能看到「已经发起的请求」，抖音 / 快手把真实直链藏在 XHR 返回的
 * JSON body 里、或通过 Blob / MediaSource 播放时，响应头里根本没有那条 mp4。
 * page-probe.js（MAIN world）会读页面自己的响应文本，把藏在 JSON / 内联脚本 /
 * HLS 清单里的 http(s) 直链经 probe-bridge.js 转发到这里。
 *
 * 判定规则不另起一套：构造一个最小的 content-type 头，直接复用上面的
 * classify()。这样 PWA manifest 噪声过滤、stream/file 判定、三处规则一致性
 * 全部沿用既有实现，探针与 webRequest 殊途同归。
 * ------------------------------------------------------------------ */

/** 探针没有响应头，只能按 URL 扩展名推断 content-type（仅用于喂给 classify）。 */
function inferProbeMime(url) {
  const full = String(url);
  const path = full.split(/[?#]/)[0].toLowerCase();
  if (/\.m3u8$/.test(path)) return "application/vnd.apple.mpegurl";
  if (/\.mpd$/.test(path)) return "application/dash+xml";
  // 分片 / 密钥不是完整视频：不编造 video/* mime，否则 classify 会误收成 file。
  if (PROBE_SEGMENT_EXT.test(path)) return "";
  if (/\.(mp4|m4v|mkv|webm|mov|flv|avi)$/.test(path)) return "video/mp4";
  if (/\.(mp3|m4a|aac|flac|wav|ogg|opus)$/.test(path)) return "audio/mpeg";
  // 与 page-probe.js 的 VIDEO_MIME_HINT 同一规则：抖音 / 快手无扩展名直链。
  if (/[?&](?:mime_?type|mime|media_?type|content_?type)=video/i.test(full)) {
    return "video/mp4";
  }
  return "";
}

/** 权威判定：与 webRequest 共用 classify，返回 "file" / "stream" / null。 */
function probeResourceKind(url) {
  const path = String(url).split(/[?#]/)[0];
  // 必须放在 classify 之前：classify 的 STREAM_EXT 含 m4s、FILE_EXT 含 m2ts，
  // 直接喂进去会把分片误判成 stream / file。与 page-probe.js 的 SEGMENT_EXT 一致。
  if (PROBE_SEGMENT_EXT.test(path)) return null;
  const mime = inferProbeMime(url);
  const headers = mime ? [{ name: "content-type", value: mime }] : [];
  return classify(url, headers);
}

/* ------------------------------------------------------------------ *
 * 0.3.9 增强（一）：资源归一化分组
 *
 * 抖音 / 快手 CDN 直链每次刷新都换签名参数（token / expires / ssig ...），
 * 同一条视频会在「本页资源」里堆成好几行；而 play_addr.url_list 里的多镜像、
 * 多清晰度也混在一起。这里用「去掉易变签名参数后的 scheme://host/path +
 * 有语义 query」作为去重键：相同键合并成一行，其它地址收进 variants 供弹窗
 * 展开选择。
 *
 * 红线：只处理 URL 字符串本身，不发请求、不读 cookie、不携带任何凭证。
 * ------------------------------------------------------------------ */

// 易变参数白名单（签名 / 时效 / 随机 / 缓存打点）。有语义的参数一律保留：
// video_id / id / ratio / bitrate / quality / mime_type 等用于区分不同视频或清晰度，
// 绝不能因为去掉它们把两条不同资源误并成一行。
const VOLATILE_QUERY = /^(?:token|tokens|sign|signature|sig|ssig|auth_?key|authkey|access_?token|expires?|exp|e|t|ts|timestamp|time|nonce|salt|rnd|random|_|cache|cachebust|cb|hash|md5|key|secret|q-sign-algorithm|q-sign-time|q-key-time|q-signature|q-url-param-list|q-header-list|x-oss-signature|x-oss-signature-version|x-oss-expires|x-oss-access-key-id|x-amz-signature|x-amz-date|x-amz-expires|x-amz-credential|x-amz-security-token|x-cos-signature|x-cos-security-token|ossaccesskeyid|cdn_?hash|wstime|wssecret|verify|digest|checksum)$/i;

const MAX_VARIANTS = 8;

/** 归一化去重键；非法 URL / 带 user:pass@ 的原样返回，不参与分组。 */
function dedupeKey(url) {
  try {
    const u = new URL(String(url));
    if (!/^https?:$/i.test(u.protocol) || u.username || u.password) return String(url);
    const keep = [];
    u.searchParams.forEach((value, key) => {
      if (!VOLATILE_QUERY.test(key)) keep.push(`${key}=${value}`);
    });
    keep.sort();
    return `${u.protocol.toLowerCase()}//${u.host.toLowerCase()}${u.pathname}${keep.length ? "?" + keep.join("&") : ""}`;
  } catch {
    return String(url);
  }
}

/* ------------------------------------------------------------------ *
 * 0.3.9 增强（二）：轻量元数据探测
 *
 * 探针（page-probe.js）从 JSON body 里读到的直链没有响应头，size 恒为 0、
 * mime 靠猜、文件名难看，且带时效签名的直链可能已经失效。这里对每条新入队
 * 的资源做一次轻量 HEAD（服务器不支持时降级一次 Range GET），补回真实体积、
 * content-type / disposition 文件名、Accept-Ranges，并给一个可校验状态。
 *
 * 状态严格三态，避免误杀：
 *   2xx/3xx        -> ok（可下载，采信体积）
 *   404 / 410      -> dead（明确失效，弹窗标灰）
 *   403/401/429/5xx/超时/网络错 -> unknown（防盗链或临时失败，不标灰，仍允许下载）
 *
 * 红线：credentials:"omit"，不带任何 cookie / Authorization / 登录态；
 *       不设置自定义请求头（除降级时的 Range）；读到响应头立即断开连接。
 * ------------------------------------------------------------------ */

const META_TIMEOUT_MS = 3500;
const META_TTL_MS = 60_000;
const META_CONCURRENCY = 3;

/** 状态分类：拿不准的一律 unknown，绝不把防盗链 403 当成失效。 */
function metadataState(status) {
  const s = Number(status) || 0;
  if (s >= 200 && s < 400) return "ok";
  if (s === 404 || s === 410) return "dead";
  return "unknown";
}

function parseTotalLength(contentLength, contentRange) {
  const n = Number.parseInt(String(contentLength || ""), 10);
  if (Number.isFinite(n) && n > 0) return n;
  const m = /\/(\d+)\s*$/.exec(String(contentRange || ""));
  return m ? Number.parseInt(m[1], 10) || 0 : 0;
}

/** 从 fetch Response 提取元数据；缺字段 / stub 环境一律安全退化。 */
function metadataFromResponse(response) {
  const at = Date.now();
  if (!response || typeof response !== "object") {
    return { state: "unknown", status: 0, size: 0, mime: "", name: "", ranges: false, at };
  }
  const status = Number(response.status) || 0;
  const h = response.headers;
  const get = (name) => {
    if (!h || typeof h.get !== "function") return "";
    try { return String(h.get(name) || ""); } catch { return ""; }
  };
  const state = metadataState(status);
  const head = {
    length: get("content-length"),
    range: get("content-range"),
    type: get("content-type"),
    disposition: get("content-disposition"),
    ranges: get("accept-ranges"),
  };
  return {
    state,
    status,
    // 只有明确 ok 才采信体积：403 / 404 页面返回的 content-length 不是文件大小
    size: state === "ok" ? parseTotalLength(head.length, head.range) : 0,
    mime: state === "ok" ? head.type.split(";")[0].trim().toLowerCase() : "",
    name: state === "ok" ? nameFromDisposition(head.disposition) : "",
    ranges: state === "ok" && /bytes/i.test(head.ranges),
    at,
  };
}

async function probeMetadata(url) {
  const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timer = controller
    ? setTimeout(() => { try { controller.abort(); } catch { /* noop */ } }, META_TIMEOUT_MS)
    : null;
  const init = {
    method: "HEAD",
    credentials: "omit",
    cache: "no-store",
    referrerPolicy: "no-referrer",
    ...(controller ? { signal: controller.signal } : {}),
  };
  try {
    let response;
    try {
      response = await fetch(url, init);
    } catch {
      return metadataFromResponse(null);
    }
    // 部分 CDN 不实现 HEAD；降级一次 Range GET，只取 1 字节且读完头就断开。
    if (response && [405, 501].includes(Number(response.status))) {
      try {
        response = await fetch(url, { ...init, method: "GET", headers: { Range: "bytes=0-0" } });
      } catch {
        return metadataFromResponse(null);
      }
    }
    return metadataFromResponse(response);
  } finally {
    if (timer) clearTimeout(timer);
    if (controller) { try { controller.abort(); } catch { /* noop */ } }
  }
}

const metaQueue = [];
const metaLastAt = new Map();
let metaActive = 0;

function scheduleMetadataProbe(tabId, url, force = false) {
  if (!/^https?:/i.test(String(url))) return;
  const key = dedupeKey(url);
  const now = Date.now();
  if (!force && now - (metaLastAt.get(key) || 0) < META_TTL_MS) return;
  metaLastAt.set(key, now);
  metaQueue.push({ tabId, url });
  pumpMetadataQueue();
}

function pumpMetadataQueue() {
  while (metaActive < META_CONCURRENCY && metaQueue.length) {
    const job = metaQueue.shift();
    metaActive += 1;
    void (async () => {
      try {
        const meta = await probeMetadata(job.url);
        await applyMetadata(job.tabId, job.url, meta);
      } catch {
        // 探测失败不影响资源列表与主流程
      } finally {
        metaActive -= 1;
        pumpMetadataQueue();
      }
    })();
  }
}

async function applyMetadata(tabId, url, meta) {
  return enqueueResourceOp(async () => {
    const key = `res:${tabId}`;
    const data = await chrome.storage.session.get(key);
    const list = Array.isArray(data[key]) ? data[key] : [];
    const dk = dedupeKey(url);
    let changed = false;
    const next = list.map((rec) => {
      if (rec.url !== url && rec.dedupeKey !== dk) return rec;
      changed = true;
      const patched = { ...rec, meta };
      if (meta.state === "ok") {
        if ((!Number(rec.size) || rec.size <= 0) && meta.size > 0) patched.size = meta.size;
        if (!rec.mime && meta.mime) patched.mime = meta.mime;
        if (meta.name && (!rec.name || looksGeneric(rec.name))) patched.name = meta.name;
      }
      return patched;
    });
    if (changed) await chrome.storage.session.set({ [key]: next });
  });
}

/* ------------------------------------------------------------------ *
 * 本页资源缓存（按标签页）
 *
 * 注意：storage.session 的「读 → 改 → 写」之间跨了 await，MV3 事件循环里
 * 同一页面多个响应几乎同时到达时，几个 addResource 会各自读到同一份旧列表，
 * 后写的把先写的整份覆盖掉，表现为资源随机少几个甚至全丢。
 * 这里用一条 Promise 链把所有读改写串行化。
 * ------------------------------------------------------------------ */

let resourceQueue = Promise.resolve();

function enqueueResourceOp(fn) {
  resourceQueue = resourceQueue.then(fn).catch(() => {});
  return resourceQueue;
}

async function addResource(tabId, record) {
  return enqueueResourceOp(async () => {
    const key = `res:${tabId}`;
    const data = await chrome.storage.session.get(key);
    const list = Array.isArray(data[key]) ? data[key] : [];
    const dk = dedupeKey(record.url);
    const incoming = {
      ...record,
      dedupeKey: dk,
      variants: Array.isArray(record.variants) ? record.variants.slice(0, MAX_VARIANTS) : [],
    };

    // 1) 完全相同的 URL：只补齐更完整的字段，不重复插入一行
    const sameUrl = list.findIndex((x) => x.url === record.url);
    if (sameUrl >= 0) {
      const next = list.slice();
      next[sameUrl] = mergeResource(next[sameUrl], incoming);
      await chrome.storage.session.set({ [key]: next });
      setBadge(tabId, next.length).catch(() => {});
      return;
    }

    // 2) 归一化同组（仅签名参数不同的镜像 / 多清晰度）：合并进已有行的 variants，
    //    列表不再堆重复行；弹窗可展开 variants 选择具体地址。
    const sameGroup = list.findIndex(
      (x) => (x.dedupeKey || dedupeKey(x.url)) === dk,
    );
    if (sameGroup >= 0) {
      const next = list.slice();
      const base = next[sameGroup];
      const variants = Array.isArray(base.variants) ? base.variants.slice() : [];
      const exists = variants.some((v) => v && v.url === record.url);
      if (!exists && variants.length < MAX_VARIANTS) {
        variants.push({
          url: record.url,
          size: Number(record.size) || 0,
          mime: record.mime || "",
          name: record.name || nameFromUrl(record.url),
          via: record.via || "webRequest",
        });
      }
      // 同组只追加备用地址，主地址保留首条（先到先得），避免主按钮目标被顶掉
      next[sameGroup] = mergeResource(base, { ...incoming, url: base.url, variants });
      await chrome.storage.session.set({ [key]: next });
      setBadge(tabId, next.length).catch(() => {});
      return;
    }

    // 3) 新资源
    const next = [incoming, ...list].slice(0, MAX_RESOURCES);
    await chrome.storage.session.set({ [key]: next });
    setBadge(tabId, next.length).catch(() => {});
  });
}

/** 合并同一条资源：保留更完整 / 更可信的字段，绝不覆盖真实响应头数据。 */
function mergeResource(base, incoming) {
  const size = Number(base.size) || 0;
  const nextSize = Number(incoming.size) || 0;
  return {
    ...base,
    ...incoming,
    size: nextSize > 0 ? nextSize : size,
    mime: base.mime || incoming.mime || "",
    name: base.name && !looksGeneric(base.name) ? base.name : (incoming.name || base.name || ""),
    referer: base.referer || incoming.referer || "",
    meta: base.meta || incoming.meta,
    primary: Boolean(base.primary || incoming.primary),
    title: base.title || incoming.title || "",
    author: base.author || incoming.author || "",
    ratio: base.ratio || incoming.ratio || "",
    at: base.at || incoming.at || Date.now(),
  };
}

async function setBadge(tabId, count) {
  try {
    await chrome.action.setBadgeText({ tabId, text: String(count) });
    await chrome.action.setBadgeBackgroundColor({ tabId, color: "#2f6df6" });
  } catch {
    // 低版本 Chrome 不支持 badge 时忽略
  }
}

async function markStream(tabId) {
  return enqueueResourceOp(() =>
    chrome.storage.session.set({ [`stream:${tabId}`]: true }),
  );
}

async function clearTab(tabId) {
  return enqueueResourceOp(async () => {
    await chrome.storage.session.remove([`res:${tabId}`, `stream:${tabId}`]);
    try {
      await chrome.action.setBadgeText({ tabId, text: "" });
    } catch {
      // 忽略
    }
  });
}

chrome.webRequest.onResponseStarted.addListener(
  (details) => {
    const tabId = details.tabId;
    if (typeof tabId !== "number" || tabId < 0) return;
    const url = details.url || "";
    if (!/^https?:/i.test(url) || url.startsWith(API)) return;

    const headers = details.responseHeaders || [];
    const kind = classify(url, headers);
    if (!kind) return;
    if (kind === "stream") {
      void markStream(tabId);
      return;
    }

    const size = Number(headerValue(headers, "content-length")) || 0;
    const cd = headerValue(headers, "content-disposition");
    const mime = headerValue(headers, "content-type").split(";")[0].trim();
    const name =
      nameFromDisposition(cd) ||
      nameFromUrl(url);
    void addResource(tabId, {
      url,
      name,
      size,
      mime,
      referer: details.initiator || "",
      at: Date.now(),
      via: "webRequest",
      // webRequest 拿到的就是真实响应头，无需再发 HEAD 探测
      meta: {
        state: "ok",
        status: 200,
        size,
        mime: mime.toLowerCase(),
        name: nameFromDisposition(cd),
        ranges: /bytes/i.test(headerValue(headers, "accept-ranges")),
        at: Date.now(),
      },
    });
  },
  { urls: ["<all_urls>"] },
  ["responseHeaders", "extraHeaders"],
);

// 记住每个标签页最后一次提交的 URL：Chrome 对同一次导航会重复派发
// onUpdated，若每次都 clearTab，会把刚嗅探到的资源又清掉。
const lastNavUrl = new Map();

chrome.tabs.onRemoved.addListener((tabId) => {
  lastNavUrl.delete(tabId);
  void clearTab(tabId);
});
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (!changeInfo.url) return;
  if (lastNavUrl.get(tabId) === changeInfo.url) return;
  lastNavUrl.set(tabId, changeInfo.url);
  void clearTab(tabId);
});

/* ------------------------------------------------------------------ *
 * 右键菜单：只保留「链接」与「媒体」，删掉「下载当前页面」
 * ------------------------------------------------------------------ */

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU_LINK,
      title: "用 FluxDL 下载此链接",
      contexts: ["link"],
    });
    chrome.contextMenus.create({
      id: MENU_MEDIA,
      title: "用 FluxDL 下载此媒体",
      contexts: ["video", "audio"],
    });
  });
});

chrome.contextMenus.onClicked.addListener((info) => {
  // 「下载此媒体」(contexts: video/audio) 拿到的是 <video>/<audio> 的 srcUrl ——
  // 已经是可直接下载的文件 / 视频直链，不是网页。一律显式 kind:"http" 走普通
  // 下载，且不做网页判定：抖快的 srcUrl 常无扩展名（.../play/?mime_type=video_mp4），
  // 走 isUnsupportedPage 会被误当成网页拒绝，走 looks_like_media 会被误建成
  // Media 任务再被 media_page_blocker 拦掉。
  if (info.menuItemId === MENU_MEDIA) {
    const src = info.srcUrl;
    if (src && /^https?:/i.test(src)) {
      void sendToFluxDL({ url: src, kind: "http", referer: info.pageUrl }).catch(() => {});
    }
    return;
  }
  if (info.menuItemId !== MENU_LINK) return;
  const url = info.linkUrl;
  if (!url || !/^https?:/i.test(url)) return;
  // 抖音作品页由桌面端免 Cookie 解析（isVideoPage 返回 true），走下面的
  // kind:"media"。这里只剩快手（内置解析器无提取器）与站点聚合首页：给出可操作指引。
  if (isUnsupportedPage(url)) {
    notify(
      "该页面无法整页解析",
      "快手网页链接或站点聚合页无法整页解析。请在浏览器扩展「本页资源」里选择视频直链下载；抖音单个视频请复制它的详情页链接（或分享短链）重试，桌面端会自动免 Cookie 解析下载。",
      true,
    );
    return;
  }
  if (isVideoPage(url)) {
    void sendToFluxDL({ url, kind: "media", referer: url }).catch(() => {});
    return;
  }
  void sendToFluxDL({ url, kind: "http", referer: info.pageUrl }).catch(() => {});
});

/* ------------------------------------------------------------------ *
 * 桌面端通信
 * ------------------------------------------------------------------ */

async function loadSettings() {
  const stored = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  // 默认开启；只有用户显式关掉才是 false。
  return { autoCapture: stored.autoCapture !== false };
}

async function postDownload(payload) {
  const response = await fetch(`${API}/api/downloads`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-fluxdl-token": TOKEN,
    },
    body: JSON.stringify(payload),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok) {
    throw new Error(data.error || `HTTP ${response.status}`);
  }
  return data;
}

async function sendToFluxDL(payload, options = {}) {
  const { silent = false } = options;
  try {
    // 扩展侧不采集、不传输任何 cookie：抖音解析用的是免 Cookie 的移动端公开接口，
    // 桌面端只发一个普通 HTTPS 请求，不读取、不携带任何浏览器登录态。
    // CaptureRequest 走 serde rename_all="camelCase"，这里必须是 userAgent；
    // 0.3.3 写成 user_agent 会被静默忽略，防盗链站点因此 403。
    const data = await postDownload({ ...payload, userAgent: navigator.userAgent });
    if (!silent) {
      notify("已发送到 FluxDL", payload.filename || payload.url, false);
    }
    return data;
  } catch (error) {
    if (!silent) {
      notify("FluxDL 未运行", "请先启动 FluxDL 桌面端，然后重试。", true);
    }
    throw error;
  }
}

function notify(title, message, isError) {
  try {
    chrome.notifications.create({
      type: "basic",
      iconUrl: chrome.runtime.getURL("icons/128.png"),
      title,
      message: message || "",
      priority: isError ? 2 : 0,
    });
  } catch {
    // 通知权限被拒绝时静默失败
  }
}

/* ------------------------------------------------------------------ *
 * 0.3.9 开发态：抖音 / 快手下载方案（免 Cookie 直链解析）
 *
 * 早期「yt-dlp 整页解析 + 本机浏览器 Cookie（B 档）」经真机验证无效：抖音
 * PC Web 详情接口位于 Argus 网关后，缺 a_bogus / uifid 一律 403，随包 yt-dlp
 * 生成不了签名，Cookie 也救不了。该通道已整体移除，设置页不再有 Cookie 配置。
 *
 * 现方案：桌面端 Engine::add 拦截抖音作品页（含 v.douyin.com 短链），用免 Cookie
 * 的移动端详情接口 api.amemv.com 取无水印直链，转成普通 HTTP 任务交给 A 档引擎。
 * 扩展只负责把页面链接作为 kind:"media" 发给桌面端，不接触任何凭证。
 *
 * 快手仍不支持整页解析：内置解析器无 Kuaishou / Kwai 提取器，放行只会制造
 * 必然失败的任务；这类链接继续提示走「本页资源」直链。
 *
 * 「本页资源」重心不变：扩展嗅探到的都是文件 / 视频直链，下载时一律显式
 * kind:"http"，避免无扩展名直链被 looks_like_media 误判成 Media 任务。
 * ------------------------------------------------------------------ */

// 缓存健康检查结果，避免每个下载都探测一次端口。
let healthCache = { at: 0, ok: false };

async function fluxdlIsRunning() {
  const now = Date.now();
  if (now - healthCache.at < 5000) return healthCache.ok;
  let ok = false;
  try {
    const response = await fetch(`${API}/api/health`, { cache: "no-store" });
    const data = await response.json().catch(() => ({}));
    ok = response.ok && Boolean(data.ok);
  } catch {
    ok = false;
  }
  healthCache = { at: now, ok };
  return ok;
}

/* ------------------------------------------------------------------ *
 * 自动接管浏览器下载（无任何范围限制）
 * ------------------------------------------------------------------ */

function filenameFromPath(path) {
  if (!path) return "";
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || "";
}

function stripDedupSuffix(name) {
  return name
    .replace(/\s*\(\d+\)(?=\.[^.]*$)/, "")
    .replace(/\s*\(\d+\)$/, "")
    .trim();
}

const GENERIC_STEMS = new Set([
  "download", "downloadfile", "getfile", "get", "file", "index",
  "unnamed", "attachment",
]);

function looksGeneric(name) {
  const dot = name.lastIndexOf(".");
  const stem = (dot === -1 ? name : name.slice(0, dot)).toLowerCase().trim();
  return !stem || GENERIC_STEMS.has(stem);
}

function suggestedFilename(item) {
  const raw = filenameFromPath(item.filename) || nameFromUrl(item.url || "");
  const cleaned = stripDedupSuffix(raw);
  return looksGeneric(cleaned) ? "" : cleaned;
}

/**
 * 只保留一个总开关，不做扩展名 / 体积 / 类型判断。
 * 「接管范围」设置已移除：所有 http(s) 下载一律交给 FluxDL。
 */
/** 超过 30 秒才收到 onCreated 的条目视为浏览器历史回放，绝不接管。 */
const MAX_CAPTURE_AGE_MS = 30 * 1000;
const SESSION_DEDUPE_KEY = "fluxdl_captured_recent_v1";
const SESSION_DEDUPE_TTL_MS = 15 * 1000;

function isFreshInProgressDownload(item, now = Date.now()) {
  if (!item || typeof item !== "object") return false;
  // Chrome/Edge 重启或重载扩展时会把历史已完成/已中断记录重放给 onCreated。
  if (item.state && item.state !== "in_progress") return false;
  // 跳过其他浏览器扩展后台发起的下载，避免误截。
  if (item.byExtensionId) return false;
  if (item.startTime) {
    const started = Date.parse(item.startTime);
    if (Number.isFinite(started) && now - started > MAX_CAPTURE_AGE_MS) {
      return false;
    }
  }
  return true;
}

function shouldCapture(item, settings) {
  if (!settings.autoCapture) return false;
  if (!isFreshInProgressDownload(item)) return false;
  const url = item.finalUrl || item.url || "";
  return /^https?:/i.test(url);
}

const inflight = new Set();
const recentUrls = new Map();

/** MV3 Service Worker 休眠会清空内存，用 storage.session 做跨唤醒短窗去重。 */
async function markIfDuplicateCapture(itemId, url, now) {
  if (now - (recentUrls.get(url) || 0) < SESSION_DEDUPE_TTL_MS) return true;
  if (recentUrls.size > 200) recentUrls.clear();
  recentUrls.set(url, now);

  const session = chrome.storage && chrome.storage.session;
  if (!session || typeof session.get !== "function") return false;
  try {
    const data = await session.get(SESSION_DEDUPE_KEY);
    const prev = Array.isArray(data && data[SESSION_DEDUPE_KEY])
      ? data[SESSION_DEDUPE_KEY]
      : [];
    const alive = prev.filter((e) => e && now - e.at < SESSION_DEDUPE_TTL_MS);
    const dup = alive.some((e) => e.id === itemId || e.url === url);
    if (!dup) {
      alive.push({ id: itemId, url, at: now });
      await session.set({ [SESSION_DEDUPE_KEY]: alive.slice(-100) });
    }
    return dup;
  } catch {
    return false;
  }
}

chrome.downloads.onCreated.addListener(async (item) => {
  if (!item || inflight.has(item.id)) return;
  if (!isFreshInProgressDownload(item)) return;
  const url = item.finalUrl || item.url || "";
  if (!/^https?:/i.test(url)) return;

  const now = Date.now();
  if (await markIfDuplicateCapture(item.id, url, now)) return;

  inflight.add(item.id);
  try {
    const settings = await loadSettings();
    if (!shouldCapture(item, settings)) return;
    if (!(await fluxdlIsRunning())) return;

    const data = await sendToFluxDL(
      {
        url,
        filename: suggestedFilename(item),
        referer: item.referrer,
        // UA 由 sendToFluxDL 统一注入，字段名必须与 Rust 的 camelCase 契约一致
      },
      { silent: true },
    );

    if (data && data.ok) {
      // 桌面端确认入队后才打断浏览器下载；任何异常都保留浏览器原有下载。
      try {
        await chrome.downloads.cancel(item.id);
      } catch {
        // 可能已经完成
      }
      try {
        await chrome.downloads.removeFile(item.id);
      } catch {
        // 文件可能尚未落盘
      }
      try {
        await chrome.downloads.erase({ id: item.id });
      } catch {
        // 忽略
      }
    }
  } catch {
    // 接收失败时不做任何打断
  } finally {
    setTimeout(() => inflight.delete(item.id), 4000);
  }
});

/* ------------------------------------------------------------------ *
 * 弹窗消息
 * ------------------------------------------------------------------ */

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    switch (message && message.type) {
      case "probeResources": {
        // 0.3.7 候选：MAIN-world 探针发现的直链。tabId 只信 sender.tab（浏览器
        // 注入的 Content Script 上下文），绝不信消息体自带的 tabId —— 页面脚本
        // 可以伪造 postMessage，但伪造不了 sender。
        const tabId = sender && sender.tab && typeof sender.tab.id === "number"
          ? sender.tab.id
          : -1;
        if (tabId < 0) return { ok: false, error: "无法确定来源标签页" };
        const urls = Array.isArray(message.urls) ? message.urls : [];
        const media = Array.isArray(message.media) ? message.media : [];
        const pageUrl = typeof message.pageUrl === "string" ? message.pageUrl : "";
        const referer = pageUrl || (sender.tab && sender.tab.url) || "";
        let added = 0;
        let streams = 0;
        const ops = [];
        const toProbe = [];

        // 结构化解析条目优先入队：页面接口明确给出的无水印正片，URL 常无扩展名，
        // 不能走 probeResourceKind（会判成 null）。先建立带标题 / primary 的基准行，
        // 随后通用 urls 里若出现同一地址只会 merge，不会顶掉标题。
        // primary 只给首条成功入队的正片：workItems 已按可信度排序，第一条就是
        // 页面接口指定的无水印主片。若同批每条都标 primary，体积全是 0 时会退回
        // 按扩展名 / 体积猜测，导致 .mp4 备用清晰度顶掉真正的正片。
        let primaryAssigned = false;
        for (let i = 0; i < media.length && i < 24; i += 1) {
          const m = media[i] || {};
          const url = String(m.url || "");
          if (!/^https?:/i.test(url) || url.startsWith(API)) continue;
          try {
            const parsed = new URL(url);
            if (!/^https?:$/i.test(parsed.protocol) || parsed.username || parsed.password) continue;
          } catch {
            continue;
          }
          const isPrimary = !primaryAssigned;
          primaryAssigned = true;
          toProbe.push(url);
          ops.push(addResource(tabId, {
            url,
            name: mediaFileName(m),
            size: 0,
            mime: "video/mp4",
            referer,
            at: Date.now(),
            via: "detail",
            primary: isPrimary,
            title: String(m.title || "").slice(0, 120),
            author: String(m.author || "").slice(0, 60),
            ratio: String(m.ratio || "").slice(0, 32),
          }));
          added += 1;
        }

        for (let i = 0; i < urls.length && i < 48; i += 1) {
          const url = String(urls[i] || "");
          if (!/^https?:/i.test(url) || url.startsWith(API)) continue;
          // 第三道校验：拒绝带 user:pass@ 的 URL（凭证红线）
          try {
            const parsed = new URL(url);
            if (!/^https?:$/i.test(parsed.protocol) || parsed.username || parsed.password) continue;
          } catch {
            continue;
          }
          const kind = probeResourceKind(url);
          if (!kind) continue;
          if (kind === "stream") {
            streams += 1;
            ops.push(markStream(tabId));
            continue;
          }
          // 探针没有响应头：体积 / 类型 / 文件名全靠猜，需要一次轻量 HEAD 校验。
          // 只对可下载直链排队，分片与清单不探测（它们本来就不入列表）。
          toProbe.push(url);
          ops.push(addResource(tabId, {
            url,
            name: nameFromUrl(url),
            size: 0,                 // 真实体积由 metadata 探测补回
            mime: inferProbeMime(url),
            referer,
            at: Date.now(),
            via: "probe",           // 标记来源，便于弹窗排查
          }));
          added += 1;
        }
        await Promise.all(ops);
        for (const url of toProbe) scheduleMetadataProbe(tabId, url);
        return { ok: true, added, streams };
      }
      case "refreshMetadata": {
        // 弹窗「重新检测」/主动刷新：对当前标签页所有资源强制重探一次。
        // 只探测未校验或校验过期的记录，避免每次打开弹窗都打满 CDN。
        if (!tab) return { ok: false, resources: [] };
        const key = `res:${tab.id}`;
        const data = await chrome.storage.session.get(key);
        const list = Array.isArray(data[key]) ? data[key] : [];
        const now = Date.now();
        for (const rec of list) {
          const meta = rec && rec.meta;
          const fresh = meta && meta.at && now - meta.at < META_TTL_MS;
          if (!fresh && /^https?:/i.test(String(rec.url))) {
            scheduleMetadataProbe(tab.id, rec.url, true);
          }
        }
        return { ok: true, scheduled: list.length };
      }
      case "getPageResources": {
        if (!tab) {
          return {
            tab: null, resources: [], hasStream: false,
            pageIsVideo: false, pageHint: "", bestVideo: null,
          };
        }
        const key = `res:${tab.id}`;
        const skey = `stream:${tab.id}`;
        const data = await chrome.storage.session.get([key, skey]);
        const rawUrl = tab.url || "";
        const resources = Array.isArray(data[key]) ? data[key] : [];
        return {
          tab: { id: tab.id, url: rawUrl, title: tab.title || "" },
          resources,
          hasStream: Boolean(data[skey]),
          pageIsVideo: isVideoPage(rawUrl),
          pageHint: pageHint(rawUrl),
          bestVideo: bestVideoResource(resources),
        };
      }
      case "clearPageResources": {
        if (tab) await clearTab(tab.id);
        return { ok: true };
      }
      case "downloadVideoFromWidget": {
        const tabId = sender && sender.tab && typeof sender.tab.id === "number"
          ? sender.tab.id
          : (tab ? tab.id : -1);
        const pageUrl = String(message.pageUrl || (sender && sender.tab && sender.tab.url) || "");
        const directUrl = typeof message.directUrl === "string" ? message.directUrl : "";
        let payload = null;
        if (directUrl && /^https?:\/\//i.test(directUrl)) {
          payload = { url: directUrl, kind: "http", referer: pageUrl };
        } else {
          let best = null;
          if (tabId >= 0) {
            const key = `res:${tabId}`;
            const stored = await chrome.storage.session.get(key);
            const list = Array.isArray(stored[key]) ? stored[key] : [];
            best = bestVideoResource(list);
          }
          if (best && best.url) {
            payload = {
              url: best.url,
              kind: "http",
              filename: best.name || undefined,
              referer: best.referer || pageUrl,
            };
          } else if (pageUrl && isVideoPage(pageUrl)) {
            payload = { url: pageUrl, kind: "media", referer: pageUrl };
          }
        }
        if (!payload) {
          return { ok: false, error: "未嗅探到可下载的视频直链，请先播放视频" };
        }
        const data = await sendToFluxDL(payload, { silent: false });
        return { ok: true, data };
      }
      case "sendDownload": {
        const data = await sendToFluxDL(message.payload || {}, {
          silent: message.silent === true,
        });
        return { ok: true, data };
      }
      default:
        return { ok: false };
    }
  })()
    .then(sendResponse)
    .catch((error) => sendResponse({ ok: false, error: String(error) }));
  return true; // 异步响应
});

// 供 Node 侧单元测试复用核心纯函数（service worker 里 module 未定义，不会执行）
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    classify,
    shouldCapture,
    isVideoPage,
    isDirectMediaFile,
    isVideoResource,
    bestVideoResource,
    inferProbeMime,
    probeResourceKind,
    dedupeKey,
    metadataState,
    metadataFromResponse,
    parseTotalLength,
    probeMetadata,
    mergeResource,
    mediaFileName,
    pageHint,
    nameFromDisposition,
    nameFromUrl,
    suggestedFilename,
    isUnsupportedPage,
  };
}
