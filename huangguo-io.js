// 黄果短剧 —— 苹果CMS 式私有 JSON 接口，单站 spider 源。
//
// ── 这个源的历史 ───────────────────────────────────────────────────
//
// 它原来是**内置**的：配置写在 APK 的 site-default.json 里，前端还有一套
// 「私密模式」解锁（密码 ssgnb）、年龄门、双分区界面。2026-10-19 那轮把它从
// 壳里删了 —— 当时的判断是「没有接口可迁」（site-default.json 的 origin 是空串）。
//
// 那个判断是错的，缺的只是 origin。路径一直躺在 git 里（a601dc5 删掉
// 「默认接口路径」之前那版），站点也一直活着。现在把它写成普通 spider 源：
// 用户从市场里装，和别家一样。
//
// ── 接口（2026-10-19 实测，全部 200）──────────────────────────────
//   GET /api/home                              banners / featured / latest / cate_rec / topic_rec
//   GET /api/videos?cate_id=<id>&page=N&size=M  {items, pagination{page,pages,size,total}}
//   GET /api/search?q=<kw>&page=N               {items, pagination}
//   GET /api/videos/<id>                        详情 + episodes[]
//   GET /api/videos/<id>/play?ep=N              播放（video_url 是 m3u8 直链，带 auth_key）
//   GET /api/tags                               categories[].tags[]（10 个分区 156 个标签）
//
// ── 三个和别家不一样的地方 ─────────────────────────────────────────
//
// ① **分类 id 是数字**（24 = AI成人短剧、25 = AI成人漫剧、26 = AI换脸、
//    27 = AI魔改），不是 slug。配置里的 ui.categoryIds 直接写这几个数。
// ② **列表项自带 episode_count**，卡片角标用「N集」比时长有用。
// ③ **封面和播放地址都带 auth_key**（`?auth_key=1792412972-0-0-…`），
//    是签名不是 cookie —— 拿到就能用，别去解析它。
(function () {
  var BASE = 'https://huangguoai.io';
  // 封面域名。**首页接口给的是相对路径**（`/upload_01/upload/…`），列表接口给的
  // 是完整地址（`https://pic.drleao.cn/upload_01/…?auth_key=…`）—— 同一个站点两套
  // 写法，不补这一层首页就是一片灰底（封面请求 404，而报错在渲染层看不到）。
  var PIC = 'https://pic.drleao.cn';

  // 一页给多少条。站点默认 20，首页的 latest 只有 8。
  var PAGE_SIZE = 20;

  function enc(v) {
    return encodeURIComponent(String(v == null ? '' : v));
  }

  function str(v) {
    return String(v == null ? '' : v).trim();
  }

  function absCover(url) {
    var s = str(url);
    if (!s) return '';
    if (s.indexOf('http://') === 0 || s.indexOf('https://') === 0) return s;
    if (s.charAt(0) === '/') return PIC + s;
    return s;
  }

  function num(v, fallback) {
    var n = Number(v);
    return isFinite(n) ? n : fallback;
  }

  // 秒 → mm:ss。站点给的 duration 是秒（"207"、"521"）。
  function clock(seconds) {
    var total = num(seconds, 0);
    if (total <= 0) return '';
    var m = Math.floor(total / 60);
    var s = Math.floor(total % 60);
    return (m < 10 ? '0' + m : String(m)) + ':' + (s < 10 ? '0' + s : String(s));
  }

  /**
   * 一次 GET + 解 JSON。
   *
   * 失败要**说清楚是哪一步**：接口改了字段、站点换域、签名过期，在这三种情况下
   * 用户该做的事完全不同（换源 / 报 bug / 重试）。统一成一句「请求失败」等于
   * 把判断成本全推给用户。
   */
  async function getJson(ctx, path) {
    var res;
    try {
      res = await ctx.call('net', {
        url: BASE + path,
        headers: { 'Accept': 'application/json, text/plain, */*' }
      });
    } catch (e) {
      throw new Error('黄果接口请求失败 ' + path + '：' + ((e && e.message) || e));
    }
    if (!res || res.ok !== true) {
      throw new Error('黄果接口请求失败 ' + path + '：' + ((res && res.error) || '没有响应'));
    }
    var body = String(res.body == null ? '' : res.body);
    if (!body) throw new Error('黄果接口返回了空响应：' + path + '（可能被中间设备拦了）');
    var box;
    try {
      box = JSON.parse(body);
    } catch (e) {
      throw new Error('黄果接口返回的不是 JSON：' + path);
    }
    if (box && box.status !== undefined && Number(box.status) !== 1) {
      throw new Error('黄果接口报了 status=' + box.status + '：' + (box.msg || '没有说明') + '（' + path + '）');
    }
    return (box && box.data) || {};
  }

  /** 列表项 → 卡片。字段名对齐 model.js 的 card()。 */
  function toCard(item) {
    if (!item || item.id == null) return null;
    var id = String(item.id);
    var episodes = num(item.episode_count, 0);
    return {
      id: id,
      title: str(item.title),
      cover: absCover(item.cover),
      // 角标优先「N集」（这是短剧，集数比时长有信息量），没有集数才用时长。
      badge: episodes > 0 ? (episodes + '集') : clock(item.duration),
      // score 是站点的 10 分制评分，前端会在后面补「分」。
      score: item.score == null ? '' : String(item.score),
      category: str(item.cate_name),
      episodeCount: episodes,
      duration: clock(item.duration)
    };
  }

  function cardsOf(list) {
    var out = [];
    var seen = {};
    var arr = Array.isArray(list) ? list : [];
    for (var i = 0; i < arr.length; i++) {
      var card = toCard(arr[i]);
      if (!card || !card.id || seen[card.id]) continue;
      seen[card.id] = 1;
      out.push(card);
    }
    return out;
  }

  /** pagination → hasMore。拿不到 pagination 就按「这页满了还有下一页」猜。 */
  function moreOf(pagination, page, count) {
    var pages = num(pagination && pagination.pages, 0);
    if (pages > 0) return page < pages;
    return count >= PAGE_SIZE;
  }

  function pageOf(args) {
    var n = num(args && args.page, 1);
    return n < 1 ? 1 : n;
  }

  /** "7628:1" → {id, ep}；只有 id 时 ep 默认 1。 */
  function splitRef(ref) {
    var raw = str(ref);
    var i = raw.indexOf(':');
    if (i < 0) return { id: raw, ep: 1 };
    return { id: raw.substring(0, i), ep: Math.max(1, num(raw.substring(i + 1), 1)) };
  }

  __spiderSite = {
    id: 'huangguo-io',
    name: '黄果短剧(io)',
    version: 1,
    requires: '>=1',
    hosts: ['huangguoai.io'],

    /**
     * 首页。接口一次给五块：banners / featured / latest / cate_rec / topic_rec。
     *
     * 这里**全部摊平成 items**，顺序是 featured → latest → cate_rec[].videos：
     * model.js 的 home() 拿前 8 条当轮播，后面的进「精选推荐 / 最新上架」两行。
     * 分区怎么切是 UI 的决定，源只负责把内容按「该先看到哪个」排好。
     *
     * banners 不进 items：它是运营位的图文（有 video_id 但 title 为空），
     * 塞进卡片网格会变成一串没标题的格子。
     */
    async home(ctx) {
      var data = await getJson(ctx, '/api/home');
      var items = cardsOf(data.featured).concat(cardsOf(data.latest));
      var recs = Array.isArray(data.cate_rec) ? data.cate_rec : [];
      for (var i = 0; i < recs.length; i++) {
        items = items.concat(cardsOf(recs[i] && recs[i].videos));
      }
      // cate_rec 里会出现 featured 已经给过的片子，去重一次（cardsOf 各自去过重，
      // 但三段拼起来会出现跨段重复）。
      var out = [];
      var seen = {};
      for (var j = 0; j < items.length; j++) {
        if (seen[items[j].id]) continue;
        seen[items[j].id] = 1;
        out.push(items[j]);
      }
      if (out.length === 0) {
        throw new Error('黄果首页没解析到内容（/api/home 返回了 ' + (data ? '空' : '空对象') + '）。'
          + '可能：接口改版、或这个域名已经不能用了。');
      }
      return { items: out, page: 1, hasMore: false };
    },

    /**
     * 分类列表。slug 是站点的 cate_id（"24" / "25" / "26" / "27"）。
     *
     * 不认识的 cate_id 站点会回一个**空列表**而不是报错，所以空结果要自己
     * 判断成错误 —— 否则用户看到的是「这个分类没有内容」，实际是配置写错了。
     */
    async category(ctx, args) {
      var cate = str((args && (args.slug || args.cateId || args.ref)) || '');
      var page = pageOf(args);
      if (!cate) throw new Error('黄果分类缺少 cate_id（检查源配置的 ui.categoryIds）');
      var data = await getJson(ctx, '/api/videos?cate_id=' + enc(cate)
        + '&page=' + page + '&size=' + PAGE_SIZE);
      var items = cardsOf(data.items);
      if (items.length === 0 && page === 1) {
        throw new Error('黄果分类「' + cate + '」第一页就没有内容。'
          + '可能：这个 cate_id 不在站点的分类表里，或者这个分类被清空了。');
      }
      return { items: items, page: page, hasMore: moreOf(data.pagination, page, items.length) };
    },

    /** 搜索。空关键词不发请求。 */
    async search(ctx, args) {
      var keyword = str((args && (args.keyword || args.q || args.ref)) || '');
      var page = pageOf(args);
      if (!keyword) throw new Error('黄果搜索词为空，没有发请求（检查一下输入框是不是空的）');
      var data = await getJson(ctx, '/api/search?q=' + enc(keyword) + '&page=' + page);
      var items = cardsOf(data.items);
      return { items: items, page: page, hasMore: moreOf(data.pagination, page, items.length) };
    },

    /**
     * 详情。
     *
     * 站点的 episodes[] 每项是 `{duration, ep_num, status, title}`，status 是
     * 解锁状态（1 可播），这里不拦 —— 拦了会让「VIP 集」整部片都打不开，
     * 而用户点那一集时播放会给出更具体的原因。
     */
    async detail(ctx, args) {
      var ref = splitRef(args && args.ref);
      var id = ref.id;
      if (!id) throw new Error('黄果详情缺少 ref（视频 id）');
      if (!/^\d+$/.test(id)) throw new Error('黄果详情 ref 不是数字 id：' + id);

      var data = await getJson(ctx, '/api/videos/' + enc(id));
      if (!data || data.id == null) throw new Error('黄果详情返回空（id=' + id + '）');

      var eps = Array.isArray(data.episodes) ? data.episodes : [];
      var episodes = [];
      for (var i = 0; i < eps.length; i++) {
        var ep = eps[i] || {};
        var no = num(ep.ep_num, i + 1);
        episodes.push({
          no: no,
          title: str(ep.title) || ('第' + no + '集'),
          line: 'default',
          ref: String(no),
          episodeNumber: no,
          duration: clock(ep.duration)
        });
      }
      // 一集都没有的片子仍然给一条 —— 前端拿 episodes 决定「点播放走哪条路」，
      // 空数组会让详情页的「立即播放」变成死按钮。
      if (episodes.length === 0) {
        episodes.push({ no: 1, title: '正片', line: 'default', ref: '1', episodeNumber: 1, duration: '' });
      }

      var counts = data.counts || {};
      var extra = {};
      if (counts.hot != null) extra.playCount = String(counts.hot);
      if (counts.collect != null && Number(counts.collect) > 0) extra.collect = String(counts.collect);
      if (data.author && data.author.name) extra.uploader = str(data.author.name);

      return {
        id: String(data.id),
        title: str(data.title) || ('视频 ' + id),
        cover: str(data.cover),
        description: str(data.description),
        score: data.score == null ? '' : String(data.score),
        category: (data.breadcrumb && data.breadcrumb[0] && str(data.breadcrumb[0].name)) || '',
        tags: Array.isArray(data.tags) ? data.tags.map(str).filter(Boolean) : [],
        duration: clock(data.duration),
        extra: extra,
        episodes: episodes,
        episodeCount: episodes.length,
        lines: [{ line: 'default', name: '默认线路' }],
        related: []
      };
    },

    /**
     * 播放。
     *
     * `/api/videos/<id>/play?ep=N` 直接回 `video_url`（m3u8，带 auth_key 签名）。
     * **每次实时请求，零缓存** —— auth_key 里有有效期戳，缓存等于「过一会点开
     * 就是 403」，而那种报错看起来像「没有权限」，实际是签名过期。
     */
    async play(ctx, args) {
      var ref = splitRef(args && args.ref);
      var id = ref.id;
      if (!id) throw new Error('黄果播放缺少 ref（视频 id）');
      var data = await getJson(ctx, '/api/videos/' + enc(id) + '/play?ep=' + ref.ep);
      var url = str(data.video_url);
      if (!url) {
        throw new Error('这一集没有播放地址（id=' + id + '，第 ' + ref.ep + ' 集）。'
          + '可能：这是付费/会员集、或者片子已下架。');
      }
      return {
        url: url,
        alts: [{ line: '默认线路', url: url }],
        episodeNumber: ref.ep
      };
    },

    /**
     * 全部类型：10 个分区、156 个标签。
     *
     * 分区的 code（djtc / appearance / play …）直接当 group id，名字用站点自己的
     * —— 配置里的 ui.tagGroups 抄一份同样的 id，不然 renderTags 一处都匹配不上，
     * 页面标题写着「156 个标签」、正文空白。
     */
    async tags(ctx) {
      var data = await getJson(ctx, '/api/tags');
      var cats = Array.isArray(data.categories) ? data.categories : [];
      var out = [];
      var seen = {};
      for (var i = 0; i < cats.length; i++) {
        var cat = cats[i] || {};
        var group = str(cat.code) || 'other';
        var list = Array.isArray(cat.tags) ? cat.tags : [];
        for (var j = 0; j < list.length; j++) {
          var tag = list[j] || {};
          var name = str(tag.name);
          var slug = str(tag.slug) || name;
          if (!name || !slug) continue;
          var key = group + '|' + slug;
          if (seen[key]) continue;
          seen[key] = 1;
          out.push({ name: name, slug: slug, group: group });
        }
      }
      if (out.length === 0) {
        throw new Error('黄果标签接口没有给出任何分类（/api/tags）');
      }
      return { items: out };
    },

    /**
     * 按标签列内容。
     *
     * 站点的标签页是一个 H5 页面（`/tag/<slug>/`），而接口这边**没有**
     * 「按标签 id 列表」的端点 —— 旧配置走的是 `/api/search?q=<标签名>`。
     * 这条沿用：搜索是全文匹配，标签名本身就是内容的高频词，实测命中。
     * 代价是会混进标题里恰好含这个词的片子，比「列表为空」好接受。
     */
    async tagList(ctx, args) {
      var slug = str((args && (args.slug || args.label || args.ref)) || '');
      var page = pageOf(args);
      if (!slug) throw new Error('黄果标签为空，没有发请求');
      var data = await getJson(ctx, '/api/search?q=' + enc(slug) + '&page=' + page);
      var items = cardsOf(data.items);
      return { items: items, page: page, hasMore: moreOf(data.pagination, page, items.length) };
    }
  };
})();
