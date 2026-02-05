# Memos Daily Review Plugin - AI Development Reference

## Project Structure

```
memos-daily-review-plugin/
├── memos-daily-review-plugin.js    # Main plugin (~2700 lines, single-file)
├── README.md                       # User documentation (English)
├── CONTRIBUTING.md                 # Development guide (English)
├── CLAUDE.md                       # This file
├── .gitignore                      # Git ignore rules
├── assets/
│   └── demo.gif                    # Demo animation
└── docs/
    └── zh-CN/                      # Chinese documentation
        ├── README.zh-CN.md         # User documentation (Chinese)
        └── CONTRIBUTING.zh-CN.md   # Development guide (Chinese)
```

---

## Code Architecture

**File**: `memos-daily-review-plugin.js`

The plugin is an IIFE (Immediately Invoked Function Expression) with the following structure:

```javascript
(function DailyReviewPlugin() {
  'use strict';

  // Lines 25-48: Configuration
  const CONFIG = { /* storage keys, defaults, options */ };

  // Lines 50-57: Precompiled Regex Patterns
  const REGEX_PATTERNS = { /* heading, list, inline formatting */ };

  // Lines 59-403: Utility Functions
  const utils = {
    getDailySeed,           // Date-based seed generation
    mulberry32,             // PRNG implementation
    shuffle,                // Fisher-Yates with seed
    markdownToHtml,         // Markdown renderer with nested lists
    formatInlineMarkdown,   // Bold, italic, links, images
    extractTags,            // Tag extraction from content
    // ... more utilities
  };

  // Lines 405-423: Settings Service
  const settingsService = {
    load,                   // Load user preferences
    save,                   // Save user preferences
  };

  // Lines 428-492: History Service
  const historyService = {
    load,                   // Load review history
    save,                   // Save review history
    recordShown,            // Record memo view
    getDaysSinceShown,      // Calculate days since last view
    pruneOldEntries,        // LRU pruning (max 5000 items)
  };

  // Lines 497-525: Pool Cache Service
  const poolService = {
    get,                    // Get cached pool
    set,                    // Set pool with TTL (6 hours)
    clear,                  // Clear cache
  };

  // Lines 530-605: Deck Cache Service
  const deckService = {
    get,                    // Get cached deck by key
    set,                    // Set deck (keeps last 10)
    clear,                  // Clear all decks
    generateKey,            // Generate cache key: day-timeRange-count-batch
  };

  // Lines 610-691: API Service
  const apiService = {
    fetchMemos,             // GET /api/v1/memos with filters
    updateMemo,             // PATCH /api/v1/memos/{name}
  };

  // Lines 696-815: Auth Service
  const authService = {
    getAccessToken,         // Get token from session/localStorage
    refreshAccessToken,     // POST /memos.api.v1.AuthService/RefreshToken
    getAuthHeaders,         // Build Authorization header
  };

  // Lines 820-2006: UI Components
  const ui = {
    injectStyles,           // Inject CSS (uses Memos CSS variables)
    createFloatingButton,   // Create bottom-right button
    createDialog,           // Create modal dialog
    renderCard,             // Render memo card with Markdown
    createImageOverlay,     // Create image preview overlay
    createEditDialog,       // Create edit modal
    bindImagePreview,       // Event delegation for images
    // ... more UI methods
  };

  // Lines 2011-2443: Controller
  const controller = {
    init,                   // Entry point
    openDialog,             // Open review dialog
    generateDeck,           // Main deck generation logic
    buildBuckets,           // Split pool into 3 time buckets
    pickFromBucket,         // Pick memos from bucket with priority
    sortByReviewPriority,   // Sort by review priority
    findSparkPair,          // Find spark pair (O(n) algorithm)
    insertSparkPair,        // Insert spark pair into deck
    showCard,               // Display current card
    prevCard,               // Navigate to previous card
    nextCard,               // Navigate to next card
    shuffle,                // Generate new deck (increment batch)
    editMemo,               // Edit current memo
    saveMemo,               // Save edited memo
  };

  // Lines 2448-2456: Entry Point
  // Initialization logic
})();
```

---

## Key Algorithms

### 1. Deterministic Deck Generation

**Location**: `controller.generateDeck()` (lines 2115-2230)

**Process**:
1. Fetch pool from cache or API
2. Build 3 buckets by creation time (oldest/middle/newest)
3. Allocate target count across buckets (e.g., 8 cards → 3/3/2)
4. Pick from each bucket using review priority
5. Interleave buckets for variety
6. Insert spark pair if available

**Key**: Uses `seedPrefix = day + timeRange + count + batch` for deterministic randomness.

