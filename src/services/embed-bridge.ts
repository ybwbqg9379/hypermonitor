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
import { calculateCII } from '@/services/country-instability';
import { getRecentAlerts } from '@/services/cross-module-integration';

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

  // Track validated parent origin for outbound postMessage calls.
  // Starts as '*' because the initial 'hypermonitor:ready' fires before
  // any parent message arrives. Locks to the real origin on first receipt.
  let parentOrigin = '*';

  window.addEventListener('message', (e: MessageEvent) => {
    if (!ALLOWED_ORIGINS.includes(e.origin)) return;

    // Lock outbound targetOrigin to the validated parent
    if (parentOrigin === '*') {
      parentOrigin = e.origin;
    }

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

  // ── Event forwarding: forward key internal events to the parent ──────

  /**
   * Safely forward an internal HyperMonitor event to the parent frame.
   * Uses '*' as targetOrigin since we're sending FROM the iframe TO the
   * parent, and the parent validates origin on receipt.
   */
  function forwardEvent(payload: Record<string, unknown>): void {
    window.parent.postMessage(
      { type: 'hypermonitor:event', payload },
      parentOrigin
    );
  }

  // 1. Breaking news alerts
  document.addEventListener('wm:breaking-news', ((e: CustomEvent) => {
    const alert = e.detail;
    if (!alert || typeof alert !== 'object') return;
    forwardEvent({
      event: 'breaking-alert',
      alert: {
        id: alert.id ?? '',
        headline: alert.headline ?? '',
        source: alert.source ?? '',
        link: alert.link,
        threatLevel: alert.threatLevel ?? 'high',
        timestamp: alert.timestamp instanceof Date
          ? alert.timestamp.toISOString()
          : String(alert.timestamp ?? ''),
        origin: alert.origin ?? 'rss_alert',
      },
    });
  }) as EventListener);

  // 2. Market watchlist changes
  window.addEventListener('wm-market-watchlist-changed', ((e: CustomEvent) => {
    const detail = e.detail as { entries?: unknown } | undefined;
    const entries = Array.isArray(detail?.entries) ? detail!.entries : [];
    forwardEvent({
      event: 'watchlist-changed',
      entries: entries
        .filter((entry: unknown) => entry && typeof entry === 'object' && 'symbol' in (entry as Record<string, unknown>))
        .slice(0, 50)
        .map((entry: Record<string, unknown>) => ({
          symbol: String(entry.symbol),
          ...(entry.name ? { name: String(entry.name) } : {}),
          ...(entry.display ? { display: String(entry.display) } : {}),
        })),
    });
  }) as EventListener);

  // 3. Country brief openings — detect when a *real* country brief is rendered.
  //
  //    The flow is: showLoading() adds .active -> show() replaces innerHTML.
  //    showLoading() and showGeoError() also add .active, but they render
  //    different templates (no .cb-link-share-btn). We use a childList
  //    observer to detect innerHTML replacements, then check for the
  //    .cb-link-share-btn element which is exclusive to the real show() template.
  //
  //    Dedup: after show() renders the real brief, subsequent async updates
  //    (updateBrief, updateMarkets, updateNews, updateInfrastructure) also
  //    mutate the DOM. We track the last forwarded country key (code|name)
  //    so we only forward once per brief.
  //
  //    Reset: hide() only removes .active (attribute change, not childList),
  //    so a SEPARATE targeted attribute observer on the overlay element
  //    watches for class changes and resets the key when .active is removed.
  let lastBriefKey = '';

  // --- Observer A: childList on document.body — detects real brief rendering ---
  const briefObserver = new MutationObserver(() => {
    const overlay = document.querySelector('.country-brief-overlay');
    if (!overlay || !overlay.classList.contains('active')) return;

    // .cb-link-share-btn only exists in the real country brief (show()),
    // not in showLoading() or showGeoError()
    if (!overlay.querySelector('.cb-link-share-btn')) return;

    const nameEl = overlay.querySelector('.cb-country-name');
    const flagEl = overlay.querySelector('.cb-flag');
    if (!nameEl) return;

    const name = nameEl.textContent?.trim() ?? '';
    if (!name) return;

    // Derive ISO country code from the flag emoji.
    let code = '';
    const flag = flagEl?.textContent?.trim() ?? '';
    if (flag.length >= 2) {
      const codePoint1 = flag.codePointAt(0);
      const codePoint2 = flag.codePointAt(2);
      if (codePoint1 && codePoint2 && codePoint1 >= 0x1F1E6 && codePoint2 >= 0x1F1E6) {
        code = String.fromCharCode(codePoint1 - 0x1F1E6 + 65) +
               String.fromCharCode(codePoint2 - 0x1F1E6 + 65);
      }
    }

    // Dedup: only forward once per country brief open
    const briefKey = code + '|' + name;
    if (briefKey === lastBriefKey) return;
    lastBriefKey = briefKey;

    forwardEvent({
      event: 'country-brief-opened',
      country: { code, name },
    });
  });

  briefObserver.observe(document.body, {
    childList: true,
    subtree: true,
  });

  // --- Observer B: attribute on overlay — resets dedup key on close ---
  // hide() calls classList.remove('active'), which is an attribute mutation.
  // The overlay element is created by CountryBriefPage's constructor and
  // may not exist yet when the bridge initializes, so we attach lazily.
  function attachCloseObserver(overlay: Element): void {
    new MutationObserver(() => {
      if (!overlay.classList.contains('active')) {
        lastBriefKey = '';
      }
    }).observe(overlay, { attributes: true, attributeFilter: ['class'] });
  }

  const overlayEl = document.querySelector('.country-brief-overlay');
  if (overlayEl) {
    attachCloseObserver(overlayEl);
  } else {
    // Overlay not yet in DOM — wait for it with a one-shot body observer
    const waitObserver = new MutationObserver(() => {
      const el = document.querySelector('.country-brief-overlay');
      if (el) {
        waitObserver.disconnect();
        attachCloseObserver(el);
      }
    });
    waitObserver.observe(document.body, { childList: true, subtree: true });
  }

  // 4. Data snapshot forwarding — push summarized data to parent on refresh.
  //
  //    Listens for `wm:intelligence-updated` (fired by cross-module-integration
  //    and correlation after each data refresh cycle). Throttled to max once
  //    per 60 seconds to avoid flooding the parent.
  let lastSnapshotTime = 0;
  const SNAPSHOT_THROTTLE_MS = 60_000;

  function buildAndForwardSnapshot(): void {
    const now = Date.now();
    if (now - lastSnapshotTime < SNAPSHOT_THROTTLE_MS) return;
    lastSnapshotTime = now;

    // CII scores — top 20 countries
    const ciiScores = calculateCII()
      .slice(0, 20)
      .map(s => ({
        code: s.code,
        name: s.name,
        score: s.score,
        level: s.level,
      }));

    // Unified alerts — most recent 10
    const alerts = getRecentAlerts(24)
      .slice(0, 10)
      .map(a => ({
        id: a.id,
        type: a.type,
        priority: a.priority,
        title: a.title,
        summary: a.summary,
        countries: a.countries,
        timestamp: a.timestamp.toISOString(),
      }));

    // News clusters — scrape from the DOM (read-only)
    // Actual structure: .item.clustered with .item-title, .item-source,
    //   .source-count, data-cluster-id, .cluster-meta > .item-time
    // Note: .item-source contains mixed content (text nodes + badge spans),
    //   so we extract only bare text nodes to get the clean source name.
    const newsClusters = Array.from(
      document.querySelectorAll('.item.clustered')
    )
      .slice(0, 15)
      .map(el => {
        const titleEl = el.querySelector('.item-title');
        const sourceEl = el.querySelector('.item-source');
        const countEl = el.querySelector('.source-count');
        const timeEl = el.querySelector('.item-time');
        const clusterId = (el as HTMLElement).dataset.clusterId ?? '';

        // Extract only bare text nodes from .item-source, skipping child
        // element text (tier badges, source-count, velocity, ALERT tag, etc.)
        let sourceName = '';
        if (sourceEl) {
          for (const node of sourceEl.childNodes) {
            if (node.nodeType === Node.TEXT_NODE) {
              const text = node.textContent?.trim();
              if (text) { sourceName = text; break; }
            }
          }
        }

        // Extract source count number from "N sources" text
        const countText = countEl?.textContent?.trim() ?? '';
        const countMatch = countText.match(/\d+/);
        return {
          id: clusterId || `cluster-${Math.random().toString(36).slice(2, 8)}`,
          title: titleEl?.textContent?.trim() ?? '',
          source: sourceName,
          sourceCount: countMatch ? parseInt(countMatch[0], 10) : 1,
          isAlert: el.classList.contains('alert'),
          lastUpdated: timeEl?.textContent?.trim() ?? '',
        };
      })
      .filter(c => c.title);

    // Market data — scrape from the DOM (read-only)
    // Actual structure: .market-item with .market-symbol (display ticker),
    //   .market-name (full name), .market-price, .market-change
    const markets = Array.from(
      document.querySelectorAll('.market-item')
    )
      .slice(0, 30)
      .map(el => {
        const symbolEl = el.querySelector('.market-symbol');
        const nameEl = el.querySelector('.market-name');
        const priceEl = el.querySelector('.market-price');
        const changeEl = el.querySelector('.market-change');
        // Use explicit NaN check so legitimate 0 values are preserved
        const rawPrice = parseFloat(priceEl?.textContent?.replace(/[^0-9.-]/g, '') ?? '');
        const rawChange = parseFloat(changeEl?.textContent?.replace(/[^0-9.%-]/g, '') ?? '');
        return {
          symbol: symbolEl?.textContent?.trim() ?? '',
          name: nameEl?.textContent?.trim() ?? '',
          display: symbolEl?.textContent?.trim() ?? '',
          price: Number.isNaN(rawPrice) ? null : rawPrice,
          change: Number.isNaN(rawChange) ? null : rawChange,
        };
      })
      .filter(m => m.symbol);

    window.parent.postMessage({
      type: 'hypermonitor:data-snapshot',
      payload: {
        ciiScores,
        alerts,
        newsClusters,
        markets,
        timestamp: new Date().toISOString(),
      },
    }, parentOrigin);
  }

  document.addEventListener('wm:intelligence-updated', buildAndForwardSnapshot);

  // Notify parent that the bridge is ready so it can (re-)send preferences
  window.parent.postMessage({ type: 'hypermonitor:ready' }, parentOrigin);
}

