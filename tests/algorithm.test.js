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
  hooks.__context = context;
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

function createResponse(status, jsonBody = null, textBody = '') {
  return {
    status,
    ok: status >= 200 && status < 300,
    async json() {
      if (jsonBody === null) throw new Error('No JSON body');
      return jsonBody;
    },
    async text() {
      return textBody;
    }
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

test('fetchMemos should downgrade query options and parse snake_case token for v0.25.x style responses', async () => {
  const hooks = loadHooks();
  const calledUrls = [];
  let callIndex = 0;

  hooks.utils.fetchWithTimeout = async (url) => {
    calledUrls.push(url);
    callIndex += 1;
    if (callIndex <= 2) {
      return createResponse(400, null, 'bad request');
    }
    return createResponse(200, { memos: [{ name: 'memos/1', content: 'x' }], next_page_token: 'tok-2' });
  };

  const result = await hooks.apiService.fetchMemos('6months', '');
  assert.equal(result.nextPageToken, 'tok-2');
  assert.equal(calledUrls.length, 3);
  assert.ok(calledUrls[0].includes('filter='));
  assert.ok(calledUrls[0].includes('orderBy='));
  assert.ok(!calledUrls[1].includes('filter='));
  assert.ok(calledUrls[1].includes('orderBy='));
  assert.ok(!calledUrls[2].includes('filter='));
  assert.ok(!calledUrls[2].includes('orderBy='));
});

test('getPoolMemos should stop early when fetch time budget is exceeded', async () => {
  const hooks = loadHooks();
  hooks.poolService.load = () => null;
  hooks.poolService.save = () => {};

  let now = 0;
  hooks.__context.Date.now = () => now;
  hooks.__context.window.Date = hooks.__context.Date;

  let calls = 0;
  hooks.apiService.fetchMemos = async (_timeRange, pageToken) => {
    calls += 1;
    now += 2500;
    const page = !pageToken ? 1 : (pageToken === 'p2' ? 2 : 3);
    const memos = [];
    for (let i = 0; i < 60; i++) {
      memos.push({
        id: `b${page}-${i}`,
        name: `memos/b${page}-${i}`,
        createTime: '2026-02-20T00:00:00Z',
        content: `memo b${page}-${i}`,
        attachments: []
      });
    }
    if (!pageToken) return { memos, nextPageToken: 'p2' };
    if (pageToken === 'p2') return { memos, nextPageToken: 'p3' };
    return { memos, nextPageToken: '' };
  };

  const memos = await hooks.controller.getPoolMemos('all', 240);
  assert.equal(calls, 2);
  assert.equal(memos.length, 120);
});

test('pickFromBucket should avoid dense same-tag picks when diversity penalty is enabled', () => {
  const hooks = loadHooks();
  const history = { items: {} };
  const today = '2026-02-23';
  const bucket = [
    { id: 'a1', tags: ['alpha'], createTime: '2026-02-20T00:00:00Z' },
    { id: 'a2', tags: ['alpha'], createTime: '2026-02-19T00:00:00Z' },
    { id: 'b1', tags: ['beta'], createTime: '2026-02-18T00:00:00Z' }
  ];

  hooks.controller.scoreByReviewPriority = () => [
    { memo: bucket[0], never: true, daysSince: 100, shownCount: 0, tie: 1 },
    { memo: bucket[1], never: true, daysSince: 99, shownCount: 0, tie: 2 },
    { memo: bucket[2], never: true, daysSince: 98, shownCount: 0, tie: 3 }
  ];

  const picked = hooks.controller.pickFromBucket(bucket, 2, history, today, 'seed');
  assert.equal(picked[0].id, 'a1');
  assert.equal(picked[1].id, 'b1');
});
