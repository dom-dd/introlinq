(function () {
  'use strict';

  var API = 'https://www.introlinq.com/api/match';
  var script = document.currentScript || document.querySelector('script[src*="widget.js"]');
  var PUB = script && script.getAttribute('data-publisher');
  if (!PUB) return;

  var _lang = (document.documentElement.lang || navigator.language || 'en').toLowerCase().slice(0, 2);
  var _bookLabels = {
    fr: 'Réserver un appel →', es: 'Reservar una llamada →', de: 'Gespräch buchen →',
    it: 'Prenota una chiamata →', pt: 'Agendar uma chamada →', nl: 'Gesprek boeken →',
    pl: 'Umów rozmowę →', sv: 'Boka ett samtal →', no: 'Book en samtale →',
    da: 'Book et opkald →', fi: 'Varaa puhelu →', ro: 'Rezervă un apel →',
    tr: 'Görüşme rezerve et →', ar: 'احجز مكالمة →', zh: '预约通话 →',
    ja: '通話を予約する →', ko: '통화 예약하기 →'
  };
  var BOOK_LABEL = _bookLabels[_lang] || 'Book a call →';

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

    fetch(API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ article: text.slice(0, 4000), publisher: PUB, page_url: window.location.href, page_title: document.title })
    })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (data) {
      if (!data || !data.matches || !data.matches.length) return;
      var cfg = data.config || {};
      preloadPhotos(data.matches);
      injectStyles(cfg);
      var popup = createPopup(cfg);
      var shown = highlightMatches(el, data.matches, popup, cfg);
      if (shown === 0 && data.matches.length > 0) {
        // Phrases not found in DOM - retry with fresh content
        _started = false;
      }
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
        '<img id="il-ph" style="width:' + photoSize + 'px!important;height:' + photoSize + 'px!important;min-width:' + photoSize + 'px!important;min-height:' + photoSize + 'px!important;max-width:' + photoSize + 'px!important;max-height:' + photoSize + 'px!important;border-radius:50%!important;object-fit:cover!important;flex-shrink:0!important;background:#edf5f0!important;display:block!important" src="" alt="">' +
        '<div>' +
          '<div style="display:flex;align-items:center;gap:6px">' +
            '<div id="il-nm" style="font-weight:600;font-size:' + nameSize + ';color:#1a1a2e;line-height:1.25"></div>' +
            '<span id="il-fl" style="font-size:13px;line-height:1;flex-shrink:0"></span>' +
          '</div>' +
          '<div id="il-rl" style="font-size:11.5px;color:#4a4a6a;margin-top:2px;line-height:1.3"></div>' +
        '</div>' +
      '</div>' +
      (isSmall ? '' : '<div id="il-rs" style="font-size:' + (isLarge ? '13px' : '12.5px') + ';color:#4a4a6a;line-height:1.6;margin-bottom:12px;font-style:italic;border-left:2px solid ' + hexToRgba(accent, 0.3) + ';padding-left:10px"></div>') +
      '<a id="il-bk" href="#" target="_blank" rel="noopener" style="display:block;background:' + accent + ';color:' + getContrastColor(accent) + ';text-align:center;padding:' + (isSmall ? '7' : '9') + 'px;border-radius:100px;font-size:13px;font-weight:700;text-decoration:none">' + BOOK_LABEL + '</a>' +
      '<div id="il-pv" style="font-size:8.5px;color:#8888a8;text-align:center;margin-top:6px;letter-spacing:.02em"></div>';
    document.body.appendChild(p);
    p.addEventListener('mouseenter', function () { clearTimeout(hideTimer); });
    p.addEventListener('mouseleave', function () { scheduleHide(p); });
    if ('ontouchstart' in window) {
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

  function findBestPhrase(nodes, phrase) {
    var allText = nodes.map(function(n){ return n.textContent; }).join('\n');
    if (allText.indexOf(phrase) !== -1) return phrase;
    // Trim progressively from the end until we find a match in the DOM
    var words = phrase.split(' ');
    for (var len = Math.floor(words.length * 0.75); len >= 4; len--) {
      var shorter = words.slice(0, len).join(' ');
      if (allText.indexOf(shorter) !== -1) return shorter;
    }
    return null;
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

    var highlighted = 0;
    matches.forEach(function (match) {
      var phrase = findBestPhrase(nodes, match.phrase);
      if (!phrase) return;
      for (var i = 0; i < nodes.length; i++) {
        var node = nodes[i];
        var text = node.textContent;
        var pos = text.indexOf(phrase);
        if (pos === -1) continue;

        var span = document.createElement('span');
        span.className = 'il-hl';
        span.textContent = phrase;

        ;(function (sp, m) {
          if ('ontouchstart' in window) {
            sp.addEventListener('click', function (ev) {
              ev.stopPropagation();
              clearTimeout(hideTimer);
              fillPopup(popup, m, cfg);
              positionPopup(popup, sp, cfg);
              popup.classList.add('il-on');
              closeOnScroll(popup);
            });
          } else {
            sp.addEventListener('mouseenter', function () {
              clearTimeout(hideTimer);
              fillPopup(popup, m, cfg);
              positionPopup(popup, sp, cfg);
              popup.classList.add('il-on');
            });
            sp.addEventListener('mouseleave', function () { scheduleHide(popup); });
          }
        })(span, match);

        var parent = node.parentNode;
        var before = text.slice(0, pos);
        var after = text.slice(pos + phrase.length);
        if (before) parent.insertBefore(document.createTextNode(before), node);
        parent.insertBefore(span, node);
        if (after) parent.insertBefore(document.createTextNode(after), node);
        parent.removeChild(node);
        nodes.splice(i, 1);
        highlighted++;
        break;
      }
    });
    return highlighted;
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
    var fl = document.getElementById('il-fl');
    if (fl) {
      var iso = countryToISO(e.location_country);
      fl.innerHTML = iso ? '<img src="https://hatscripts.github.io/circle-flags/flags/' + iso.toLowerCase() + '.svg" alt="" style="width:18px!important;height:18px!important;min-width:18px!important;min-height:18px!important;max-width:18px!important;max-height:18px!important;vertical-align:middle!important;flex-shrink:0!important;border-radius:50%!important;display:inline-block!important">' : '';
    }
    var rl = document.getElementById('il-rl');
    var showCompany = !e.is_demo_provider;
    rl.innerHTML = [e.position ? '<span>' + e.position.replace(/</g,'&lt;') + '</span>' : '', showCompany && e.company ? '<span style="color:#8888a8">' + e.company.replace(/</g,'&lt;') + '</span>' : ''].filter(Boolean).join('<br>');
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
