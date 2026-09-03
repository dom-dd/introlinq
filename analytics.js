/* PostHog for IntroLinq's public marketing/funnel pages.
 *
 * Goal: understand why visitors don't register. Loaded in <head> on the
 * homepage, niche landing pages, /signup and /login.
 *
 * Bot handling (IntroLinq gets heavy cloud-ASN crawler traffic):
 *  - PostHog's built-in user-agent bot filter stays on (default).
 *  - before_send drops anything from an automation runtime (navigator.webdriver).
 *  - Session recording is OFF everywhere except /signup and /login - those are
 *    low-traffic, human-intent pages, so the 5k/mo replay quota is spent only
 *    where it answers the question, not on landing-page crawler hits.
 *  - person_profiles: 'identified_only' - anonymous/bot hits never mint a person.
 *
 * Anyone touching this: keep it dependency-free and safe to run before the
 * rest of the page. window.ilTrack(name, props) is the helper other pages use.
 */
(function () {
  var TOKEN = 'phc_AyjrGifQYm52Ro7zN4v9VatrZgQZ7tKDNPCpSJ7SnKyg';
  var API_HOST = 'https://eu.i.posthog.com';

  // Pages where session replay is worth spending quota on.
  var RECORD_PATHS = ['/signup', '/login'];
  var path = location.pathname.replace(/\/+$/, '') || '/';
  var shouldRecord = RECORD_PATHS.some(function (p) { return path === p || path.indexOf(p + '/') === 0; });

  // --- PostHog loader snippet (unmodified) ---
  !function(t,e){var o,n,p,r;e.__SV||(window.posthog&&window.posthog.__loaded)||(window.posthog=e,e._i=[],e.init=function(i,s,a){function g(t,e){var o=e.split(".");2==o.length&&(t=t[o[0]],e=o[1]),t[e]=function(){t.push([e].concat(Array.prototype.slice.call(arguments,0)))}}p||((p=t.createElement("script")).type="text/javascript",p.crossOrigin="anonymous",p.async=!0,p.src=s.api_host.replace(".i.posthog.com","-assets.i.posthog.com")+"/static/array.js",p.onerror=function(){p=null},(r=t.getElementsByTagName("script")[0]).parentNode.insertBefore(p,r));var u=e;for(void 0!==a?u=e[a]=[]:a="posthog",u.people=u.people||[],u.toString=function(t){var e="posthog";return"posthog"!==a&&(e+="."+a),t||(e+=" (stub)"),e},u.people.toString=function(){return u.toString(1)+".people (stub)"},o="Tl Ml El Il Al init Xl tu Jl Kl nu ho Yl au Gl capture getExtension eu xl vu calculateEventProperties du register register_once register_for_session unregister unregister_for_session gu Ql cu getFeatureFlag getFeatureFlagPayload getFeatureFlagResult getAllFeatureFlags isFeatureEnabled reloadFeatureFlags updateFlags updateEarlyAccessFeatureEnrollment getEarlyAccessFeatures on onFeatureFlags onSurveysLoaded onSessionId getSurveys getActiveMatchingSurveys renderSurvey displaySurvey cancelPendingSurvey canRenderSurvey canRenderSurveyAsync mu identify setPersonProperties unsetPersonProperties group resetGroups setPersonPropertiesForFlags resetPersonPropertiesForFlags setGroupPropertiesForFlags resetGroupPropertiesForFlags reset yu shutdown setIdentity clearIdentity get_distinct_id getGroups get_session_id get_session_replay_url alias set_config startSessionRecording stopSessionRecording sessionRecordingStarted captureException addExceptionStep captureLog startExceptionAutocapture stopExceptionAutocapture loadToolbar get_property getSessionProperty fu uu createPersonProfile setInternalOrTestUser pu Fl Ol opt_in_capturing opt_out_capturing has_opted_in_capturing has_opted_out_capturing get_explicit_consent_status is_capturing clear_opt_in_out_capturing ou debug do ts getPageViewId captureTraceFeedback captureTraceMetric zl".split(" "),n=0;n<o.length;n++)g(u,o[n]);e._i.push([i,s,a])},e.__SV=1)}(document,window.posthog||[]);

  posthog.init(TOKEN, {
    api_host: API_HOST,
    defaults: '2026-05-30',
    person_profiles: 'identified_only',
    disable_session_recording: !shouldRecord,
    autocapture: true,
    capture_pageview: true,
    capture_pageleave: true,
    before_send: function (event) {
      try {
        if (navigator.webdriver) return null;
      } catch (e) {}
      return event;
    }
  });

  // Lightweight helper for the funnel events other pages fire. Safe to call
  // before array.js has finished loading - the stub queues it.
  window.ilTrack = function (name, props) {
    try { window.posthog && window.posthog.capture(name, props || {}); } catch (e) {}
  };
})();
