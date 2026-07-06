(function () {
  'use strict';

  var script = document.currentScript || document.querySelector('script[src*="expertboard.js"]');
  var PUB = (script && (script.getAttribute('data-publisher') || script.getAttribute('data-site'))) || window.IL_BOARD_PUBLISHER || null;
  if (!PUB) return;

  var API = 'https://www.introlinq.com/api/board?pub=' + encodeURIComponent(PUB);
  var TRACK = 'https://www.introlinq.com/api/dashboard?action=out';

  var _lang = (document.documentElement.lang || navigator.language || 'en').toLowerCase().slice(0, 2);
  var _bookLabels = {
    fr: 'Réserver →', es: 'Reservar →', de: 'Buchen →', it: 'Prenota →',
    pt: 'Agendar →', nl: 'Boeken →', pl: 'Umów →', sv: 'Boka →'
  };
  var BOOK_LABEL = _bookLabels[_lang] || 'Book a call →';

  function hexToRgba(hex, alpha) {
    var r = parseInt(hex.slice(1,3),16), g = parseInt(hex.slice(3,5),16), b = parseInt(hex.slice(5,7),16);
    return 'rgba('+r+','+g+','+b+','+alpha+')';
  }

  function getContrastColor(hex) {
    var r=parseInt(hex.slice(1,3),16),g=parseInt(hex.slice(3,5),16),b=parseInt(hex.slice(5,7),16);
    return (r*299+g*587+b*114)/1000 > 128 ? '#1a1a2e' : '#ffffff';
  }

  function esc(s) {
    return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function countryToISO(c) {
    if (!c) return '';
    var m = {'united states':'US','usa':'US','united kingdom':'GB','uk':'GB','canada':'CA','australia':'AU','france':'FR','germany':'DE','spain':'ES','italy':'IT','netherlands':'NL','india':'IN','brazil':'BR','singapore':'SG','ireland':'IE','switzerland':'CH','sweden':'SE','norway':'NO','denmark':'DK','finland':'FI','portugal':'PT','belgium':'BE','austria':'AT','new zealand':'NZ','south africa':'ZA','nigeria':'NG','kenya':'KE','ghana':'GH','israel':'IL','uae':'AE','united arab emirates':'AE','japan':'JP','china':'CN','south korea':'KR','hong kong':'HK','taiwan':'TW','mexico':'MX','argentina':'AR','colombia':'CO','chile':'CL','poland':'PL','romania':'RO','ukraine':'UA','russia':'RU','turkey':'TR','thailand':'TH','vietnam':'VN','indonesia':'ID','malaysia':'MY','philippines':'PH','pakistan':'PK','bangladesh':'BD'};
    return c.length === 2 ? c.toUpperCase() : (m[c.toLowerCase()] || '');
  }

  // Find container element or create one after the script tag
  var container = script && script.getAttribute('data-container')
    ? document.getElementById(script.getAttribute('data-container'))
    : null;
  if (!container) {
    container = document.createElement('div');
    container.id = 'il-board';
    if (script && script.parentNode) {
      script.parentNode.insertBefore(container, script.nextSibling);
    } else {
      document.body.appendChild(container);
    }
  }

  // Inject base styles
  var style = document.createElement('style');
  style.textContent = [
    '#il-board{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;box-sizing:border-box;color:#1a1a2e;line-height:normal}',
    '#il-board *{box-sizing:border-box}',
    '.ilb-header{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:0.75rem;margin-bottom:1.25rem}',
    '.ilb-title{font-size:1.125rem;font-weight:700;color:#1a1a2e}',
    '.ilb-search{flex:1;min-width:180px;max-width:320px;position:relative}',
    '.ilb-search input{width:100%;padding:0.5rem 0.75rem 0.5rem 2rem;border:1.5px solid #e4e4ee;border-radius:100px;font-size:0.8125rem;font-family:inherit;outline:none;color:#1a1a2e;transition:border-color .15s}',
    '.ilb-search input:focus{border-color:var(--ilb-color)}',
    '.ilb-search-icon{position:absolute;left:0.625rem;top:50%;transform:translateY(-50%);color:#8888a8;pointer-events:none}',
    '.ilb-filters{display:flex;gap:0.5rem;overflow-x:auto;flex-wrap:nowrap;margin-bottom:1.25rem;scrollbar-width:none;padding-bottom:2px}',
    '.ilb-filters::-webkit-scrollbar{display:none}',
    '.ilb-filter{padding:0.3rem 0.875rem;border-radius:100px;border:1.5px solid #e4e4ee;background:#fff;font-size:0.75rem;font-weight:500;color:#4a4a6a;cursor:pointer;transition:all .15s;font-family:inherit;white-space:nowrap;flex-shrink:0}',
    '.ilb-filter:hover{border-color:var(--ilb-color);color:var(--ilb-color)}',
    '.ilb-filter.active{background:var(--ilb-color);border-color:var(--ilb-color);color:var(--ilb-color-contrast)}',
    '.ilb-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:1rem}',
    '@media(max-width:700px){.ilb-grid{grid-template-columns:repeat(2,1fr)}}',
    '@media(max-width:440px){.ilb-grid{grid-template-columns:1fr}}',
    '.ilb-card{border:1.5px solid #e4e4ee;border-radius:14px;padding:1rem 0.875rem;background:#fff;display:flex;flex-direction:column;align-items:center;text-align:center;gap:0.375rem;transition:box-shadow .15s,transform .15s}',
    '.ilb-card:hover{box-shadow:0 6px 24px rgba(0,0,0,0.09);transform:translateY(-2px)}',
    '.ilb-photo{width:52px!important;height:52px!important;min-width:52px;border-radius:50%!important;object-fit:cover;background:#edf5f0;flex-shrink:0}',
    '.ilb-name{font-weight:600;font-size:0.875rem;color:#1a1a2e;line-height:1.3;width:100%}',
    '.ilb-role{font-size:0.72rem;color:#8888a8;line-height:1.3;width:100%;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}',
    '.ilb-bio{font-size:0.72rem;color:#4a4a6a;line-height:1.45;width:100%;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;margin-top:2px}',
    '.ilb-btn{display:block;width:100%;text-align:center;padding:0.5rem 0.75rem;border-radius:100px;font-size:0.8rem;font-weight:700;text-decoration:none;background:var(--ilb-color);color:var(--ilb-color-contrast);transition:opacity .15s;font-family:inherit;margin-top:auto}',
    '.ilb-btn:hover{opacity:0.88}',
    '.ilb-empty{text-align:center;padding:3rem 1rem;color:#8888a8;font-size:0.875rem}',
    '.ilb-footer{margin-top:1rem;text-align:right;font-size:0.7rem;color:#aaa}',
    '.ilb-footer a{color:#aaa;text-decoration:none}',
    '.ilb-footer a:hover{color:#888}',
  ].join('');
  document.head.appendChild(style);

  // Show loading state
  container.innerHTML = '<div style="padding:2rem;text-align:center;color:#8888a8;font-size:0.875rem">Loading experts...</div>';

  fetch(API)
    .then(function(r){ return r.ok ? r.json() : null; })
    .then(function(data) {
      if (!data) { container.innerHTML = ''; return; }
      render(data);
    })
    .catch(function(){ container.innerHTML = ''; });

  var _allExperts = [];
  var _activeFilter = '';
  var _searchTerm = '';
  var _color = '#e6a820';
  var _contrast = '#1a1a2e';

  function render(data) {
    _allExperts = data.experts || [];
    _color = data.config.color || '#e6a820';
    _contrast = getContrastColor(_color);

    container.style.setProperty('--ilb-color', _color);
    container.style.setProperty('--ilb-color-contrast', _contrast);

    var topics = data.topics || [];

    var html = '<div class="ilb-header">'
      + '<div class="ilb-title">Book an expert</div>'
      + '<div class="ilb-search">'
      + '<svg class="ilb-search-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/></svg>'
      + '<input type="text" placeholder="Search experts..." id="ilb-search-input" autocomplete="off">'
      + '</div></div>';

    if (topics.length) {
      html += '<div class="ilb-filters"><button class="ilb-filter active" data-topic="">All</button>'
        + topics.map(function(t){ return '<button class="ilb-filter" data-topic="'+esc(t)+'">'+esc(t)+'</button>'; }).join('')
        + '</div>';
    }

    html += '<div class="ilb-grid" id="ilb-grid"></div>';
    html += '<div class="ilb-footer"><a href="https://www.introlinq.com" target="_blank" rel="noopener">Powered by IntroLinq</a></div>';

    container.innerHTML = html;

    renderGrid();

    // Filter buttons
    container.querySelectorAll('.ilb-filter').forEach(function(btn) {
      btn.addEventListener('click', function() {
        container.querySelectorAll('.ilb-filter').forEach(function(b){ b.classList.remove('active'); });
        btn.classList.add('active');
        _activeFilter = btn.getAttribute('data-topic');
        renderGrid();
      });
    });

    // Search input
    var searchInput = document.getElementById('ilb-search-input');
    if (searchInput) {
      searchInput.addEventListener('input', function() {
        _searchTerm = this.value.toLowerCase().trim();
        renderGrid();
      });
    }
  }

  function renderGrid() {
    var grid = document.getElementById('ilb-grid');
    if (!grid) return;

    var filtered = _allExperts.filter(function(e) {
      var topicMatch = !_activeFilter || (e.topics || []).some(function(t){ return t === _activeFilter; });
      var bioText = (e.headlines || {})[_lang] || (e.headlines || {})['en'] || e.bio || '';
      var searchMatch = !_searchTerm || [e.name, e.position, e.company, bioText, (e.topics||[]).join(' ')]
        .filter(Boolean).join(' ').toLowerCase().indexOf(_searchTerm) !== -1;
      return topicMatch && searchMatch;
    });

    if (!filtered.length) {
      grid.innerHTML = '<div class="ilb-empty" style="grid-column:1/-1">No experts found.</div>';
      return;
    }

    grid.innerHTML = filtered.map(function(e) {
      var fallback = 'https://ui-avatars.com/api/?background=edf5f0&color=3d7a5f&bold=true&size=96&name=' + encodeURIComponent(e.name);
      var bio = (e.headlines || {})[_lang] || (e.headlines || {})['en'] || e.bio || '';
      var role = [e.position, e.company].filter(Boolean).join(' · ');
      var iso = countryToISO(e.location_country || '');
      var flagHtml = iso ? '<img src="https://hatscripts.github.io/circle-flags/flags/'+iso.toLowerCase()+'.svg" style="width:13px;height:13px;border-radius:50%;vertical-align:middle;margin-left:5px" alt="">' : '';
      var bookUrl = e.booking_url
        ? TRACK + '&pub=' + encodeURIComponent(PUB)
          + '&expert_id=' + encodeURIComponent(e.id || '')
          + '&expert_name=' + encodeURIComponent(e.name || '')
          + '&expert_url=' + encodeURIComponent(e.booking_url)
          + '&article=' + encodeURIComponent(window.location.href.slice(0, 300))
          + '&phrase=expertboard&source=board'
        : '#';

      return '<div class="ilb-card">'
        + '<img class="ilb-photo" src="' + esc(e.photo_url || fallback) + '" onerror="this.src=\'' + fallback + '\'" alt="' + esc(e.name) + '">'
        + '<div class="ilb-name">' + esc(e.name) + flagHtml + '</div>'
        + (role ? '<div class="ilb-role">' + esc(role) + '</div>' : '')
        + (bio ? '<div class="ilb-bio">' + esc(bio) + '</div>' : '')
        + (bookUrl !== '#' ? '<a class="ilb-btn" href="' + esc(bookUrl) + '" target="_blank" rel="noopener">' + BOOK_LABEL + '</a>' : '')
        + '</div>';
    }).join('');
  }

})();
