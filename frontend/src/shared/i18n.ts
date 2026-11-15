// i18n (Internationalization) Module for listen-along.
// A CLASSIC script (index.html <script src="/shared/i18n.js">), not a module:
// no import / export here, or it would be emitted as a module. It sets
// window.i18n (typed in globals.d.ts).
(function() {
  'use strict';

  type Translations = { [key: string]: string | Translations };

  const STORAGE_KEY = 'listen-language';
  const SUPPORTED_LANGUAGES = ['en', 'tr'];
  const DEFAULT_LANGUAGE = 'en';

  let currentLanguage = DEFAULT_LANGUAGE;
  let translations: Translations = {};
  let isLoaded = false;

  // Detect browser language
  function detectLanguage() {
    let stored = null;
    try { stored = localStorage.getItem(STORAGE_KEY); } catch { /* storage blocked */ }
    if (stored && SUPPORTED_LANGUAGES.includes(stored)) {
      return stored;
    }

    // Check browser language
    // userLanguage: old Internet Explorer.
    const browserLang = navigator.language || (navigator as Navigator & { userLanguage?: string }).userLanguage;
    if (browserLang) {
      const lang = browserLang.split('-')[0].toLowerCase();
      if (SUPPORTED_LANGUAGES.includes(lang)) {
        return lang;
      }
    }

    return DEFAULT_LANGUAGE;
  }

  // Load translation file
  async function loadTranslations(lang: string): Promise<Translations> {
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
  function getTranslation(key: string, replacements: Record<string, string | number> = {}): string {
    const keys = key.split('.');
    let value: string | Translations = translations;

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
    return value.replace(/\{(\w+)\}/g, (match, placeholder: string) => {
      return placeholder in replacements ? String(replacements[placeholder]) : match;
    });
  }

  // Update all elements with data-i18n attribute
  function updatePageTranslations() {
    // Update text content
    document.querySelectorAll('[data-i18n]').forEach(el => {
      const key = el.getAttribute('data-i18n') as string;
      el.textContent = getTranslation(key);
    });

    // Update placeholders
    document.querySelectorAll<HTMLInputElement>('[data-i18n-placeholder]').forEach(el => {
      const key = el.getAttribute('data-i18n-placeholder') as string;
      el.placeholder = getTranslation(key);
    });

    // Update aria-labels
    document.querySelectorAll('[data-i18n-aria-label]').forEach(el => {
      const key = el.getAttribute('data-i18n-aria-label') as string;
      el.setAttribute('aria-label', getTranslation(key));
    });

    // Update title attributes
    document.querySelectorAll('[data-i18n-title]').forEach(el => {
      const key = el.getAttribute('data-i18n-title') as string;
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
  async function setLanguage(lang: string): Promise<boolean> {
    if (!SUPPORTED_LANGUAGES.includes(lang)) {
      console.error(`Unsupported language: ${lang}`);
      return false;
    }

    if (lang === currentLanguage && isLoaded) {
      return true;
    }

    currentLanguage = lang;
    try { localStorage.setItem(STORAGE_KEY, lang); } catch { /* storage blocked */ }
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