```javascript
// Simplified logic
const pool = await poolService.get() || await apiService.fetchMemos();
const buckets = buildBuckets(pool);  // [oldest, middle, newest]
const targets = [Math.ceil(count/3), Math.ceil(count/3), count - 2*Math.ceil(count/3)];
const selected = buckets.map((bucket, i) => pickFromBucket(bucket, targets[i], history, today, seedPrefix));
const interleaved = interleave(selected);
const sparkPair = findSparkPair(pool, interleaved, seedPrefix);
if (sparkPair) insertSparkPair(interleaved, sparkPair);
return interleaved;
```

### 2. Review Priority Algorithm

**Location**: `controller.sortByReviewPriority()` (lines 2270-2294)

**Scoring Criteria** (in order):
1. Never shown (highest priority)
2. Days since last shown (longer = higher)
3. Shown count (lower = higher)
4. Tie-breaker (deterministic hash of memo ID)

**Relaxation Strategy**:
- Try `minDaysSince = 3` first
- If insufficient, relax to 2, then 1, then 0
- Ensures enough memos even with small pools

```javascript
// Simplified logic
for (let minDaysSince = 3; minDaysSince >= 0; minDaysSince--) {
  const scored = candidates
    .map(m => {
      const entry = history.items[m.id];
      const daysSince = getDaysSinceShown(history, m.id, today);
      const never = !entry || !entry.lastShownDay;
      const shownCount = entry?.shownCount || 0;
      const tie = stringToSeed(`${seedPrefix}-${m.id}`);
      return { m, never, daysSince, shownCount, tie, valid: daysSince >= minDaysSince };
    })
    .filter(item => item.valid);

  if (scored.length >= needed) {
    scored.sort((a, b) => {
      if (a.never !== b.never) return b.never - a.never;
      if (a.daysSince !== b.daysSince) return b.daysSince - a.daysSince;
      if (a.shownCount !== b.shownCount) return a.shownCount - b.shownCount;
      return a.tie - b.tie;
    });
    return scored.slice(0, needed).map(item => item.m);
  }
}
```

### 3. Spark Pair Algorithm

**Location**: `controller.findSparkPair()` (lines 2326-2358)

**Purpose**: Find memo pairs with same tag but maximum time gap.

**Optimization**: O(n) linear scan instead of O(n log n) sorting.

```javascript
// Simplified logic
const tagMap = {};
for (const memo of pool) {
  for (const tag of memo.tags) {
    if (!tagMap[tag]) tagMap[tag] = [];
    tagMap[tag].push(memo);
  }
}

const candidates = [];
for (const [tag, memos] of Object.entries(tagMap)) {
  if (memos.length < 2) continue;

  // O(n) scan for min/max instead of O(n log n) sort
  let oldest = memos[0];
  let newest = memos[0];
  for (const memo of memos) {
    const t = new Date(memo.createTime).getTime();
    const oldestTime = new Date(oldest.createTime).getTime();
    const newestTime = new Date(newest.createTime).getTime();
    if (t < oldestTime) oldest = memo;
    if (t > newestTime) newest = memo;
  }

  const tie = stringToSeed(`spark-${tag}-${seedPrefix}`);
  candidates.push({ oldest, newest, tie });
}

candidates.sort((a, b) => a.tie - b.tie);
return candidates[0] || null;
```

### 4. Markdown Rendering with Nested Lists

**Location**: `utils.markdownToHtml()` (lines 258-403)

**Key Features**:
- Detects indentation level (Tab = 2 spaces)
- Infers list depth from indent width
- Uses stack to maintain list elements at each level
- Nests inner `<ul>`/`<ol>` under parent `<li>`
- Uses DocumentFragment for batch DOM insertion

```javascript
// Simplified logic
const fragment = document.createDocumentFragment();
const listStack = [];  // [{type: 'ul', depth: 0, element: <ul>}, ...]

for (const line of lines) {
  const leading = line.match(/^[ \t]*/)[0].replace(/\t/g, '  ');
  const indentWidth = leading.length;
  const depth = getListDepthForIndent(indentWidth);
  const trimmed = line.trim();

  if (ulMatch = trimmed.match(/^[-*+]\s+(.*)$/)) {
    ensureListForLevel('ul', depth);
    const li = document.createElement('li');
    li.innerHTML = formatInlineMarkdown(ulMatch[1]);
    listStack[listStack.length - 1].element.appendChild(li);
  }
  // ... similar for ordered lists, headings, paragraphs
}

container.appendChild(fragment);
```

---

## Data Storage

**localStorage Keys**:

| Key | Purpose | Structure |
|-----|---------|-----------|
| `memos-daily-review-settings` | User settings | `{timeRange: string, count: number}` |
| `memos-daily-review-pool` | Pool cache | `{memos: Memo[], timestamp: number}` |
| `memos-daily-review-cache` | Deck cache | `{[key: string]: {deck: Memo[], timestamp: number}}` |
| `memos-daily-review-history` | Review history | `{items: {[memoId: string]: {lastShownDay: string, shownCount: number}}}` |

