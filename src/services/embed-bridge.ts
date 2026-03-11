/**
 * Embed Bridge — postMessage listener for HyperInsights iframe integration.
 *
 * When HyperMonitor runs inside an iframe, the parent (HyperInsights) sends
 * `{ type: 'hyperinsights:preferences', theme, locale }` messages to
 * synchronize theme and language. This module listens for those messages
 * and applies the preferences using existing internal APIs.
 *
 * Upstream-safe: this file is HyperMonitor-only and will never conflict
 * with WorldMonitor upstream merges.
 */
import { changeLanguage, getCurrentLanguage } from './i18n';
import { getCurrentTheme, setTheme, type Theme } from '@/utils/theme-manager';

const ALLOWED_ORIGINS = [
  'https://hyperinsights.vercel.app',
  'http://localhost:3000',
];

interface PreferencesMessage {
  type: 'hyperinsights:preferences';
  theme?: string;
  locale?: string;
}

function isPreferencesMessage(data: unknown): data is PreferencesMessage {
  return (
    typeof data === 'object' &&
    data !== null &&
    (data as Record<string, unknown>).type === 'hyperinsights:preferences'
  );
}

/**
 * Initialize the embed bridge. Only activates when running inside an iframe.
 * Call once during app bootstrap (after i18n is initialized).
 */
export function initEmbedBridge(): void {
  // Only activate when running inside an iframe
  if (window.self === window.top) return;

  window.addEventListener('message', (e: MessageEvent) => {
    if (!ALLOWED_ORIGINS.includes(e.origin)) return;
    if (!isPreferencesMessage(e.data)) return;

    const { theme, locale } = e.data;

    // Deduplicate: only apply if theme actually changed
    if (theme === 'dark' || theme === 'light') {
      if (getCurrentTheme() !== theme) {
        setTheme(theme as Theme);
      }
    }

    // Deduplicate: changeLanguage() calls window.location.reload(), so we
    // must skip when the language already matches to avoid an infinite loop.
    if (locale && typeof locale === 'string') {
      const normalized = locale.split('-')[0] || locale;
      if (getCurrentLanguage() !== normalized) {
        void changeLanguage(locale);
      }
    }
  });

  // Notify parent that the bridge is ready so it can (re-)send preferences
  window.parent.postMessage({ type: 'hypermonitor:ready' }, '*');
}
