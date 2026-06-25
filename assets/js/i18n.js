/*
 * Runtime interface-language switch for the Chirpy site.
 *
 * Scope: flips ONLY the UI chrome strings that carry data-i18n-en / data-i18n-zh
 * attributes (site title, tagline, nav labels, section intros, About text).
 * It does NOT hide, move, or filter any posts — the two article sections
 * (English / 中文) are always present in the navigation regardless of UI language.
 *
 * Default language is English (matches the build-time `lang: en`). The chosen
 * language is remembered in localStorage so it persists across pages/visits.
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

  // Apply the active language to every element that declares both variants.
  function apply(lang) {
    var nodes = document.querySelectorAll('[data-i18n-en][data-i18n-zh]');
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      var txt = lang === 'zh' ? el.getAttribute('data-i18n-zh')
                              : el.getAttribute('data-i18n-en');
      if (txt !== null && txt !== undefined) {
        el.textContent = txt;
      }
    }

    // The toggle button shows the language you would switch TO.
    var label = document.getElementById('lang-toggle-label');
    if (label) {
      label.textContent = lang === 'zh' ? 'EN' : '中文';
    }

    // Reflect on <html lang> for accessibility without rebuilding the page.
    document.documentElement.setAttribute('data-ui-lang', lang);
  }

  function init() {
    var lang = getLang();
    apply(lang);

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
