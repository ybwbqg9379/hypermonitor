/**
 * Embed Bridge — postMessage listener for HyperInsights iframe integration.
 *
 * When HyperMonitor runs inside an iframe, the parent (HyperInsights) sends
 * `{ type: 'hyperinsights:preferences', theme, locale }` messages to
 * synchronize theme and language, and `{ type: 'hyperinsights:design-tokens' }`
 * messages to synchronize visual style (font, etc.).
 *
 * This module listens for those messages and applies the preferences using
 * existing internal APIs.
 *
 * Upstream-safe: this file is HyperMonitor-only and will never conflict
 * with WorldMonitor upstream merges.
 */
import { changeLanguage, getCurrentLanguage } from './i18n';
import { getCurrentTheme, setTheme, type Theme } from '@/utils/theme-manager';
import { getMapProvider, setMapTheme, isLightMapTheme, getMapTheme } from '@/config/basemap';

const ALLOWED_ORIGINS = [
  'https://hyperinsights.vercel.app',
  'http://localhost:3000',
];

/** Map from app theme to the map tile theme for the current provider. */
function mapThemeForAppTheme(appTheme: 'dark' | 'light'): string | null {
  const provider = getMapProvider();
  const current = getMapTheme(provider);
  const currentIsLight = isLightMapTheme(current);

  // Already in the correct family — skip
  if ((appTheme === 'light') === currentIsLight) return null;

  // Pick a sensible counterpart per provider
  switch (provider) {
    case 'pmtiles':
    case 'auto':
      return appTheme === 'light' ? 'light' : 'black';
    case 'openfreemap':
      return appTheme === 'light' ? 'positron' : 'dark';
    case 'carto':
      return appTheme === 'light' ? 'positron' : 'dark-matter';
    default:
      return null;
  }
}

interface PreferencesMessage {
  type: 'hyperinsights:preferences';
  theme?: string;
  locale?: string;
}

interface DesignTokensMessage {
  type: 'hyperinsights:design-tokens';
  fontFamily?: string;
}

function isPreferencesMessage(data: unknown): data is PreferencesMessage {
  return (
    typeof data === 'object' &&
    data !== null &&
    (data as Record<string, unknown>).type === 'hyperinsights:preferences'
  );
}

function isDesignTokensMessage(data: unknown): data is DesignTokensMessage {
  return (
    typeof data === 'object' &&
    data !== null &&
    (data as Record<string, unknown>).type === 'hyperinsights:design-tokens'
  );
}

/**
 * Initialize the embed bridge. Only activates when running inside an iframe.
 * Call once during app bootstrap (after i18n is initialized).
 */
export function initEmbedBridge(): void {
  // Only activate when running inside an iframe
  if (window.self === window.top) return;

  // Mark the document as embedded for CSS-driven UI customization
  document.documentElement.dataset.embedded = 'true';

  window.addEventListener('message', (e: MessageEvent) => {
    if (!ALLOWED_ORIGINS.includes(e.origin)) return;

    if (isPreferencesMessage(e.data)) {
      const { theme, locale } = e.data;

      // Deduplicate: only apply if theme actually changed
      if (theme === 'dark' || theme === 'light') {
        if (getCurrentTheme() !== theme) {
          setTheme(theme as Theme);

          // Sync map basemap style to match the new app theme
          const newMapTheme = mapThemeForAppTheme(theme);
          if (newMapTheme) {
            setMapTheme(getMapProvider(), newMapTheme);
            // Dispatch a custom event so the map controller can reload
            window.dispatchEvent(new CustomEvent('embed:basemap-reload'));
          }
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
    }

    if (isDesignTokensMessage(e.data)) {
      const { fontFamily } = e.data;
      if (fontFamily && typeof fontFamily === 'string') {
        document.documentElement.style.setProperty('--font-body', fontFamily);
      }
    }
  });

  // Notify parent that the bridge is ready so it can (re-)send preferences
  window.parent.postMessage({ type: 'hypermonitor:ready' }, '*');
}

