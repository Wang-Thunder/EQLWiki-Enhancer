const DEFAULTS = {
  freezeHeader: true,
  sideSearch: true,
  sideSearchPosition: 'left',
  sideSearchOffset: 50,
  sideSearchWidth: 190,
  sideSearchOpacity: 0.95,
  sideSearchHotkey: 'Alt+S',
  sideDoublePressEnabled: false,
  sideDoublePressKey: 'Shift',
  cornerSearch: true,
  cornerPosition: 'right',
  cornerUnlocked: false,
  cornerOpacity: 0.5,
  cornerWidth: 190,
  cornerX: null,
  cornerY: null,
  centerSearch: true,
  centerSearchShortcut: 'Ctrl+Shift+F',
  autocompleteEnabled: true,
  searchOpenMode: 'new',
  hidePageSearchUI: false
};

const statusEl = document.getElementById('status');
const popupSearchInput = document.getElementById('popup-search');
const supportCard = document.getElementById('support-card');
const supportThanks = document.getElementById('support-thanks');
const supportLink = document.getElementById('support-link');
let statusTimer;

const RANGE_MAP = {
  sideSearchOffset: { output: 'sideSearchOffsetOutput', unit: '%' },
  sideSearchWidth: { output: 'sideSearchWidthOutput', unit: 'px' },
  sideSearchOpacity: { output: 'sideSearchOpacityOutput', unit: '%', factor: 100 },
  cornerWidth: { output: 'cornerWidthOutput', unit: 'px' },
  cornerOpacity: { output: 'cornerOpacityOutput', unit: '%', factor: 100 }
};

function showSaved(message = 'Saved') {
  statusEl.textContent = message;
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => { statusEl.textContent = ''; }, 1300);
}

function normalizeHotkeyPart(part) {
  const p = String(part || '').trim();
  if (!p) return '';
  const lower = p.toLowerCase();
  const map = { ctrl: 'Ctrl', control: 'Ctrl', alt: 'Alt', option: 'Alt', shift: 'Shift', meta: 'Meta', cmd: 'Meta', command: 'Meta', esc: 'Escape', return: 'Enter', spacebar: 'Space', ' ': 'Space' };
  if (map[lower]) return map[lower];
  if (p.length === 1) return p.toUpperCase();
  return p.charAt(0).toUpperCase() + p.slice(1);
}

function normalizeShortcutString(str) {
  return String(str || '').split('+').map(normalizeHotkeyPart).filter(Boolean).join('+');
}

function shortcutFromEvent(event) {
  const parts = [];
  if (event.ctrlKey) parts.push('Ctrl');
  if (event.altKey) parts.push('Alt');
  if (event.shiftKey) parts.push('Shift');
  if (event.metaKey) parts.push('Meta');
  const key = normalizeHotkeyPart(event.key === ' ' ? 'Space' : event.key);
  if (!key || ['Ctrl', 'Alt', 'Shift', 'Meta'].includes(key)) return parts.join('+');
  parts.push(key);
  return parts.join('+');
}

function singleKeyFromEvent(event) {
  const key = normalizeHotkeyPart(event.key === ' ' ? 'Space' : event.key);
  return key || '';
}

function updateRangeOutput(id, value) {
  const meta = RANGE_MAP[id];
  if (!meta) return;
  const output = document.getElementById(meta.output);
  if (!output) return;
  const shown = meta.factor ? Math.round(Number(value) * meta.factor) : Number(value);
  output.textContent = `${shown}${meta.unit}`;
}

function setControlValue(id, value) {
  const el = document.getElementById(id);
  if (!el) return;
  if (el.type === 'checkbox') el.checked = Boolean(value);
  else if (el.dataset.shortcut === 'true') el.value = normalizeShortcutString(value);
  else if (el.dataset.singleKey === 'true') el.value = normalizeHotkeyPart(value);
  else if (el.type === 'range') {
    const displayValue = id.includes('Opacity') ? Math.round(Number(value) * 100) : value;
    el.value = String(displayValue);
    updateRangeOutput(id, value);
  } else el.value = value;
}

function getControlValue(el) {
  if (el.type === 'checkbox') return el.checked;
  if (el.dataset.shortcut === 'true') return normalizeShortcutString(el.value);
  if (el.dataset.singleKey === 'true') return normalizeHotkeyPart(el.value);
  if (el.type === 'range') return el.id.includes('Opacity') ? Number(el.value) / 100 : Number(el.value);
  return el.value;
}

