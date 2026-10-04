const QUICK_SEARCH_URL = chrome.runtime.getURL('quicksearch.html');
const SUPPORT_URL = 'https://ko-fi.com/wangthunder';
const SUPPORT_VISIT_THRESHOLD_MS = 45 * 1000;
const SUPPORT_VISIT_KEY = 'supportVisit';
const thumbCache = new Map();

function makeSearchUrl(term) {
  return `https://eqlwiki.com/index.php?title=Special:Search&search=${encodeURIComponent(term || '')}`;
}

function articleUrl(title) {
  return `https://eqlwiki.com/index.php?title=${encodeURIComponent(String(title || '').replace(/\s+/g, '_'))}`;
}

async function markSupporter() {
  await chrome.storage.sync.set({
    supporterMode: true,
    supporterSince: Date.now(),
    supporterMethod: 'kofi_visit'
  });
  await chrome.storage.local.remove(SUPPORT_VISIT_KEY);
}

async function getSupportVisit() {
  const stored = await chrome.storage.local.get(SUPPORT_VISIT_KEY);
  return stored[SUPPORT_VISIT_KEY] || null;
}

async function maybeCompleteSupportVisit() {
  const visit = await getSupportVisit();
  if (!visit?.startedAt) return false;
  if (Date.now() - Number(visit.startedAt) < SUPPORT_VISIT_THRESHOLD_MS) return false;
  await markSupporter();
  return true;
}

async function openSupportPage() {
  const { supporterMode = false } = await chrome.storage.sync.get({ supporterMode: false });
  if (supporterMode) return { ok: true, supporter: true };

  const tab = await chrome.tabs.create({ url: SUPPORT_URL, active: false });
  await chrome.storage.local.set({
    [SUPPORT_VISIT_KEY]: {
      tabId: tab.id,
      startedAt: Date.now()
    }
  });
  if (tab.id) await chrome.tabs.update(tab.id, { active: true });
  return { ok: true, supporter: false };
}

chrome.tabs.onActivated.addListener(async activeInfo => {
  const visit = await getSupportVisit();
  if (!visit?.tabId || activeInfo.tabId === visit.tabId) return;
  await maybeCompleteSupportVisit();
});

chrome.tabs.onRemoved.addListener(async tabId => {
  const visit = await getSupportVisit();
  if (!visit?.tabId || tabId !== visit.tabId) return;
  const completed = await maybeCompleteSupportVisit();
  if (!completed) await chrome.storage.local.remove(SUPPORT_VISIT_KEY);
});

async function openSearch(term, sourceTabId = null) {
  const { searchOpenMode = 'new' } = await chrome.storage.sync.get({ searchOpenMode: 'new' });
  const url = makeSearchUrl(term);
  if (searchOpenMode === 'current' && sourceTabId) {
    await chrome.tabs.update(sourceTabId, { url });
  } else {
    await chrome.tabs.create({ url });
  }
}

function humanizeLinkUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    const title = url.searchParams.get('title');
    if (title) return decodeURIComponent(title).replace(/_/g, ' ');
    const last = url.pathname.split('/').filter(Boolean).pop();
    if (!last) return '';
    const decoded = decodeURIComponent(last).replace(/[_-]+/g, ' ').trim();
    return decoded.length >= 2 ? decoded : '';
  } catch {
    return '';
  }
}

function createContextMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'eql-root', title: 'EQLWiki', contexts: ['page', 'selection', 'link'] });
    chrome.contextMenus.create({ id: 'eql-search-selection', parentId: 'eql-root', title: 'Search selected text: “%s”', contexts: ['selection'] });
    chrome.contextMenus.create({ id: 'eql-search-link', parentId: 'eql-root', title: 'Search this link on EQLWiki', contexts: ['link'] });
    chrome.contextMenus.create({ id: 'eql-open-quick-search', parentId: 'eql-root', title: 'Open EQLWiki quick search', contexts: ['page', 'selection', 'link'] });
  });
}

chrome.runtime.onInstalled.addListener(createContextMenus);
chrome.runtime.onStartup.addListener(createContextMenus);

chrome.commands.onCommand.addListener(async command => {
  if (command !== 'open-eqlwe-popup') return;
  try { await chrome.action.openPopup(); } catch {}
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === 'eql-search-selection' && info.selectionText) {
    await openSearch(info.selectionText.trim(), tab?.id || null);
    return;
  }
  if (info.menuItemId === 'eql-search-link') {
    const term = humanizeLinkUrl(info.linkUrl || '');
    if (term) {
      await openSearch(term, tab?.id || null);
    } else {
      const params = new URLSearchParams();
      if (info.linkUrl) params.set('q', info.linkUrl);
      if (tab?.id) params.set('tabId', String(tab.id));
      await chrome.windows.create({ url: `${QUICK_SEARCH_URL}?${params.toString()}`, type: 'popup', width: 460, height: 240 });
    }
    return;
  }
  if (info.menuItemId === 'eql-open-quick-search') {
    const prefill = (info.selectionText || humanizeLinkUrl(info.linkUrl || '') || '').trim();
    const params = new URLSearchParams();
    if (prefill) params.set('q', prefill);
    if (tab?.id) params.set('tabId', String(tab.id));
    await chrome.windows.create({ url: `${QUICK_SEARCH_URL}?${params.toString()}`, type: 'popup', width: 460, height: 240 });
  }
});

