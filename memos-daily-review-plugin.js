/**
 * Memos Daily Review Plugin（每日回顾）
 *
 * A single-file front-end script intended for Memos "Additional Script".
 * Adds a bottom-right "每日回顾" button (hidden on /auth) that opens a deck-style review dialog.
 *
 * Highlights:
 * - Single-card review with prev/next + counter and a settings tab
 * - Deterministic daily deck (stable within the same day/settings/batch)
 * - Low server load: memo pool cached with TTL; "换一批" regenerates locally
 * - Review bias: avoid recent repeats; prefer unseen/long-unseen/low-seen memos
 * - "Spark pair": try inserting two far-apart memos sharing a tag
 * - Lightweight Markdown rendering including nested lists; tags extracted to header
 * - Image preview overlay + optional edit-and-save (requires auth & permission)
 *
 * Install:
 * Paste into Settings -> System -> Additional Script
 */
(function DailyReviewPlugin() {
  'use strict';

  // ============================================
  // Configuration
  // ============================================
  const CONFIG = {
    STORAGE_KEY: 'memos-daily-review-settings',
    CACHE_KEY: 'memos-daily-review-cache',
    POOL_KEY: 'memos-daily-review-pool',
    HISTORY_KEY: 'memos-daily-review-history',
    AUTH_TOKEN_KEY: 'memos_access_token',
    AUTH_EXPIRES_KEY: 'memos_token_expires_at',
    DEFAULT_TIME_RANGE: '6months',
    DEFAULT_COUNT: 8,
    TIME_RANGES: [
      { value: 'all', label: '全部时间', days: null },
      { value: '1year', label: '1 年内', days: 365 },
      { value: '6months', label: '6 个月内', days: 180 },
      { value: '3months', label: '3 个月内', days: 90 },
      { value: '1month', label: '1 个月内', days: 30 }
    ],
    COUNT_OPTIONS: [4, 8, 12, 16, 20, 24],
    API_PAGE_SIZE: 1000,
    POOL_TTL_MS: 6 * 60 * 60 * 1000,
    POOL_MAX_PAGES_ALL: 2,
    NO_REPEAT_DAYS: 3,
    HISTORY_MAX_ITEMS: 5000,
    DECK_SCHEMA_VERSION: 3
  };

  // ============================================
  // Utility Functions
  // ============================================
  const utils = {
    // Get today's date string as seed
    getDailySeed() {
      const now = new Date();
      return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    },

    // Mulberry32 PRNG - generates deterministic random numbers from seed
    mulberry32(seed) {
      return function() {
        let t = seed += 0x6D2B79F5;
        t = Math.imul(t ^ t >>> 15, t | 1);
        t ^= t + Math.imul(t ^ t >>> 7, t | 61);
        return ((t ^ t >>> 14) >>> 0) / 4294967296;
      };
    },

    // Convert string to numeric seed
    stringToSeed(str) {
      let hash = 0;
      for (let i = 0; i < str.length; i++) {
        const char = str.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash;
      }
      return Math.abs(hash);
    },

    // Fisher-Yates shuffle with seeded random
    seededShuffle(array, seed) {
      const result = [...array];
      const random = this.mulberry32(seed);
      for (let i = result.length - 1; i > 0; i--) {
        const j = Math.floor(random() * (i + 1));
        [result[i], result[j]] = [result[j], result[i]];
      }
      return result;
    },

    // Format timestamp to readable date
    formatDate(timestamp) {
      const date = new Date(timestamp);
      return date.toLocaleDateString('zh-CN', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit'
      });
    },

    parseLocalDay(dayString) {
      return new Date(`${dayString}T00:00:00`);
    },

    diffDays(fromDayString, toDayString) {
      const from = this.parseLocalDay(fromDayString);
      const to = this.parseLocalDay(toDayString);
      const msPerDay = 24 * 60 * 60 * 1000;
      return Math.floor((to.getTime() - from.getTime()) / msPerDay);
    },

    getMemoId(memo) {
      return memo?.name || memo?.id || memo?.uid || '';
    },

    normalizeMemo(memo) {
      const id = this.getMemoId(memo);
      const attachments = Array.isArray(memo?.attachments)
        ? memo.attachments
            .filter((att) => att && typeof att === 'object')
            .map((att) => ({
              name: att.name,
              filename: att.filename,
              type: att.type,
              externalLink: att.externalLink
            }))
        : [];
      const content = memo?.content || '';
      return {
        id,
        name: memo?.name,
        uid: memo?.uid,
        createTime: memo?.createTime,
        content,
        tags: this.extractTags(content),
        attachments
      };
    },

    // Escape HTML to prevent XSS
    escapeHtml(text) {
      const div = document.createElement('div');
      div.textContent = text;
      return div.innerHTML;
    },

    sanitizeUrl(url) {
      const raw = (url || '').toString().trim();
      if (!raw) return null;

      // Allow in-page anchors
      if (raw.startsWith('#')) return raw;

      // Allow relative URLs (common for attachments)
      if (raw.startsWith('/') || raw.startsWith('./') || raw.startsWith('../')) return raw;

      try {
        const parsed = new URL(raw, window.location.origin);
        const protocol = (parsed.protocol || '').toLowerCase();
        if (protocol === 'http:' || protocol === 'https:') {
          return parsed.href;
        }
        if (protocol === 'mailto:') {
          return parsed.href;
        }
      } catch (e) {
        return null;
      }
      return null;
    },

    async fetchWithTimeout(url, options = {}, timeoutMs = 8000) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      try {
        return await fetch(url, { ...options, signal: controller.signal });
      } finally {
        clearTimeout(timeout);
      }
    },

    // Extract tags from content
    extractTags(content) {
      const tagRegex = /#([^\s#]+)/g;
      const tags = new Set();
      let match;
      while ((match = tagRegex.exec(content)) !== null) {
        tags.add(match[1]);
      }
      return Array.from(tags);
    },

    // Remove tags from content for display
    removeTagsFromContent(content) {
      const text = content || '';
      const lines = text.split(/\r?\n/);
      const cleaned = lines.map((line) => {
        const match = line.match(/^([ \t]*)(.*)$/) || [];
        const leading = (match[1] || '').replace(/\t/g, '  ');
        let rest = match[2] || '';
        rest = rest.replace(/#([^\s#]+)/g, '');
        rest = rest.replace(/[ \t]+/g, ' ');
        return `${leading}${rest}`;
      });
      return cleaned
        .join('\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    },

    formatInlineMarkdown(text) {
      let html = text;

      // Inline code
      html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

      // Bold
      html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
      html = html.replace(/__(.+?)__/g, '<strong>$1</strong>');

      // Italic
      html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
      html = html.replace(/_(.+?)_/g, '<em>$1</em>');

      // Strikethrough
      html = html.replace(/~~(.+?)~~/g, '<del>$1</del>');

      // Links
      html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (match, label, href) => {
        const safe = this.sanitizeUrl(href);
        if (!safe) {
          return `${label} (${href})`;
        }
        return `<a href="${safe}" target="_blank" rel="noopener noreferrer">${label}</a>`;
      });

      // Auto-link URLs
      html = html.replace(/(?<!href="|src=")https?:\/\/[^\s<]+/g, (url) => {
        const safe = this.sanitizeUrl(url);
        if (!safe) return url;
        return `<a href="${safe}" target="_blank" rel="noopener noreferrer">${url}</a>`;
      });

      return html;
    },

    // Simple markdown to HTML converter (headings, lists, paragraphs)
    markdownToHtml(text) {
      const escaped = this.escapeHtml(text || '');
      const lines = escaped.split(/\r?\n/);
      let paragraphLines = [];

      const container = document.createElement('div');
      const listStack = [];
      const lastLiByLevel = [];
      const indentWidthStack = [];
      let pendingBlankLineInList = false;

      const flushParagraph = () => {
        if (paragraphLines.length > 0) {
          const p = document.createElement('p');
          p.innerHTML = paragraphLines.join('<br>');
          container.appendChild(p);
          paragraphLines = [];
        }
      };

      const closeAllLists = () => {
        listStack.length = 0;
        lastLiByLevel.length = 0;
        indentWidthStack.length = 0;
        pendingBlankLineInList = false;
      };

      const getListDepthForIndent = (indentWidth) => {
        if (indentWidthStack.length === 0) {
          indentWidthStack.push(indentWidth);
          return 0;
        }

        const lastIndent = indentWidthStack[indentWidthStack.length - 1];
        if (indentWidth > lastIndent) {
          indentWidthStack.push(indentWidth);
          return indentWidthStack.length - 1;
        }

        while (indentWidthStack.length > 1 && indentWidth < indentWidthStack[indentWidthStack.length - 1]) {
          indentWidthStack.pop();
        }

        if (indentWidth > indentWidthStack[indentWidthStack.length - 1]) {
          indentWidthStack.push(indentWidth);
        } else if (indentWidthStack.length === 1 && indentWidth < indentWidthStack[0]) {
          // Adjust base indentation for top-level lists.
          indentWidthStack[0] = indentWidth;
        }

        return indentWidthStack.length - 1;
      };

      const ensureListForLevel = (listType, level) => {
        if (level < 0) level = 0;

        // Drop deeper levels if indentation decreased.
        while (listStack.length > level + 1) {
          listStack.pop();
          lastLiByLevel.pop();
        }

        // If list type changed at the same level, start a new list.
        if (listStack[level] && listStack[level].type !== listType) {
          listStack.length = level;
          lastLiByLevel.length = level;
        }

        // Create missing list levels.
        for (let current = listStack.length; current <= level; current++) {
          const listEl = document.createElement(listType);
          if (current === 0) {
            container.appendChild(listEl);
          } else {
            const parentLi = lastLiByLevel[current - 1];
            (parentLi || container).appendChild(listEl);
          }
          listStack.push({ type: listType, el: listEl });
        }
      };

      for (const line of lines) {
        const leadingMatch = line.match(/^[ \t]*/);
        const leading = ((leadingMatch && leadingMatch[0]) || '').replace(/\t/g, '  ');
        const indentWidth = leading.length;
        const trimmed = line.trim();

        if (!trimmed) {
          flushParagraph();
          if (listStack.length > 0) {
            pendingBlankLineInList = true;
          } else {
            closeAllLists();
          }
          continue;
        }

        const headingMatch = trimmed.match(/^(#{1,6})\s+(.*)$/);
        if (headingMatch) {
          const level = headingMatch[1].length;
          flushParagraph();
          closeAllLists();
          const h = document.createElement(`h${level}`);
          h.innerHTML = this.formatInlineMarkdown(headingMatch[2]);
          container.appendChild(h);
          continue;
        }

        const ulMatch = trimmed.match(/^[-*+]\s+(.*)$/);
        if (ulMatch) {
          flushParagraph();
          pendingBlankLineInList = false;
          const depth = getListDepthForIndent(indentWidth);
          ensureListForLevel('ul', depth);
          const li = document.createElement('li');
          li.innerHTML = this.formatInlineMarkdown(ulMatch[1]);
          listStack[depth].el.appendChild(li);
          lastLiByLevel[depth] = li;
          lastLiByLevel.length = depth + 1;
          continue;
        }

        const olMatch = trimmed.match(/^(\d+)[.)]\s+(.*)$/);
        if (olMatch) {
          flushParagraph();
          pendingBlankLineInList = false;
          const depth = getListDepthForIndent(indentWidth);
          ensureListForLevel('ol', depth);
          const li = document.createElement('li');
          li.innerHTML = this.formatInlineMarkdown(olMatch[2]);
          listStack[depth].el.appendChild(li);
          lastLiByLevel[depth] = li;
          lastLiByLevel.length = depth + 1;
          continue;
        }

        closeAllLists();
        paragraphLines.push(this.formatInlineMarkdown(trimmed));
      }

      flushParagraph();
      closeAllLists();
      return container.innerHTML;
    }
  };

  // ============================================
  // Settings Service
  // ============================================
  const settingsService = {
    load() {
      try {
        const saved = localStorage.getItem(CONFIG.STORAGE_KEY);
        if (saved) {
          return JSON.parse(saved);
        }
      } catch (e) {
        console.error('Failed to load daily review settings:', e);
      }
      return {
        timeRange: CONFIG.DEFAULT_TIME_RANGE,
        count: CONFIG.DEFAULT_COUNT
      };
    },

    save(settings) {
      try {
        localStorage.setItem(CONFIG.STORAGE_KEY, JSON.stringify(settings));
      } catch (e) {
        console.error('Failed to save daily review settings:', e);
      }
    }
  };

  // ============================================
  // Review History Service
  // ============================================
  const historyService = {
    load() {
      try {
        const saved = localStorage.getItem(CONFIG.HISTORY_KEY);
        if (!saved) return { schemaVersion: CONFIG.DECK_SCHEMA_VERSION, items: {} };
        const parsed = JSON.parse(saved);
        if (parsed && typeof parsed === 'object' && parsed.items && typeof parsed.items === 'object') {
          return { schemaVersion: CONFIG.DECK_SCHEMA_VERSION, items: parsed.items };
        }
      } catch (e) {
        console.error('Failed to load daily review history:', e);
      }
      return { schemaVersion: CONFIG.DECK_SCHEMA_VERSION, items: {} };
    },

    save(history) {
      try {
        localStorage.setItem(CONFIG.HISTORY_KEY, JSON.stringify(history));
      } catch (e) {
        console.error('Failed to save daily review history:', e);
      }
    },

    prune(history) {
      if (!history || !history.items || typeof history.items !== 'object') return history;
      const ids = Object.keys(history.items);
      if (ids.length <= CONFIG.HISTORY_MAX_ITEMS) return history;

      const entries = ids
        .map((id) => {
          const entry = history.items[id] || {};
          const day = typeof entry.lastShownDay === 'string' ? entry.lastShownDay : '';
          const dayTs = day ? utils.parseLocalDay(day).getTime() : 0;
          return { id, dayTs };
        })
        .sort((a, b) => a.dayTs - b.dayTs);

      const removeCount = entries.length - CONFIG.HISTORY_MAX_ITEMS;
      for (let i = 0; i < removeCount; i++) {
        delete history.items[entries[i].id];
      }
      return history;
    },

    getEntry(history, memoId) {
      return history.items[memoId];
    },

    getDaysSinceShown(history, memoId, today) {
      const entry = this.getEntry(history, memoId);
      if (!entry || !entry.lastShownDay) return Number.POSITIVE_INFINITY;
      return utils.diffDays(entry.lastShownDay, today);
    },

    markViewed(memoId, today) {
      if (!memoId) return;
      const history = this.load();
      const entry = history.items[memoId] || { lastShownDay: null, shownCount: 0 };
      entry.lastShownDay = today;
      entry.shownCount = (entry.shownCount || 0) + 1;
      history.items[memoId] = entry;
      this.prune(history);
      this.save(history);
    }
  };

  // ============================================
  // Pool Cache Service
  // ============================================
  const poolService = {
    load(timeRange) {
      try {
        const saved = localStorage.getItem(CONFIG.POOL_KEY);
        if (!saved) return null;
        const parsed = JSON.parse(saved);
        if (!parsed || typeof parsed !== 'object') return null;
        if (parsed.timeRange !== timeRange) return null;
        if (!Array.isArray(parsed.memos)) return null;
        if (typeof parsed.timestamp !== 'number') return null;
        if (Date.now() - parsed.timestamp > CONFIG.POOL_TTL_MS) return null;
        return parsed.memos;
      } catch (e) {
        console.error('Failed to load memo pool cache:', e);
      }
      return null;
    },

    save(timeRange, memos) {
      try {
        localStorage.setItem(
          CONFIG.POOL_KEY,
          JSON.stringify({ schemaVersion: CONFIG.DECK_SCHEMA_VERSION, timeRange, memos, timestamp: Date.now() })
        );
      } catch (e) {
        console.error('Failed to save memo pool cache:', e);
      }
    }
  };

  // ============================================
  // Deck Cache Service
  // ============================================
  const deckService = {
    makeKey(day, timeRange, count, batch) {
      return `${day}-${timeRange}-${count}-${batch}`;
    },

    loadStore() {
      try {
        const saved = localStorage.getItem(CONFIG.CACHE_KEY);
        if (!saved) return { schemaVersion: CONFIG.DECK_SCHEMA_VERSION, decks: {}, lastKey: '' };
        const parsed = JSON.parse(saved);

        // Backward compatible: older schema stored { key, memos, timestamp }.
        if (parsed && typeof parsed === 'object' && typeof parsed.key === 'string' && Array.isArray(parsed.memos)) {
          return {
            schemaVersion: CONFIG.DECK_SCHEMA_VERSION,
            decks: {
              [parsed.key]: {
                key: parsed.key,
                memos: parsed.memos,
                timestamp: typeof parsed.timestamp === 'number' ? parsed.timestamp : Date.now()
              }
            },
            lastKey: parsed.key
          };
        }

        if (parsed && typeof parsed === 'object' && parsed.decks && typeof parsed.decks === 'object') {
          return {
            schemaVersion: CONFIG.DECK_SCHEMA_VERSION,
            decks: parsed.decks,
            lastKey: typeof parsed.lastKey === 'string' ? parsed.lastKey : ''
          };
        }
      } catch (e) {
        console.error('Failed to load deck cache:', e);
      }
      return { schemaVersion: CONFIG.DECK_SCHEMA_VERSION, decks: {}, lastKey: '' };
    },

    saveStore(store) {
      try {
        localStorage.setItem(CONFIG.CACHE_KEY, JSON.stringify(store));
      } catch (e) {
        console.error('Failed to save deck cache:', e);
      }
    },

    getDeck(key) {
      const store = this.loadStore();
      const deck = store.decks[key];
      if (!deck || typeof deck !== 'object' || typeof deck.key !== 'string' || !Array.isArray(deck.memos)) return null;
      return deck;
    },

    saveDeck(deck) {
      const store = this.loadStore();
      store.decks = store.decks && typeof store.decks === 'object' ? store.decks : {};
      store.decks[deck.key] = deck;
      store.lastKey = deck.key;

      // Prune old decks to prevent unbounded growth.
      const entries = Object.values(store.decks).filter((d) => d && typeof d === 'object' && typeof d.key === 'string');
      entries.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
      const keep = new Set(entries.slice(0, 10).map((d) => d.key));
      for (const k of Object.keys(store.decks)) {
        if (!keep.has(k)) delete store.decks[k];
      }

      this.saveStore(store);
    },

    isValid(deck, expectedKey) {
      if (!deck || typeof deck.key !== 'string') return false;
      return deck.key === expectedKey && Array.isArray(deck.memos);
    }
  };

  // ============================================
  // API Service
  // ============================================
  const apiService = {
    async fetchMemos(timeRange, pageToken) {
      const timeRangeConfig = CONFIG.TIME_RANGES.find(t => t.value === timeRange);
      let filter = '';

      if (timeRangeConfig && timeRangeConfig.days !== null) {
        const now = Math.floor(Date.now() / 1000);
        const startTime = now - (timeRangeConfig.days * 24 * 60 * 60);
        filter = `created_ts >= ${startTime}`;
      }

      const params = new URLSearchParams({
        pageSize: String(CONFIG.API_PAGE_SIZE)
      });

      if (filter) {
        params.append('filter', filter);
      }
      if (pageToken) {
        params.append('pageToken', pageToken);
      }

      try {
        const doFetch = async () => {
          const headers = { 'Accept': 'application/json', ...authService.getAuthHeaders() };
          return await utils.fetchWithTimeout(
            `/api/v1/memos?${params.toString()}`,
            { method: 'GET', headers, credentials: 'include' },
            8000
          );
        };

        let response = await doFetch();
        if (response.status === 401) {
          await authService.ensureAccessToken();
          response = await doFetch();
        }
        if (!response.ok) {
          throw new Error(`API error: ${response.status}`);
        }
        const data = await response.json();
        return { memos: data.memos || [], nextPageToken: data.nextPageToken || data.next_page_token || '' };
      } catch (e) {
        console.error('Failed to fetch memos:', e);
        throw e;
      }
    },

    async updateMemoContent(memoName, content) {
      if (!memoName) throw new Error('missing memo name');
      const urlBase = `/api/v1/${memoName}`;
      const body = JSON.stringify({ name: memoName, content });
      let refreshed = false;

      const candidates = [
        `${urlBase}?updateMask.paths=content&updateMask.paths=update_time`,
        `${urlBase}?update_mask.paths=content&update_mask.paths=update_time`
      ];

      let lastError = null;
      for (const url of candidates) {
        try {
          let headers = { 'Content-Type': 'application/json', 'Accept': 'application/json', ...authService.getAuthHeaders() };
          let response = await utils.fetchWithTimeout(url, { method: 'PATCH', headers, body, credentials: 'include' }, 8000);
          if (response.status === 401 && !refreshed) {
            refreshed = true;
            await authService.ensureAccessToken();
            headers = { 'Content-Type': 'application/json', 'Accept': 'application/json', ...authService.getAuthHeaders() };
            response = await utils.fetchWithTimeout(url, { method: 'PATCH', headers, body, credentials: 'include' }, 8000);
          }
          if (response.ok) {
            return await response.json();
          }
          const text = await response.text();
          lastError = new Error(`API error: ${response.status} ${text}`);
        } catch (e) {
          lastError = e;
        }
      }
      throw lastError || new Error('Failed to update memo');
    }
  };

  // ============================================
  // Auth Service
  // ============================================
  const authService = {
    refreshPromise: null,

    getAccessToken() {
      const readToken = (storage) => {
        try {
          return storage.getItem(CONFIG.AUTH_TOKEN_KEY);
        } catch {
          return null;
        }
      };
      return readToken(sessionStorage) || readToken(localStorage) || null;
    },

    writeAccessToken(token, expiresAt) {
      try {
        if (token) {
          sessionStorage.setItem(CONFIG.AUTH_TOKEN_KEY, token);
          if (expiresAt) {
            sessionStorage.setItem(CONFIG.AUTH_EXPIRES_KEY, expiresAt.toISOString());
          }
          return;
        }
        sessionStorage.removeItem(CONFIG.AUTH_TOKEN_KEY);
        sessionStorage.removeItem(CONFIG.AUTH_EXPIRES_KEY);
      } catch (e) {
        // ignore storage errors
      }
    },

    parseExpiresAt(value) {
      if (!value) return null;
      if (typeof value === 'string') {
        const d = new Date(value);
        return Number.isNaN(d.getTime()) ? null : d;
      }
      if (typeof value === 'object') {
        // Handle protobuf Timestamp-like JSON (seconds/nanos).
        if (typeof value.seconds === 'number') {
          return new Date(value.seconds * 1000);
        }
        if (typeof value.seconds === 'string') {
          const seconds = parseInt(value.seconds, 10);
          if (!Number.isNaN(seconds)) return new Date(seconds * 1000);
        }
      }
      return null;
    },

    async refreshAccessTokenViaConnect() {
      try {
        const response = await utils.fetchWithTimeout(
          '/memos.api.v1.AuthService/RefreshToken',
          {
            method: 'POST',
            credentials: 'include',
            headers: {
              'Accept': 'application/json',
              'Content-Type': 'application/json',
              'Connect-Protocol-Version': '1'
            },
            body: '{}'
          },
          8000
        );
        if (!response.ok) return null;
        const data = await response.json();
        const message = data && data.message ? data.message : data;
        const token = message?.accessToken || message?.access_token || null;
        const expiresAt = this.parseExpiresAt(message?.expiresAt || message?.expires_at);
        this.writeAccessToken(token, expiresAt);
        return token;
      } catch (e) {
        return null;
      }
    },

    async ensureAccessToken() {
      const token = this.getAccessToken();
      if (token) return token;
      if (this.refreshPromise) return await this.refreshPromise;
      this.refreshPromise = this.refreshAccessTokenViaConnect().finally(() => {
        this.refreshPromise = null;
      });
      return await this.refreshPromise;
    },

    getAuthHeaders() {
      const token = this.getAccessToken();
      if (!token) return {};
      return { 'Authorization': `Bearer ${token}` };
    },

    async getCurrentUser() {
      const token = this.getAccessToken();
      if (!token) return null;
      const response = await utils.fetchWithTimeout(
        '/api/v1/auth/me',
        {
          method: 'GET',
          cache: 'no-store',
          credentials: 'include',
          headers: { 'Accept': 'application/json', ...this.getAuthHeaders() }
        },
        5000
      );
      if (!response.ok) return null;
      const data = await response.json();
      return data && data.user ? data.user : null;
    },

    async isAuthenticated() {
      try {
        const user = await this.getCurrentUser();
        return !!user;
      } catch (e) {
        return false;
      }
    }
  };

  // ============================================
  // UI Components
  // ============================================
  const ui = {
    styleId: 'daily-review-styles',
    buttonId: 'daily-review-button',
    dialogId: 'daily-review-dialog',
    overlayId: 'daily-review-overlay',
    panelReviewId: 'daily-review-panel-review',
    panelSettingsId: 'daily-review-panel-settings',
    stateId: 'daily-review-state',
    deckId: 'daily-review-deck',
    cardId: 'daily-review-card',
    prevId: 'daily-review-prev',
    nextId: 'daily-review-next',
    counterId: 'daily-review-counter',
    refreshId: 'daily-review-refresh',
    editId: 'daily-review-edit',
    editOverlayId: 'daily-review-edit-overlay',
    editDialogId: 'daily-review-edit-dialog',
    editTextareaId: 'daily-review-edit-textarea',
    editSaveId: 'daily-review-edit-save',
    editCancelId: 'daily-review-edit-cancel',
    editStatusId: 'daily-review-edit-status',
    imageOverlayId: 'daily-review-image-overlay',
    imageDialogId: 'daily-review-image-dialog',
    imageCloseId: 'daily-review-image-close',
    imagePrevId: 'daily-review-image-prev',
    imageNextId: 'daily-review-image-next',
    imageCaptionId: 'daily-review-image-caption',
    imagePreviewId: 'daily-review-image-preview',
    imageGroups: {},
    activeImageKey: null,
    activeImageIndex: 0,
    isButtonVisible: false,

    injectStyles() {
      if (document.getElementById(this.styleId)) return;

      const styles = document.createElement('style');
      styles.id = this.styleId;
      styles.textContent = `
        #${this.buttonId} {
          position: fixed;
          bottom: 24px;
          right: 24px;
          z-index: 40;
          height: 40px;
          padding: 0 12px;
          border-radius: 999px;
          background-color: var(--primary);
          color: var(--primary-foreground);
          border: none;
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: center;
          box-shadow: var(--shadow-lg);
          transition: transform 0.2s, opacity 0.2s;
          font-size: 14px;
          font-weight: 600;
        }
        #${this.buttonId}:hover {
          transform: scale(1.05);
          opacity: 0.9;
        }

        #${this.overlayId} {
          position: fixed;
          inset: 0;
          z-index: 50;
          background-color: rgba(0, 0, 0, 0.5);
          opacity: 0;
          pointer-events: none;
          transition: opacity 0.2s;
        }
        #${this.overlayId}.visible {
          opacity: 1;
          pointer-events: auto;
        }

        #${this.dialogId} {
          position: fixed;
          top: 50%;
          left: 50%;
          transform: translate(-50%, -50%) scale(0.95);
          z-index: 51;
          width: calc(100% - 2rem);
          max-width: 640px;
          height: min(760px, calc(100vh - 4rem));
          background-color: var(--background);
          border: 1px solid var(--border);
          border-radius: var(--radius);
          box-shadow: var(--shadow-lg);
          display: flex;
          flex-direction: column;
          opacity: 0;
          pointer-events: none;
          transition: opacity 0.2s, transform 0.2s;
          overflow: hidden;
        }
        #${this.dialogId}.visible {
          opacity: 1;
          pointer-events: auto;
          transform: translate(-50%, -50%) scale(1);
        }

        .daily-review-header {
          padding: 16px 20px;
          border-bottom: 1px solid var(--border);
          display: flex;
          align-items: center;
          justify-content: space-between;
          flex-shrink: 0;
        }
        .daily-review-title {
          font-size: 18px;
          font-weight: 600;
          color: var(--foreground);
          margin: 0;
        }
        .daily-review-close {
          background: none;
          border: none;
          cursor: pointer;
          padding: 4px;
          color: var(--muted-foreground);
          border-radius: 4px;
          display: flex;
          align-items: center;
          justify-content: center;
        }
        .daily-review-close:hover {
          background-color: var(--accent);
          color: var(--foreground);
        }

        .daily-review-tabs {
          padding: 10px 20px 6px;
          border-bottom: 1px solid var(--border);
          display: flex;
          gap: 18px;
          flex-shrink: 0;
        }
        .daily-review-tab {
          background: none;
          border: none;
          padding: 6px 2px 10px;
          cursor: pointer;
          color: var(--muted-foreground);
          font-size: 14px;
          position: relative;
        }
        .daily-review-tab:hover {
          color: var(--foreground);
        }
        .daily-review-tab.active {
          color: var(--foreground);
          font-weight: 600;
        }
        .daily-review-tab.active::after {
          content: '';
          position: absolute;
          left: 0;
          right: 0;
          bottom: 0;
          height: 2px;
          background-color: var(--primary);
          border-radius: 2px;
        }

        .daily-review-body {
          flex: 1;
          overflow: hidden;
          display: flex;
          flex-direction: column;
          min-height: 0;
        }

        .daily-review-panel {
          flex: 1;
          overflow: hidden;
          display: flex;
          flex-direction: column;
          min-height: 0;
        }
        .daily-review-panel.hidden {
          display: none;
        }

        .daily-review-state {
          flex: 1;
          display: none;
          align-items: center;
          justify-content: center;
          flex-direction: column;
          padding: 20px;
          gap: 10px;
          color: var(--muted-foreground);
          font-size: 14px;
        }
        .daily-review-state.visible {
          display: flex;
        }

        .daily-review-deck {
          flex: 1;
          margin: 16px 20px;
          padding: 18px;
          border-radius: 14px;
          background-color: var(--muted);
          border: 1px solid var(--border);
          overflow: hidden;
          display: flex;
          flex-direction: column;
          gap: 14px;
          min-height: 0;
        }
        .daily-review-deck.hidden {
          display: none;
        }
        .daily-review-card-stack {
          flex: 1;
          position: relative;
          display: flex;
          align-items: center;
          justify-content: center;
          overflow: hidden;
          min-height: 0;
        }
        .daily-review-card {
          width: 100%;
          max-width: 560px;
          height: 100%;
          background-color: var(--card);
          border: 1px solid var(--border);
          border-radius: 12px;
          box-shadow: 0 10px 26px rgba(0, 0, 0, 0.12);
        }
        .daily-review-card-back {
          position: absolute;
          top: 50%;
          left: 50%;
          width: 100%;
          max-width: 560px;
          height: 100%;
          transform: translate(-50%, -50%);
          pointer-events: none;
          opacity: 0.55;
          filter: saturate(0.9);
        }
        .daily-review-card-back.back-1 {
          transform: translate(-50%, -50%) translateY(10px) scale(0.985);
          opacity: 0.5;
        }
        .daily-review-card-back.back-2 {
          transform: translate(-50%, -50%) translateY(18px) scale(0.97);
          opacity: 0.4;
        }
        .daily-review-card-front {
          position: relative;
          z-index: 3;
          padding: 16px 16px 14px;
          overflow-y: auto;
          height: 100%;
          scrollbar-gutter: stable;
        }

        .daily-review-deck-footer {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
          flex-shrink: 0;
        }
        .daily-review-actions {
          display: flex;
          align-items: center;
          gap: 10px;
        }
        .daily-review-pager {
          display: flex;
          align-items: center;
          gap: 10px;
        }
        .daily-review-counter {
          font-size: 13px;
          color: var(--muted-foreground);
          min-width: 64px;
          text-align: center;
        }
        .daily-review-icon-btn {
          width: 40px;
          height: 40px;
          border-radius: 999px;
          border: 1px solid var(--border);
          background-color: var(--background);
          color: var(--foreground);
          display: inline-flex;
          align-items: center;
          justify-content: center;
          cursor: pointer;
          transition: background-color 0.2s, transform 0.15s;
        }
        .daily-review-icon-btn:hover {
          background-color: var(--accent);
        }
        .daily-review-icon-btn:active {
          transform: scale(0.98);
        }
        .daily-review-icon-btn:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }

        #${this.editOverlayId} {
          position: fixed;
          inset: 0;
          z-index: 55;
          background-color: rgba(0, 0, 0, 0.55);
          opacity: 0;
          pointer-events: none;
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 16px;
          transition: opacity 0.2s;
        }
        #${this.editOverlayId}.visible {
          opacity: 1;
          pointer-events: auto;
        }
        #${this.editDialogId} {
          width: min(720px, calc(100% - 2rem));
          max-height: calc(100vh - 4rem);
          background-color: var(--background);
          border: 1px solid var(--border);
          border-radius: var(--radius);
          box-shadow: var(--shadow-lg);
          display: flex;
          flex-direction: column;
          overflow: hidden;
        }
        .daily-review-edit-header {
          padding: 12px 16px;
          border-bottom: 1px solid var(--border);
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
        }
        .daily-review-edit-title {
          font-size: 14px;
          font-weight: 600;
          color: var(--foreground);
        }
        .daily-review-edit-status {
          font-size: 12px;
          color: var(--muted-foreground);
          text-align: right;
          flex: 1;
        }
        .daily-review-edit-textarea {
          width: 100%;
          flex: 1;
          min-height: 220px;
          resize: none;
          border: none;
          outline: none;
          padding: 14px 16px;
          background-color: var(--background);
          color: var(--foreground);
          font-size: 14px;
          line-height: 1.6;
          font-family: var(--font-mono);
        }
        .daily-review-edit-footer {
          padding: 12px 16px;
          border-top: 1px solid var(--border);
          display: flex;
          align-items: center;
          justify-content: flex-end;
          gap: 10px;
        }

        .daily-review-settings {
          padding: 16px 20px;
          display: flex;
          gap: 16px;
          flex-wrap: wrap;
          align-items: center;
          flex-shrink: 0;
        }
        .daily-review-settings-hint {
          padding: 0 20px 16px;
          color: var(--muted-foreground);
          font-size: 13px;
          line-height: 1.5;
        }
        .daily-review-setting-group {
          display: flex;
          align-items: center;
          gap: 8px;
        }
        .daily-review-setting-label {
          font-size: 14px;
          color: var(--muted-foreground);
        }
        .daily-review-select {
          padding: 6px 10px;
          border: 1px solid var(--border);
          border-radius: 6px;
          background-color: var(--background);
          color: var(--foreground);
          font-size: 14px;
          cursor: pointer;
        }
        .daily-review-select:focus {
          outline: 2px solid var(--ring);
          outline-offset: 2px;
        }

        .daily-review-memo {
          padding: 14px 16px;
          background-color: var(--card);
          border: 1px solid var(--border);
          border-radius: 8px;
          transition: box-shadow 0.2s;
        }
        .daily-review-memo:hover {
          box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
        }
        .daily-review-memo-date {
          font-size: 12px;
          color: var(--muted-foreground);
          margin-bottom: 10px;
        }
        .daily-review-memo-content {
          font-size: 14px;
          line-height: 1.6;
          color: var(--foreground);
          word-break: break-word;
          margin-bottom: 10px;
        }
        .daily-review-memo-content p {
          margin: 0 0 0.5em;
        }
        .daily-review-memo-content p:last-child {
          margin-bottom: 0;
        }
        .daily-review-memo-content ul,
        .daily-review-memo-content ol {
          list-style-position: outside;
          margin: 0.3em 0 0.6em 1.2em;
          padding-left: 1.1em;
        }
        .daily-review-memo-content ul {
          list-style-type: disc;
        }
        .daily-review-memo-content ol {
          list-style-type: decimal;
        }
        .daily-review-memo-content li {
          display: list-item;
          margin: 0.2em 0;
        }
        .daily-review-memo-content ul:last-child,
        .daily-review-memo-content ol:last-child {
          margin-bottom: 0;
        }
        .daily-review-memo-content h1,
        .daily-review-memo-content h2,
        .daily-review-memo-content h3,
        .daily-review-memo-content h4,
        .daily-review-memo-content h5,
        .daily-review-memo-content h6 {
          margin: 0.6em 0 0.35em;
          font-weight: 600;
        }
        .daily-review-memo-content a {
          color: var(--primary);
          text-decoration: underline;
        }
        .daily-review-memo-content code {
          background-color: var(--muted);
          padding: 2px 6px;
          border-radius: 4px;
          font-family: var(--font-mono);
          font-size: 13px;
        }
        .daily-review-memo-content strong {
          font-weight: 600;
        }
        .daily-review-memo-content em {
          font-style: italic;
        }
        .daily-review-memo-content del {
          text-decoration: line-through;
          opacity: 0.7;
        }
        .daily-review-memo-tags {
          display: flex;
          flex-wrap: wrap;
          gap: 6px;
          margin-bottom: 10px;
        }
        .daily-review-memo-tag {
          display: inline-flex;
          align-items: center;
          padding: 2px 8px;
          background-color: var(--primary);
          color: var(--primary-foreground);
          border-radius: 4px;
          font-size: 12px;
          font-weight: 500;
        }
        .daily-review-memo-images {
          display: grid;
          gap: 8px;
          margin-top: 10px;
        }
        .daily-review-memo-image-link {
          display: block;
          border-radius: 6px;
          overflow: hidden;
          background-color: var(--muted);
        }
        .daily-review-memo-images.grid-1 {
          grid-template-columns: 1fr;
        }
        .daily-review-memo-images.grid-2 {
          grid-template-columns: repeat(2, 1fr);
        }
        .daily-review-memo-images.grid-3 {
          grid-template-columns: repeat(3, 1fr);
        }
        .daily-review-memo-image {
          width: 100%;
          height: 140px;
          object-fit: contain;
          object-position: center;
          display: block;
          transition: box-shadow 0.2s ease;
        }
        .daily-review-memo-images.grid-1 .daily-review-memo-image {
          height: 220px;
        }
        .daily-review-memo-images.grid-2 .daily-review-memo-image {
          height: 160px;
        }
        .daily-review-memo-image-link:hover {
          box-shadow: 0 6px 16px rgba(0, 0, 0, 0.18);
        }

        #${this.imageOverlayId} {
          position: fixed;
          inset: 0;
          z-index: 60;
          background-color: rgba(0, 0, 0, 0.7);
          opacity: 0;
          pointer-events: none;
          display: flex;
          align-items: center;
          justify-content: center;
          transition: opacity 0.2s;
        }
        #${this.imageOverlayId}.visible {
          opacity: 1;
          pointer-events: auto;
        }
        #${this.imageDialogId} {
          position: relative;
          max-width: 92vw;
          max-height: 86vh;
          background-color: var(--background);
          border-radius: 10px;
          padding: 12px;
          box-shadow: var(--shadow-lg);
        }
        #${this.imagePreviewId} {
          max-width: 88vw;
          max-height: 78vh;
          display: block;
          border-radius: 8px;
          background-color: var(--muted);
        }
        #${this.imageCaptionId} {
          margin-top: 8px;
          text-align: center;
          font-size: 12px;
          color: var(--muted-foreground);
        }
        .daily-review-image-nav {
          position: absolute;
          top: 50%;
          transform: translateY(-50%);
          width: 36px;
          height: 36px;
          border-radius: 50%;
          border: none;
          background: rgba(0, 0, 0, 0.45);
          color: #fff;
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: center;
          transition: opacity 0.2s;
        }
        .daily-review-image-nav:disabled {
          opacity: 0.35;
          cursor: default;
        }
        #${this.imagePrevId} {
          left: 10px;
        }
        #${this.imageNextId} {
          right: 10px;
        }
        #${this.imageCloseId} {
          position: absolute;
          top: 10px;
          right: 10px;
          width: 30px;
          height: 30px;
          border-radius: 50%;
          border: none;
          background: rgba(0, 0, 0, 0.45);
          color: #fff;
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: center;
        }

        .daily-review-empty {
          text-align: center;
          padding: 40px 20px;
          color: var(--muted-foreground);
        }
        .daily-review-empty-icon {
          font-size: 48px;
          margin-bottom: 12px;
        }

        .daily-review-loading {
          text-align: center;
          padding: 40px 20px;
          color: var(--muted-foreground);
        }
        .daily-review-loading-spinner {
          width: 32px;
          height: 32px;
          border: 3px solid var(--border);
          border-top-color: var(--primary);
          border-radius: 50%;
          animation: daily-review-spin 0.8s linear infinite;
          margin: 0 auto 12px;
        }
        @keyframes daily-review-spin {
          to { transform: rotate(360deg); }
        }

        .daily-review-error {
          text-align: center;
          padding: 40px 20px;
          color: var(--destructive);
        }

        .daily-review-footer {
          padding: 12px 20px;
          border-top: 1px solid var(--border);
          display: flex;
          justify-content: flex-end;
          gap: 8px;
          flex-shrink: 0;
        }
        .daily-review-btn {
          padding: 8px 16px;
          border-radius: 6px;
          font-size: 14px;
          cursor: pointer;
          display: flex;
          align-items: center;
          gap: 6px;
          transition: background-color 0.2s, opacity 0.2s;
        }
        .daily-review-btn-secondary {
          background-color: var(--secondary);
          color: var(--secondary-foreground);
          border: 1px solid var(--border);
        }
        .daily-review-btn-secondary:hover {
          background-color: var(--accent);
        }
        .daily-review-btn-primary {
          background-color: var(--primary);
          color: var(--primary-foreground);
          border: none;
        }
        .daily-review-btn-primary:hover {
          opacity: 0.9;
        }
      `;
      document.head.appendChild(styles);
    },

    createFloatingButton() {
      if (document.getElementById(this.buttonId)) return;

      const button = document.createElement('button');
      button.id = this.buttonId;
      button.title = '每日回顾';
      button.textContent = '每日回顾';
      button.style.display = 'none';
      button.addEventListener('click', () => controller.openDialog());
      document.body.appendChild(button);
    },

    isAuthRoute() {
      const path = window.location.pathname || '';
      return path === '/auth' || path.startsWith('/auth/');
    },

    showFloatingButton() {
      const button = document.getElementById(this.buttonId);
      if (!button) return;
      if (this.isButtonVisible) return;
      button.style.display = '';
      this.isButtonVisible = true;
    },

    hideFloatingButton() {
      const button = document.getElementById(this.buttonId);
      if (!button) return;
      if (!this.isButtonVisible) return;
      button.style.display = 'none';
      this.isButtonVisible = false;
    },

    createDialog() {
      if (document.getElementById(this.dialogId)) return;

      // Create overlay
      const overlay = document.createElement('div');
      overlay.id = this.overlayId;
      overlay.addEventListener('click', () => controller.closeDialog());

      // Create dialog
      const dialog = document.createElement('div');
      dialog.id = this.dialogId;
      dialog.innerHTML = `
        <div class="daily-review-header">
          <h2 class="daily-review-title">每日回顾</h2>
          <button class="daily-review-close" title="关闭">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <line x1="18" y1="6" x2="6" y2="18"></line>
              <line x1="6" y1="6" x2="18" y2="18"></line>
            </svg>
          </button>
        </div>
        <div class="daily-review-tabs">
          <button class="daily-review-tab active" data-tab="review">每日回顾</button>
          <button class="daily-review-tab" data-tab="settings">回顾设置</button>
        </div>
        <div class="daily-review-body">
          <div class="daily-review-panel" id="${this.panelReviewId}">
            <div class="daily-review-state" id="${this.stateId}"></div>
            <div class="daily-review-deck" id="${this.deckId}">
              <div class="daily-review-card-stack">
                <div class="daily-review-card daily-review-card-back back-2" aria-hidden="true"></div>
                <div class="daily-review-card daily-review-card-back back-1" aria-hidden="true"></div>
                <div class="daily-review-card daily-review-card-front" id="${this.cardId}"></div>
              </div>
              <div class="daily-review-deck-footer">
                <div class="daily-review-actions">
                  <button class="daily-review-icon-btn" id="${this.refreshId}" title="换一批">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                      <path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"></path>
                      <path d="M21 3v5h-5"></path>
                    </svg>
                  </button>
                  <button class="daily-review-icon-btn" id="${this.editId}" title="编辑当前 Memo">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                      <path d="M12 20h9"></path>
                      <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"></path>
                    </svg>
                  </button>
                </div>
                <div class="daily-review-pager">
                  <button class="daily-review-icon-btn" id="${this.prevId}" title="上一张">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <path d="M15 18l-6-6 6-6"></path>
                    </svg>
                  </button>
                  <div class="daily-review-counter" id="${this.counterId}">0 / 0</div>
                  <button class="daily-review-icon-btn" id="${this.nextId}" title="下一张">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <path d="M9 18l6-6-6-6"></path>
                    </svg>
                  </button>
                </div>
              </div>
            </div>
          </div>
          <div class="daily-review-panel hidden" id="${this.panelSettingsId}">
            <div class="daily-review-settings">
              <div class="daily-review-setting-group">
                <label class="daily-review-setting-label">时间范围</label>
                <select class="daily-review-select" id="daily-review-time-range">
                  ${CONFIG.TIME_RANGES.map(t => `<option value="${t.value}">${t.label}</option>`).join('')}
                </select>
              </div>
              <div class="daily-review-setting-group">
                <label class="daily-review-setting-label">每日张数</label>
                <select class="daily-review-select" id="daily-review-count">
                  ${CONFIG.COUNT_OPTIONS.map(c => `<option value="${c}">${c} 张</option>`).join('')}
                </select>
              </div>
            </div>
            <div class="daily-review-settings-hint">
              默认打开为“单张翻阅”模式：上一张/下一张在本地切换，不会额外请求服务器；“换一批”只会重新抽取，不会重新拉取数据。
            </div>
          </div>
        </div>
        <div class="daily-review-footer">
          <button class="daily-review-btn daily-review-btn-primary" id="daily-review-close-btn">关闭</button>
        </div>
      `;

      // Prevent dialog clicks from closing
      dialog.addEventListener('click', (e) => e.stopPropagation());

      // Bind events
      dialog.querySelector('.daily-review-close').addEventListener('click', () => controller.closeDialog());
      dialog.querySelector('#daily-review-close-btn').addEventListener('click', () => controller.closeDialog());
      dialog.querySelector(`#${this.refreshId}`).addEventListener('click', () => controller.newBatch());
      dialog.querySelector(`#${this.editId}`).addEventListener('click', () => controller.editCurrent());
      dialog.querySelector(`#${this.prevId}`).addEventListener('click', () => controller.prev());
      dialog.querySelector(`#${this.nextId}`).addEventListener('click', () => controller.next());

      dialog.querySelectorAll('.daily-review-tab').forEach((tab) => {
        tab.addEventListener('click', () => {
          this.switchTab(tab.dataset.tab);
        });
      });

      dialog.querySelector('#daily-review-time-range').addEventListener('change', (e) => {
        const settings = settingsService.load();
        settings.timeRange = e.target.value;
        settingsService.save(settings);
        controller.onSettingsChanged();
      });
      dialog.querySelector('#daily-review-count').addEventListener('change', (e) => {
        const settings = settingsService.load();
        settings.count = parseInt(e.target.value, 10);
        settingsService.save(settings);
        controller.onSettingsChanged();
      });

      document.body.appendChild(overlay);
      document.body.appendChild(dialog);
    },

    createEditDialog() {
      if (document.getElementById(this.editOverlayId)) return;

      const overlay = document.createElement('div');
      overlay.id = this.editOverlayId;
      overlay.addEventListener('click', () => controller.closeEditor());

      const dialog = document.createElement('div');
      dialog.id = this.editDialogId;
      dialog.innerHTML = `
        <div class="daily-review-edit-header">
          <div class="daily-review-edit-title">编辑 Memo</div>
          <div class="daily-review-edit-status" id="${this.editStatusId}"></div>
          <button class="daily-review-close" title="关闭">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <line x1="18" y1="6" x2="6" y2="18"></line>
              <line x1="6" y1="6" x2="18" y2="18"></line>
            </svg>
          </button>
        </div>
        <textarea class="daily-review-edit-textarea" id="${this.editTextareaId}" spellcheck="false"></textarea>
        <div class="daily-review-edit-footer">
          <button class="daily-review-btn daily-review-btn-secondary" id="${this.editCancelId}">取消</button>
          <button class="daily-review-btn daily-review-btn-primary" id="${this.editSaveId}">保存</button>
        </div>
      `;

      dialog.addEventListener('click', (e) => e.stopPropagation());
      overlay.appendChild(dialog);
      document.body.appendChild(overlay);

      dialog.querySelector('.daily-review-close').addEventListener('click', () => controller.closeEditor());
      document.getElementById(this.editCancelId).addEventListener('click', () => controller.closeEditor());
      document.getElementById(this.editSaveId).addEventListener('click', () => controller.saveEditor());
    },

    openEditor(content) {
      const overlay = document.getElementById(this.editOverlayId);
      const textarea = document.getElementById(this.editTextareaId);
      if (!overlay || !textarea) return;
      textarea.value = content || '';
      this.setEditStatus('');
      overlay.classList.add('visible');
      requestAnimationFrame(() => textarea.focus());
    },

    closeEditor() {
      const overlay = document.getElementById(this.editOverlayId);
      if (!overlay) return;
      overlay.classList.remove('visible');
      this.setEditStatus('');
    },

    getEditorValue() {
      const textarea = document.getElementById(this.editTextareaId);
      return textarea ? textarea.value : '';
    },

    setEditStatus(message) {
      const status = document.getElementById(this.editStatusId);
      if (status) status.textContent = message || '';
    },

    setEditorSaving(isSaving) {
      const textarea = document.getElementById(this.editTextareaId);
      const save = document.getElementById(this.editSaveId);
      const cancel = document.getElementById(this.editCancelId);
      if (textarea) textarea.disabled = !!isSaving;
      if (save) save.disabled = !!isSaving;
      if (cancel) cancel.disabled = !!isSaving;
    },

    switchTab(tabName) {
      const dialog = document.getElementById(this.dialogId);
      if (!dialog) return;
      const tabs = dialog.querySelectorAll('.daily-review-tab');
      tabs.forEach((t) => t.classList.toggle('active', t.dataset.tab === tabName));
      const reviewPanel = document.getElementById(this.panelReviewId);
      const settingsPanel = document.getElementById(this.panelSettingsId);
      if (reviewPanel && settingsPanel) {
        reviewPanel.classList.toggle('hidden', tabName !== 'review');
        settingsPanel.classList.toggle('hidden', tabName !== 'settings');
      }
    },

    createImagePreview() {
      if (document.getElementById(this.imageOverlayId)) return;

      const overlay = document.createElement('div');
      overlay.id = this.imageOverlayId;
      overlay.addEventListener('click', () => this.closeImagePreview());

      const dialog = document.createElement('div');
      dialog.id = this.imageDialogId;
      dialog.innerHTML = `
        <img id="${this.imagePreviewId}" alt="">
        <div id="${this.imageCaptionId}"></div>
        <button class="daily-review-image-nav" id="${this.imagePrevId}" title="上一张">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M15 18l-6-6 6-6"></path>
          </svg>
        </button>
        <button class="daily-review-image-nav" id="${this.imageNextId}" title="下一张">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M9 18l6-6-6-6"></path>
          </svg>
        </button>
        <button id="${this.imageCloseId}" title="关闭">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="18" y1="6" x2="6" y2="18"></line>
            <line x1="6" y1="6" x2="18" y2="18"></line>
          </svg>
        </button>
      `;

      dialog.addEventListener('click', (event) => event.stopPropagation());
      overlay.appendChild(dialog);
      document.body.appendChild(overlay);

      document.getElementById(this.imagePrevId).addEventListener('click', (event) => {
        event.stopPropagation();
        this.navigateImage(-1);
      });
      document.getElementById(this.imageNextId).addEventListener('click', (event) => {
        event.stopPropagation();
        this.navigateImage(1);
      });
      document.getElementById(this.imageCloseId).addEventListener('click', (event) => {
        event.stopPropagation();
        this.closeImagePreview();
      });
    },

    showDialog() {
      const overlay = document.getElementById(this.overlayId);
      const dialog = document.getElementById(this.dialogId);
      if (overlay && dialog) {
        // Set initial settings values
        const settings = settingsService.load();
        dialog.querySelector('#daily-review-time-range').value = settings.timeRange;
        dialog.querySelector('#daily-review-count').value = settings.count;
        this.switchTab('review');

        // Show with animation
        requestAnimationFrame(() => {
          overlay.classList.add('visible');
          dialog.classList.add('visible');
        });
      }
    },

    hideDialog() {
      const overlay = document.getElementById(this.overlayId);
      const dialog = document.getElementById(this.dialogId);
      if (overlay && dialog) {
        overlay.classList.remove('visible');
        dialog.classList.remove('visible');
      }
    },

    setReviewState(type, message) {
      const state = document.getElementById(this.stateId);
      const deck = document.getElementById(this.deckId);
      if (!state || !deck) return;

      if (!type) {
        state.classList.remove('visible');
        deck.classList.remove('hidden');
        state.innerHTML = '';
        return;
      }

      deck.classList.add('hidden');
      state.classList.add('visible');
      if (type === 'loading') {
        state.innerHTML = `
          <div class="daily-review-loading-spinner"></div>
          <div>加载中...</div>
        `;
      } else if (type === 'empty') {
        state.innerHTML = `
          <div style="font-size: 22px;">📝</div>
          <div>没有找到符合条件的 Memo</div>
          <div style="font-size: 13px;">尝试调整时间范围或创建更多 Memo</div>
        `;
      } else if (type === 'error') {
        state.innerHTML = `<div>${utils.escapeHtml(message || '加载失败，请检查网络连接或登录状态')}</div>`;
      }
    },

    renderDeck(deckMemos, index) {
      if (!Array.isArray(deckMemos) || deckMemos.length === 0) {
        this.setReviewState('empty');
        return;
      }
      const safeIndex = Math.max(0, Math.min(index, deckMemos.length - 1));
      this.setReviewState(null);
      this.renderMemoCard(deckMemos[safeIndex], safeIndex, deckMemos.length);
    },

    renderMemoCard(memo, index, total) {
      const card = document.getElementById(this.cardId);
      const counter = document.getElementById(this.counterId);
      const prev = document.getElementById(this.prevId);
      const next = document.getElementById(this.nextId);
      if (!card) return;

      const createTime = memo.createTime ? new Date(memo.createTime).getTime() : Date.now();
      const rawContent = memo.content || '';
      const memoKey = memo.id || utils.getMemoId(memo) || `memo-${Math.random().toString(36).slice(2)}`;
      const tags = Array.isArray(memo.tags) ? memo.tags : utils.extractTags(rawContent);
      const contentWithoutTags = utils.removeTagsFromContent(rawContent);
      const htmlContent = utils.markdownToHtml(contentWithoutTags);

      const images = (memo.attachments || []).filter(att => att.type && att.type.startsWith('image/'));
      const imageUrls = images
        .map(img => img.externalLink || `/file/${img.name}/${img.filename}`)
        .map((url) => utils.sanitizeUrl(url))
        .filter(Boolean);
      this.imageGroups = {};
      if (imageUrls.length > 0) {
        this.imageGroups[memoKey] = imageUrls;
      }

      let gridClass = 'grid-1';
      if (images.length === 2 || images.length === 4) {
        gridClass = 'grid-2';
      } else if (images.length >= 3) {
        gridClass = 'grid-3';
      }

      card.innerHTML = `
        <div class="daily-review-memo-date">${utils.formatDate(createTime)}</div>
        ${tags.length > 0 ? `
          <div class="daily-review-memo-tags">
            ${tags.map(tag => `<span class="daily-review-memo-tag">#${utils.escapeHtml(tag)}</span>`).join('')}
          </div>
        ` : ''}
        <div class="daily-review-memo-content">${htmlContent}</div>
        ${imageUrls.length > 0 ? `
          <div class="daily-review-memo-images ${gridClass}">
            ${imageUrls.map((imgUrl, imgIndex) => `
              <a class="daily-review-memo-image-link" href="${imgUrl}" data-memo-key="${memoKey}" data-image-index="${imgIndex}">
                <img src="${imgUrl}" class="daily-review-memo-image" alt="" loading="lazy">
              </a>
            `).join('')}
          </div>
        ` : ''}
      `;

      if (counter) counter.textContent = `${index + 1} / ${total}`;
      if (prev) prev.disabled = index <= 0;
      if (next) next.disabled = index >= total - 1;

      this.bindImagePreview();
    },

    bindImagePreview() {
      const content = document.getElementById(this.cardId) || document.getElementById(this.deckId);
      if (!content) return;
      const links = content.querySelectorAll('.daily-review-memo-image-link');
      links.forEach(link => {
        link.addEventListener('click', (event) => {
          event.preventDefault();
          const memoKey = link.dataset.memoKey;
          const index = parseInt(link.dataset.imageIndex || '0', 10);
          if (memoKey && this.imageGroups[memoKey]) {
            this.openImagePreview(memoKey, index);
          }
        });
      });
    },

    openImagePreview(memoKey, index) {
      this.activeImageKey = memoKey;
      this.activeImageIndex = index;
      this.updateImagePreview();
      const overlay = document.getElementById(this.imageOverlayId);
      if (overlay) {
        overlay.classList.add('visible');
      }
    },

    closeImagePreview() {
      const overlay = document.getElementById(this.imageOverlayId);
      if (overlay) {
        overlay.classList.remove('visible');
      }
      this.activeImageKey = null;
      this.activeImageIndex = 0;
    },

    navigateImage(step) {
      if (!this.activeImageKey) return;
      const images = this.imageGroups[this.activeImageKey] || [];
      if (images.length === 0) return;
      const nextIndex = this.activeImageIndex + step;
      if (nextIndex < 0 || nextIndex >= images.length) return;
      this.activeImageIndex = nextIndex;
      this.updateImagePreview();
    },

    updateImagePreview() {
      if (!this.activeImageKey) return;
      const images = this.imageGroups[this.activeImageKey] || [];
      if (images.length === 0) return;

      const img = document.getElementById(this.imagePreviewId);
      const caption = document.getElementById(this.imageCaptionId);
      const prev = document.getElementById(this.imagePrevId);
      const next = document.getElementById(this.imageNextId);

      const currentUrl = images[this.activeImageIndex];
      if (img) {
        img.src = currentUrl;
      }
      if (caption) {
        caption.textContent = `${this.activeImageIndex + 1} / ${images.length}`;
      }
      if (prev) {
        prev.disabled = this.activeImageIndex <= 0;
      }
      if (next) {
        next.disabled = this.activeImageIndex >= images.length - 1;
      }
    }
  };

  // ============================================
  // Controller
  // ============================================
  const controller = {
    isOpen: false,
    deckBatch: 0,
    deckIndex: 0,
    deckMemos: [],
    viewedInSession: new Set(),
    currentDeckKey: '',
    isSavingEdit: false,

    init() {
      ui.injectStyles();
      ui.createFloatingButton();
      ui.createDialog();
      ui.createImagePreview();
      ui.createEditDialog();

      this.updateEntryVisibility();
      this.patchRouteEvents();
      window.addEventListener('popstate', () => this.updateEntryVisibility());
      window.addEventListener('daily-review-routechange', () => this.updateEntryVisibility());
    },

    async openDialog() {
      if (ui.isAuthRoute()) return;
      if (this.isOpen) return;
      this.isOpen = true;
      this.deckBatch = 0;
      this.deckIndex = 0;
      this.deckMemos = [];
      this.viewedInSession = new Set();
      ui.showDialog();
      this.loadDeck();
    },

    closeDialog() {
      if (!this.isOpen) return;
      this.isOpen = false;
      ui.closeEditor();
      ui.closeImagePreview();
      ui.hideDialog();
    },

    patchRouteEvents() {
      if (window.__dailyReviewRoutePatched) return;
      window.__dailyReviewRoutePatched = true;

      const dispatch = () => window.dispatchEvent(new Event('daily-review-routechange'));
      const originalPushState = history.pushState;
      const originalReplaceState = history.replaceState;
      history.pushState = function(...args) {
        const result = originalPushState.apply(this, args);
        dispatch();
        return result;
      };
      history.replaceState = function(...args) {
        const result = originalReplaceState.apply(this, args);
        dispatch();
        return result;
      };
    },

    updateEntryVisibility() {
      if (ui.isAuthRoute()) {
        ui.hideFloatingButton();
      } else {
        ui.showFloatingButton();
      }
    },

    onSettingsChanged() {
      this.deckBatch = 0;
      this.deckIndex = 0;
      this.deckMemos = [];
      this.viewedInSession = new Set();
      this.loadDeck(true);
    },

    newBatch() {
      this.deckBatch += 1;
      this.deckIndex = 0;
      this.deckMemos = [];
      this.viewedInSession = new Set();
      this.loadDeck(true);
    },

    editCurrent() {
      if (!this.deckMemos.length) return;
      const memo = this.deckMemos[this.deckIndex];
      if (!memo || !memo.name) {
        // Use alert instead of setReviewState to avoid hiding the deck
        alert('当前 Memo 不支持编辑');
        return;
      }
      ui.openEditor(memo.content || '');
    },

    closeEditor() {
      if (this.isSavingEdit) return;
      ui.closeEditor();
    },

    async saveEditor() {
      if (this.isSavingEdit) return;
      if (!this.deckMemos.length) return;

      const memo = this.deckMemos[this.deckIndex];
      if (!memo || !memo.name) return;

      const nextContent = ui.getEditorValue();
      if ((nextContent || '') === (memo.content || '')) {
        ui.closeEditor();
        return;
      }

      this.isSavingEdit = true;
      ui.setEditorSaving(true);
      ui.setEditStatus('保存中…');

      try {
        const updated = await apiService.updateMemoContent(memo.name, nextContent || '');
        const normalized = utils.normalizeMemo(updated);
        if (!normalized.id) throw new Error('invalid update response');

        this.deckMemos[this.deckIndex] = normalized;

        // Update pool cache (best-effort).
        const settings = settingsService.load();
        const pool = poolService.load(settings.timeRange);
        if (pool && Array.isArray(pool)) {
          const idx = pool.findIndex((m) => m && m.id === normalized.id);
          if (idx >= 0) {
            pool[idx] = normalized;
            poolService.save(settings.timeRange, pool);
          }
        }

        // Update deck cache (best-effort).
        if (this.currentDeckKey) {
          const deck = deckService.getDeck(this.currentDeckKey);
          if (deck && Array.isArray(deck.memos)) {
            const deckIdx = deck.memos.findIndex((m) => m && m.id === normalized.id);
            if (deckIdx >= 0) {
              deck.memos[deckIdx] = normalized;
              deck.timestamp = Date.now();
              deckService.saveDeck(deck);
            }
          }
        }

        ui.renderDeck(this.deckMemos, this.deckIndex);
        ui.closeEditor();
      } catch (e) {
        console.error('Failed to update memo:', e);
        const msg = String(e && e.message ? e.message : e);
        if (msg.includes('401') || msg.includes('Unauthenticated') || msg.includes('authentication')) {
          ui.setEditStatus('保存失败：需要登录或无权限');
        } else if (msg.includes('403') || msg.includes('PermissionDenied') || msg.includes('permission')) {
          ui.setEditStatus('保存失败：无权限');
        } else {
          ui.setEditStatus('保存失败，请稍后重试');
        }
      } finally {
        this.isSavingEdit = false;
        ui.setEditorSaving(false);
      }
    },

    prev() {
      if (!this.deckMemos.length) return;
      if (this.deckIndex <= 0) return;
      this.deckIndex -= 1;
      ui.renderDeck(this.deckMemos, this.deckIndex);
      this.markViewedCurrent();
    },

    next() {
      if (!this.deckMemos.length) return;
      if (this.deckIndex >= this.deckMemos.length - 1) return;
      this.deckIndex += 1;
      ui.renderDeck(this.deckMemos, this.deckIndex);
      this.markViewedCurrent();
    },

    markViewedCurrent() {
      const memo = this.deckMemos[this.deckIndex];
      if (!memo) return;
      const memoId = memo.id || utils.getMemoId(memo);
      if (!memoId) return;
      if (this.viewedInSession.has(memoId)) return;
      this.viewedInSession.add(memoId);
      historyService.markViewed(memoId, utils.getDailySeed());
    },

    async getPoolMemos(timeRange) {
      const cached = poolService.load(timeRange);
      if (cached && cached.length > 0) return cached;

      const normalized = [];
      const seen = new Set();

      const first = await apiService.fetchMemos(timeRange);
      for (const memo of first.memos || []) {
        const m = utils.normalizeMemo(memo);
        if (!m.id) continue;
        if (seen.has(m.id)) continue;
        seen.add(m.id);
        normalized.push(m);
      }

      if (timeRange === 'all' && first.nextPageToken && CONFIG.POOL_MAX_PAGES_ALL > 1) {
        try {
          const second = await apiService.fetchMemos(timeRange, first.nextPageToken);
          for (const memo of second.memos || []) {
            const m = utils.normalizeMemo(memo);
            if (!m.id) continue;
            if (seen.has(m.id)) continue;
            seen.add(m.id);
            normalized.push(m);
          }
        } catch (e) {
          // Best-effort second page; ignore failures to keep load low and UX resilient.
          console.warn('Failed to fetch extra memo page for pool:', e);
        }
      }

      poolService.save(timeRange, normalized);
      return normalized;
    },

    buildBuckets(pool) {
      const sorted = [...pool].sort((a, b) => {
        const ta = a.createTime ? new Date(a.createTime).getTime() : 0;
        const tb = b.createTime ? new Date(b.createTime).getTime() : 0;
        return ta - tb;
      });
      if (sorted.length === 0) return [[], [], []];
      const third = Math.ceil(sorted.length / 3);
      const oldest = sorted.slice(0, third);
      const middle = sorted.slice(third, third * 2);
      const newest = sorted.slice(third * 2);
      return [oldest, middle, newest];
    },

    allocateTargets(count) {
      const base = Math.floor(count / 3);
      const rem = count % 3;
      const targets = [base, base, base];
      for (let i = 0; i < rem; i++) {
        targets[i] += 1;
      }
      return targets;
    },

    sortByReviewPriority(candidates, history, today, seedPrefix, minDaysSince) {
      const scored = candidates
        .filter((m) => m && m.id)
        .filter((m) => {
          const daysSince = historyService.getDaysSinceShown(history, m.id, today);
          return daysSince >= minDaysSince;
        })
        .map((m) => {
          const entry = history.items[m.id];
          const shownCount = entry?.shownCount || 0;
          const daysSince = historyService.getDaysSinceShown(history, m.id, today);
          const never = !entry || !entry.lastShownDay;
          const tie = utils.stringToSeed(`${seedPrefix}-${m.id}`);
          return { m, never, daysSince, shownCount, tie };
        });

      scored.sort((a, b) => {
        if (a.never !== b.never) return a.never ? -1 : 1;
        if (a.daysSince !== b.daysSince) return b.daysSince - a.daysSince;
        if (a.shownCount !== b.shownCount) return a.shownCount - b.shownCount;
        return a.tie - b.tie;
      });

      return scored.map((s) => s.m);
    },

    pickFromBucket(bucket, target, history, today, seedPrefix) {
      if (target <= 0) return [];
      const relax = [CONFIG.NO_REPEAT_DAYS, 2, 1, 0];
      const picked = [];
      const pickedIds = new Set();
      for (const minDays of relax) {
        if (picked.length >= target) break;
        const ordered = this.sortByReviewPriority(bucket, history, today, seedPrefix, minDays);
        for (const memo of ordered) {
          if (picked.length >= target) break;
          if (pickedIds.has(memo.id)) continue;
          pickedIds.add(memo.id);
          picked.push(memo);
        }
      }
      return picked.slice(0, target);
    },

    interleave(selectedBuckets) {
      const result = [];
      const buckets = selectedBuckets.map((b) => [...b]);
      while (buckets.some((b) => b.length > 0)) {
        for (const b of buckets) {
          const next = b.shift();
          if (next) result.push(next);
        }
      }
      return result;
    },

    findSparkPair(pool, history, today, seedPrefix) {
      const tagMap = new Map();
      for (const memo of pool) {
        if (!memo?.id) continue;
        const daysSince = historyService.getDaysSinceShown(history, memo.id, today);
        if (daysSince < CONFIG.NO_REPEAT_DAYS) continue;
        const tags = Array.isArray(memo.tags) ? memo.tags : [];
        for (const tag of tags) {
          if (!tag) continue;
          if (!tagMap.has(tag)) tagMap.set(tag, []);
          tagMap.get(tag).push(memo);
        }
      }

      const candidates = [];
      for (const [tag, memos] of tagMap.entries()) {
        if (memos.length < 2) continue;
        const sorted = [...memos].sort((a, b) => {
          const ta = a.createTime ? new Date(a.createTime).getTime() : 0;
          const tb = b.createTime ? new Date(b.createTime).getTime() : 0;
          return ta - tb;
        });
        const oldest = sorted[0];
        const newest = sorted[sorted.length - 1];
        if (!oldest || !newest || oldest.id === newest.id) continue;
        const tie = utils.stringToSeed(`${seedPrefix}-tag-${tag}`);
        candidates.push({ tag, oldest, newest, tie });
      }

      if (candidates.length === 0) return null;
      candidates.sort((a, b) => a.tie - b.tie);
      return [candidates[0].oldest, candidates[0].newest];
    },

    buildDeckFromPool(pool, settings, today, batch) {
      const eligible = (pool || []).filter((m) => m && m.id && ((m.content || '').trim() !== '' || (m.attachments || []).length > 0));
      if (eligible.length === 0) return [];

      const history = historyService.load();
      const seedPrefix = `${today}-${settings.timeRange}-${settings.count}-${batch}`;

      const [oldest, middle, newest] = this.buildBuckets(eligible);
      const targets = this.allocateTargets(settings.count);

      const selectedOldest = this.pickFromBucket(oldest, targets[0], history, today, `${seedPrefix}-oldest`);
      const selectedMiddle = this.pickFromBucket(middle, targets[1], history, today, `${seedPrefix}-middle`);
      const selectedNewest = this.pickFromBucket(newest, targets[2], history, today, `${seedPrefix}-newest`);

      let deck = this.interleave([selectedOldest, selectedMiddle, selectedNewest]);

      // Add one "spark pair" (tag collision) if possible.
      const spark = this.findSparkPair(eligible, history, today, seedPrefix);
      if (spark) {
        const [a, b] = spark;
        const positions = deck.length >= 8 ? [2, 5] : [1, Math.max(2, deck.length - 1)];
        const insert = (pos, memo) => {
          if (!memo) return;
          if (deck.some((m) => m.id === memo.id)) return;
          deck.splice(Math.min(pos, deck.length), 0, memo);
        };
        insert(positions[0], a);
        insert(positions[1], b);
        const seen = new Set();
        deck = deck.filter((m) => {
          if (!m?.id) return false;
          if (seen.has(m.id)) return false;
          seen.add(m.id);
          return true;
        });
      }

      return deck.slice(0, settings.count);
    },

    async loadDeck(forceRegenerate = false) {
      const settings = settingsService.load();
      const today = utils.getDailySeed();
      const key = deckService.makeKey(today, settings.timeRange, settings.count, this.deckBatch);
      this.currentDeckKey = key;

      if (!forceRegenerate) {
        const cached = deckService.getDeck(key);
        if (deckService.isValid(cached, key)) {
          this.deckMemos = cached.memos || [];
          this.deckIndex = 0;
          ui.renderDeck(this.deckMemos, this.deckIndex);
          this.markViewedCurrent();
          return;
        }
      }

      ui.setReviewState('loading');

      try {
        const pool = await this.getPoolMemos(settings.timeRange);
        const deckMemos = this.buildDeckFromPool(pool, settings, today, this.deckBatch);

        if (deckMemos.length === 0) {
          ui.setReviewState('empty');
          return;
        }

        const deck = {
          schemaVersion: CONFIG.DECK_SCHEMA_VERSION,
          key,
          day: today,
          timeRange: settings.timeRange,
          count: settings.count,
          batch: this.deckBatch,
          memos: deckMemos,
          timestamp: Date.now()
        };
        deckService.saveDeck(deck);

        this.deckMemos = deckMemos;
        this.deckIndex = 0;
        ui.renderDeck(this.deckMemos, this.deckIndex);
        this.markViewedCurrent();
      } catch (error) {
        console.error('Failed to load daily review deck:', error);
        ui.setReviewState('error', '加载失败，请检查网络连接或登录状态');
      }
    }
  };

  // ============================================
  // Entry Point
  // ============================================
  // Wait for DOM to be ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      setTimeout(() => controller.init(), 500);
    });
  } else {
    setTimeout(() => controller.init(), 500);
  }
})();