async function loadSettings() {
  const stored = await chrome.storage.sync.get(DEFAULTS);
  Object.keys(DEFAULTS).forEach(id => setControlValue(id, stored[id]));
}

function setSupportUi(isSupporter) {
  if (supportCard) supportCard.hidden = Boolean(isSupporter);
  if (supportThanks) supportThanks.hidden = !isSupporter;
}

async function loadSupportState() {
  try {
    const response = await chrome.runtime.sendMessage({ action: 'getSupportStatus' });
    setSupportUi(Boolean(response?.supporter));
  } catch {
    const { supporterMode = false } = await chrome.storage.sync.get({ supporterMode: false });
    setSupportUi(Boolean(supporterMode));
  }
}

function saveValue(el) {
  chrome.storage.sync.set({ [el.id]: getControlValue(el) }, () => {
    showSaved();
    requestAnimationFrame(adjustPopupHeight);
  });
}

function adjustPopupHeight() {
  // CSS sizes the popup to content and caps it at Chrome's 600px popup height.
}




Object.keys(DEFAULTS).forEach(id => {
  const el = document.getElementById(id);
  if (!el) return;

  if (el.type === 'range') {
    el.addEventListener('input', () => {
      const preview = el.id.includes('Opacity') ? Number(el.value) / 100 : Number(el.value);
      updateRangeOutput(el.id, preview);
    });
    el.addEventListener('change', () => saveValue(el));
  } else if (el.dataset.shortcut === 'true') {
    el.addEventListener('keydown', event => {
      event.preventDefault();
      event.stopPropagation();
      if (['Backspace', 'Delete', 'Escape'].includes(event.key)) {
        el.value = '';
        saveValue(el);
        return;
      }
      const shortcut = shortcutFromEvent(event);
      if (!shortcut || ['Ctrl', 'Alt', 'Shift', 'Meta'].includes(shortcut)) return;
      el.value = shortcut;
      saveValue(el);
    });
  } else if (el.dataset.singleKey === 'true') {
    el.addEventListener('keydown', event => {
      event.preventDefault();
      event.stopPropagation();
      if (['Backspace', 'Delete', 'Escape'].includes(event.key)) {
        el.value = '';
        saveValue(el);
        return;
      }
      const key = singleKeyFromEvent(event);
      if (!key) return;
      el.value = key;
      saveValue(el);
    });
  } else {
    el.addEventListener('change', () => saveValue(el));
  }
});

document.querySelectorAll('details.settings-group').forEach(details => {
  details.addEventListener('toggle', () => requestAnimationFrame(adjustPopupHeight));
});

if (supportLink) {
  supportLink.addEventListener('click', async event => {
    event.preventDefault();
    try {
      const response = await chrome.runtime.sendMessage({ action: 'openSupport' });
      if (!response?.ok) throw new Error('Unable to open support page');
      window.close();
    } catch {
      const tab = await chrome.tabs.create({ url: supportLink.href, active: false });
      await chrome.storage.local.set({
        supportVisit: {
          tabId: tab.id,
          startedAt: Date.now()
        }
      });
      if (tab.id) await chrome.tabs.update(tab.id, { active: true });
      window.close();
    }
  });
}

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'sync' || !changes.supporterMode) return;
  setSupportUi(Boolean(changes.supporterMode.newValue));
});

document.getElementById('popup-search-form').addEventListener('submit', async event => {
  event.preventDefault();
  const term = popupSearchInput.value.trim();
  if (!term) return;
  const { searchOpenMode } = await chrome.storage.sync.get({ searchOpenMode: 'new' });
  const url = `https://eqlwiki.com/index.php?title=Special:Search&search=${encodeURIComponent(term)}`;
  if (searchOpenMode === 'current') {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) await chrome.tabs.update(tab.id, { url });
    else await chrome.tabs.create({ url });
  } else {
    await chrome.tabs.create({ url });
  }
  window.close();
});

document.getElementById('resetCornerPosition').addEventListener('click', () => {
  chrome.storage.sync.set({ cornerX: null, cornerY: null }, () => showSaved('Corner position reset'));
});

