(function () {
  'use strict';

  var script = document.currentScript || document.querySelector('script[src*="carousel.js"]');
  var PUB = (script && (script.getAttribute('data-publisher') || script.getAttribute('data-site'))) || window.IL_CAROUSEL_PUBLISHER || null;
  if (!PUB) return;

  var API = 'https://www.introlinq.com/api/board?pub=' + encodeURIComponent(PUB);
  var TRACK = 'https://www.introlinq.com/api/dashboard?action=out';

  var _lang = (document.documentElement.lang || navigator.language || 'en').toLowerCase().slice(0, 2);
  var _bookLabels = { fr:'Réserver →',es:'Reservar →',de:'Buchen →',it:'Prenota →',pt:'Agendar →',nl:'Boeken →',pl:'Umów →',sv:'Boka →' };
  var BOOK_LABEL = _bookLabels[_lang] || 'Book a call →';

  function getContrastColor(hex) {
    var r=parseInt(hex.slice(1,3),16),g=parseInt(hex.slice(3,5),16),b=parseInt(hex.slice(5,7),16);
    return (r*299+g*587+b*114)/1000>128?'#1a1a2e':'#ffffff';
  }
  function esc(s) {
    return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }
  function countryToISO(c) {
    if (!c) return '';
    var m={'united states':'US','usa':'US','united kingdom':'GB','uk':'GB','canada':'CA','australia':'AU','france':'FR','germany':'DE','spain':'ES','italy':'IT','netherlands':'NL','india':'IN','brazil':'BR','singapore':'SG','ireland':'IE','switzerland':'CH','sweden':'SE','norway':'NO','denmark':'DK','finland':'FI','portugal':'PT','belgium':'BE','austria':'AT','new zealand':'NZ','south africa':'ZA','nigeria':'NG','kenya':'KE','israel':'IL','uae':'AE','united arab emirates':'AE','japan':'JP','china':'CN','south korea':'KR','hong kong':'HK','taiwan':'TW','mexico':'MX','argentina':'AR','colombia':'CO','chile':'CL','poland':'PL','romania':'RO','ukraine':'UA','turkey':'TR','thailand':'TH','indonesia':'ID','malaysia':'MY','philippines':'PH'};
    return c.length===2?c.toUpperCase():(m[c.toLowerCase()]||'');
  }

  // Create container
  var uid = 'ilc-' + Math.random().toString(36).slice(2, 7);
  var container = document.createElement('div');
  container.id = uid;
  if (script && script.parentNode) {
    script.parentNode.insertBefore(container, script.nextSibling);
  } else {
    document.body.appendChild(container);
  }

  // Styles
  var style = document.createElement('style');
  style.textContent = [
    '#'+uid+'{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;box-sizing:border-box;color:#1a1a2e;line-height:normal;width:100%}',
    '#'+uid+' *{box-sizing:border-box}',
    '#'+uid+' .ilc-wrap{position:relative}',
    '#'+uid+' .ilc-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:0.875rem}',
    '#'+uid+' .ilc-label{font-size:0.8125rem;font-weight:700;color:#8888a8;text-transform:uppercase;letter-spacing:0.06em}',
    '#'+uid+' .ilc-arrows{display:flex;gap:0.375rem}',
    '#'+uid+' .ilc-arrow{width:28px;height:28px;border-radius:50%;border:1.5px solid #e4e4ee;background:#fff;cursor:pointer;display:flex;align-items:center;justify-content:center;color:#4a4a6a;transition:all .15s;flex-shrink:0}',
    '#'+uid+' .ilc-arrow:hover{border-color:var(--ilc-color);color:var(--ilc-color)}',
    '#'+uid+' .ilc-track-wrap{overflow:hidden;position:relative}',
    '#'+uid+' .ilc-track-wrap::after{content:"";position:absolute;right:0;top:0;bottom:0;width:48px;background:linear-gradient(to right,transparent,var(--ilc-bg,#fff));pointer-events:none}',
    '#'+uid+' .ilc-track{display:flex;gap:0.875rem;overflow-x:auto;scroll-behavior:smooth;-webkit-overflow-scrolling:touch;scrollbar-width:none;padding-bottom:2px}',
    '#'+uid+' .ilc-track::-webkit-scrollbar{display:none}',
    '#'+uid+' .ilc-card{flex:0 0 160px;border:1.5px solid #e4e4ee;border-radius:14px;padding:1rem 0.875rem;background:#fff;display:flex;flex-direction:column;align-items:center;text-align:center;gap:0.375rem;transition:box-shadow .15s,transform .15s;cursor:default}',
    '#'+uid+' .ilc-card:hover{box-shadow:0 4px 18px rgba(0,0,0,0.09);transform:translateY(-2px)}',
    '#'+uid+' .ilc-photo{width:52px!important;height:52px!important;min-width:52px;border-radius:50%!important;object-fit:cover;background:#edf5f0}',
    '#'+uid+' .ilc-name{font-weight:600;font-size:0.8rem;color:#1a1a2e;line-height:1.3;width:100%}',
    '#'+uid+' .ilc-headline{font-size:0.7rem;font-style:italic;color:var(--ilc-color);line-height:1.3;width:100%;font-weight:500;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}',
    '#'+uid+' .ilc-position{font-size:0.7rem;color:#8888a8;line-height:1.3;width:100%}',
    '#'+uid+' .ilc-company{font-size:0.675rem;color:#aaaacc;line-height:1.3;width:100%;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}',
    '#'+uid+' .ilc-tags{display:flex;flex-wrap:wrap;gap:0.25rem;justify-content:center;margin-top:0.125rem}',
    '#'+uid+' .ilc-tag{font-size:0.6rem;padding:0.15rem 0.45rem;border-radius:100px;background:#f0f0f8;color:#6a6a8a;font-weight:500;white-space:nowrap}',
    '#'+uid+' .ilc-btn{display:block;width:100%;text-align:center;padding:0.45rem 0.5rem;border-radius:100px;font-size:0.72rem;font-weight:700;text-decoration:none;background:var(--ilc-color);color:var(--ilc-color-contrast);transition:opacity .15s;font-family:inherit;margin-top:auto}',
    '#'+uid+' .ilc-btn:hover{opacity:0.85}',
    '#'+uid+' .ilc-price{font-size:0.65rem;color:#bbb;margin-top:0.125rem}',
    '#'+uid+' .ilc-footer{margin-top:0.625rem;text-align:right;font-size:0.675rem;color:#ccc}',
    '#'+uid+' .ilc-footer a{color:#ccc;text-decoration:none}',
    '#'+uid+' .ilc-footer a:hover{color:#aaa}',
  ].join('');
  document.head.appendChild(style);

  container.innerHTML = '<div style="height:210px;display:flex;align-items:center;justify-content:center;color:#aaa;font-size:0.8rem;font-family:system-ui,sans-serif">Loading...</div>';

  fetch(API)
    .then(function(r){ return r.ok ? r.json() : null; })
    .then(function(data) {
      if (!data || !data.experts || !data.experts.length) { container.innerHTML = ''; return; }
      render(data);
    })
    .catch(function(){ container.innerHTML = ''; });

  function render(data) {
    var experts = data.experts || [];
    var color = data.config.color || '#e6a820';
    var contrast = getContrastColor(color);

    container.style.setProperty('--ilc-color', color);
    container.style.setProperty('--ilc-color-contrast', contrast);

    var cardWidth = 160 + 14; // card width (160px) + gap (0.875rem ≈ 14px)

    var cards = experts.map(function(e) {
      var fallback = 'https://ui-avatars.com/api/?background=edf5f0&color=3d7a5f&bold=true&size=96&name=' + encodeURIComponent(e.name);
      var iso = countryToISO(e.location_country || '');
      var flagHtml = iso ? '<img src="https://hatscripts.github.io/circle-flags/flags/'+iso.toLowerCase()+'.svg" style="width:11px;height:11px;border-radius:50%;vertical-align:middle;margin-left:2px" alt="">' : '';
      var price = e.price_from ? 'From '+(e.price_currency||'USD')+' '+e.price_from : '';
      var tags = (e.topics || []).slice(0, 2);
      var headline = (e.headlines || {})[_lang] || (e.headlines || {})['en'] || e.bio || '';
      var bookUrl = e.booking_url
        ? TRACK+'&pub='+encodeURIComponent(PUB)
          +'&expert_id='+encodeURIComponent(e.id||'')
          +'&expert_name='+encodeURIComponent(e.name||'')
          +'&expert_url='+encodeURIComponent(e.booking_url)
          +'&article='+encodeURIComponent(window.location.href.slice(0,300))
          +'&phrase=carousel&source=carousel'
        : '#';
      return '<div class="ilc-card">'
        +'<img class="ilc-photo" src="'+esc(e.photo_url||fallback)+'" onerror="this.src=\''+fallback+'\'" alt="'+esc(e.name)+'">'
        +'<div class="ilc-name">'+esc(e.name)+flagHtml+'</div>'
        +(headline?'<div class="ilc-headline">'+esc(headline)+'</div>':'')
        +(e.position?'<div class="ilc-position">'+esc(e.position)+'</div>':'')
        +(e.company?'<div class="ilc-company">'+esc(e.company)+'</div>':'')
        +(tags.length?'<div class="ilc-tags">'+tags.map(function(t){return '<span class="ilc-tag">'+esc(t)+'</span>';}).join('')+'</div>':'')
        +(bookUrl!=='#'?'<a class="ilc-btn" href="'+esc(bookUrl)+'" target="_blank" rel="noopener">'+BOOK_LABEL+'</a>':'')
        +(price?'<div class="ilc-price">'+esc(price)+'</div>':'')
        +'</div>';
    }).join('');

    var prevId = uid+'-prev';
    var nextId = uid+'-next';
    container.innerHTML = '<div class="ilc-wrap">'
      +'<div class="ilc-header">'
      +'<div class="ilc-label">Talk to an expert</div>'
      +'<div class="ilc-arrows">'
      +'<button class="ilc-arrow" id="'+prevId+'" aria-label="Previous">'
      +'<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>'
      +'</button>'
      +'<button class="ilc-arrow" id="'+nextId+'" aria-label="Next">'
      +'<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>'
      +'</button>'
      +'</div></div>'
      +'<div class="ilc-track-wrap"><div class="ilc-track" id="'+uid+'-track">'+cards+'</div></div>'
      +'<div class="ilc-footer"><a href="https://www.introlinq.com" target="_blank" rel="noopener">Powered by IntroLinq</a></div>'
      +'</div>';

    var track = document.getElementById(uid+'-track');

    // Manual arrow buttons
    document.getElementById(prevId).addEventListener('click', function() {
      track.scrollLeft -= cardWidth * 2;
    });
    document.getElementById(nextId).addEventListener('click', function() {
      track.scrollLeft += cardWidth * 2;
    });

    // Auto-scroll: CSS scroll-behavior:smooth handles animation; direct scrollLeft avoids scroll-snap conflicts
    function step() {
      var maxScroll = track.scrollWidth - track.clientWidth;
      if (!maxScroll || maxScroll <= 0) return;
      if (track.scrollLeft >= maxScroll - 4) {
        // Instant reset to start, then resume smooth scrolling
        track.style.scrollBehavior = 'auto';
        track.scrollLeft = 0;
        // Restore smooth after the instant jump settles
        setTimeout(function() { track.style.scrollBehavior = ''; }, 50);
      } else {
        track.scrollLeft += cardWidth;
      }
    }

    var autoTimer = setInterval(step, 3000);

    track.addEventListener('mouseenter', function() { clearInterval(autoTimer); });
    track.addEventListener('mouseleave', function() { autoTimer = setInterval(step, 3000); });
  }

})();
