/*
 * Runtime interface-language switch for the Chirpy site — FLASH-FREE (no FOUC).
 *
 * How it works (see also _includes/metadata-hook.html + assets/css/i18n.css):
 *   - Every translatable UI string is rendered into the DOM at build time as BOTH
 *     variants: <span data-i18n-lang="en">…</span><span data-i18n-lang="zh">…</span>.
 *   - The active language is selected purely by the [data-lang] attribute on <html>,
 *     which a synchronous inline <head> script stamps BEFORE first paint. i18n.css
 *     then hides the inactive-language spans. So the first frame is already correct
 *     and NOTHING is text-swapped after render — no English→Chinese flash.
 *
 * This deferred script's ONLY job is to wire the click toggle: flip the saved
 * language in localStorage and update html[data-lang] live (CSS reacts instantly).
 * It does NOT touch textContent, so it can safely run after DOMContentLoaded.
 *
 * Scope: flips ONLY the UI chrome strings (site title, tagline, nav labels, section
 * intros, About text). It does NOT hide, move, or filter any posts — the two article
 * sections (English / 中文) are always present in the navigation regardless of UI language.
 *
 * Default language is English (matches the build-time `lang: en`). The chosen language
 * is remembered in localStorage so it persists across pages/visits.
 *
 * No dependency on jQuery or the theme bundle; runs on its own.
 */
(function () {
  'use strict';

  var STORAGE_KEY = 'ui-lang';
  var DEFAULT_LANG = 'en';

  function getLang() {
    try {
      var v = localStorage.getItem(STORAGE_KEY);
      return v === 'zh' || v === 'en' ? v : DEFAULT_LANG;
    } catch (e) {
      return DEFAULT_LANG;
    }
  }

  function setLang(lang) {
    try {
      localStorage.setItem(STORAGE_KEY, lang);
    } catch (e) {
      /* ignore storage failures (private mode etc.) */
    }
  }

  // Reflect the active language onto <html data-lang>. CSS (i18n.css) shows the
  // matching-language spans; no per-element text mutation happens here.
  function apply(lang) {
    document.documentElement.setAttribute('data-lang', lang);
    // Keep the legacy attribute too, for any external CSS/JS that referenced it.
    document.documentElement.setAttribute('data-ui-lang', lang);
  }

  function init() {
    // The inline <head> script already set html[data-lang] before paint; re-assert
    // it here defensively (and set data-ui-lang) in case the page was served stale.
    apply(getLang());

    var btn = document.getElementById('lang-toggle');
    if (btn) {
      btn.addEventListener('click', function () {
        var next = getLang() === 'zh' ? 'en' : 'zh';
        setLang(next);
        apply(next);
      });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