async function fetchSuggestionCore(term) {
  const endpoints = [
    `https://eqlwiki.com/api.php?action=opensearch&format=json&origin=*&limit=12&namespace=0&search=${encodeURIComponent(term)}`,
    `https://eqlwiki.com/api.php?action=query&format=json&origin=*&list=prefixsearch&pslimit=12&psnamespace=0&pssearch=${encodeURIComponent(term)}`
  ];
  let results = [];
  for (const url of endpoints) {
    try {
      const response = await fetch(url, { credentials: 'omit' });
      if (!response.ok) continue;
      const data = await response.json();
      if (Array.isArray(data?.[1])) {
        const urls = Array.isArray(data?.[3]) ? data[3] : [];
        results = data[1].map((title, index) => ({ title, url: urls[index] || articleUrl(title) }));
      } else if (Array.isArray(data?.query?.prefixsearch)) {
        results = data.query.prefixsearch.map(item => ({ title: item.title, url: articleUrl(item.title) }));
      }
      if (results.length) break;
    } catch {}
  }
  const deduped = [];
  const seen = new Set();
  for (const item of results) {
    const key = item.title.toLocaleLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(item);
    }
  }
  const needle = term.toLocaleLowerCase();
  deduped.sort((a, b) => {
    const al = a.title.toLocaleLowerCase();
    const bl = b.title.toLocaleLowerCase();
    const score = value => value === needle ? 0 : value.startsWith(needle) ? 1 : 2;
    return score(al) - score(bl) || a.title.localeCompare(b.title);
  });
  return deduped.slice(0, 8);
}

function normalizeImgSrc(src) {
  if (!src) return '';
  if (src.startsWith('//')) return `https:${src}`;
  if (src.startsWith('/')) return `https://eqlwiki.com${src}`;
  return src;
}

function extractImageFromHtml(html) {
  const matches = [...html.matchAll(/<img\b[^>]*src=["']([^"']+)["'][^>]*>/gi)];
  for (const match of matches) {
    const tag = match[0];
    const lower = tag.toLowerCase();
    if (lower.includes('logo') || lower.includes('wordmark') || lower.includes('icon')) continue;
    if (lower.includes('image needed') || lower.includes('imageneeded') || lower.includes('placeholder')) continue;
    const src = normalizeImgSrc(match[1]);
    const sl = src.toLowerCase();
    if (!src || sl.includes('image_needed') || sl.includes('placeholder') || sl.includes('upload.wikimedia.org/wikipedia')) continue;
    if (!/\.(png|jpe?g|gif|webp)(\?|$)/i.test(sl)) continue;
    return src;
  }
  return '';
}

async function fetchThumbnailFromParse(title) {
  if (thumbCache.has(title)) return thumbCache.get(title);
  let thumb = '';
  try {
    const url = `https://eqlwiki.com/api.php?action=parse&format=json&origin=*&page=${encodeURIComponent(title)}&prop=text`;
    const response = await fetch(url, { credentials: 'omit' });
    if (response.ok) {
      const data = await response.json();
      const html = data?.parse?.text?.['*'] || '';
      thumb = extractImageFromHtml(html);
    }
  } catch {}
  thumbCache.set(title, thumb);
  return thumb;
}

async function getSuggestions(term) {
  const results = await fetchSuggestionCore(term);
  const withThumbs = await Promise.all(results.map(async item => ({ ...item, thumbnail: await fetchThumbnailFromParse(item.title) })));
  return withThumbs;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.action === 'openSupport') {
    openSupportPage()
      .then(result => sendResponse(result))
      .catch(error => sendResponse({ ok: false, error: String(error?.message || error) }));
    return true;
  }

  if (message?.action === 'getSupportStatus') {
    Promise.all([
      chrome.storage.sync.get({ supporterMode: false }),
      maybeCompleteSupportVisit()
    ])
      .then(async ([stored, completed]) => {
        if (completed) {
          sendResponse({ ok: true, supporter: true });
          return;
        }
        sendResponse({ ok: true, supporter: Boolean(stored.supporterMode) });
      })
      .catch(error => sendResponse({ ok: false, supporter: false, error: String(error?.message || error) }));
    return true;
  }

  if (message?.action !== 'getSuggestions') return false;
  const term = String(message.term || '').trim();
  if (term.length < 2) {
    sendResponse({ ok: true, results: [] });
    return false;
  }
  getSuggestions(term)
    .then(results => sendResponse({ ok: true, results }))
    .catch(error => sendResponse({ ok: false, results: [], error: String(error?.message || error) }));
  return true;
});