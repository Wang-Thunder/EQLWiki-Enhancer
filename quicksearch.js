const input = document.getElementById('quick-search');
const box = document.getElementById('quick-suggestions');
const params = new URLSearchParams(location.search);
const prefill = params.get('q') || '';
const sourceTabId = Number(params.get('tabId')) || null;
if (prefill) input.value = prefill;
input.focus();
input.select();

let timer = null;
let results = [];
let active = -1;

function hideSuggestions() { box.hidden = true; box.innerHTML = ''; results = []; active = -1; }
function drawActive() { box.querySelectorAll('.popup-suggestion').forEach((el, i) => el.classList.toggle('active', i === active)); }

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

function renderSuggestions(items) {
  results = items;
  active = -1;
  box.innerHTML = '';
  if (!items.length) { hideSuggestions(); return; }
  items.forEach(item => {
    const button = buildSuggestionNode(item);
    button.addEventListener('mousedown', e => e.preventDefault());
    button.addEventListener('click', () => { input.value = item.title; hideSuggestions(); });
    box.appendChild(button);
  });
  box.hidden = false;
}

async function getSuggestions(term) {
  try {
    const response = await chrome.runtime.sendMessage({ action: 'getSuggestions', term });
    return response?.ok && Array.isArray(response.results) ? response.results : [];
  } catch { return []; }
}

async function requestSuggestions() {
  const { autocompleteEnabled = true } = await chrome.storage.sync.get({ autocompleteEnabled: true });
  const term = input.value.trim();
  if (!autocompleteEnabled || term.length < 2) { hideSuggestions(); return; }
  try {
    const items = await getSuggestions(term);
    if (input.value.trim() === term) renderSuggestions(items);
  } catch { hideSuggestions(); }
}

input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(requestSuggestions, 160); });
input.addEventListener('keydown', event => {
  if (event.key === 'Escape') { hideSuggestions(); return; }
  if (!results.length) return;
  if (event.key === 'ArrowDown') { event.preventDefault(); active = (active + 1) % results.length; drawActive(); }
  else if (event.key === 'ArrowUp') { event.preventDefault(); active = active <= 0 ? results.length - 1 : active - 1; drawActive(); }
  else if (event.key === 'Enter' && active >= 0) { input.value = results[active].title; hideSuggestions(); }
});
input.addEventListener('blur', () => setTimeout(hideSuggestions, 100));

document.getElementById('quick-search-form').addEventListener('submit', async event => {
  event.preventDefault();
  const term = input.value.trim();
  if (!term) return;
  const url = `https://eqlwiki.com/index.php?title=Special:Search&search=${encodeURIComponent(term)}`;
  const { searchOpenMode } = await chrome.storage.sync.get({ searchOpenMode: 'new' });
  if (searchOpenMode === 'current') {
    if (sourceTabId) await chrome.tabs.update(sourceTabId, { url });
    else await chrome.tabs.create({ url });
  } else {
    await chrome.tabs.create({ url });
  }
  window.close();
});

if (prefill) setTimeout(requestSuggestions, 50);