**Caching Strategy**:
- **Pool**: TTL 6 hours, reduces API requests
- **Deck**: Cached by key `day-timeRange-count-batch`, keeps last 10
- **History**: Max 5000 entries, LRU eviction by "longest unseen"

---

## API Dependencies

| Endpoint | Method | Purpose | Auth |
|----------|--------|---------|------|
| `/api/v1/memos` | GET | Fetch memo list | Optional (filters by visibility) |
| `/api/v1/memos/{name}` | PATCH | Update memo content | Required |
| `/memos.api.v1.AuthService/RefreshToken` | POST | Refresh access token | Requires refresh cookie |

**Query Parameters** (GET /api/v1/memos):
- `pageSize`: Max 1000
- `filter`: CEL expression, e.g., `create_time > "2023-01-01T00:00:00Z"`

---

## CSS Variables

Uses Memos CSS variables for theme compatibility:

- `--primary` / `--primary-foreground` - Primary color
- `--background` / `--foreground` - Background/foreground
- `--border` - Border color
- `--card` - Card background
- `--muted-foreground` - Secondary text
- `--accent` - Accent color
- `--radius` - Border radius
- `--shadow-lg` - Shadow

---

## Modification Guide

### Add New Time Range

**File**: `memos-daily-review-plugin.js`
**Location**: Lines 30-38 (`CONFIG.TIME_RANGES`)

```javascript
TIME_RANGES: [
  { value: 'all', label: '全部', labelEn: 'All', months: null },
  { value: '1year', label: '1年', labelEn: '1 Year', months: 12 },
  { value: '6months', label: '6个月', labelEn: '6 Months', months: 6 },
  { value: '3months', label: '3个月', labelEn: '3 Months', months: 3 },
  { value: '1month', label: '1个月', labelEn: '1 Month', months: 1 },
  // Add new range here
],
```

### Add New Count Option

**Location**: Lines 40-41 (`CONFIG.COUNT_OPTIONS`)

```javascript
COUNT_OPTIONS: [4, 8, 12, 16, 20, 24],  // Add new count here
```

### Modify Styles

**Location**: Lines 820-1100 (`ui.injectStyles()`)

All styles are injected as a single `<style>` tag. Modify CSS rules directly.

### Adjust Caching

**Location**: Lines 25-48 (`CONFIG`)

```javascript
POOL_TTL_MS: 6 * 60 * 60 * 1000,  // Pool cache TTL (6 hours)
NO_REPEAT_DAYS: 3,                 // Deduplication days
MAX_HISTORY_ITEMS: 5000,           // Max history entries
MAX_CACHED_DECKS: 10,              // Max cached decks
```

---

## Debugging

### Console Logging

The plugin uses `console.error` for errors. Add `console.log` for debugging:

```javascript
console.log('[DailyReview] Generated deck:', deck);
console.log('[DailyReview] History:', history);
```

### Inspect localStorage

```javascript
// In browser console
localStorage.getItem('memos-daily-review-settings');
localStorage.getItem('memos-daily-review-pool');
localStorage.getItem('memos-daily-review-cache');
localStorage.getItem('memos-daily-review-history');
```

### Performance Profiling

```javascript
// Add performance marks
performance.mark('generateDeck-start');
// ... function logic
performance.mark('generateDeck-end');
performance.measure('generateDeck', 'generateDeck-start', 'generateDeck-end');
console.log(performance.getEntriesByName('generateDeck'));
```

### Network Inspection

Use browser DevTools Network panel to inspect API calls:
- Check request headers (Authorization)
- Check response status and body
- Check timing (should use cache when available)

---

## Common Tasks

### Clear All Caches

```javascript
// In browser console
localStorage.removeItem('memos-daily-review-pool');
localStorage.removeItem('memos-daily-review-cache');
localStorage.removeItem('memos-daily-review-history');
```

### Force Refresh Pool

```javascript
// In browser console
localStorage.removeItem('memos-daily-review-pool');
// Then click "每日回顾" button
```

### Test with Different Seed

Modify `getDailySeed()` to return a fixed value:

```javascript
getDailySeed() {
  return 'test-seed-123';  // Fixed seed for testing
},
```

### Syntax Check

```bash
node --check memos-daily-review-plugin.js
```

---

## Known Limitations

- Max 1000 memos per fetch (API limitation)
- Simplified Markdown (no code blocks, quotes, tables, horizontal rules)
- Nested list depth inferred from indent width (may not fully comply with CommonMark)
- Cache is date-based, auto-invalidates across days
- Button auto-hides on `/auth` routes

---

## Performance Benchmarks

For datasets with 1000+ memos:
- Deck generation: < 100ms
- Markdown rendering (long docs): < 50ms
- Memory usage: Stable after 100 card switches

Use browser Performance panel for profiling.