document.getElementById('resetAll').addEventListener('click', () => {
  chrome.storage.sync.set(DEFAULTS, async () => {
    await loadSettings();
    requestAnimationFrame(adjustPopupHeight);
    showSaved('Settings reset');
  });
});

document.getElementById('exportSettings').addEventListener('click', async () => {
  const stored = await chrome.storage.sync.get(DEFAULTS);
  const blob = new Blob([JSON.stringify(stored, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'eql-we-settings.json';
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  showSaved('Settings exported');
});

document.getElementById('importSettings').addEventListener('click', () => {
  document.getElementById('importSettingsFile').click();
});

document.getElementById('importSettingsFile').addEventListener('change', async event => {
  const file = event.target.files?.[0];
  if (!file) return;
  try {
    const parsed = JSON.parse(await file.text());
    const sanitized = {};
    Object.keys(DEFAULTS).forEach(key => {
      if (Object.prototype.hasOwnProperty.call(parsed, key)) sanitized[key] = parsed[key];
    });
    await chrome.storage.sync.set(sanitized);
    await loadSettings();
    requestAnimationFrame(adjustPopupHeight);
    showSaved('Settings imported');
  } catch {
    showSaved('Invalid settings file');
  } finally {
    event.target.value = '';
  }
});

async function getSuggestions(term) {
  try {
    const response = await chrome.runtime.sendMessage({ action: 'getSuggestions', term });
    return response?.ok && Array.isArray(response.results) ? response.results : [];
  } catch {
    return [];
  }
}

function buildSuggestionNode(item) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'popup-suggestion';
  if (item.thumbnail) {
    const img = document.createElement('img');
    img.className = 'popup-thumb';
    img.alt = '';
    img.src = item.thumbnail;
    button.appendChild(img);
  } else {
    const placeholder = document.createElement('span');
    placeholder.className = 'popup-thumb placeholder';
    placeholder.textContent = 'EQL';
    button.appendChild(placeholder);
  }
  const text = document.createElement('span');
  text.className = 'popup-suggestion-text';
  text.textContent = item.title;
  button.appendChild(text);
  return button;
}

function setupUiAutocomplete(inputId, boxId) {
  const input = document.getElementById(inputId);
  const box = document.getElementById(boxId);
  if (!input || !box) return;
  let timer = null;
  let results = [];
  let active = -1;

  const hide = () => { box.hidden = true; box.innerHTML = ''; results = []; active = -1; };
  const draw = () => { box.querySelectorAll('.popup-suggestion').forEach((el, i) => el.classList.toggle('active', i === active)); };
  const render = items => {
    results = items;
    active = -1;
    box.innerHTML = '';
    if (!items.length) { hide(); return; }
    items.forEach(item => {
      const button = buildSuggestionNode(item);
      button.addEventListener('mousedown', e => e.preventDefault());
      button.addEventListener('click', () => { input.value = item.title; hide(); });
      box.appendChild(button);
    });
    box.hidden = false;
  };
  const request = async () => {
    const { autocompleteEnabled = true } = await chrome.storage.sync.get({ autocompleteEnabled: true });
    const term = input.value.trim();
    if (!autocompleteEnabled || term.length < 2) { hide(); return; }
    try {
      const items = await getSuggestions(term);
      if (input.value.trim() === term) render(items);
    } catch { hide(); }
  };

  input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(request, 160); });
  input.addEventListener('focus', () => { clearTimeout(timer); timer = setTimeout(request, 100); });
  input.addEventListener('keydown', event => {
    if (event.key === 'Escape') { hide(); return; }
    if (!results.length) return;
    if (event.key === 'ArrowDown') { event.preventDefault(); active = (active + 1) % results.length; draw(); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); active = active <= 0 ? results.length - 1 : active - 1; draw(); }
    else if (event.key === 'Enter' && active >= 0) { input.value = results[active].title; hide(); }
  });
  input.addEventListener('blur', () => setTimeout(hide, 100));
}

setupUiAutocomplete('popup-search', 'popup-suggestions');
Promise.all([loadSettings(), loadSupportState()]).then(() => {
  requestAnimationFrame(() => {
    adjustPopupHeight();
    popupSearchInput.focus({ preventScroll: true });
    popupSearchInput.select();
  });
});