(function () {
  'use strict';

  var API = 'https://www.introlinq.com/api/match';
  var script = document.currentScript || document.querySelector('script[src*="widget.js"]');
  var PUB = (script && (script.getAttribute('data-publisher') || script.getAttribute('data-site'))) || window.IL_PUBLISHER_ID || null;
  if (!PUB) return;

  var _bookLabels = {
    fr: 'Réserver un appel →', es: 'Reservar una llamada →', de: 'Gespräch buchen →',
    it: 'Prenota una chiamata →', pt: 'Agendar uma chamada →', nl: 'Gesprek boeken →',
    pl: 'Umów rozmowę →', sv: 'Boka ett samtal →', no: 'Book en samtale →',
    da: 'Book et opkald →', fi: 'Varaa puhelu →', ro: 'Rezervă un apel →',
    tr: 'Görüşme rezerve et →', ar: 'احجز مكالمة →', zh: '预约通话 →',
    ja: '通話を予約する →', ko: '통화 예약하기 →'
  };
  // Defaults for the IL_PRELOADED_MATCHES path (no article text to detect from yet).
  // The normal flow overrides these from the article's own text once extracted.
  var _lang = (document.documentElement.lang || 'en').toLowerCase().slice(0, 2);
  var BOOK_LABEL = _bookLabels[_lang] || 'Book a call →';

  // Detects language from the article's own text rather than trusting the page's
  // <html lang> (often misconfigured on CMS sites) or the visitor's browser locale.
  // Counts total function-word occurrences per language, with English competing
  // directly, so the article's dominant language wins even if fragments of another
  // language (e.g. a French expert bio or testimonial) appear on the page.
  var LANG_WORDS = {
    en: ['the','and','of','to','is','in','that','for','with','you','your','are','this','have','from','will','not','but','they','was','can','what','how','which','their','has','been','were','would','about','when','more','other','into','than','them','then','some','also','because','through'],
    fr: ['le','la','les','des','une','est','et','pour','avec','dans','vous','votre','nous','sur','qui','que','pas','plus','cette','du','au','par','mais','ont','leur','aux','ce','ses','vos','elle','son','sa','comme','tout','aussi','bien','faire','peut','être','très','sans','même'],
    es: ['el','los','las','que','para','con','una','es','por','su','este','esta','del','se','más','como','pero','sus','al','lo','tiene','también','puede','hacer','todo','cuando','muy','sin','sobre','entre','ya','hay','desde','está','cada'],
    de: ['der','die','das','und','ist','für','mit','den','sie','auf','nicht','ein','eine','des','im','dem','zu','von','werden','auch','sich','bei','oder','wir','aber','wenn','kann','haben','mehr','wie','nach','über','nur','aus','durch','einen','einer','zum','zur','sind'],
    it: ['il','di','che','per','con','una','non','sono','questo','della','del','le','si','più','come','anche','alla','nel','gli','dei','delle','essere','hanno','questa','tra','ma','dal','ai','sul','nella'],
    pt: ['os','um','uma','não','com','para','por','mais','como','seu','sua','dos','das','em','ao','pelo','isso','você','tem','ser','foi','pela','são','muito','quando','também','já','ou','na','da'],
    nl: ['de','het','een','van','voor','met','niet','dat','dit','zijn','worden','ook','naar','maar','bij','uit','deze','wordt','heeft','hebben','kan','meer','als','dan','wat','onze','je'],
    pl: ['nie','się','jest','dla','na','że','ale','jak','po','przez','tego','być','są','oraz','tym','przy','czy','może','tylko','już','bardzo'],
    sv: ['och','att','det','som','för','med','inte','den','är','av','på','har','till','ett','om','ska','kan','från','vi','du','eller','men','efter','vid'],
    no: ['og','det','som','ikke','den','er','av','på','har','til','et','om','skal','kan','fra','vi','du','eller','men','etter','ved','også'],
    da: ['og','det','som','ikke','den','er','af','på','har','til','et','om','skal','kan','fra','vi','du','eller','men','efter','ved','også'],
    fi: ['ja','on','ei','se','että','ovat','tämä','mutta','kun','myös','voi','ole','sen','joka','niin','kuin','jos','vain','mitä'],
    ro: ['și','este','pentru','care','din','pe','cu','nu','mai','sau','sunt','această','acest','dar','după','până','fost','poate','fiecare']
  };
  var LANG_SETS = {};
  (function () {
    for (var l in LANG_WORDS) {
      var set = {};
      for (var i = 0; i < LANG_WORDS[l].length; i++) set[LANG_WORDS[l][i]] = 1;
      LANG_SETS[l] = set;
    }
  })();
  function detectLanguage(articleText) {
    if (/[؀-ۿ]/.test(articleText)) return 'ar';
    if (/[぀-ヿｦ-ﾟ]/.test(articleText)) return 'ja';
    if (/[가-힯]/.test(articleText)) return 'ko';
    if (/[一-鿿]/.test(articleText)) return 'zh';

    var words = articleText.slice(0, 20000).toLowerCase().split(/[^a-zß-ÿĀ-ſȘ-ț]+/);
    var best = 'en', bestN = 0;
    for (var lang in LANG_SETS) {
      var set = LANG_SETS[lang];
      var n = 0;
      for (var i = 0; i < words.length; i++) {
        if (set[words[i]]) n++;
      }
      if (n > bestN) { bestN = n; best = lang; }
    }
    // Weak signal (very short or mixed text): default to English
    if (best !== 'en' && bestN < 10) return 'en';
    return best;
  }

  var _started = false;
  function safeInit() {
    if (_started) return;
    _started = true;
    tryRun(0);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', safeInit);
  } else {
    safeInit();
  }
  window.addEventListener('load', safeInit);

  function tryRun(attempt) {
    var el = findArticle();
    var text = el ? extractParagraphText(el) : '';

    if ((!el || text.length < 150) && attempt < 10) {
      setTimeout(function () { tryRun(attempt + 1); }, 600);
      return;
    }

    if (!el || text.length < 150) return;

    _lang = detectLanguage(text);
    BOOK_LABEL = _bookLabels[_lang] || 'Book a call →';

    if (window.IL_PRELOADED_MATCHES) {
      var pre = window.IL_PRELOADED_MATCHES;
      if (pre.matches && pre.matches.length) {
        var pcfg = pre.config || {};
        preloadPhotos(pre.matches);
        injectStyles(pcfg);
        var ppopup = createPopup(pcfg);
        highlightMatches(el, pre.matches, ppopup, pcfg, []);
      }
      return;
    }

    var seenExpertIds = {};
    var sharedCfg = null;
    var sharedPopup = null;
    var usedRanges = [];

    // Attempts to highlight each match and returns only the ones that
    // actually rendered. Matches whose phrase can't be found in the DOM (the
    // AI paraphrased instead of quoting, or the range collided with an
    // earlier highlight) are excluded - and critically, NOT marked as seen,
    // so the same expert gets another chance if a later chunk finds them at
    // a different phrase. Only what the reader can actually see gets
    // reported and cached; invisible matches used to get cached forever.
    function applyMatches(data) {
      if (!data || !data.matches || !data.matches.length) return;
      sharedCfg = sharedCfg || data.config || {};
      if (!sharedPopup) {
        injectStyles(sharedCfg);
        sharedPopup = createPopup(sharedCfg);
      }
      var shown = [];
      data.matches.forEach(function (m) {
        var id = m.expert && m.expert.id;
        if (!id || seenExpertIds[id]) return;
        if (highlightOnePhrase(el, m, sharedPopup, sharedCfg, usedRanges)) {
          seenExpertIds[id] = true;
          shown.push(m);
        }
      });
      if (!shown.length) return;
      preloadPhotos(shown);
      return shown;
    }

    // FNV-1a hash of the article text, sent with every scan/report request so
    // the server can detect an article that was EDITED at the same URL (the
    // cached result no longer describes this text and must be rescanned).
    // Whitespace is collapsed first so formatting churn doesn't read as a
    // content change.
    function hashText(s) {
      var str = s.replace(/\s+/g, ' ');
      var h = 0x811c9dc5;
      for (var i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = Math.imul(h, 0x01000193) >>> 0;
      }
      return h.toString(16);
    }

    // No cache pre-flight round trip: the scan requests below carry page_url
    // and the server short-circuits each one from the match cache directly
    // (flagged cached:true in the response). Cached pages cost one round
    // trip instead of two; uncached pages start their AI scan ~0.5-1s sooner.
    runFullScan();

    function runFullScan() {
      var reportMatches = [];
      var gotAnyResponse = false;
      var failedCount = 0;
      var sawCached = false;
      var totalCostUsd = 0;

      function collect(data) {
        if (data) gotAnyResponse = true;
        else failedCount++;
        if (data && data.cached) sawCached = true;
        if (data && typeof data.cost_usd === 'number') totalCostUsd += data.cost_usd;
        var newMatches = applyMatches(data);
        if (newMatches) reportMatches = reportMatches.concat(newMatches);
      }

      // Reads the article in chunks so any length is covered without one oversized,
      // slow request: each chunk resolves and shows its experts as soon as it's ready.
      // Chunks start where the quick pass ends (minus the usual overlap) instead of
      // at 0 - the intro was being scanned twice on every page. Very short articles
      // still get one full chunk: quick is capped at 3 matches, so the chunk pass is
      // what lets a short page reach the publisher's full match budget.
      var QUICK_LEN = 1500;
      var CHUNK_SIZE = 9000;
      var CHUNK_OVERLAP = 300;
      var chunkSource = text.length <= QUICK_LEN ? text : text.slice(QUICK_LEN - CHUNK_OVERLAP);
      var chunkTexts = [];
      if (chunkSource.length <= CHUNK_SIZE) {
        chunkTexts.push(chunkSource);
      } else {
        var step = CHUNK_SIZE - CHUNK_OVERLAP;
        for (var pos = 0; pos < chunkSource.length; pos += step) {
          chunkTexts.push(chunkSource.slice(pos, pos + CHUNK_SIZE));
          if (pos + CHUNK_SIZE >= chunkSource.length) break;
        }
      }

      // POSTs one scan request, retrying once after a short delay on any
      // failure - a fresh deploy cold-starts every serverless function, and a
      // page load right then can see its parallel requests transiently fail.
      // Only counts toward failedCount when the retry also fails.
      function postScan(body) {
        function attempt() {
          return fetch(API, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
          }).then(function (r) { return r.ok ? r.json() : null; });
        }
        return attempt()
          .catch(function () { return null; })
          .then(function (data) {
            if (data) return data;
            return new Promise(function (resolve) { setTimeout(resolve, 1500); })
              .then(attempt)
              .catch(function () { return null; });
          })
          .then(collect);
      }

      var pending = [];
      var pageUrl = window.location.href;
      // One hash of the FULL text for the whole page-view: quick, every chunk
      // and the report must all carry the SAME value or the server would see
      // a mismatch against the cached row and rescan on every visit.
      var contentHash = hashText(text);

      // Quick: article intro, capped - shows the first experts fast. page_url
      // lets the server serve the whole thing from cache when available.
      pending.push(postScan({ article: text.slice(0, QUICK_LEN), publisher: PUB, page_url: pageUrl, page_title: document.title, quick: true, lang: _lang, content_hash: contentHash }));

      // Each chunk covers the rest of the article; all fire in parallel, each adding
      // experts to the page as soon as it resolves
      chunkTexts.forEach(function (chunkText) {
        pending.push(postScan({ article: chunkText, publisher: PUB, page_url: pageUrl, page_title: document.title, chunk: true, lang: _lang, content_hash: contentHash }));
      });

      // Once every chunk has resolved, report the merged, deduplicated result once -
      // this is what gets cached, logged, and posted to Slack. `complete` tells the
      // server whether every chunk actually succeeded - if some failed (a transient
      // API error, a timeout), a 0-match result is a partial-failure artifact, not a
      // real "no experts here" verdict, and must not be cached as one. When the
      // responses came from the server's cache there's nothing new to persist -
      // reporting would just rewrite the same entry (and Slack already notified).
      Promise.all(pending.map(function (p) { return p.catch(function () {}); })).then(function () {
        if (!gotAnyResponse || sawCached) return;
        fetch(API, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ report: true, publisher: PUB, page_url: pageUrl, page_title: document.title, matches: reportMatches, complete: failedCount === 0, cost_usd: totalCostUsd, content_hash: contentHash })
        }).catch(function () {});
      });
    }
  }

  function findArticle() {
    var selectors = [
      'article .post-content',
      'article .entry-content',
      'article .article-body',
      '.post-content',
      '.entry-content',
      '.article-content',
      '.article-body',
      '.post-body',
      '.content-body',
      '.blog-post-content',
      '[itemprop="articleBody"]',
      '.gh-content',
      '.post__content',
      '.markup',
      'article',
      'main'
    ];
    for (var i = 0; i < selectors.length; i++) {
      var el = document.querySelector(selectors[i]);
      if (el && (el.innerText || '').length > 200) return el;
    }
    return null;
  }

  // True for IntroLinq's own UI (carousel ilc-, expertboard ilb-/il-board, widget
  // popup il-pop) - their text (often French expert bios) must never be treated
  // as article content or the language detection and AI matching go wrong.
  // il-hl highlight spans are NOT excluded: they wrap real article text, and
  // removing them would shift combined-string offsets between highlight passes.
  function isOwnWidget(p) {
    var id = p.id || '';
    var cls = (typeof p.className === 'string' ? p.className : '');
    if (/(^|\s)il-hl(\s|$)/.test(cls)) return false;
    return /^il[bc]?-/.test(id) || /(^|\s)il[bc]?-/.test(cls);
  }

  function extractParagraphText(el) {
    var walker = document.createTreeWalker(
      el,
      NodeFilter.SHOW_TEXT,
      { acceptNode: function (node) {
        var p = node.parentElement;
        while (p && p !== el) {
          if (/^(SCRIPT|STYLE|NOSCRIPT|TEXTAREA|INPUT|CODE|PRE|A|H1|H2|H3|H4|H5|H6)$/.test(p.tagName)) return NodeFilter.FILTER_REJECT;
          if (isOwnWidget(p)) return NodeFilter.FILTER_REJECT;
          p = p.parentElement;
        }
        return NodeFilter.FILTER_ACCEPT;
      }}
    );
    var parts = [];
    var n;
    while ((n = walker.nextNode())) {
      var t = n.textContent.replace(/\s+/g, ' ').trim();
      if (t) parts.push(t);
    }
    return parts.join(' ');
  }

  function hexToRgba(hex, alpha) {
    var r = parseInt(hex.slice(1, 3), 16);
    var g = parseInt(hex.slice(3, 5), 16);
    var b = parseInt(hex.slice(5, 7), 16);
    return 'rgba(' + r + ',' + g + ',' + b + ',' + alpha + ')';
  }

  function preloadPhotos(matches) {
    matches.forEach(function (m) {
      if (m.expert && m.expert.photo_url) {
        var img = new Image();
        img.src = m.expert.photo_url;
      }
    });
  }

  function injectStyles(cfg) {
    var color = cfg.color || '#e6a820';
    var w = { small: 240, medium: 300, large: 360 }[cfg.size] || 300;
    var existing = document.getElementById('il-styles');
    if (existing) existing.remove();
    var s = document.createElement('style');
    s.id = 'il-styles';
    // 'underline': dotted underline only, no background wash - reads as an
    // editorial annotation rather than a highlighter mark. 'fill' (default)
    // is the original tinted-background + solid-underline treatment. Purely
    // a per-publisher A/B lever - set from the dashboard, no other behaviour
    // differs between the two.
    var hlCss = cfg.highlightStyle === 'underline'
      ? '.il-hl{border-bottom:2px dotted ' + color + ';cursor:pointer;padding:0 1px;transition:border-bottom-style .15s}' +
        '.il-hl:hover{border-bottom-style:solid}'
      : '.il-hl{background:' + hexToRgba(color, 0.15) + ';border-bottom:2px solid ' + color + ';cursor:pointer;border-radius:2px;padding:0 2px;transition:background .15s}' +
        '.il-hl:hover{background:' + hexToRgba(color, 0.3) + '}';
    s.textContent =
      hlCss +
      '#il-pop{position:fixed;z-index:2147483647;width:' + w + 'px;background:#fff;border-radius:16px;' +
      'box-shadow:0 16px 48px rgba(0,0,0,0.14),0 2px 8px rgba(0,0,0,0.06);' +
      'padding:18px;opacity:0;transform:translateY(6px);' +
      'transition:opacity .18s ease,transform .18s ease;pointer-events:none;' +
      'border:1px solid rgba(26,26,46,0.10);' +
      'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;' +
      'box-sizing:border-box;line-height:normal;text-align:left}' +
      '#il-pop.il-on{opacity:1;transform:translateY(0);pointer-events:all}' +
      '#il-pop *{box-sizing:border-box}';
    document.head.appendChild(s);
  }

  function createPopup(cfg) {
    var color = cfg.color || '#e6a820';
    var accent = cfg.accent || color;
    var isSmall = cfg.size === 'small';
    var isLarge = cfg.size === 'large';
    var photoSize = isSmall ? 36 : isLarge ? 54 : 46;
    var nameSize = isLarge ? '15px' : '14px';

    var existing = document.getElementById('il-pop');
    if (existing) existing.remove();

    var p = document.createElement('div');
    p.id = 'il-pop';
    p.innerHTML =
      '<div style="display:flex;gap:12px;align-items:center;margin-bottom:' + (isSmall ? '8' : '10') + 'px">' +
        '<img id="il-ph" style="width:' + photoSize + 'px!important;height:' + photoSize + 'px!important;min-width:' + photoSize + 'px!important;min-height:' + photoSize + 'px!important;max-width:' + photoSize + 'px!important;max-height:' + photoSize + 'px!important;border-radius:50%!important;object-fit:cover!important;flex-shrink:0!important;background:#edf5f0!important;display:block!important" src="" alt="">' +
        '<div style="flex:1;min-width:0">' +
          '<div style="display:flex;align-items:center;gap:6px">' +
            '<div id="il-nm" style="font-weight:600;font-size:' + nameSize + ';color:#1a1a2e;line-height:1.25"></div>' +
            '<span id="il-fl" style="font-size:13px;line-height:1;flex-shrink:0"></span>' +
          '</div>' +
          '<div id="il-rl" style="font-size:11.5px;color:#4a4a6a;margin-top:2px;line-height:1.3"></div>' +
        '</div>' +
        '<button id="il-cl" style="display:none;flex-shrink:0;background:none;border:none;cursor:pointer;color:#8888a8;font-size:18px;line-height:1;padding:0 0 0 4px;align-self:flex-start" aria-label="Close">&times;</button>' +
      '</div>' +
      (isSmall ? '' : '<div id="il-bio" style="display:none;font-size:' + (isLarge ? '12px' : '11.5px') + ';color:#1a1a2e;font-weight:500;line-height:1.45;margin-bottom:8px"></div>') +
      (isSmall ? '' : '<div id="il-rs" style="font-size:' + (isLarge ? '13px' : '12.5px') + ';color:#4a4a6a;line-height:1.6;margin-bottom:12px;font-style:italic;border-left:2px solid ' + hexToRgba(accent, 0.3) + ';padding-left:10px"></div>') +
      '<a id="il-bk" href="#" target="_blank" rel="noopener" style="display:block;background:' + accent + ';color:' + getContrastColor(accent) + ';text-align:center;padding:' + (isSmall ? '7' : '9') + 'px;border-radius:100px;font-size:13px;font-weight:700;text-decoration:none">' + BOOK_LABEL + '</a>' +
      '<div id="il-pv" style="font-size:8.5px;color:#8888a8;text-align:center;margin-top:6px;letter-spacing:.02em"></div>';
    document.body.appendChild(p);
    p.addEventListener('mouseenter', function () { clearTimeout(hideTimer); });
    p.addEventListener('mouseleave', function () { scheduleHide(p); });
    if ('ontouchstart' in window) {
      var cl = document.getElementById('il-cl');
      if (cl) {
        cl.style.display = 'block';
        cl.addEventListener('click', function (ev) { ev.stopPropagation(); p.classList.remove('il-on'); });
      }
      p.addEventListener('click', function (ev) { ev.stopPropagation(); });
      document.addEventListener('click', function () { p.classList.remove('il-on'); });
    }
    return p;
  }

  function countryToISO(country) {
    if (!country) return '';
    var names = {
      'afghanistan':'AF','albania':'AL','algeria':'DZ','argentina':'AR','australia':'AU',
      'austria':'AT','bangladesh':'BD','belgium':'BE','brazil':'BR','bulgaria':'BG',
      'canada':'CA','chile':'CL','china':'CN','colombia':'CO','croatia':'HR',
      'czech republic':'CZ','czechia':'CZ','denmark':'DK','egypt':'EG','estonia':'EE',
      'finland':'FI','france':'FR','germany':'DE','ghana':'GH','greece':'GR',
      'hong kong':'HK','hungary':'HU','india':'IN','indonesia':'ID','iran':'IR',
      'ireland':'IE','israel':'IL','italy':'IT','japan':'JP','jordan':'JO',
      'kenya':'KE','latvia':'LV','lebanon':'LB','lithuania':'LT','luxembourg':'LU',
      'malaysia':'MY','malta':'MT','mexico':'MX','morocco':'MA','netherlands':'NL',
      'new zealand':'NZ','nigeria':'NG','norway':'NO','pakistan':'PK','peru':'PE',
      'philippines':'PH','poland':'PL','portugal':'PT','romania':'RO','russia':'RU',
      'saudi arabia':'SA','serbia':'RS','singapore':'SG','slovakia':'SK','slovenia':'SI',
      'south africa':'ZA','south korea':'KR','spain':'ES','sri lanka':'LK','sweden':'SE',
      'switzerland':'CH','taiwan':'TW','thailand':'TH','tunisia':'TN','turkey':'TR',
      'ukraine':'UA','united arab emirates':'AE','uae':'AE','united kingdom':'GB',
      'uk':'GB','united states':'US','usa':'US','uruguay':'UY','venezuela':'VE',
      'vietnam':'VN'
    };
    return country.length === 2 ? country.toUpperCase() : (names[country.toLowerCase()] || '');
  }

  function getContrastColor(hex) {
    var r = parseInt(hex.slice(1, 3), 16);
    var g = parseInt(hex.slice(3, 5), 16);
    var b = parseInt(hex.slice(5, 7), 16);
    return (r * 299 + g * 587 + b * 114) / 1000 > 128 ? '#1a1a2e' : '#ffffff';
  }

  function collectTextNodes(container) {
    var walker = document.createTreeWalker(
      container,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode: function (node) {
          var el = node.parentElement;
          while (el && el !== container) {
            if (/^(SCRIPT|STYLE|NOSCRIPT|TEXTAREA|INPUT|CODE|PRE|A|H1|H2|H3|H4|H5|H6)$/.test(el.tagName)) {
              return NodeFilter.FILTER_REJECT;
            }
            if (isOwnWidget(el)) return NodeFilter.FILTER_REJECT;
            el = el.parentElement;
          }
          return NodeFilter.FILTER_ACCEPT;
        }
      }
    );
    var nodes = [];
    var n;
    while ((n = walker.nextNode())) nodes.push(n);
    return nodes;
  }

  // A matched phrase can land in several DOM text nodes when the article's
  // own markup (e.g. <strong>50%</strong> mid-sentence) interrupts it -
  // wrapCombinedRange then produces multiple .il-hl fragments for what is
  // really ONE match. Every fragment gets its own hover/tap listener (so the
  // whole phrase is interactive edge-to-edge, no dead zones over the bold
  // bits), but they all share one popup positioned off the FIRST fragment -
  // anchoring every handler to the same span keeps the card in one stable
  // spot instead of jumping/reappearing as the cursor crosses fragment
  // boundaries (previously each fragment repositioned the popup to itself).
  function attachGroupEvents(spans, m, popup, cfg) {
    var anchor = spans[0];
    if ('ontouchstart' in window) {
      spans.forEach(function (sp) {
        sp.addEventListener('click', function (ev) {
          ev.stopPropagation();
          clearTimeout(hideTimer);
          fillPopup(popup, m, cfg);
          positionPopup(popup, anchor, cfg);
          popup.classList.add('il-on');
          closeOnScroll(popup);
        });
      });
    } else {
      spans.forEach(function (sp) {
        sp.addEventListener('mouseenter', function () {
          clearTimeout(hideTimer);
          fillPopup(popup, m, cfg);
          positionPopup(popup, anchor, cfg);
          popup.classList.add('il-on');
        });
        sp.addEventListener('mouseleave', function () { scheduleHide(popup); });
      });
    }
  }

  function highlightMatches(container, matches, popup, cfg, usedRanges) {
    var highlighted = 0;
    matches.forEach(function (match) {
      if (highlightOnePhrase(container, match, popup, cfg, usedRanges)) highlighted++;
    });
    return highlighted;
  }

  // Prevents two different experts' highlights from overlapping or touching,
  // which made hovering across the boundary appear to randomly switch experts.
  var RANGE_GAP = 2;
  function rangesConflict(usedRanges, start, end) {
    for (var i = 0; i < usedRanges.length; i++) {
      var r = usedRanges[i];
      if (start < r[1] + RANGE_GAP && end > r[0] - RANGE_GAP) return true;
    }
    return false;
  }

  // The AI is asked to copy an "exact substring from article," but often
  // normalizes typographic quotes/apostrophes (curly -> straight) even when
  // told not to - e.g. writing d'orchestrer for the source's d'orchestrer.
  // That single-character mismatch broke exact-match highlighting right at
  // that point, and the shrinking-window fallback below would silently
  // settle for whatever shorter prefix DID match, visibly cutting the
  // highlight off mid-sentence. Normalizing both sides before matching fixes
  // this - every substitution is one codepoint for one codepoint, so string
  // positions stay valid for wrapCombinedRange's offset math.
  function normalizeQuotes(s) {
    return s.replace(/[‘’‚ʼ´′]/g, "'").replace(/[“”„″]/g, '"');
  }

  function highlightOnePhrase(container, match, popup, cfg, usedRanges) {
    // Re-collect on every phrase: earlier highlights split text nodes
    var nodes = collectTextNodes(container);
    var combined = '';
    var offsets = [];
    for (var i = 0; i < nodes.length; i++) {
      offsets.push(combined.length);
      combined += nodes[i].textContent;
    }
    combined = normalizeQuotes(combined);

    var words = normalizeQuotes(match.phrase || '').replace(/\s+/g, ' ').trim().split(' ');
    if (!words[0]) return false;
    // Whitespace-flexible regex; \s* joiner tolerates node boundaries with no space
    var minLen = Math.min(4, words.length);
    for (var len = words.length; len >= minLen; len--) {
      var candidate = words.slice(0, len).join(' ');
      var re = new RegExp(candidate.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s*'));
      var m = re.exec(combined);
      if (m && m[0].trim()) {
        var start = m.index, end = m.index + m[0].length;
        if (rangesConflict(usedRanges, start, end)) continue;
        var ok = wrapCombinedRange(nodes, offsets, start, end, match, popup, cfg);
        if (ok) { usedRanges.push([start, end]); return true; }
      }
    }
    return false;
  }

  function wrapCombinedRange(nodes, offsets, start, end, match, popup, cfg) {
    var spans = [];
    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i];
      var text = node.textContent;
      var nodeStart = offsets[i];
      var nodeEnd = nodeStart + text.length;
      if (nodeEnd <= start || nodeStart >= end) continue;
      var parent = node.parentNode;
      if (!parent) continue;
      if (parent.closest && parent.closest('.il-hl')) continue;
      var from = Math.max(0, start - nodeStart);
      var to = Math.min(text.length, end - nodeStart);
      if (to <= from || !text.slice(from, to).trim()) continue;

      var span = document.createElement('span');
      span.className = 'il-hl';
      span.textContent = text.slice(from, to);
      spans.push(span);

      if (from > 0) parent.insertBefore(document.createTextNode(text.slice(0, from)), node);
      parent.insertBefore(span, node);
      if (to < text.length) parent.insertBefore(document.createTextNode(text.slice(to)), node);
      parent.removeChild(node);
    }
    // One shared listener setup for the whole group, not per-fragment -
    // see attachGroupEvents for why.
    if (spans.length) attachGroupEvents(spans, match, popup, cfg);
    return spans.length > 0;
  }

  function fillPopup(popup, match, cfg) {
    var e = match.expert;
    if (!e) return;
    var img = document.getElementById('il-ph');
    var fallback = 'https://ui-avatars.com/api/?background=edf5f0&color=3d7a5f&bold=true&size=88&name=' + encodeURIComponent(e.name);
    img.src = fallback;
    if (e.photo_url) {
      var pre = new Image();
      pre.onload = function () { img.src = e.photo_url; };
      pre.src = e.photo_url;
    }
    document.getElementById('il-nm').textContent = e.name;
    var fl = document.getElementById('il-fl');
    if (fl) {
      var iso = countryToISO(e.location_country);
      fl.innerHTML = iso ? '<img src="https://hatscripts.github.io/circle-flags/flags/' + iso.toLowerCase() + '.svg" alt="" style="width:18px!important;height:18px!important;min-width:18px!important;min-height:18px!important;max-width:18px!important;max-height:18px!important;vertical-align:middle!important;flex-shrink:0!important;border-radius:50%!important;display:inline-block!important">' : '';
    }
    var rl = document.getElementById('il-rl');
    var showCompany = !e.is_demo_provider;
    rl.innerHTML = [e.position ? '<span>' + e.position.replace(/</g,'&lt;') + '</span>' : '', showCompany && e.company ? '<span style="color:#8888a8">' + e.company.replace(/</g,'&lt;') + '</span>' : ''].filter(Boolean).join('<br>');
    // Credential line: the expert's curated one-line track record ("Raised
    // £200m", "3 exits", "2200 employees") - the strongest trust signal we
    // have, previously never shown anywhere on the card. For non-English
    // articles the server sends a translated version (match.credential) so
    // this line matches the reason's language; the stored bio (English) is
    // the fallback. Long-form text gets clipped at a word boundary.
    var bo = document.getElementById('il-bio');
    if (bo) {
      var bioText = (match.credential || e.bio || '').replace(/\s+/g, ' ').trim();
      if (bioText.length > 160) {
        var cut = bioText.slice(0, 160);
        var sp = cut.lastIndexOf(' ');
        bioText = (sp > 0 ? cut.slice(0, sp) : cut) + '…';
      }
      if (bioText) { bo.textContent = bioText; bo.style.display = 'block'; }
      else bo.style.display = 'none';
    }
    var rs = document.getElementById('il-rs');
    if (rs) rs.textContent = match.reason;
    var bk = document.getElementById('il-bk');
    var url = e.booking_url || '#';
    if (url !== '#') {
      bk.href = 'https://www.introlinq.com/api/dashboard?action=out'
        + '&pub=' + encodeURIComponent(PUB)
        + '&expert_id=' + encodeURIComponent(e.id || '')
        + '&expert_name=' + encodeURIComponent(e.name || '')
        + '&expert_url=' + encodeURIComponent(url)
        + '&article=' + encodeURIComponent(window.location.href.slice(0, 300))
        + '&phrase=' + encodeURIComponent(match.phrase || '')
        + '&lang=' + encodeURIComponent(navigator.language || '')
        + '&tz=' + encodeURIComponent(Intl.DateTimeFormat().resolvedOptions().timeZone || '')
        + '&device=' + (window.innerWidth < 768 ? 'mobile' : window.innerWidth < 1024 ? 'tablet' : 'desktop')
        + '&source=' + encodeURIComponent(getTrafficSource())
        + '&title=' + encodeURIComponent(document.title.slice(0, 150));
    } else {
      bk.href = '#';
    }

    var pv = document.getElementById('il-pv');
    if (pv) {
      var providerName = e.provider_name || (e.provider_slug || 'openintro');
      var providerLogoUrl = e.provider_logo_url || null;
      var providerUrl = e.provider_website_url || '#';
      var cfg = { name: providerName, url: providerUrl, logo: providerLogoUrl };
      var ilLogo = '<img src="https://www.introlinq.com/favicon.svg" alt="IntroLinq" style="width:11px;height:11px;border-radius:2px;vertical-align:middle;margin-right:3px">';
      var s = 'font-size:8.5px;color:#8888a8;font-family:Inter,system-ui,sans-serif;text-decoration:none;display:flex;align-items:center;gap:2px';
      pv.style.cssText = 'display:flex;align-items:center;justify-content:space-between;margin-top:6px;padding-top:6px;border-top:1px solid rgba(26,26,46,0.07)';
      var partnerLink;
      if (e.is_demo_provider && cfg.logo) {
        partnerLink = '<a href="' + cfg.url + '" target="_blank" rel="noopener" style="' + s + '">In partnership with <img src="' + cfg.logo + '" alt="' + cfg.name + '" style="height:14px;width:auto;max-width:70px;object-fit:contain;margin-left:4px;vertical-align:middle"></a>';
      } else {
        var providerLogoHtml = cfg.logo
          ? '<img src="' + cfg.logo + '" alt="' + cfg.name + '" style="width:13px;height:13px;object-fit:contain;border-radius:2px;vertical-align:middle;margin-right:3px">'
          : '';
        partnerLink = '<a href="' + cfg.url + '" target="_blank" rel="noopener" style="' + s + '">In partnership with ' + providerLogoHtml + cfg.name + '</a>';
      }
      pv.innerHTML = partnerLink + '<a href="https://www.introlinq.com" target="_blank" rel="noopener" style="' + s + '">' + ilLogo + 'IntroLinq</a>';
    }
  }

  function positionPopup(popup, span, cfg) {
    var rect = span.getBoundingClientRect();
    var isMobile = window.innerWidth < 520;
    var W = isMobile ? Math.min(280, window.innerWidth - 24) : ({ small: 240, medium: 300, large: 360 }[cfg.size] || 300);
    popup.style.width = W + 'px';
    // Use actual rendered height (forces layout) so we know exactly how tall it is
    var H = popup.offsetHeight || (isMobile ? 360 : (cfg.size === 'small' ? 150 : cfg.size === 'large' ? 260 : 220));
    // Use visualViewport on mobile to exclude browser chrome (address bar, bottom bar)
    var vpH = (window.visualViewport ? window.visualViewport.height : window.innerHeight);
    var margin = 12;
    var top = rect.bottom + 10;
    var left = isMobile ? Math.round((window.innerWidth - W) / 2) : rect.left;
    // Flip above the span if popup would be cut off at bottom
    if (top + H + margin > vpH) top = rect.top - H - 10;
    // Clamp to visible area
    if (top < margin) top = margin;
    if (top + H + margin > vpH) top = Math.max(margin, vpH - H - margin);
    if (!isMobile && left + W > window.innerWidth - 12) left = window.innerWidth - W - 12;
    if (left < 8) left = 8;
    popup.style.top = top + 'px';
    popup.style.left = left + 'px';
  }

  function getTrafficSource() {
    var ref = document.referrer;
    if (!ref) return 'direct';
    if (/google\.|bing\.|yahoo\.|duckduckgo\.|ecosia\./.test(ref)) return 'search';
    if (/facebook\.|twitter\.|x\.com|linkedin\.|instagram\.|pinterest\.|reddit\.|tiktok\./.test(ref)) return 'social';
    if (/mail\.|gmail\.|outlook\.|substack\.com/.test(ref)) return 'email';
    return 'referral';
  }

  var hideTimer;
  function scheduleHide(popup) {
    hideTimer = setTimeout(function () {
      popup.classList.remove('il-on');
    }, 150);
  }

  function closeOnScroll(popup) {
    var handler = function () {
      popup.classList.remove('il-on');
      window.removeEventListener('scroll', handler, { passive: true });
    };
    window.addEventListener('scroll', handler, { passive: true });
  }

})();
