const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function createStorage() {
  const store = new Map();
  return {
    getItem(key) {
      return store.has(key) ? store.get(key) : null;
    },
    setItem(key, value) {
      store.set(key, String(value));
    },
    removeItem(key) {
      store.delete(key);
    },
    clear() {
      store.clear();
    }
  };
}

function loadHooks(fixedNowMs = Date.parse('2026-02-23T00:00:00Z')) {
  const scriptPath = path.join(__dirname, '..', 'memos-daily-review-plugin.js');
  const code = fs.readFileSync(scriptPath, 'utf8');

  class FixedDate extends Date {
    constructor(...args) {
      if (args.length === 0) {
        super(fixedNowMs);
      } else {
        super(...args);
      }
    }
    static now() {
      return fixedNowMs;
    }
  }

  const localStorage = createStorage();
  const sessionStorage = createStorage();

  const context = {
    console,
    Math,
    Date: FixedDate,
    JSON,
    Promise,
    URL,
    URLSearchParams,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    fetch: async () => {
      throw new Error('fetch should be mocked in tests');
    },
    alert() {},
    confirm() {
      return true;
    },
    Event: class Event {
      constructor(type) {
        this.type = type;
      }
    },
    window: {
      location: { origin: 'https://example.com', href: 'https://example.com/', pathname: '/' },
      addEventListener() {},
      removeEventListener() {},
      dispatchEvent() {},
      __dailyReviewInitialized: false,
      __dailyReviewRoutePatched: false
    },
    document: {
      readyState: 'complete',
      addEventListener() {},
      getElementById() {
        return null;
      },
      createElement() {
        return {
          style: {},
          classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
          appendChild() {},
          remove() {},
          setAttribute() {},
          addEventListener() {},
          removeEventListener() {},
          querySelector() { return null; },
          querySelectorAll() { return []; }
        };
      },
      createDocumentFragment() {
        return { appendChild() {} };
      },
      head: { appendChild() {} },
      body: { appendChild() {} }
    },
    history: {
      pushState() {},
      replaceState() {}
    },
    navigator: {
      onLine: true,
      language: 'en-US'
    },
    localStorage,
    sessionStorage,
    __DAILY_REVIEW_TEST_MODE: true
  };

  context.globalThis = context;
  context.window.history = context.history;
  context.window.localStorage = localStorage;
  context.window.sessionStorage = sessionStorage;
  context.window.navigator = context.navigator;
  context.window.document = context.document;

  vm.createContext(context);
  vm.runInContext(code, context, { filename: 'memos-daily-review-plugin.js' });

  const hooks = context.__DAILY_REVIEW_TEST_HOOKS;
  if (!hooks) {
    throw new Error('Failed to load __DAILY_REVIEW_TEST_HOOKS');
  }
  return hooks;
}

function createMemo(id, createTime) {
  return {
    id,
    name: `memos/${id}`,
    createTime,
    content: `memo ${id}`,
    tags: [],
    attachments: []
  };
}

test('buildBuckets should use time-boundary buckets instead of equal-size split', () => {
  const fixedNow = Date.parse('2026-02-23T00:00:00Z');
  const hooks = loadHooks(fixedNow);
  const dayMs = 24 * 60 * 60 * 1000;
  const pool = [
    createMemo('m1', new Date(fixedNow - 2 * dayMs).toISOString()),
    createMemo('m2', new Date(fixedNow - 5 * dayMs).toISOString()),
    createMemo('m3', new Date(fixedNow - 20 * dayMs).toISOString()),
    createMemo('m4', new Date(fixedNow - 40 * dayMs).toISOString()),
    createMemo('m5', new Date(fixedNow - 100 * dayMs).toISOString()),
    createMemo('m6', new Date(fixedNow - 220 * dayMs).toISOString())
  ];

  const [oldest, middle, newest] = hooks.controller.buildBuckets(pool);
  const oldIds = new Set(oldest.map((m) => m.id));
  const middleIds = new Set(middle.map((m) => m.id));
  const newIds = new Set(newest.map((m) => m.id));

  assert.deepEqual([...oldIds].sort(), ['m6']);
  assert.deepEqual([...middleIds].sort(), ['m4', 'm5']);
  assert.deepEqual([...newIds].sort(), ['m1', 'm2', 'm3']);
});

test('getPoolMemos should keep fetching pages until desired pool size is reached', async () => {
  const hooks = loadHooks();
  hooks.poolService.load = () => null;
  hooks.poolService.save = () => {};

  let calls = 0;
  hooks.apiService.fetchMemos = async (_timeRange, pageToken) => {
    calls += 1;
    const page = !pageToken ? 1 : (pageToken === 'p2' ? 2 : 3);
    const memos = [];
    for (let i = 0; i < 60; i++) {
      memos.push({
        id: `p${page}-${i}`,
        name: `memos/p${page}-${i}`,
        createTime: '2026-02-20T00:00:00Z',
        content: `memo p${page}-${i}`,
        attachments: []
      });
    }
    if (!pageToken) return { memos, nextPageToken: 'p2' };
    if (pageToken === 'p2') return { memos, nextPageToken: 'p3' };
    return { memos, nextPageToken: '' };
  };

  const memos = await hooks.controller.getPoolMemos('all', 150);

  assert.equal(calls, 3);
  assert.ok(memos.length >= 150);
});

test('buildDeckFromPool should top up to requested count even when initial bucket picks are sparse', () => {
  const hooks = loadHooks();
  const today = '2026-02-23';
  const settings = { timeRange: 'all', count: 12 };
  const pool = [];
  for (let i = 0; i < 20; i++) {
    pool.push({
      id: `memo-${i}`,
      name: `memos/memo-${i}`,
      createTime: '2026-02-20T00:00:00Z',
      content: `memo-${i}`,
      tags: [],
      attachments: []
    });
  }

  hooks.controller.buildBuckets = () => [[], [], [...pool]];
  hooks.controller.findSparkPair = () => null;

  const deck = hooks.controller.buildDeckFromPool(pool, settings, today, 0);
  assert.equal(deck.length, 12);
});
