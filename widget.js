(function () {
  'use strict';

  var API = 'https://www.introlinq.com/api/match';
  var script = document.currentScript || document.querySelector('script[src*="widget.js"]');
  var PUB = script && script.getAttribute('data-publisher');
  if (!PUB) return;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  function init() {
    var el = findArticle();
    if (!el) return;

    var text = extractParagraphText(el);
    if (text.length < 150) return;

    fetch(API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ article: text.slice(0, 4000), publisher: PUB })
    })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (data) {
      if (!data || !data.matches || !data.matches.length) return;
      var cfg = data.config || {};
      preloadPhotos(data.matches);
      injectStyles(cfg);
      var popup = createPopup(cfg);
      highlightMatches(el, data.matches, popup, cfg);
    })
    .catch(function () {});
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

  function extractParagraphText(el) {
    var parts = [];
    el.querySelectorAll('p, li').forEach(function (node) {
      var t = (node.innerText || node.textContent || '').replace(/\s+/g, ' ').trim();
      if (t.length > 20) parts.push(t);
    });
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
    s.textContent =
      '.il-hl{background:' + hexToRgba(color, 0.15) + ';border-bottom:2px solid ' + color + ';cursor:pointer;border-radius:2px;padding:0 2px;transition:background .15s}' +
      '.il-hl:hover{background:' + hexToRgba(color, 0.3) + '}' +
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
        '<img id="il-ph" width="' + photoSize + '" height="' + photoSize + '" style="border-radius:50%;object-fit:cover;flex-shrink:0;background:#edf5f0" src="" alt="">' +
        '<div>' +
          '<div id="il-nm" style="font-weight:600;font-size:' + nameSize + ';color:#1a1a2e;line-height:1.25"></div>' +
          '<div id="il-rl" style="font-size:11.5px;color:#4a4a6a;margin-top:2px;line-height:1.3"></div>' +
          '<div id="il-pr" style="font-size:11px;color:#8888a8;margin-top:3px"></div>' +
        '</div>' +
      '</div>' +
      (isSmall ? '' : '<div id="il-rs" style="font-size:' + (isLarge ? '13px' : '12.5px') + ';color:#4a4a6a;line-height:1.6;margin-bottom:12px;font-style:italic;border-left:2px solid ' + hexToRgba(accent, 0.3) + ';padding-left:10px"></div>') +
      '<a id="il-bk" href="#" target="_blank" rel="noopener" style="display:block;background:' + accent + ';color:' + getContrastColor(accent) + ';text-align:center;padding:' + (isSmall ? '7' : '9') + 'px;border-radius:100px;font-size:13px;font-weight:700;text-decoration:none">Book a call →</a>' +
      '<div style="font-size:9px;color:#8888a8;text-align:center;margin-top:8px;letter-spacing:.05em;text-transform:uppercase">Powered by IntroLinq</div>';
    document.body.appendChild(p);
    p.addEventListener('mouseenter', function () { clearTimeout(hideTimer); });
    p.addEventListener('mouseleave', function () { scheduleHide(p); });
    return p;
  }

  function getContrastColor(hex) {
    var r = parseInt(hex.slice(1, 3), 16);
    var g = parseInt(hex.slice(3, 5), 16);
    var b = parseInt(hex.slice(5, 7), 16);
    return (r * 299 + g * 587 + b * 114) / 1000 > 128 ? '#1a1a2e' : '#ffffff';
  }

  function highlightMatches(container, matches, popup, cfg) {
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
            el = el.parentElement;
          }
          return NodeFilter.FILTER_ACCEPT;
        }
      }
    );

    var nodes = [];
    var n;
    while ((n = walker.nextNode())) nodes.push(n);

    matches.forEach(function (match) {
      var phrase = match.phrase;
      for (var i = 0; i < nodes.length; i++) {
        var node = nodes[i];
        var text = node.textContent;
        var pos = text.indexOf(phrase);
        if (pos === -1) continue;

        var span = document.createElement('span');
        span.className = 'il-hl';
        span.textContent = phrase;

        ;(function (sp, m) {
          sp.addEventListener('mouseenter', function () {
            clearTimeout(hideTimer);
            fillPopup(popup, m, cfg);
            positionPopup(popup, sp, cfg);
            popup.classList.add('il-on');
          });
          sp.addEventListener('mouseleave', function () { scheduleHide(popup); });
        })(span, match);

        var parent = node.parentNode;
        var before = text.slice(0, pos);
        var after = text.slice(pos + phrase.length);
        if (before) parent.insertBefore(document.createTextNode(before), node);
        parent.insertBefore(span, node);
        if (after) parent.insertBefore(document.createTextNode(after), node);
        parent.removeChild(node);
        nodes.splice(i, 1);
        break;
      }
    });
  }

  function fillPopup(popup, match, cfg) {
    var e = match.expert;
    var img = document.getElementById('il-ph');
    var fallback = 'https://ui-avatars.com/api/?background=edf5f0&color=3d7a5f&bold=true&size=88&name=' + encodeURIComponent(e.name);
    img.src = fallback;
    if (e.photo_url) {
      var pre = new Image();
      pre.onload = function () { img.src = e.photo_url; };
      pre.src = e.photo_url;
    }
    document.getElementById('il-nm').textContent = e.name;
    document.getElementById('il-rl').textContent = [e.position, e.company].filter(Boolean).join(' · ');
    document.getElementById('il-pr').textContent = e.price_from ? 'From £' + e.price_from + ' / session' : '';
    var rs = document.getElementById('il-rs');
    if (rs) rs.textContent = match.reason;
    var url = e.booking_url || '#';
    if (url !== '#') url += (url.indexOf('?') !== -1 ? '&' : '?') + 'ref=' + encodeURIComponent(PUB);
    document.getElementById('il-bk').href = url;
  }

  function positionPopup(popup, span, cfg) {
    var rect = span.getBoundingClientRect();
    var W = { small: 240, medium: 300, large: 360 }[cfg.size] || 300;
    var H = cfg.size === 'small' ? 150 : cfg.size === 'large' ? 260 : 220;
    var top = rect.bottom + 10;
    var left = rect.left;
    if (rect.bottom + H + 10 > window.innerHeight) top = rect.top - H - 10;
    if (left + W > window.innerWidth - 12) left = window.innerWidth - W - 12;
    if (left < 8) left = 8;
    popup.style.top = top + 'px';
    popup.style.left = left + 'px';
  }

  var hideTimer;
  function scheduleHide(popup) {
    hideTimer = setTimeout(function () {
      popup.classList.remove('il-on');
    }, 150);
  }

})();
