// i18n (Internationalization) Module for listen-along
(function() {
  'use strict';

  const STORAGE_KEY = 'listen-language';
  const SUPPORTED_LANGUAGES = ['en', 'tr'];
  const DEFAULT_LANGUAGE = 'en';

  let currentLanguage = DEFAULT_LANGUAGE;
  let translations = {};
  let isLoaded = false;

  // Detect browser language
  function detectLanguage() {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored && SUPPORTED_LANGUAGES.includes(stored)) {
      return stored;
    }

    // Check browser language
    const browserLang = navigator.language || navigator.userLanguage;
    if (browserLang) {
      const lang = browserLang.split('-')[0].toLowerCase();
      if (SUPPORTED_LANGUAGES.includes(lang)) {
        return lang;
      }
    }

    return DEFAULT_LANGUAGE;
  }

  // Load translation file
  async function loadTranslations(lang) {
    try {
      const response = await fetch(`/locales/${lang}.json`);
      if (!response.ok) {
        throw new Error(`Failed to load ${lang} translations`);
      }
      return await response.json();
    } catch (err) {
      console.error(`Failed to load translations for ${lang}:`, err);
      // Fall back to English if loading fails
      if (lang !== DEFAULT_LANGUAGE) {
        return loadTranslations(DEFAULT_LANGUAGE);
      }
      return {};
    }
  }

  // Get nested translation by key path (e.g., "app.title")
  function getTranslation(key, replacements = {}) {
    const keys = key.split('.');
    let value = translations;

    for (const k of keys) {
      if (value && typeof value === 'object' && k in value) {
        value = value[k];
      } else {
        // Key not found, return the key itself
        console.warn(`Translation key not found: ${key}`);
        return key;
      }
    }

    if (typeof value !== 'string') {
      console.warn(`Translation key ${key} is not a string`);
      return key;
    }

    // Replace placeholders like {count}, {name}, etc.
    return value.replace(/\{(\w+)\}/g, (match, placeholder) => {
      return placeholder in replacements ? replacements[placeholder] : match;
    });
  }

  // Update all elements with data-i18n attribute
  function updatePageTranslations() {
    // Update text content
    document.querySelectorAll('[data-i18n]').forEach(el => {
      const key = el.getAttribute('data-i18n');
      el.textContent = getTranslation(key);
    });

    // Update placeholders
    document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
      const key = el.getAttribute('data-i18n-placeholder');
      el.placeholder = getTranslation(key);
    });

    // Update aria-labels
    document.querySelectorAll('[data-i18n-aria-label]').forEach(el => {
      const key = el.getAttribute('data-i18n-aria-label');
      el.setAttribute('aria-label', getTranslation(key));
    });

    // Update title attributes
    document.querySelectorAll('[data-i18n-title]').forEach(el => {
      const key = el.getAttribute('data-i18n-title');
      el.setAttribute('title', getTranslation(key));
    });

    // Update HTML lang attribute
    document.documentElement.lang = currentLanguage;

    // Dispatch event for dynamic content updates
    window.dispatchEvent(new CustomEvent('languageChanged', { detail: { language: currentLanguage } }));
  }

  // Initialize i18n
  async function init() {
    currentLanguage = detectLanguage();
    translations = await loadTranslations(currentLanguage);
    isLoaded = true;
    updatePageTranslations();
    return currentLanguage;
  }

  // Change language
  async function setLanguage(lang) {
    if (!SUPPORTED_LANGUAGES.includes(lang)) {
      console.error(`Unsupported language: ${lang}`);
      return false;
    }

    if (lang === currentLanguage && isLoaded) {
      return true;
    }

    currentLanguage = lang;
    localStorage.setItem(STORAGE_KEY, lang);
    translations = await loadTranslations(lang);
    updatePageTranslations();
    return true;
  }

  // Get current language
  function getLanguage() {
    return currentLanguage;
  }

  // Get list of supported languages
  function getSupportedLanguages() {
    return [...SUPPORTED_LANGUAGES];
  }

  // Export to window
  window.i18n = {
    init,
    t: getTranslation,
    setLanguage,
    getLanguage,
    getSupportedLanguages,
    updatePageTranslations
  };
})();
