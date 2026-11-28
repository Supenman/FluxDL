/**
 * FluxDL 原创高清原图还原规则库（35+ 主流站点与云存储 CDN，纯函数、零凭证、零外连）：
 * 仅做 URL 形态归一化，将缩略图/裁切/质量压缩参数还原为原始大图直链。
 * 兼容浏览器内容脚本与 Node 契约单测。
 */
(function (root) {
  "use strict";

  const HD_RULES = [
    {
      name: "新浪微博",
      host: /(?:^|\.)sinaimg\.cn$/i,
      apply(url) {
        return url.replace(
          /\/(?:mw\d+|orj\d+|thumb\d+|bmiddle|small|square|wap\d+)\//i,
          "/large/",
        );
      },
    },
    {
      name: "Twitter / X",
      host: /^pbs\.twimg\.com$/i,
      apply(url) {
        try {
          const u = new URL(url);
          if (u.searchParams.has("name")) {
            u.searchParams.set("name", "orig");
            return u.toString();
          }
          return url.replace(/:(?:thumb|small|medium|large)$/i, ":orig");
        } catch {
          return url;
        }
      },
    },
    {
      name: "B 站图床",
      host: /(?:^|\.)hdslb\.com$/i,
      apply(url) {
        return url.replace(/@\d+w(?:_\d+h)?[^/?#]*$/i, "");
      },
    },
    {
      name: "小红书",
      host: /(?:^|\.)xhscdn\.com$/i,
      apply(url) {
        return url.replace(/\?imageView2\/.*$/i, "").replace(/!nd_.*$/i, "");
      },
    },
    {
      name: "抖音 / 字节图床",
      host: /(?:^|\.)(?:byteimg|douyinpic|pstatp)\.com$/i,
      apply(url) {
        return url.replace(/~tplv-[^/?#]+/i, "~noop.image");
      },
    },
    {
      name: "阿里 / 淘宝 / 天猫 / 1688",
      host: /(?:^|\.)alicdn\.com$/i,
      apply(url) {
        return url
          .replace(/_\d+x\d+(?:q\d+)?(?:\.(?:jpg|jpeg|png|webp))?$/i, "")
          .replace(/\.\d+x\d+\.(?=(?:jpg|jpeg|png|webp)(?:\?|$))/i, ".")
          .replace(/_\.webp$/i, "");
      },
    },
    {
      name: "京东图床",
      host: /(?:^|\.)360buyimg\.com$/i,
      apply(url) {
        return url
          .replace(/\/n[1-9]\//i, "/n0/")
          .replace(/\/s\d+x\d+_jfs\//i, "/jfs/")
          .replace(/!cc_\d+x\d+.*$/i, "")
          .replace(/\.avif$/i, "");
      },
    },
    {
      name: "拼多多",
      host: /(?:^|\.)pddpic\.com$/i,
      apply(url) {
        return url.replace(/\?imageView2\/.*$/i, "").replace(/\?imageMogr2\/.*$/i, "");
      },
    },
    {
      name: "Amazon CDN",
      host: /(?:^|\.)media-amazon\.com$|(?:^|\.)ssl-images-amazon\.com$/i,
      apply(url) {
        return url.replace(/\._[A-Za-z0-9_,-]+_\.(?=[a-z0-9]+(?:\?|$))/i, ".");
      },
    },
    {
      name: "Shopify CDN",
      host: /(?:^|\.)shopify\.com$/i,
      apply(url) {
        return url
          .replace(
            /_(?:\d+x\d*|pico|icon|thumb|small|compact|medium|large|grande|master)(?:@\d+x)?(?:\.progressive)?(?=\.[a-z0-9]+(?:\?|$))/i,
            "",
          )
          .replace(/([?&])(?:width|height)=\d+&/gi, "$1")
          .replace(/[?&](?:width|height)=\d+$/gi, "");
      },
    },
    {
      name: "Shopee",
      host: /(?:^|\.)susercontent\.com$|(?:^|\.)shopee\.[^/]+$/i,
      apply(url) {
        return url.replace(/_tn(?=\.[a-z0-9]+(?:\?|$)|$)/i, "").replace(/@resize_w\d+[^/?#]*/i, "");
      },
    },
    {
      name: "Temu / Shein",
      host: /(?:^|\.)(?:kwcdn|ltwebstatic)\.com$/i,
      apply(url) {
        return url
          .replace(/\?imageView2\/.*$/i, "")
          .replace(/_thumbnail_\d+x\d+/i, "");
      },
    },
    {
      name: "Etsy",
      host: /(?:^|\.)etsystatic\.com$/i,
      apply(url) {
        return url.replace(/\/il_\d+x(?:\d+|N)\./i, "/il_fullxfull.");
      },
    },
    {
      name: "eBay",
      host: /(?:^|\.)ebayimg\.com$/i,
      apply(url) {
        return url.replace(/\/s-l\d+\.(?=[a-z0-9]+(?:\?|$))/i, "/s-l1600.");
      },
    },
    {
      name: "Pinterest",
      host: /(?:^|\.)pinimg\.com$/i,
      apply(url) {
        return url.replace(/\/(?:\d+x|736x|564x|474x|236x|170x)\//i, "/originals/");
      },
    },
    {
      name: "花瓣",
      host: /(?:^|\.)huaban(?:img)?\.com$/i,
      apply(url) {
        return url.replace(/_fw\d+(?:\/format\/webp)?$/i, "").replace(/_sq\d+.*$/i, "");
      },
    },
    {
      name: "站酷 ZCOOL",
      host: /(?:^|\.)zcool\.cn$/i,
      apply(url) {
        return url.replace(/@\d+w_.*$/i, "");
      },
    },
    {
      name: "豆瓣",
      host: /(?:^|\.)doubanio\.com$/i,
      apply(url) {
        return url.replace(/\/view\/photo\/(?:s|m|sqxs|albumicon)\/public\//i, "/view/photo/l/public/");
      },
    },
    {
      name: "知乎",
      host: /(?:^|\.)zhimg\.com$/i,
      apply(url) {
        return url.replace(/_(?:b|l|r|720w|hd|qhd)(?=\.[a-z0-9]+(?:\?|$))/i, "");
      },
    },
    {
      name: "ArtStation",
      host: /(?:^|\.)artstation\.com$/i,
      apply(url) {
        return url.replace(/\/(?:smaller_square|small_square|medium|large)\//i, "/4k/");
      },
    },
    {
      name: "Behance",
      host: /(?:^|\.)behance\.net$/i,
      apply(url) {
        return url.replace(/\/projects\/(?:202|404|808|max_808|disp)\//i, "/projects/max_3840/");
      },
    },
    {
      name: "Dribbble",
      host: /(?:^|\.)dribbble\.com$/i,
      apply(url) {
        return url.replace(/\?resize=\d+x\d+.*$/i, "");
      },
    },
    {
      name: "Pixiv",
      host: /^i\.pximg\.net$/i,
      apply(url) {
        return url
          .replace(/\/c\/\d+x\d+[^/]*\/img-master\//i, "/img-original/")
          .replace(/_master1200(?=\.[a-z0-9]+(?:\?|$))/i, "");
      },
    },
    {
      name: "Wikimedia",
      host: /^upload\.wikimedia\.org$/i,
      apply(url) {
        return url.replace(/\/thumb\/(.+?)\/\d+px-[^/?#]+$/i, "/$1");
      },
    },
    {
      name: "Unsplash",
      host: /^images\.unsplash\.com$/i,
      apply(url) {
        try {
          const u = new URL(url);
          if (u.searchParams.has("w") || u.searchParams.has("q")) {
            u.searchParams.delete("w");
            u.searchParams.delete("h");
            u.searchParams.delete("fit");
            u.searchParams.set("q", "100");
            return u.toString();
          }
          return url;
        } catch {
          return url;
        }
      },
    },
    {
      name: "Pexels",
      host: /^images\.pexels\.com$/i,
      apply(url) {
        return url.replace(/\?.*$/, "");
      },
    },
    {
      name: "Imgur",
      host: /^i\.imgur\.com$/i,
      apply(url) {
        return url.replace(/([a-zA-Z0-9]{5,})[sbtmlh](?=\.(?:jpg|jpeg|png|webp|gif)(?:\?|$))/i, "$1");
      },
    },
    {
      name: "Reddit",
      host: /^preview\.redd\.it$/i,
      apply(url) {
        return url.replace(/^https?:\/\/preview\.redd\.it\//i, "https://i.redd.it/").replace(/\?.*$/, "");
      },
    },
    {
      name: "YouTube 缩略图",
      host: /^i\.ytimg\.com$/i,
      apply(url) {
        return url.replace(/\/(?:hqdefault|mqdefault|sddefault|default)\.jpg/i, "/maxresdefault.jpg");
      },
    },
    {
      name: "QQ 空间 / 腾讯图床",
      host: /(?:^|\.)(?:qpic\.cn|photo\.store\.qq\.com)$/i,
      apply(url) {
        return url.replace(/\/(?:m|b|s)(?=\?|$)/i, "/0").replace(/\/\d+\?/, "/0?");
      },
    },
    {
      name: "百度图床",
      host: /(?:^|\.)bdstatic\.com$/i,
      apply(url) {
        return url.replace(/\/f=JPEG\?w=\d+&h=\d+/i, "");
      },
    },
    {
      name: "WordPress 缩略图",
      host: /.*/,
      apply(url) {
        return url.replace(/-\d{2,4}x\d{2,4}(?=\.(?:jpg|jpeg|png|webp)(?:\?|$))/i, "");
      },
    },
    {
      name: "Cloudflare Image Resizing",
      host: /.*/,
      apply(url) {
        return url.replace(/\/cdn-cgi\/image\/[^/]+\/(https?:\/\/)/i, "/$1");
      },
    },
    {
      name: "通用云存储缩放参数",
      host: /.*/,
      apply(url) {
        return url
          .replace(/[?&]x-oss-process=image\/[^&#]+/i, "")
          .replace(/[?&]imageMogr2\/[^&#]+/i, "")
          .replace(/[?&]imageView2\/[^&#]+/i, "")
          .replace(/[?&]x-bce-process=image\/[^&#]+/i, "");
      },
    },
  ];

  function upgradeToHdUrl(rawUrl) {
    if (typeof rawUrl !== "string" || !/^https?:\/\//i.test(rawUrl.trim())) {
      return { url: rawUrl, upgraded: false, rule: null };
    }
    let parsed;
    try {
      parsed = new URL(rawUrl.trim());
    } catch {
      return { url: rawUrl, upgraded: false, rule: null };
    }
    if (parsed.username || parsed.password) {
      return { url: rawUrl, upgraded: false, rule: null };
    }
    const host = parsed.hostname.toLowerCase();
    const original = parsed.toString();
    for (const rule of HD_RULES) {
      if (!rule.host.test(host)) continue;
      const next = rule.apply(original);
      if (next && next !== original && /^https?:\/\//i.test(next)) {
        return { url: next, upgraded: true, rule: rule.name };
      }
    }
    return { url: original, upgraded: false, rule: null };
  }

  const api = { HD_RULES, upgradeToHdUrl };
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    root.__FLUXDL_HD_RULES__ = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : self);
