(function () {
  'use strict';

  // Production widget - hook + multi-name popup (formerly the widget5.js
  // fork) with a no-match fallback (formerly widget6.js): when a page
  // genuinely has no match at all, appends a small line at the end of the
  // article - a fixed generic hook (there's no matched phrase to derive a
  // topic-specific one from) plus a CTA pill, no bigger a footprint than
  // plain text. Hovering it (tapping on touch) opens the exact same
  // floating popup a real match uses, showing 3 randomly-picked experts -
  // same infrastructure, same stats, same hover-then-click rules as a real
  // match, nothing shown until a reader actually engages, and nothing ever
  // pushes the article's own content around. Only appears when a publisher
  // has opted in via no_match_fallback_enabled (server-side gate - see
  // buildRandomFallback in api/match.js, called from tryServeFromCache) -
  // off leaves a no-match page showing nothing, same as before this was
  // folded in. Both pieces were proven out on live traffic
  // (little-green-agency, openintro) as separate experimental files before
  // being merged into this one - search this file for "NO-MATCH FALLBACK"
  // to find every piece that came from widget6.js specifically.
  var API = 'https://www.introlinq.com/api/match';
  var script = document.currentScript || document.querySelector('script[src*="widget.js"]');
  var PUB = (script && (script.getAttribute('data-publisher') || script.getAttribute('data-site'))) || window.IL_PUBLISHER_ID || null;
  if (!PUB) return;

  // Experimental widget hand-off - lets a specific publisher run a
  // different widget file entirely without touching anything on their own
  // site: their installed <script src="widget.js" data-publisher="..."> tag
  // never changes, this just redirects to the alternate file for publishers
  // on the list below. Empty/removed = zero effect on everyone else, since
  // the rest of this file runs completely unchanged for every publisher not
  // on the list. Checked before the double-init guard below, since handing
  // off means this copy of widget.js does nothing else at all. Currently
  // empty - widget5.js/widget6.js's features both now live here directly;
  // kept in place (see widget1.js, archived unused) as the mechanism for
  // the next experimental variant, not because anything needs it today.
  var EXPERIMENTAL_WIDGETS = {};
  if (EXPERIMENTAL_WIDGETS[PUB]) {
    var handoff = document.createElement('script');
    handoff.src = 'https://www.introlinq.com/' + EXPERIMENTAL_WIDGETS[PUB];
    handoff.setAttribute('data-publisher', PUB);
    if (script && script.parentNode) {
      script.parentNode.insertBefore(handoff, script.nextSibling);
    } else {
      document.head.appendChild(handoff);
    }
    return;
  }

  // Guards against the widget tag being pasted twice on the same page (e.g. the
  // dashboard's GTM install snippet added alongside the direct <script data-publisher>
  // one, both left in place). Each copy is a fully separate IIFE with its own private
  // state, so without this a second copy would run its own createPopup(), which removes
  // the FIRST copy's #il-pop and replaces it - any highlight already wired to that
  // removed popup then does nothing on hover, while the popup itself still renders fine
  // for whichever copy runs last. window-level (not closure-local) so it's shared
  // across every separate script execution, not just repeated calls within one.
  if (window.__ilWidgetInit) return;
  window.__ilWidgetInit = true;

  // Deliberately no {name} - naming the expert here ("Speak with Jingjin")
  // read as a mundane action description next to the option row that
  // already shows their name and photo right there. A short, energetic
  // imperative reads stronger and repeats fine across 2-3 rows without
  // feeling templated. Several translations lean on a neutral verb
  // ("talk"/"book"/"connect") rather than a literal "meet" where that
  // would force a gendered object pronoun (es/it) with no expert-gender
  // data to pick it correctly.
  var _bookLabels = {
    en: 'Meet now →',
    fr: 'Rencontrez →', es: 'Reúnete ahora →', de: 'Jetzt treffen →',
    it: 'Parla ora →', pt: 'Fale agora →', nl: 'Nu ontmoeten →',
    pl: 'Poznaj teraz →', sv: 'Möt nu →', no: 'Møt nå →',
    da: 'Mød nu →', fi: 'Tapaa nyt →', ro: 'Cunoaște acum →',
    tr: 'Şimdi tanış →', ar: 'قابل الآن →', zh: '立即预约 →',
    ja: '今すぐ会う →', ko: '지금 만나기 →'
  };
  // Heading above the option-row list (see fillPopup) - {company} is
  // cfg.company_name when set, otherwise the withoutCompany variant is used
  // instead of substituting a translated "We" into the withCompany template
  // (subject-verb agreement for a company name vs. "we" doesn't translate
  // as a simple word-swap in most of these languages). Kept as a short
  // colon-terminated heading rather than a full "recommends talking to"
  // sentence, which sidesteps a lot of fragile per-language preposition/
  // case grammar around the name list that follows it anyway.
  var _recommendLabels = {
    en: { withCompany: '{company} recommends:', withoutCompany: 'We recommend:' },
    fr: { withCompany: '{company} recommande :', withoutCompany: 'Nous recommandons :' },
    es: { withCompany: '{company} recomienda:', withoutCompany: 'Recomendamos:' },
    de: { withCompany: '{company} empfiehlt:', withoutCompany: 'Wir empfehlen:' },
    it: { withCompany: '{company} consiglia:', withoutCompany: 'Consigliamo:' },
    pt: { withCompany: '{company} recomenda:', withoutCompany: 'Recomendamos:' },
    nl: { withCompany: '{company} beveelt aan:', withoutCompany: 'Wij bevelen aan:' },
    pl: { withCompany: '{company} poleca:', withoutCompany: 'Polecamy:' },
    sv: { withCompany: '{company} rekommenderar:', withoutCompany: 'Vi rekommenderar:' },
    no: { withCompany: '{company} anbefaler:', withoutCompany: 'Vi anbefaler:' },
    da: { withCompany: '{company} anbefaler:', withoutCompany: 'Vi anbefaler:' },
    fi: { withCompany: '{company} suosittelee:', withoutCompany: 'Suosittelemme:' },
    ro: { withCompany: '{company} recomandă:', withoutCompany: 'Recomandăm:' },
    tr: { withCompany: '{company} önerir:', withoutCompany: 'Öneririz:' },
    ar: { withCompany: '{company} يوصي:', withoutCompany: 'نوصي:' },
    zh: { withCompany: '{company} 推荐：', withoutCompany: '我们推荐：' },
    ja: { withCompany: '{company}のおすすめ：', withoutCompany: 'おすすめ：' },
    ko: { withCompany: '{company} 추천:', withoutCompany: '추천:' }
  };
  // NO-MATCH FALLBACK's fixed hook+CTA (see showNoMatchFallback) - unlike a
  // real match's hook/cta, there's no AI call backing this (by design, zero
  // AI cost for a page with nothing to match), so it can't be grounded
  // per-match the way api/match.js's HOOK & CTA prompt rule does. Just a
  // static translation of the same fixed line every language gets.
  var _noMatchLabels = {
    en: { hook: 'Need expert advice on business, growth, or funding?', cta: 'We work with people who’ve done it →' },
    fr: { hook: 'Besoin de conseils d’experts sur votre entreprise ou son financement ?', cta: 'Nous travaillons avec des personnes qui l’ont déjà fait →' },
    es: { hook: '¿Necesitas el consejo de un experto sobre tu negocio o su financiación?', cta: 'Trabajamos con personas que ya lo han hecho →' },
    de: { hook: 'Brauchen Sie fachkundigen Rat zu Ihrem Unternehmen oder dessen Finanzierung?', cta: 'Wir arbeiten mit Menschen, die das schon gemacht haben →' },
    it: { hook: 'Hai bisogno di consigli di esperti sulla tua attività o sul suo finanziamento?', cta: 'Lavoriamo con persone che l’hanno già fatto →' },
    pt: { hook: 'Precisa de conselhos de especialistas sobre o seu negócio ou financiamento?', cta: 'Trabalhamos com quem já passou por isso →' },
    nl: { hook: 'Advies nodig van een expert over je bedrijf of de financiering ervan?', cta: 'Wij werken met mensen die dit al hebben gedaan →' },
    pl: { hook: 'Potrzebujesz porady eksperta w sprawie firmy lub jej finansowania?', cta: 'Współpracujemy z ludźmi, którzy już to zrobili →' },
    sv: { hook: 'Behöver du experthjälp med ditt företag eller dess finansiering?', cta: 'Vi samarbetar med personer som redan gjort det →' },
    no: { hook: 'Trenger du ekspertråd om bedriften din eller finansieringen av den?', cta: 'Vi samarbeider med folk som har gjort det →' },
    da: { hook: 'Har du brug for ekspertrådgivning om din virksomhed eller dens finansiering?', cta: 'Vi samarbejder med folk, der har gjort det →' },
    fi: { hook: 'Tarvitsetko asiantuntijan neuvoja yrityksestäsi tai sen rahoituksesta?', cta: 'Teemme yhteistyötä ihmisten kanssa, jotka ovat jo tehneet sen →' },
    ro: { hook: 'Ai nevoie de sfaturi de la un expert despre afacerea ta sau finanțarea ei?', cta: 'Colaborăm cu oameni care au trecut deja prin asta →' },
    tr: { hook: 'İşletmeniz veya finansmanı hakkında uzman tavsiyesine mi ihtiyacınız var?', cta: 'Bunu daha önce yapmış kişilerle çalışıyoruz →' },
    ar: { hook: 'هل تحتاج إلى نصيحة خبير بشأن عملك أو تمويله؟', cta: 'نعمل مع أشخاص قاموا بذلك بالفعل →' },
    zh: { hook: '需要关于业务或融资的专家建议吗？', cta: '我们与已经做到这一点的人合作 →' },
    ja: { hook: 'ビジネスや資金調達について専門家のアドバイスが必要ですか？', cta: '実際に経験した人々と協力しています →' },
    ko: { hook: '사업이나 자금 조달에 대한 전문가의 조언이 필요하신가요?', cta: '이미 경험한 사람들과 함께합니다 →' }
  };
  // Defaults for the IL_PRELOADED_MATCHES path (no article text to detect from yet).
  // The normal flow overrides these from the article's own text once extracted.
  var _lang = (document.documentElement.lang || 'en').toLowerCase().slice(0, 2);
  var BOOK_LABEL = _bookLabels[_lang] || _bookLabels.en;
  var RECOMMEND_LABEL = _recommendLabels[_lang] || _recommendLabels.en;
  var NO_MATCH_LABEL = _noMatchLabels[_lang] || _noMatchLabels.en;

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
    BOOK_LABEL = _bookLabels[_lang] || _bookLabels.en;
    RECOMMEND_LABEL = _recommendLabels[_lang] || _recommendLabels.en;
    NO_MATCH_LABEL = _noMatchLabels[_lang] || _noMatchLabels.en;

    if (window.IL_PRELOADED_MATCHES) {
      var pre = window.IL_PRELOADED_MATCHES;
      if (pre.matches && pre.matches.length) {
        var pcfg = pre.config || {};
        preloadPhotos(pre.matches);
        injectStyles(pcfg);
        var ppopup = createPopup(pcfg);
        highlightMatches(el, pre.matches, ppopup, pcfg, []);
      } else if (pre.noMatch) {
        // Demo/testing path only - simulates a confirmed no-match page
        // (set window.IL_PRELOADED_MATCHES = {matches:[], noMatch:true,
        // randomExperts:[...], config:{...}}) without needing a real
        // scanned page.
        injectStyles(pre.config || {});
        showNoMatchFallback(el, pre.config || {}, pre.randomExperts, pre.randomExpertsTotal);
      }
      return;
    }

    var sharedCfg = null;
    var sharedPopup = null;
    var usedRanges = [];

    // Attempts to highlight each match and returns only the ones that
    // actually rendered. Matches whose phrase can't be found in the DOM (the
    // AI paraphrased instead of quoting, or the range collided with an
    // earlier highlight) are excluded. Only what the reader can actually see
    // counts for the stale-cache check below - invisible matches would
    // otherwise look like a real impression.
    function applyMatches(data) {
      if (!data || !data.matches || !data.matches.length) return;
      sharedCfg = sharedCfg || data.config || {};
      if (!sharedPopup) {
        injectStyles(sharedCfg);
        sharedPopup = createPopup(sharedCfg);
      }
      // No per-phrase dedup here - unlike widget.js's single-expert dedup
      // (never show the same person twice), a hook is a topic, not an
      // identity, so the same 2-3 names can legitimately back up more than
      // one phrase without it reading as repetitive.
      var shown = [];
      data.matches.forEach(function (m) {
        if (!m.hook && !(m.options && m.options.length)) return;
        if (highlightOnePhrase(el, m, sharedPopup, sharedCfg, usedRanges)) {
          shown.push(m);
        }
      });
      if (!shown.length) return;
      preloadPhotos(shown);
      return shown;
    }

    // FNV-1a hash of the article text, sent with the scan request so the
    // server can detect an article that was EDITED at the same URL (the
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

    var pageUrl = window.location.href;
    var contentHash = hashText(text);

    // One request for the whole article, whatever its length - no more
    // quick/chunk split, since nobody waits on the AI call anymore (see
    // api/match.js: a cache miss claims the page for a background scan and
    // responds immediately with nothing to show; the reader who triggers it
    // never sees the result of their own visit, and the page is cached by
    // the time anyone else arrives). Retries once after a short delay on any
    // failure - a fresh deploy cold-starts every serverless function, and a
    // page load right then can see this transiently fail.
    function postScan() {
      var body = { article: text, publisher: PUB, page_url: pageUrl, page_title: document.title, lang: _lang, content_hash: contentHash };
      function attempt() {
        return fetch(API, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        }).then(function (r) { return r.ok ? r.json() : null; });
      }
      attempt()
        .catch(function () { return null; })
        .then(function (data) {
          if (data) return data;
          return new Promise(function (resolve) { setTimeout(resolve, 1500); })
            .then(attempt)
            .catch(function () { return null; });
        })
        .then(function (data) {
          // Nothing to render this visit, either because the page is still
          // pending its background scan, or both attempts failed outright -
          // there's nothing further to do; no polling, no follow-up request.
          if (!data || !data.cached) return;
          // NO-MATCH FALLBACK: the page was genuinely scanned and confirmed
          // to have nothing relevant - the server sets noMatch:true
          // specifically for this case (see tryServeFromCache in
          // api/match.js), distinct from "not scanned yet" (which has no
          // `cached` field at all and was already returned above).
          // isLikelyArticlePage() gates the fallback line specifically, not
          // the scan itself above - a category/tag/author archive page can
          // still clear the 150-char bar and get scanned/matched normally
          // (a real MATCH only ever shows if the AI found something
          // genuinely relevant), but the fallback's generic "talk to an
          // expert" line has no business appearing on a listing, homepage,
          // or login page just because that page also came back no-match.
          if (data.noMatch) {
            if (isLikelyArticlePage()) {
              injectStyles(data.config || {});
              showNoMatchFallback(el, data.config || {}, data.randomExperts, data.randomExpertsTotal);
            }
            return;
          }
          var shown = applyMatches(data);
          // The server said this page has experts, but none of their phrases
          // could be found in the live DOM - the exact wording drifted since
          // it was scanned (a CMS re-render, an ad shifting surrounding text,
          // anything), and a cache hit has no other way to ever learn that
          // happened. Tell the server to throw the entry away so the NEXT
          // visitor gets a fresh scan instead of the same silent failure
          // repeating indefinitely.
          if (data.matches.length > 0 && (!shown || shown.length === 0)) {
            fetch(API, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ staleCache: true, publisher: PUB, page_url: pageUrl })
            }).catch(function () {});
          }
        });
    }
    postScan();
  }

  // Gates the no-match fallback line only (see the call site in postScan's
  // response handler) - never the scan/highlight flow itself. The URL pattern
  // check runs unconditionally and can veto on its own - confirmed on
  // littlegreenagency.co.uk that its theme stamps og:type="article" on
  // BOTH a real post and its /category/ archive pages alike, so og:type
  // can't be trusted as a positive signal by itself; a listing/utility URL
  // always says no regardless of what og:type claims. When og:type IS
  // present and says something other than "article" (e.g. "website"),
  // that's a second, independent negative signal - catches pages like a
  // homepage that don't match any URL pattern here. Only falls back to
  // requiring a real <article> element (not findArticle()'s broader
  // fallbacks like a bare 'main') when there's no og:type at all to go on.
  function isLikelyArticlePage() {
    var path = window.location.pathname.toLowerCase();
    if (path === '' || path === '/') return false;
    if (/\/(category|categories|tag|tags|author|page\/\d+|search|login|signin|sign-in|signup|sign-up|register|cart|checkout|account|wp-admin)(\/|$)/.test(path)) return false;

    var ogType = document.querySelector('meta[property="og:type"]');
    if (ogType) {
      var content = (ogType.getAttribute('content') || '').toLowerCase();
      if (content) return content === 'article';
    }
    return !!document.querySelector('article');
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
      // tagDiv/Newspaper theme (confirmed on challenges.tn) - a very common
      // premium WordPress news theme whose class names are all "td-"
      // prefixed (td-post-content, not post-content), so none of the
      // selectors above ever match and this used to fall through to the
      // bare 'article' selector below. On this theme that <article> is the
      // page-builder's own template wrapper for the WHOLE page (ads,
      // related-post grids, sponsored content, comments - not just the
      // post body), which matters for more than just container size: a
      // "related articles"/"sponsored content" block rotating inside it
      // changes the extracted text - and therefore the content hash - on
      // every load even when the actual post never changed, which is
      // exactly the kind of hash instability that forced repeated paid
      // rescans before (see the challenges-tn comment on the scan-cap
      // check in api/match.js). td-post-content is the theme's own tight
      // single-post wrapper, checked before the generic fallbacks below.
      '.td-post-content',
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

  // Google auto-ads (adsbygoogle / google-auto-placed / the aswift_* iframe
  // host div) get injected directly into the article DOM on some sites and
  // rotate their creative/labels on every single page load. Left in, that
  // ad copy was both feeding the AI irrelevant "content" to match against
  // and defeating the server's content-hash cache check - every visit
  // looked like the article had been edited, forcing a full paid rescan.
  function isAdContainer(p) {
    var id = p.id || '';
    var cls = (typeof p.className === 'string' ? p.className : '');
    return /adsbygoogle|google-auto-placed|goog-rentr|google-aiuf|google-anno-skip/i.test(cls) || /^aswift_/i.test(id);
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
          if (isAdContainer(p)) return NodeFilter.FILTER_REJECT;
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
      (m.options || []).forEach(function (opt) {
        if (opt.expert && opt.expert.photo_url) {
          var img = new Image();
          img.src = opt.expert.photo_url;
        }
      });
    });
  }

  function injectStyles(cfg) {
    var color = cfg.color || '#e6a820';
    var accent = cfg.accent || color;
    var noMatchTextColor = cfg.noMatchTextColor || '#1a1a2e';
    // Wider than widget.js's original sizes (240/300/360) - three stacked
    // name+credential+role rows need more breathing room than one profile
    // did, especially once credentials render as wrapping pills below.
    var w = { small: 280, medium: 340, large: 400 }[cfg.size] || 340;
    var existing = document.getElementById('il-styles');
    if (existing) existing.remove();
    var s = document.createElement('style');
    s.id = 'il-styles';
    // 'underline': dotted underline only, no background wash - reads as an
    // editorial annotation rather than a highlighter mark. 'underline-solid':
    // same, but a solid line instead of dotted - a firmer editorial cue
    // without the tinted background. 'fill' (default) is the original
    // tinted-background + solid-underline treatment. Purely a per-publisher
    // A/B lever - set from the dashboard, no other behaviour differs
    // between the three.
    // !important throughout: unlike the popup (appended to body, outside the
    // article), these spans are inserted directly into the article's own DOM
    // - a low-specificity class selector like .il-hl loses to whatever the
    // host page's own stylesheet declares for span/text elements at that
    // point in the article, on some publisher pages but not others depending
    // on their CSS's specificity and cascade order.
    var hlCss = cfg.highlightStyle === 'underline'
      ? '.il-hl{border-bottom:2px dotted ' + color + '!important;cursor:pointer!important;padding:0 1px!important;background:none!important;transition:border-bottom-style .15s}' +
        '.il-hl:hover{border-bottom-style:solid!important}'
      : cfg.highlightStyle === 'underline-solid'
      ? '.il-hl{border-bottom:2px solid ' + color + '!important;cursor:pointer!important;padding:0 1px!important;background:none!important;transition:border-bottom-width .15s}' +
        '.il-hl:hover{border-bottom-width:3px!important}'
      : '.il-hl{background:' + hexToRgba(color, 0.15) + '!important;border-bottom:2px solid ' + color + '!important;cursor:pointer!important;border-radius:2px!important;padding:0 2px!important;transition:background .15s}' +
        '.il-hl:hover{background:' + hexToRgba(color, 0.3) + '!important}';
    s.textContent =
      hlCss +
      '#il-pop{position:fixed;z-index:2147483647;width:' + w + 'px;background:#fff;border-radius:16px;' +
      'box-shadow:0 16px 48px rgba(0,0,0,0.14),0 2px 8px rgba(0,0,0,0.06);' +
      'padding:18px;opacity:0;transform:translateY(6px);' +
      'transition:opacity .18s ease,transform .18s ease;pointer-events:none;' +
      'border:1px solid rgba(26,26,46,0.10);' +
      'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;' +
      // -webkit-text-size-adjust:100% pins our declared font sizes exactly -
      // mobile Safari/Chrome auto-boost small text in narrow columns based on
      // the HOST page's surrounding layout (a heuristic meant for the page's
      // own article text), which can inflate an 8.5px footer label enough to
      // overflow the card on one publisher's page but not another's, even
      // with byte-identical widget HTML. overflow:hidden is the hard
      // backstop: nothing can ever visually escape the rounded card,
      // whatever the cause.
      '-webkit-text-size-adjust:100%;text-size-adjust:100%;overflow:hidden;' +
      'box-sizing:border-box;line-height:normal;text-align:left}' +
      '#il-pop.il-on{opacity:1;transform:translateY(0);pointer-events:all}' +
      '#il-pop *{box-sizing:border-box}' +
      // Compact per-expert block below the hook/CTA - photo+name+Meet on
      // one row, role right underneath (tight - reads as one unit with the
      // name), then punchy credential facts on their own line, joined with
      // " | " instead of separate pill chips - reads as one quick scannable
      // line instead of a row of badges.
      // Divider + heading between the hook/CTA block and the name list -
      // a visible border-top (not just a margin gap) so the two sections
      // read as clearly separate, and the label itself is a proper
      // sub-heading now (dark, bigger) instead of a tiny muted caption.
      '.il2-list-label{font-size:11.5px!important;font-weight:700!important;color:#1a1a2e!important;letter-spacing:.02em!important;padding-top:12px;margin-top:2px;border-top:1px solid rgba(26,26,46,0.1);margin-bottom:8px}' +
      '.il2-opt{display:flex!important;align-items:center;gap:10px;padding:9px 0}' +
      '.il2-opt+.il2-opt{border-top:1px solid rgba(26,26,46,0.14)}' +
      '.il2-opt-photo{width:38px!important;height:38px!important;min-width:38px!important;min-height:38px!important;max-width:38px!important;max-height:38px!important;border-radius:50%!important;object-fit:cover!important;background:#edf5f0!important;flex-shrink:0!important;display:block!important}' +
      '.il2-opt-info{flex:1;min-width:0}' +
      // il2-opt-book is a direct sibling of the photo/info column now (see
      // buildOptionRow), not nested next to the name - that way it's
      // centered by .il2-opt's own align-items:center same as the photo,
      // instead of pinned to the top of the block next to the name line.
      '.il2-opt-name{display:block!important;font-weight:600!important;font-size:12px!important;color:#1a1a2e!important;line-height:1.2!important;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0;text-decoration:none!important}' +
      '.il2-opt-role{font-size:11px!important;font-weight:500!important;color:#4a4a6a!important;line-height:1.25!important;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:0}' +
      // Same dark ink as the name, bold, rather than a saturated accent
      // colour (yellow read as a warning, green wasn't liked either) -
      // stands out through weight/contrast instead of hue.
      '.il2-opt-facts{font-size:10.5px!important;font-weight:700!important;color:#1a1a2e!important;line-height:1.4!important;margin-top:3px}' +
      // Filled, not outlined, so it actually stands out next to the name
      // instead of blending into the row.
      '.il2-opt-book{flex-shrink:0!important;display:block!important;background:' + accent + '!important;border:none!important;color:' + getContrastColor(accent) + '!important;text-align:center;padding:5px 12px!important;border-radius:100px!important;font-size:11px!important;font-weight:700!important;text-decoration:none!important;white-space:nowrap}' +
      // Discoverability nudge (see maybeShowDiscoveryCue) - a
      // white "phantom hand" tap on desktop, a soft pulse on the highlight
      // itself on touch. pointer-events:none on #il-cue is load-bearing:
      // it must never intercept the mouseenter/click that actually opens
      // the popup, or the outside-click dismiss handler on touch.
      // position:absolute (not fixed) + document-relative left/top - the
      // cue must scroll WITH the article text, not stay pinned to the
      // viewport while the highlighted phrase it's pointing at scrolls
      // away underneath it. Motion: slides up from below into position
      // (fade in), taps, slides back down out of position (fade out) -
      // mirrors reaching up to tap something then withdrawing.
      '@keyframes il-cue-in{0%{opacity:0;transform:translate(-50%,calc(-50% + 22px))}100%{opacity:1;transform:translate(-50%,-50%)}}' +
      '@keyframes il-cue-tap{0%{transform:translate(-50%,-50%) scale(1)}35%{transform:translate(-50%,-50%) scale(.78)}65%{transform:translate(-50%,-50%) scale(1.05)}100%{transform:translate(-50%,-50%) scale(1)}}' +
      '@keyframes il-cue-out{0%{opacity:1;transform:translate(-50%,-50%)}100%{opacity:0;transform:translate(-50%,calc(-50% + 22px))}}' +
      '#il-cue{position:absolute!important;z-index:2147483647!important;pointer-events:none!important;width:33px!important;height:30px!important;opacity:0;filter:drop-shadow(0 2px 6px rgba(0,0,0,.35))!important}' +
      // Animation lives on a separate class, added one tick after insertion
      // (see showPhantomHand's forced reflow) rather than baked into #il-cue
      // itself. Applying it in the SAME pass as the element's creation let
      // the browser start the animation clock before the 0% (opacity:0,
      // shifted-down) state ever actually painted, on the very first play
      // of a page view - it would just appear at full opacity already in
      // position, then run straight into the tap/out phases with no visible
      // fade-in. Forcing a reflow between insertion and adding this class
      // guarantees the starting state is committed first.
      '#il-cue.il-cue-play{animation:il-cue-in 1.1s ease forwards,il-cue-tap .8s ease 1.1s,il-cue-out 1s ease 2.4s forwards!important}' +
      '#il-cue img{width:100%!important;height:100%!important;display:block!important}' +
      '@keyframes il-pulse-glow{0%,100%{box-shadow:0 0 0 0 ' + hexToRgba(color, 0) + '}50%{box-shadow:0 0 0 6px ' + hexToRgba(color, 0.35) + '}}' +
      '.il-hl.il-cue-pulse{animation:il-pulse-glow 1s ease-in-out 2!important}' +
      // NO-MATCH FALLBACK (formerly widget6.js - see this file's header
      // comment). #il6-hookwrap (headline + CTA pill) is the only thing on
      // the page -
      // deliberately as small a footprint as a plain text line, since this
      // shows on ~81% of pages (whatever has no real content match) without
      // a publisher ever having agreed to a permanent directory box on most
      // of their articles. Hovering/tapping it opens the exact same
      // floating #il-pop popup a real match uses (see
      // attachFallbackTrigger) - not a custom inline reveal - so nothing
      // ever pushes the article's own content around, and the 3 named
      // people only exist for a reader who actually engages, same as a
      // real match's hover popup.
      // Both the hook text and the divider line above it render directly in
      // the article's own background (unlike the popup, which always sits
      // on its own white card) - a fixed dark colour goes unreadable on a
      // dark-themed site (confirmed on justcharmaine.co.uk: "dark grey on
      // black"). cfg.noMatchTextColor lets a publisher override it from
      // the dashboard; null keeps this same #1a1a2e default.
      '#il6-fallback{margin-top:1.75rem;padding-top:1.25rem;border-top:1px solid ' + hexToRgba(noMatchTextColor, 0.15) + ';font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif}' +
      '#il6-hookwrap{cursor:pointer}' +
      '#il6-hook{font-size:15px!important;font-weight:700!important;color:' + noMatchTextColor + '!important;line-height:1.4!important;margin-bottom:10px}' +
      '#il6-cta{display:inline-block!important;background:' + accent + '!important;color:' + getContrastColor(accent) + '!important;text-align:center;padding:9px 18px!important;border-radius:100px!important;font-size:13px!important;font-weight:700!important;text-decoration:none!important}' +
      // !important on every property here, not just display - unprotected
      // align-items was the likely real cause of the avatars misaligning
      // against the button on challenges.tn: every OTHER visual rule in
      // this file learned that lesson already (see the popup's own
      // !important comment above), this row just hadn't yet.
      '#il6-cta-row{display:flex!important;align-items:center!important;gap:10px!important;flex-wrap:wrap!important}' +
      '#il6-avatars{display:flex!important;align-items:center!important;flex-shrink:0!important}' +
      // Sized to roughly match the CTA pill's own height (9px padding +
      // 13px text ~= 33px tall) so the row reads as one aligned unit.
      // Overlapping circle-of-faces convention - negative margin pulls
      // each one under the last, white ring (border + a hairline shadow
      // so it still separates on a white page background) keeps them
      // readable as distinct people rather than a blob. min-height/
      // flex-shrink alongside min-width/object-fit - confirmed on
      // challenges.tn that a plain height:32px!important can still lose a
      // same-specificity cascade fight against the host page's own img
      // rules depending on stylesheet load order, and without a height
      // FLOOR the real photos (each a different natural size/aspect ratio,
      // unlike the uniform ui-avatars.com fallback) end up rendering at
      // inconsistent sizes relative to each other, not just to the button.
      '.il6-avatar{width:32px!important;height:32px!important;min-width:32px!important;min-height:32px!important;max-width:32px!important;max-height:32px!important;flex-shrink:0!important;border-radius:50%!important;object-fit:cover!important;background:#edf5f0!important;border:2px solid #fff!important;box-shadow:0 0 0 1px rgba(26,26,46,0.12)!important;margin-left:-10px!important;display:block!important}' +
      '.il6-avatar:first-child{margin-left:0!important}' +
      // "+N more" cap on the stack - dark ink fill so it reads as a
      // distinct count rather than another (oddly blank) face.
      '.il6-avatar-more{display:flex!important;align-items:center!important;justify-content:center!important;background:#1a1a2e!important;color:#fff!important;font-size:10px!important;font-weight:700!important;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif}';
    document.head.appendChild(s);
  }

  // NO-MATCH FALLBACK (formerly widget6.js). Appended once per page, at the end
  // of the article - there's no matched phrase to hang this off of, so
  // unlike everything else in this file it can't use the inline-highlight
  // mechanic, and there's no per-phrase reason to derive a topic-specific
  // hook from (see deriveHook in api/match.js), so the headline is a single
  // fixed line rather than an AI/keyword-derived one. Only #il6-hookwrap
  // (that headline + CTA) ever renders on the page - no bigger a footprint
  // than a plain text line, since this shows on ~81% of pages without a
  // publisher ever agreeing to a permanent directory box on most of their
  // articles. Hovering/tapping it opens the SAME #il-pop popup (createPopup/
  // fillPopup/positionPopup) a real match uses - not a custom reveal - so
  // this rides the exact infrastructure, stats, and hover-then-click
  // conventions Widget 5 already has, and the 3 randomly-picked experts
  // (see pickRandomExperts in api/match.js) float over the page instead of
  // pushing article content down. Nothing renders at all if the server
  // couldn't supply any random experts (e.g. this publisher has zero
  // eligible experts) - a line that reveals nothing on hover isn't
  // restrained, it's broken.
  // On most CMS templates, findArticle()'s container IS roughly the
  // readable body, so appending to its end lands right after the last
  // paragraph. Not guaranteed though - some themes (confirmed on
  // challenges.tn's tagDiv/Newspaper theme) wrap the ENTIRE page-builder
  // template in a single <article>, containing ads, related-post grids and
  // sponsored content alongside the real text, not just the article body.
  // A real highlighted match never has this problem (it's anchored to the
  // matched phrase's own DOM position), but the no-match fallback has no
  // phrase to anchor to - appending to the container's true end there can
  // land it far past the actual article, right before the footer.
  //
  // Just taking the last real text node (collectTextNodes, same filter
  // real matches rely on) isn't enough on its own either - confirmed on
  // justcharmaine.co.uk, a bare classic WordPress theme with no semantic
  // wrapper narrower than <main id="content"> at all, which spans the
  // post body AND its author-bio box, related-posts widget, tags line and
  // comments section. <a>/H1-H6 are already excluded by collectTextNodes
  // (skips nav links, tag pills, share/social icons, the "About me"/"Buy
  // me a coffee" buttons), but plain-text fragments like an author bio
  // sentence or a "Tagged: ..." label aren't. Two extra steps close most
  // of that gap without needing theme-specific selectors: hard-exclude
  // #comments/.comments-area (a standard WordPress core marker from
  // comments_template(), reliable across nearly every theme), then prefer
  // the last node that sits inside an actual <p> with real sentence
  // length (>=60 chars) over whatever the literal last text node happens
  // to be - skips past short label/list fragments a wider net would catch.
  function findFallbackAnchor(articleEl) {
    // Tried scoring headings by word count to detect an author-bio/
    // signature block ("Charmaine S." vs. a real section heading like "1.
    // Freelance Writing for Beginners") - dropped it after checking against
    // justcharmaine.co.uk's actual heading list: a SECOND promotional block
    // (a newsletter/lead-magnet CTA) sits even after the comments section,
    // with a genuinely long heading of its own ("Get instant access to the
    // 10-step mini guide...") that breaks any backward scan before it ever
    // reaches the bio heading. Reliable, theme-agnostic detection of every
    // possible trailing widget isn't achievable this way - #comments/
    // .comments-area (standard WordPress core markup) is the only boundary
    // solid enough to trust, so exclude it AND anything that comes at or
    // after it in document order (catches that second block too, even
    // though it isn't literally inside the comments element).
    var comments = articleEl.querySelector('#comments, .comments-area');
    var nodes = collectTextNodes(articleEl).filter(function (n) {
      if (!comments) return true;
      if (comments.contains(n)) return false;
      return !(comments.compareDocumentPosition(n) & Node.DOCUMENT_POSITION_FOLLOWING);
    });
    if (!nodes.length) return null;
    var candidate = null;
    for (var i = nodes.length - 1; i >= 0 && !candidate; i--) {
      var p = nodes[i].parentElement;
      while (p && p !== articleEl && p.tagName !== 'P') p = p.parentElement;
      if (p && p.tagName === 'P' && (p.textContent || '').trim().length >= 60) candidate = p;
    }
    var el = candidate || nodes[nodes.length - 1].parentElement;
    while (el && el.parentElement !== articleEl) el = el.parentElement;
    return (el && el.parentElement === articleEl) ? el : null;
  }

  function showNoMatchFallback(articleEl, cfg, randomExperts, randomExpertsTotal) {
    if (document.getElementById('il6-fallback')) return;
    var options = (randomExperts || []).filter(function (o) { return o && o.expert; }).slice(0, 3);
    if (!options.length) return;
    // How many MORE eligible experts exist beyond the 3 shown - the badge
    // reads "+N", not the raw total, so it should never show a 0 or
    // negative count if the roster happens to be exactly 3 or fewer.
    var moreCount = (typeof randomExpertsTotal === 'number' ? randomExpertsTotal : options.length) - options.length;

    // Sends the reader to the matched partner's own site (open-intro.com
    // today, whichever partner backs this publisher in general), not an
    // IntroLinq page, through the same tracked redirect every booking link
    // in this file uses - the partner needs to actually be landed on for
    // ITS OWN attribution cookie to get set (see the OpenIntro webhook
    // integration), so a booking made later - even one that never touches
    // an IntroLinq link again - still credits back to us. Falls back to
    // IntroLinq's own board page only if a partner site URL is somehow
    // missing. click_source='no_match_cta' keeps this countable separately
    // from both a real match's 'cta' and this same block's own
    // 'no_match_person' rows inside the popup.
    var boardUrl = 'https://www.introlinq.com/experts?pub=' + encodeURIComponent(PUB);
    var providerUrl = options[0].expert.provider_website_url || boardUrl;
    var ctaHref = 'https://www.introlinq.com/api/dashboard?action=out'
      + '&pub=' + encodeURIComponent(PUB)
      + '&expert_url=' + encodeURIComponent(providerUrl)
      + '&article=' + encodeURIComponent(window.location.href.slice(0, 300))
      + '&lang=' + encodeURIComponent(navigator.language || '')
      + '&tz=' + encodeURIComponent(Intl.DateTimeFormat().resolvedOptions().timeZone || '')
      + '&device=' + (window.innerWidth < 768 ? 'mobile' : window.innerWidth < 1024 ? 'tablet' : 'desktop')
      + '&source=' + encodeURIComponent(getTrafficSource())
      + '&title=' + encodeURIComponent(document.title.slice(0, 150))
      + '&click_source=no_match_cta';

    // Same 3 real people the popup shows, not a generic stock cluster -
    // what you see next to the button is genuinely who you'd meet. Same
    // fallback-avatar convention as buildOptionRow's photos.
    var avatarsHtml = options.map(function (opt) {
      var e = opt.expert;
      var fallback = 'https://ui-avatars.com/api/?background=edf5f0&color=3d7a5f&bold=true&size=64&name=' + encodeURIComponent(e.name);
      // width/height attributes, not just the CSS above - a browser applies
      // these as an intrinsic sizing hint before any stylesheet is even
      // parsed, which a host page's own img rules can't out-cascade the
      // way they can a plain CSS height declaration.
      return '<img class="il6-avatar" width="32" height="32" src="' + (e.photo_url || fallback) + '" onerror="this.onerror=null;this.src=\'' + fallback + '\'" alt="">';
    }).join('') + (moreCount > 0 ? '<div class="il6-avatar il6-avatar-more">+' + moreCount + '</div>' : '');

    var div = document.createElement('div');
    div.id = 'il6-fallback';
    div.innerHTML =
      '<div id="il6-hookwrap">' +
        '<div id="il6-hook">' + NO_MATCH_LABEL.hook.replace(/</g,'&lt;') + '</div>' +
        '<div id="il6-cta-row">' +
          '<a id="il6-cta" href="' + ctaHref + '" target="_blank" rel="noopener">' + NO_MATCH_LABEL.cta.replace(/</g,'&lt;') + '</a>' +
          '<div id="il6-avatars">' + avatarsHtml + '</div>' +
        '</div>' +
      '</div>';
    // cfg.noMatchAnchorSelector is an admin-only per-publisher override
    // (see api/match.js) for themes where findFallbackAnchor's generic
    // heuristic can't do any better - takes priority when it actually
    // matches something on the page; falls through to the heuristic
    // otherwise (a stale/typo'd selector shouldn't silently break the
    // fallback entirely). A leading "before:" flips it to insert right
    // BEFORE the matched element instead of after - needed when the best
    // available boundary is the START of the trailing content rather than
    // the end of the real article (e.g. justcharmaine.co.uk's WordPress
    // "Previous/Next" post-navigation block, which sits between the two
    // and is a standard Gutenberg core block present on every one of that
    // publisher's posts, not something specific to a single article).
    var overrideAnchor = null, overridePosition = 'afterend';
    if (cfg && cfg.noMatchAnchorSelector) {
      var selector = cfg.noMatchAnchorSelector;
      if (selector.indexOf('before:') === 0) {
        overridePosition = 'beforebegin';
        selector = selector.slice(7);
      }
      try { overrideAnchor = document.querySelector(selector); } catch (e) { overrideAnchor = null; }
    }
    var anchor = overrideAnchor || findFallbackAnchor(articleEl);
    var position = overrideAnchor ? overridePosition : 'afterend';
    if (anchor) {
      anchor.insertAdjacentElement(position, div);
    } else {
      articleEl.appendChild(div);
    }

    // No hook/cta on this match object - only options - so fillPopup hides
    // its own headline+CTA block (would otherwise just duplicate the
    // always-visible line above) and renders just the list-label + rows +
    // partnership footer. No real phrase to attribute these rows to either;
    // an empty string is fine, buildTrackedBookingUrl only uses it for the
    // &phrase= tracking param.
    var popup = createPopup(cfg);
    var fakeMatch = { phrase: '', options: options };
    attachFallbackTrigger(document.getElementById('il6-hookwrap'), fakeMatch, popup, cfg);
  }

  // Same hover-then-click pattern as a highlighted phrase's popup
  // (attachGroupEvents) - reuses that popup's own shared hideTimer/
  // scheduleHide and its own mouseenter/mouseleave (set up in createPopup)
  // for moving from the line into the popup without it flickering shut.
  // Touch has no hover, so tapping the plain headline text opens the popup
  // instead (matches this file's other 'ontouchstart' in window branches);
  // the CTA is a real link and is deliberately excluded so it keeps
  // navigating normally on tap like any other link, rather than being
  // hijacked into a reveal step.
  function attachFallbackTrigger(anchor, match, popup, cfg) {
    if ('ontouchstart' in window) {
      anchor.addEventListener('click', function (ev) {
        if (ev.target.closest && ev.target.closest('#il6-cta')) return;
        ev.stopPropagation();
        fillPopup(popup, match, cfg, 'no_match_person');
        positionPopup(popup, anchor, cfg);
        popup.classList.add('il-on');
        closeOnScroll(popup);
      });
      return;
    }
    anchor.addEventListener('mouseenter', function () {
      clearTimeout(hideTimer);
      fillPopup(popup, match, cfg, 'no_match_person');
      positionPopup(popup, anchor, cfg);
      popup.classList.add('il-on');
    });
    anchor.addEventListener('mouseleave', function () {
      if (!popup.classList.contains('il-pinned')) scheduleHide(popup);
    });
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
    // Every visual property below is !important, not just the photo (which
    // was already defended this way): planet-fintech's page has a
    // body{font-size:11px} base and other broad rules that were bleeding
    // through our plain inline styles despite those normally winning on
    // specificity - a card that looked fine on every other publisher's page
    // showed with its name/role row missing and other text sized wrong on
    // that one specifically. !important on an inline style beats essentially
    // any host stylesheet rule that isn't itself an equally-specific inline
    // !important, which no publisher's page has a reason to write.
    // Hybrid layout: a punchy outcome headline + primary CTA up top (same
    // as the pure-hook version), PLUS a short list of real named experts
    // below it (from the multi-option version) - the headline sells the
    // outcome, the names back it up with concrete proof this isn't vague
    // marketing copy. Each name row has its own direct "Book" link;
    // the top CTA is the lower-commitment "just let me browse" path.
    // Both blocks are independently optional (fillPopup hides whichever
    // has no data) so this still degrades gracefully to either pure
    // earlier variant.
    p.innerHTML =
      '<div id="il2-hookwrap" style="margin-bottom:' + (isSmall ? '10' : '14') + 'px">' +
        '<div style="display:flex!important;align-items:flex-start;justify-content:space-between;gap:8px;margin-bottom:8px">' +
          '<div id="il2-hook" style="font-size:' + (isLarge ? '15px' : '14px') + '!important;font-weight:700!important;color:#1a1a2e!important;line-height:1.4!important"></div>' +
          '<button id="il-cl" style="display:none;flex-shrink:0;background:none!important;border:none!important;cursor:pointer;color:#8888a8!important;font-size:18px!important;line-height:1!important;padding:0 0 0 4px" aria-label="Close">&times;</button>' +
        '</div>' +
        '<a id="il2-cta" href="#" target="_blank" rel="noopener" style="display:block!important;background:' + accent + '!important;color:' + getContrastColor(accent) + '!important;text-align:center;padding:' + (isSmall ? '7' : '9') + 'px;border-radius:100px;font-size:13px!important;font-weight:700!important;text-decoration:none!important"></a>' +
      '</div>' +
      '<div id="il2-list"></div>' +
      '<div id="il-pv" style="font-size:8.5px!important;color:#8888a8!important;text-align:center;margin-top:8px;letter-spacing:.02em"></div>';
    document.body.appendChild(p);
    p.addEventListener('mouseenter', function () { clearTimeout(hideTimer); });
    p.addEventListener('mouseleave', function () {
      if (!p.classList.contains('il-pinned')) scheduleHide(p);
    });
    if ('ontouchstart' in window) {
      var cl = document.getElementById('il-cl');
      if (cl) {
        cl.style.display = 'block';
        cl.addEventListener('click', function (ev) { ev.stopPropagation(); p.classList.remove('il-on', 'il-pinned'); });
      }
      p.addEventListener('click', function (ev) { ev.stopPropagation(); });
      document.addEventListener('click', function () { p.classList.remove('il-on', 'il-pinned'); });
    } else {
      // Un-pins a card opened via keyboard (see attachGroupEvents' keydown
      // handler - the only thing that still sets il-pinned on desktop) -
      // anywhere outside the card AND outside any highlight closes it.
      document.addEventListener('click', function (ev) {
        if (!p.classList.contains('il-pinned')) return;
        if (ev.target.closest && ev.target.closest('#il-pop, .il-hl')) return;
        p.classList.remove('il-pinned');
        scheduleHide(p);
      });
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

  // Most readers never notice a highlight is interactive - it's deliberately
  // subtle (see the .il-hl rules in injectStyles above), which is good for
  // not looking spammy but bad for discoverability. This shows an animated
  // nudge - a white "phantom hand" tap on desktop, a soft pulse on the
  // highlight itself on touch (same 'ontouchstart' in window check used
  // everywhere else in this file) - on EVERY highlighted phrase, each time
  // it's been in view for a couple of seconds (not the instant it appears -
  // a reader who's still scrolling past it hasn't "looked" at it yet), then
  // repeats every CUE_REPEAT_MS for as long as they stay on it. Each
  // highlight gets its own independent observer, so whichever one a reader
  // actually scrolls to (not just the first on the page) still gets a nudge.
  // The whole point is teaching a reader they CAN hover a highlight - once
  // they've actually done that for real (see stopDiscoveryCue, wired into
  // attachGroupEvents below), cueLearned stops every future play everywhere
  // on the page and clears whatever's on screen right now.
  var cueLearned = false;
  function stopDiscoveryCue() {
    if (cueLearned) return;
    cueLearned = true;
    var existing = document.querySelectorAll('#il-cue');
    for (var i = 0; i < existing.length; i++) existing[i].remove();
  }
  var CUE_DWELL_MS = 2500;
  // TESTING VALUE - repeats the play every 14s while still in view, instead
  // of playing once and disappearing forever. Under evaluation on
  // /demo/introlinq; not a final decision on the real UX.
  var CUE_REPEAT_MS = 14000;
  function maybeShowDiscoveryCue(anchor, cfg) {
    // Publisher-controlled - see the "Discovery animation" toggle on the
    // dashboard's Appearance & behaviour tab. Defaults to enabled (only
    // an explicit false, never a missing/undefined field, turns it off)
    // so it stays on for every existing publisher and every new signup
    // unless they deliberately opt out.
    if (cfg && cfg.discoveryCue === false) return;
    if (typeof IntersectionObserver !== 'function') return;
    var play = function () {
      if (cueLearned) return;
      if ('ontouchstart' in window) {
        anchor.classList.add('il-cue-pulse');
        setTimeout(function () { anchor.classList.remove('il-cue-pulse'); }, 2200);
      } else {
        showPhantomHand(anchor);
      }
    };
    var dwellTimer = null;
    var repeatTimer = null;
    var observer = new IntersectionObserver(function (entries) {
      if (cueLearned) { observer.disconnect(); return; }
      if (entries[0].isIntersecting) {
        if (dwellTimer || repeatTimer) return;
        dwellTimer = setTimeout(function () {
          dwellTimer = null;
          if (cueLearned) return;
          play();
          repeatTimer = setInterval(play, CUE_REPEAT_MS);
        }, CUE_DWELL_MS);
      } else {
        // Scrolled away - stop looping/waiting. They didn't actually read
        // it if the dwell hadn't finished yet; either way it re-arms
        // cleanly if the phrase scrolls back into view later.
        if (dwellTimer) { clearTimeout(dwellTimer); dwellTimer = null; }
        if (repeatTimer) { clearInterval(repeatTimer); repeatTimer = null; }
      }
    }, { threshold: 0.6 });
    observer.observe(anchor);
  }

  // Positioned with page-relative (document) coordinates, not viewport
  // coordinates, and #il-cue is position:absolute rather than fixed - so it
  // scrolls together with the article text it's pointing at instead of
  // staying pinned to the screen while the phrase scrolls away underneath.
  function showPhantomHand(anchor) {
    var rect = anchor.getBoundingClientRect();
    var scrollX = window.pageXOffset || document.documentElement.scrollLeft;
    var scrollY = window.pageYOffset || document.documentElement.scrollTop;
    var cue = document.createElement('div');
    cue.id = 'il-cue';
    cue.style.left = (rect.left + rect.width / 2 + scrollX) + 'px';
    cue.style.top = (rect.top + rect.height / 2 + scrollY) + 'px';
    // Real cursor artwork rather than a hand-drawn shape - black outline +
    // white fill reads on both light and dark article backgrounds without
    // needing to be a solid colour (a plain white silhouette would vanish
    // against a white background, and had twice failed to read as a hand
    // at this size anyway). Swaps from the plain pointing hand to the
    // "click" artwork (burst lines) right as the tap bounce plays - see
    // the il-cue-tap delay in injectStyles, which this 1100ms matches.
    var img = document.createElement('img');
    img.src = 'https://www.introlinq.com/cue-icons/cursor-over.png';
    img.alt = '';
    cue.appendChild(img);
    document.body.appendChild(cue);
    void cue.offsetWidth; // force layout so the pre-animation state above is committed before il-cue-play starts the animation clock
    cue.classList.add('il-cue-play');
    setTimeout(function () { img.src = 'https://www.introlinq.com/cue-icons/cursor-click.png'; }, 1100);
    setTimeout(function () { cue.remove(); }, 3450);
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
  // Fired once per highlighted phrase per page view, the first time a reader
  // actually hovers (desktop) or taps (touch) it - not on every re-hover, or
  // this would flood hover_logs every time a cursor drifts in and out. This
  // is the missing middle funnel step between impression (shown) and click
  // (booked): tells a discoverability problem (nobody ever hovers) apart
  // from a relevance/commitment-bar problem (readers hover and see the
  // expert card, but don't click through).
  // Tracked against the primary (first) option when one exists - keeps
  // seen_logs/hover_logs schema-compatible with widget.js. Falls back to
  // null/null if a match has a hook but no options at all, same as any
  // other row would with nothing to attribute.
  function trackHover(hoverTracked, m) {
    if (hoverTracked.done) return;
    hoverTracked.done = true;
    var e = m.options && m.options[0] && m.options[0].expert;
    fetch('https://www.introlinq.com/api/dashboard?pub=' + encodeURIComponent(PUB) + '&action=hover', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        expert_id: e && e.id,
        expert_name: e && e.name,
        phrase: m.phrase,
        article: window.location.href.slice(0, 300),
        device: window.innerWidth < 768 ? 'mobile' : window.innerWidth < 1024 ? 'tablet' : 'desktop'
      })
    }).catch(function () {});
  }

  function trackSeen(m) {
    var e = m.options && m.options[0] && m.options[0].expert;
    fetch('https://www.introlinq.com/api/dashboard?pub=' + encodeURIComponent(PUB) + '&action=seen', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        expert_id: e && e.id,
        expert_name: e && e.name,
        phrase: m.phrase,
        article: window.location.href.slice(0, 300),
        device: window.innerWidth < 768 ? 'mobile' : window.innerWidth < 1024 ? 'tablet' : 'desktop'
      })
    }).catch(function () {});
  }

  // Fires once per highlighted phrase per page view, the first time it's
  // been at least 60% visible for a full continuous second - long enough to
  // rule out a rapid scroll-past, short of the 2.5s dwell the discovery cue
  // itself waits for (this is a lower, easier-to-clear bar than "eligible
  // for a nudge animation"). Deliberately independent of maybeShowDiscoveryCue
  // and cfg.discoveryCue - a publisher turning the cue animation off doesn't
  // mean they stop wanting to know whether readers actually scroll past
  // their highlights, so this observer runs unconditionally.
  var SEEN_DWELL_MS = 1000;
  function maybeTrackSeen(anchor, m) {
    if (typeof IntersectionObserver !== 'function') return;
    var tracked = false;
    var timer = null;
    var observer = new IntersectionObserver(function (entries) {
      if (entries[0].isIntersecting) {
        if (timer || tracked) return;
        timer = setTimeout(function () {
          timer = null;
          if (tracked) return;
          tracked = true;
          trackSeen(m);
          observer.disconnect();
        }, SEEN_DWELL_MS);
      } else if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    }, { threshold: 0.6 });
    observer.observe(anchor);
  }

  function attachGroupEvents(spans, m, popup, cfg) {
    var anchor = spans[0];
    var hoverTracked = { done: false };
    if ('ontouchstart' in window) {
      spans.forEach(function (sp) {
        sp.addEventListener('click', function (ev) {
          ev.stopPropagation();
          stopDiscoveryCue();
          trackHover(hoverTracked, m);
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
          stopDiscoveryCue();
          trackHover(hoverTracked, m);
          clearTimeout(hideTimer);
          fillPopup(popup, m, cfg);
          positionPopup(popup, anchor, cfg);
          popup.classList.add('il-on');
        });
        // Pinned cards (opened via keyboard - see the keydown handler
        // below) ignore mouseleave entirely.
        sp.addEventListener('mouseleave', function () {
          if (!popup.classList.contains('il-pinned')) scheduleHide(popup);
        });
        // Same "hover already showed it, a click commits" pattern as
        // widget.js - commits to the top CTA link specifically (the
        // low-commitment "browse" path this variant leads with), not one
        // of the named options, since there's no single obvious person to
        // pick between.
        sp.addEventListener('click', function () {
          stopDiscoveryCue();
          trackHover(hoverTracked, m);
          fillPopup(popup, m, cfg);
          var cta = document.getElementById('il2-cta');
          if (cta && cta.getAttribute('href') !== '#') cta.click();
        });
      });
    }
    // Keyboard equivalent of click/mouseenter above, on the one focusable
    // fragment (anchor === spans[0], the one with tabindex="0" - see
    // wrapCombinedRange). Space also triggers native scroll on most
    // elements, so it's prevented here same as a real link/button would.
    anchor.addEventListener('keydown', function (ev) {
      if (ev.key !== 'Enter' && ev.key !== ' ') return;
      ev.preventDefault();
      stopDiscoveryCue();
      trackHover(hoverTracked, m);
      clearTimeout(hideTimer);
      fillPopup(popup, m, cfg);
      positionPopup(popup, anchor, cfg);
      popup.classList.add('il-on', 'il-pinned');
    });
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
      // role=link (every fragment, so a screen reader reading through the
      // paragraph announces each piece consistently) + tabindex only on the
      // first fragment (one tab stop per phrase, not one per DOM fragment -
      // matches the popup's own first-fragment anchoring above) makes this
      // keyboard/AT-reachable without becoming a real navigable <a> - see
      // attachGroupEvents for the matching keydown handler.
      span.setAttribute('role', 'link');
      if (spans.length === 0) span.setAttribute('tabindex', '0');
      spans.push(span);

      if (from > 0) parent.insertBefore(document.createTextNode(text.slice(0, from)), node);
      parent.insertBefore(span, node);
      if (to < text.length) parent.insertBefore(document.createTextNode(text.slice(to)), node);
      parent.removeChild(node);
    }
    // One shared listener setup for the whole group, not per-fragment -
    // see attachGroupEvents for why.
    if (spans.length) {
      attachGroupEvents(spans, match, popup, cfg);
      maybeShowDiscoveryCue(spans[0], cfg);
      maybeTrackSeen(spans[0], match);
    }
    return spans.length > 0;
  }

  // Builds one compact expert row's markup - photo, name, role, and its own
  // direct Book link (the real https://.../api/dashboard?action=out
  // tracked redirect, same params widget.js always sent). No preload-swap
  // for photos here - onerror fallback is simpler and fine for up to 3
  // small thumbnails.
  // clickSource distinguishes the top CTA button from a specific named
  // expert's own Meet/name/photo link in click_logs - for the PRIMARY
  // option those two currently lead to the exact same expert, so without
  // this they'd be indistinguishable even though they're different UI
  // elements the reader chose between.
  function buildTrackedBookingUrl(e, match, clickSource) {
    var url = e.booking_url || '#';
    if (url === '#') return '#';
    return 'https://www.introlinq.com/api/dashboard?action=out'
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
      + '&title=' + encodeURIComponent(document.title.slice(0, 150))
      + '&click_source=' + encodeURIComponent(clickSource);
  }

  function buildOptionRow(opt, match, clickSource) {
    var e = opt.expert;
    if (!e) return '';
    var fallback = 'https://ui-avatars.com/api/?background=edf5f0&color=3d7a5f&bold=true&size=64&name=' + encodeURIComponent(e.name);
    var showCompany = !e.is_demo_provider;
    var role = [e.position, showCompany ? e.company : null].filter(Boolean).join(' · ');
    var href = buildTrackedBookingUrl(e, match, clickSource || 'person');
    // opt.credentials is an array of short punchy facts ("4 exits", "$1B+
    // processed") - joined into one line with " | " instead of separate
    // pill chips, so it reads as one quick scannable line rather than a
    // row of badges.
    var facts = Array.isArray(opt.credentials) ? opt.credentials.filter(Boolean) : [];
    var factsHtml = facts.length
      ? '<div class="il2-opt-facts">' + facts.map(function (c) { return String(c).replace(/</g,'&lt;'); }).join(' | ') + '</div>'
      : '';
    // Photo and name are clickable too now, not just the Meet button -
    // same tracked href, bigger click target. Falls back to plain
    // (non-linked) markup when there's no real booking_url, same
    // condition the Meet button itself already uses.
    var photoImg = '<img class="il2-opt-photo" src="' + (e.photo_url || fallback) + '" onerror="this.onerror=null;this.src=\'' + fallback + '\'" alt="">';
    var nameEsc = (e.name || '').replace(/</g,'&lt;');
    var photoHtml = href !== '#'
      ? '<a href="' + href + '" target="_blank" rel="noopener" style="display:block!important;flex-shrink:0">' + photoImg + '</a>'
      : photoImg;
    var nameHtml = href !== '#'
      ? '<a class="il2-opt-name" href="' + href + '" target="_blank" rel="noopener">' + nameEsc + '</a>'
      : '<div class="il2-opt-name">' + nameEsc + '</div>';
    var bookLabel = BOOK_LABEL.replace(/</g,'&lt;');
    return '<div class="il2-opt">' +
        photoHtml +
        '<div class="il2-opt-info">' +
          nameHtml +
          (role ? '<div class="il2-opt-role">' + role.replace(/</g,'&lt;') + '</div>' : '') +
          factsHtml +
        '</div>' +
        (href !== '#' ? '<a class="il2-opt-book" href="' + href + '" target="_blank" rel="noopener">' + bookLabel + '</a>' : '') +
      '</div>';
  }

  // match here is { phrase, hook, cta, query, options } - hook/cta/query
  // drive the top headline+button (hidden if hook is absent), options
  // drives the name-row list below it (hidden if empty) - independently
  // optional so this degrades gracefully either direction.
  function fillPopup(popup, match, cfg, personClickSource) {
    var hookWrap = document.getElementById('il2-hookwrap');
    if (hookWrap) hookWrap.style.display = match.hook ? 'block' : 'none';
    var hookEl = document.getElementById('il2-hook');
    if (hookEl) hookEl.textContent = match.hook || '';
    var cta = document.getElementById('il2-cta');
    if (cta) cta.textContent = match.cta || 'Explore experts →';

    var options = match.options || [];
    var list = document.getElementById('il2-list');
    if (list) {
      // The label used to be gated on match.hook (every real match always
      // has both together), but widget6's no-match fallback deliberately
      // sends a match with options and no hook - see attachFallbackTrigger
      // - so the label needs to stand on its own whenever there's a list
      // to introduce, hook or no hook.
      var listLabel = cfg.company_name
        ? RECOMMEND_LABEL.withCompany.replace('{company}', String(cfg.company_name).replace(/</g,'&lt;'))
        : RECOMMEND_LABEL.withoutCompany;
      list.innerHTML = options.length
        ? '<div class="il2-list-label">' + listLabel + '</div>' + options.map(function (opt) { return buildOptionRow(opt, match, personClickSource); }).join('')
        : '';
    }
    // Partnership attribution footer - same as widget.js/2/3's version,
    // keyed off the primary (first) option since they're usually all from
    // the same partner network anyway.
    var e = options[0] && options[0].expert;
    // CTA goes straight to the PRIMARY (first-listed) named expert's own
    // tracked booking link - not OpenIntro's AI search (/discover/ai),
    // which is real but too slow in practice for a launch-day link.
    // click_source='cta' (vs 'person' on the name-row links) is what
    // makes this distinguishable in click_logs even though it's the same
    // destination as that expert's own Meet link.
    if (cta) cta.href = e ? buildTrackedBookingUrl(e, match, 'cta') : '#';
    var pv = document.getElementById('il-pv');
    if (pv && e) {
      var providerName = e.provider_name || (e.provider_slug || 'openintro');
      var providerLogoUrl = e.provider_logo_url || null;
      var providerUrl = e.provider_website_url || '#';
      var prov = { name: providerName, url: providerUrl, logo: providerLogoUrl };
      var ilLogo = '<img src="https://www.introlinq.com/favicon.svg" alt="IntroLinq" style="width:11px!important;height:11px!important;border-radius:2px;vertical-align:middle;margin-left:4px;margin-right:3px;flex-shrink:0">';
      var s = 'font-size:8.5px!important;color:#8888a8!important;font-family:Inter,system-ui,sans-serif;text-decoration:none;display:flex!important;align-items:center;gap:2px;min-width:0;overflow:hidden;white-space:nowrap;flex-shrink:1';
      pv.style.cssText = 'display:flex!important;align-items:center;justify-content:space-between;flex-wrap:nowrap;gap:8px;margin-top:6px;padding-top:6px;border-top:1px solid rgba(26,26,46,0.07)';
      var partnerLink;
      if (e.is_demo_provider && prov.logo) {
        partnerLink = '<a href="' + prov.url + '" target="_blank" rel="noopener" style="' + s + '">In partnership with <img src="' + prov.logo + '" alt="' + prov.name + '" style="height:14px!important;width:auto;max-width:70px;object-fit:contain;margin-left:5px;vertical-align:middle;flex-shrink:0"></a>';
      } else {
        var providerLogoHtml = prov.logo
          ? '<img src="' + prov.logo + '" alt="' + prov.name + '" style="width:13px!important;height:13px!important;object-fit:contain;border-radius:2px;vertical-align:middle;margin-left:5px;margin-right:3px;flex-shrink:0">'
          : '';
        partnerLink = '<a href="' + prov.url + '" target="_blank" rel="noopener" style="' + s + '">In partnership with' + (providerLogoHtml || ' ') + prov.name + '</a>';
      }
      pv.innerHTML = partnerLink + '<a href="https://www.introlinq.com" target="_blank" rel="noopener" style="' + s + '">Powered by' + ilLogo + 'IntroLinq</a>';
    }
  }

  function positionPopup(popup, span, cfg) {
    var rect = span.getBoundingClientRect();
    var isMobile = window.innerWidth < 520;
    var W = isMobile ? Math.min(320, window.innerWidth - 24) : ({ small: 280, medium: 340, large: 400 }[cfg.size] || 340);
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
