(() => {
  'use strict';

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

  const SUGGESTION_LIMIT = 8;
  const DOUBLE_PRESS_WINDOW = 350;
  let settings = { ...DEFAULTS };
  let stickyHeader = null;
  let stickyPlaceholder = null;
  let resizeObserver = null;
  let lastDoubleKey = '';
  let lastDoubleTime = 0;
  let cornerDrag = null;
  const formState = new WeakMap();

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function isEditableTarget(target) {
    if (!target) return false;
    if (target.isContentEditable) return true;
    return ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
  }

  function normalizeHotkeyPart(part) {
    const p = String(part || '').trim();
    if (!p) return '';
    const lower = p.toLowerCase();
    const map = {
      ctrl: 'Ctrl', control: 'Ctrl', alt: 'Alt', option: 'Alt', shift: 'Shift',
      meta: 'Meta', cmd: 'Meta', command: 'Meta', esc: 'Escape', return: 'Enter',
      spacebar: 'Space', ' ': 'Space'
    };
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

  function matchesShortcut(event, shortcut) {
    const wanted = normalizeShortcutString(shortcut);
    return Boolean(wanted) && shortcutFromEvent(event) === wanted;
  }

  function isVisible(el) {
    if (!el) return false;
    const style = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
  }

  function findBestHeader() {
    // Prefer MediaWiki/Vector's known header containers directly. These checks must
    // not depend on the element currently being inside the viewport: deep links
    // (for example, URLs with a #section fragment) may scroll the page before this
    // content script runs, putting the real header above the viewport.
    const preferredSelectors = [
      '.vector-header-container',
      'header.vector-header',
      '.vector-header',
      '.mw-header',
      '#mw-head',
      '#mw-navigation'
    ];

    const viewportWidth = Math.max(document.documentElement.clientWidth, window.innerWidth || 0);
    const usable = el => {
      if (!isVisible(el)) return false;
      const rect = el.getBoundingClientRect();
      return rect.height >= 24 && rect.height <= 260 && rect.width >= Math.min(500, viewportWidth * 0.55);
    };

    for (const selector of preferredSelectors) {
      const match = [...document.querySelectorAll(selector)].find(usable);
      if (match) return match;
    }

    // Fallback for alternate skins/layouts. Score candidates by their document
    // position rather than viewport position so restored scroll positions and
    // fragment navigation cannot disqualify the real page header.
    const candidates = [];
    ['header', '#header', '.header'].forEach(selector =>
      document.querySelectorAll(selector).forEach(el => candidates.push(el))
    );

    const searchInput = document.querySelector('input[name="search"], input[type="search"], #searchInput, .cdx-text-input__input');
    if (searchInput) {
      let el = searchInput.parentElement;
      for (let depth = 0; el && el !== document.body && depth < 10; depth += 1, el = el.parentElement) candidates.push(el);
    }

    let best = null;
    let bestScore = -Infinity;

    [...new Set(candidates)].forEach(el => {
      if (!usable(el)) return;
      const rect = el.getBoundingClientRect();
      const documentTop = rect.top + window.scrollY;
      if (documentTop > 600) return;

      let score = 0;
      score += Math.max(0, 220 - Math.abs(documentTop)) * 0.2;
      score += Math.min(60, (rect.width / viewportWidth) * 60);
      score -= Math.max(0, rect.height - 110) * 0.2;
      if (el.matches('header')) score += 35;
      if (searchInput && el.contains(searchInput)) score += 45;
      if (el.querySelector('nav, [role="navigation"], form[role="search"], input[name="search"], input[type="search"]')) score += 15;
      if (/head|nav|header/i.test(`${el.id} ${el.className}`)) score += 10;

      if (score > bestScore) {
        bestScore = score;
        best = el;
      }
    });

    return best;
  }

  function updateStickyGeometry() {
    if (!stickyHeader || !stickyPlaceholder) return;
    const rect = stickyPlaceholder.getBoundingClientRect();
    const width = stickyPlaceholder.offsetWidth || rect.width || window.innerWidth;
    const left = rect.left;
    const height = stickyHeader.getBoundingClientRect().height || stickyHeader.offsetHeight;
    stickyHeader.style.setProperty('--eql-sticky-left', `${Math.max(0, left)}px`);
    stickyHeader.style.setProperty('--eql-sticky-width', `${Math.min(width, window.innerWidth - Math.max(0, left))}px`);
    stickyPlaceholder.style.height = `${height}px`;
  }

  function enableStickyHeader() {
    if (stickyHeader && document.contains(stickyHeader)) {
      updateStickyGeometry();
      return;
    }
    const header = findBestHeader();
    if (!header?.parentNode) return;

    stickyHeader = header;
    stickyPlaceholder = document.createElement('div');
    stickyPlaceholder.id = 'eql-enhancer-sticky-placeholder';
    stickyPlaceholder.setAttribute('aria-hidden', 'true');
    stickyPlaceholder.style.height = `${header.getBoundingClientRect().height}px`;
    stickyPlaceholder.style.width = '100%';
    stickyPlaceholder.style.pointerEvents = 'none';
    header.parentNode.insertBefore(stickyPlaceholder, header);
    header.classList.add('eql-enhancer-sticky');
    updateStickyGeometry();

    window.addEventListener('resize', updateStickyGeometry, { passive: true });
    if ('ResizeObserver' in window) {
      resizeObserver = new ResizeObserver(updateStickyGeometry);
      resizeObserver.observe(header);
      resizeObserver.observe(stickyPlaceholder);
    }
  }

  function disableStickyHeader() {
    resizeObserver?.disconnect();
    resizeObserver = null;
    window.removeEventListener('resize', updateStickyGeometry);
    if (stickyHeader) {
      stickyHeader.classList.remove('eql-enhancer-sticky');
      stickyHeader.style.removeProperty('--eql-sticky-left');
      stickyHeader.style.removeProperty('--eql-sticky-width');
    }
    stickyPlaceholder?.remove();
    stickyHeader = null;
    stickyPlaceholder = null;
  }

  function searchFormMarkup(id, placeholder) {
    return `<form id="${id}" class="eql-enhancer-search-form" autocomplete="off">
      <input type="text" name="search" placeholder="${placeholder}" autocomplete="off" required>
      <div class="eql-enhancer-suggestions" hidden></div>
    </form>`;
  }

  function performSearch(term) {
    const url = `https://eqlwiki.com/index.php?title=Special:Search&search=${encodeURIComponent(term)}`;
    if (settings.searchOpenMode === 'new') window.open(url, '_blank', 'noopener');
    else window.location.href = url;
  }

  function hideSuggestions(form) {
    const box = form?.querySelector('.eql-enhancer-suggestions');
    if (!box) return;
    box.hidden = true;
    box.innerHTML = '';
    const state = formState.get(form) || {};
    state.results = [];
    state.activeIndex = -1;
    formState.set(form, state);
  }

  function positionSuggestions(form) {
    const box = form?.querySelector('.eql-enhancer-suggestions');
    if (!box) return;
    box.classList.remove('eql-suggestions-above');

    if (form.id !== 'eql-corner-search-form') return;

    const rect = form.getBoundingClientRect();
    const estimatedHeight = Math.min(260, Math.max(120, box.scrollHeight || (box.childElementCount || SUGGESTION_LIMIT) * 35));
    const below = window.innerHeight - rect.bottom;
    const above = rect.top;

    if (below < estimatedHeight + 10 && above > below) {
      box.classList.add('eql-suggestions-above');
    }
  }

  function renderSuggestions(form, input, results) {
    const box = form.querySelector('.eql-enhancer-suggestions');
    if (!box || !settings.autocompleteEnabled || !results.length) {
      hideSuggestions(form);
      return;
    }

    const state = formState.get(form) || {};
    state.results = results;
    state.activeIndex = -1;
    formState.set(form, state);
    box.innerHTML = '';

    results.forEach((result, index) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'eql-enhancer-suggestion-item';
      button.dataset.index = String(index);

      if (result.thumbnail) {
        const img = document.createElement('img');
        img.className = 'eql-suggestion-thumb';
        img.alt = '';
        img.src = result.thumbnail;
        button.appendChild(img);
      } else {
        const placeholder = document.createElement('span');
        placeholder.className = 'eql-suggestion-thumb eql-suggestion-thumb-placeholder';
        placeholder.textContent = 'EQL';
        button.appendChild(placeholder);
      }

      const label = document.createElement('span');
      label.className = 'eql-suggestion-label';
      label.textContent = result.title;
      button.appendChild(label);

      button.addEventListener('mousedown', event => event.preventDefault());
      button.addEventListener('click', () => {
        input.value = result.title;
        hideSuggestions(form);
        if (settings.searchOpenMode === 'new') window.open(result.url, '_blank', 'noopener');
        else window.location.href = result.url;
      });
      box.appendChild(button);
    });
    box.hidden = false;
    requestAnimationFrame(() => positionSuggestions(form));
  }

  function updateActiveSuggestion(form) {
    const state = formState.get(form) || {};
    form.querySelectorAll('.eql-enhancer-suggestion-item').forEach((item, index) => {
      item.classList.toggle('active', index === state.activeIndex);
    });
  }

  async function requestSuggestions(term) {
    try {
      const response = await chrome.runtime.sendMessage({ action: 'getSuggestions', term });
      return response?.ok && Array.isArray(response.results) ? response.results : [];
    } catch {
      return [];
    }
  }

  function scheduleSuggestions(form, input) {
    const state = formState.get(form) || {};
    clearTimeout(state.debounce);
    const term = input.value.trim();
    if (!settings.autocompleteEnabled || term.length < 2) {
      hideSuggestions(form);
      return;
    }
    state.debounce = setTimeout(async () => {
      const results = await requestSuggestions(term);
      if (input.value.trim() === term) renderSuggestions(form, input, results);
    }, 160);
    formState.set(form, state);
  }

  function setupSearchForm(form) {
    if (!form || form.dataset.enhanced === 'true') return;
    form.dataset.enhanced = 'true';
    const input = form.querySelector('input[name="search"]');
    if (!input) return;
    formState.set(form, { results: [], activeIndex: -1 });

    form.addEventListener('submit', event => {
      event.preventDefault();
      const term = input.value.trim();
      if (!term) return;
      hideSuggestions(form);
      performSearch(term);
    });

    input.addEventListener('input', () => scheduleSuggestions(form, input));
    input.addEventListener('focus', () => scheduleSuggestions(form, input));
    input.addEventListener('keydown', event => {
      const state = formState.get(form) || { results: [], activeIndex: -1 };
      if (event.key === 'Escape') {
        hideSuggestions(form);
        return;
      }
      if (!state.results?.length) return;
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        state.activeIndex = (state.activeIndex + 1) % state.results.length;
        formState.set(form, state);
        updateActiveSuggestion(form);
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        state.activeIndex = state.activeIndex <= 0 ? state.results.length - 1 : state.activeIndex - 1;
        formState.set(form, state);
        updateActiveSuggestion(form);
      } else if (event.key === 'Enter' && state.activeIndex >= 0) {
        event.preventDefault();
        const result = state.results[state.activeIndex];
        input.value = result.title;
        hideSuggestions(form);
        if (settings.searchOpenMode === 'new') window.open(result.url, '_blank', 'noopener');
        else window.location.href = result.url;
      }
    });

    form.addEventListener('focusout', () => {
      requestAnimationFrame(() => {
        if (!form.contains(document.activeElement)) hideSuggestions(form);
      });
    });
  }

  function injectSideSearch() {
    let container = document.getElementById('eql-left-search-container');
    if (!container) {
      container = document.createElement('div');
      container.id = 'eql-left-search-container';
      container.className = 'collapsed';
      container.innerHTML = `${searchFormMarkup('eql-left-search-form', 'Search EQLWiki...')}
        <button id="eql-left-search-toggle" type="button" aria-label="Toggle EQLWiki search" title="Search EQLWiki">⌕</button>`;
      document.body.appendChild(container);
      const toggleBtn = container.querySelector('#eql-left-search-toggle');
      const input = container.querySelector('input[name="search"]');

      const setExpanded = expanded => {
        container.classList.toggle('expanded', expanded);
        container.classList.toggle('collapsed', !expanded);
      };
      container._eqlSetExpanded = setExpanded;
      container.addEventListener('mouseenter', () => setExpanded(true));
      container.addEventListener('mouseleave', () => {
        if (!container.contains(document.activeElement)) setExpanded(false);
      });
      container.addEventListener('focusout', () => {
        requestAnimationFrame(() => {
          if (!container.matches(':hover') && !container.contains(document.activeElement)) setExpanded(false);
        });
      });
      toggleBtn.addEventListener('click', () => {
        const expand = !container.classList.contains('expanded');
        setExpanded(expand);
        if (expand) input.focus();
      });
      setupSearchForm(container.querySelector('form'));
    }

    container.dataset.position = settings.sideSearchPosition;
    container.style.setProperty('--eql-side-width', `${clamp(Number(settings.sideSearchWidth) || 190, 150, 420)}px`);
    container.style.setProperty('--eql-side-opacity', String(clamp(Number(settings.sideSearchOpacity) || 0.95, 0.2, 1)));
    container.style.setProperty('--eql-side-offset', `${clamp(Number(settings.sideSearchOffset) || 50, 10, 90)}%`);
  }

  function removeSideSearch() {
    document.getElementById('eql-left-search-container')?.remove();
  }

  function toggleSideSearch() {
    const container = document.getElementById('eql-left-search-container');
    if (!container) return;
    const expand = !container.classList.contains('expanded');
    container.classList.remove('force-collapsed');
    container._eqlSetExpanded?.(expand);
    const input = container.querySelector('input[name="search"]');
    if (expand) {
      input?.focus();
    } else {
      input?.blur();
      container.classList.add('force-collapsed');
      setTimeout(() => container.classList.remove('force-collapsed'), 450);
    }
  }

  function applyCornerPosition(container) {
    container.style.setProperty('--eql-corner-width', `${clamp(Number(settings.cornerWidth) || 190, 150, 420)}px`);
    container.style.setProperty('--eql-corner-opacity', String(clamp(Number(settings.cornerOpacity) || 0.5, 0.2, 1)));
    container.classList.toggle('unlocked', Boolean(settings.cornerUnlocked));

    if (typeof settings.cornerX === 'number' && typeof settings.cornerY === 'number') {
      const maxLeft = Math.max(0, window.innerWidth - container.offsetWidth - 4);
      const maxTop = Math.max(0, window.innerHeight - container.offsetHeight - 4);
      const left = clamp(settings.cornerX, 0, maxLeft);
      const top = clamp(settings.cornerY, 0, maxTop);
      container.style.left = `${left}px`;
      container.style.top = `${top}px`;
      container.style.right = 'auto';
      container.style.bottom = 'auto';
    } else {
      container.style.top = 'auto';
      container.style.bottom = '14px';
      container.style.left = settings.cornerPosition === 'left' ? '14px' : 'auto';
      container.style.right = settings.cornerPosition === 'right' ? '14px' : 'auto';
    }
    requestAnimationFrame(() => positionSuggestions(container.querySelector('form')));
  }

  function startCornerDrag(event) {
    if (!settings.cornerUnlocked) return;
    const container = document.getElementById('eql-corner-search-container');
    if (!container) return;
    event.preventDefault();
    const rect = container.getBoundingClientRect();
    cornerDrag = { container, startX: event.clientX, startY: event.clientY, originLeft: rect.left, originTop: rect.top };
    document.addEventListener('pointermove', onCornerDragMove);
    document.addEventListener('pointerup', endCornerDrag, { once: true });
  }

  function onCornerDragMove(event) {
    if (!cornerDrag) return;
    const { container } = cornerDrag;
    const maxLeft = Math.max(0, window.innerWidth - container.offsetWidth - 4);
    const maxTop = Math.max(0, window.innerHeight - container.offsetHeight - 4);
    const left = clamp(cornerDrag.originLeft + event.clientX - cornerDrag.startX, 0, maxLeft);
    const top = clamp(cornerDrag.originTop + event.clientY - cornerDrag.startY, 0, maxTop);
    container.style.left = `${left}px`;
    container.style.top = `${top}px`;
    container.style.right = 'auto';
    container.style.bottom = 'auto';
    cornerDrag.left = left;
    cornerDrag.top = top;
    positionSuggestions(container.querySelector('form'));
  }

  function endCornerDrag() {
    document.removeEventListener('pointermove', onCornerDragMove);
    if (cornerDrag && typeof cornerDrag.left === 'number' && typeof cornerDrag.top === 'number') {
      chrome.storage.sync.set({ cornerX: Math.round(cornerDrag.left), cornerY: Math.round(cornerDrag.top) });
    }
    cornerDrag = null;
  }

  function resetCornerPosition() {
    chrome.storage.sync.set({ cornerX: null, cornerY: null });
  }

  function injectCornerSearch() {
    let container = document.getElementById('eql-corner-search-container');
    if (!container) {
      container = document.createElement('div');
      container.id = 'eql-corner-search-container';
      container.innerHTML = `<button class="eql-corner-drag-handle" type="button" title="Drag search box">⋮⋮</button>${searchFormMarkup('eql-corner-search-form', 'Search EQLWiki...')}`;
      document.body.appendChild(container);
      const handle = container.querySelector('.eql-corner-drag-handle');
      handle.addEventListener('pointerdown', startCornerDrag);
      handle.addEventListener('dblclick', resetCornerPosition);
      setupSearchForm(container.querySelector('form'));
    }
    applyCornerPosition(container);
  }

  function removeCornerSearch() {
    document.getElementById('eql-corner-search-container')?.remove();
  }

  function injectCenterSearch() {
    if (document.getElementById('eql-center-search-container')) return;
    const container = document.createElement('div');
    container.id = 'eql-center-search-container';
    container.innerHTML = searchFormMarkup('eql-center-search-form', 'Search EQLWiki (Esc to close)...');
    document.body.appendChild(container);
    const input = container.querySelector('input[name="search"]');
    input.id = 'eql-center-search-input';
    setupSearchForm(container.querySelector('form'));
    document.addEventListener('mousedown', event => {
      if (container.classList.contains('visible') && !container.contains(event.target)) hideCenterSearch();
    });
  }

  function removeCenterSearch() {
    document.getElementById('eql-center-search-container')?.remove();
  }

  function showCenterSearch() {
    if (!settings.centerSearch || settings.hidePageSearchUI) return;
    injectCenterSearch();
    const container = document.getElementById('eql-center-search-container');
    const input = document.getElementById('eql-center-search-input');
    container?.classList.add('visible');
    input?.focus();
    input?.select();
  }

  function hideCenterSearch() {
    document.getElementById('eql-center-search-container')?.classList.remove('visible');
    document.getElementById('eql-center-search-input')?.blur();
  }

  function toggleCenterSearch() {
    const container = document.getElementById('eql-center-search-container');
    if (container?.classList.contains('visible')) hideCenterSearch();
    else showCenterSearch();
  }

  function applySettings() {
    if (settings.freezeHeader) enableStickyHeader();
    else disableStickyHeader();

    if (settings.hidePageSearchUI) {
      removeSideSearch();
      removeCornerSearch();
      removeCenterSearch();
      return;
    }

    if (settings.sideSearch) injectSideSearch(); else removeSideSearch();
    if (settings.cornerSearch) injectCornerSearch(); else removeCornerSearch();
    if (settings.centerSearch) injectCenterSearch(); else removeCenterSearch();

    if (!settings.autocompleteEnabled) document.querySelectorAll('.eql-enhancer-search-form').forEach(hideSuggestions);
  }

  function handleDoublePress(event) {
    if (!settings.sideSearch || !settings.sideDoublePressEnabled || settings.hidePageSearchUI) return false;
    const desired = normalizeHotkeyPart(settings.sideDoublePressKey);
    const actual = normalizeHotkeyPart(event.key === ' ' ? 'Space' : event.key);
    if (!desired || actual !== desired || event.repeat) return false;
    const sideContainer = document.getElementById('eql-left-search-container');
    const targetInsideSideSearch = Boolean(sideContainer && sideContainer.contains(event.target));
    if (isEditableTarget(event.target) && !targetInsideSideSearch && actual !== 'Escape') return false;

    const now = performance.now();
    if (lastDoubleKey === actual && now - lastDoubleTime <= DOUBLE_PRESS_WINDOW) {
      lastDoubleTime = 0;
      lastDoubleKey = '';
      event.preventDefault();
      toggleSideSearch();
      return true;
    }
    lastDoubleKey = actual;
    lastDoubleTime = now;
    return false;
  }

  function onGlobalKeyDown(event) {
    if (event.key === 'Escape') hideCenterSearch();
    if (handleDoublePress(event)) return;
    if (!isEditableTarget(event.target) && settings.centerSearch && matchesShortcut(event, settings.centerSearchShortcut)) {
      event.preventDefault();
      toggleCenterSearch();
      return;
    }
    if (!isEditableTarget(event.target) && settings.sideSearch && settings.sideSearchHotkey && matchesShortcut(event, settings.sideSearchHotkey)) {
      event.preventDefault();
      toggleSideSearch();
    }
  }

  async function loadSettings() {
    const stored = await chrome.storage.sync.get(DEFAULTS);
    settings = { ...DEFAULTS, ...stored };
    applySettings();
  }

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'sync') return;
    Object.keys(changes).forEach(key => { settings[key] = changes[key].newValue; });
    applySettings();
  });

  document.addEventListener('keydown', onGlobalKeyDown, true);
  window.addEventListener('resize', () => {
    const corner = document.getElementById('eql-corner-search-container');
    if (corner) applyCornerPosition(corner);
  }, { passive: true });

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', loadSettings, { once: true });
  else loadSettings();
})();