/**
 * Worldbook Entry Groups — Standalone fixed-size panel, 3 native host entry points
 * (Extensions Drawer `#extensions_settings2`, Magic Wand `#extensionsMenu`, WorldInfo `#world_popup`),
 * O(1) per-chat save stage bar, and scene-group (NSFW) configuration.
 */

import {
    GROUP_MODES,
    SPECIAL_GROUP_UNGROUPED,
    VALID_COLOR_MODES,
    VALID_PALETTES,
    applyAutoGroupProposals,
    buildGroupedView,
    cloneBookConfig,
    computeEntryTogglePlan,
    computeGroupTogglePlan,
    createGroupId,
    detectAutoGroups,
    formatGreetingCommentTag,
    matchEntries,
    normalizeBookConfig,
    normalizeKeywordList,
    pruneOrphanAssignments,
} from './core.js';
import {
    applyTauriSurface,
    applyWorldbookTogglePlan,
    copyTextToClipboard,
    detectHostColorScheme,
    getActiveChatBoundProfile,
    getPreferredDefaultBook,
    getSettings,
    getWorldNames,
    locateEntryInNativeEditor,
    loadWorldbookSummariesUncached,
    recordStateIntoActiveChatIfMatching,
    resolveGreetingCoordinationForBook,
    saveActiveChatBoundProfile,
    showToast,
} from './host.js';

const APP_VERSION = '0.3.0';
const NATIVE_BTN_ID = 'weg-native-entry-btn';
const WAND_ENTRY_ID = 'weg-wand-entry';
const EXT_DRAWER_ID = 'weg-extension-settings';
const MODAL_BACKDROP_ID = 'weg-modal-backdrop';
const FLOATING_MENU_ID = 'weg-floating-menu';
const MAX_UNDO_STEPS = 15;

let _callbacks = null;

let _isOpen = false;
let _currentBook = '';
let _loadingBook = false;
let _writingToggle = false;
let _loadError = '';
/** @type {Array<any>} */
let _loadedSummaries = [];
let _greetingCharName = '';
let _greetingIndex = null;

let _searchQuery = '';
let _isComposing = false;
/** @type {'all' | 'enabled' | 'disabled'} */
let _statusFilter = 'all';
let _batchMode = false;
/** @type {Set<string>} */
const _selectedUids = new Set();

/** @type {Map<string, Array<any>>} */
const _undoStacks = new Map();

let _submodal = null;
let _dragOffset = { x: 0, y: 0 };
let _dragCleanup = null;
let _floatingMenuCleanup = null;

function esc(val) {
    return String(val ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function isNarrowViewport() {
    if (typeof window === 'undefined') return false;
    return window.innerWidth <= 768 || Boolean(window.matchMedia?.('(pointer: coarse)')?.matches);
}

export function bindPanelCallbacks(callbacks) {
    _callbacks = callbacks || null;
}

function notifySettingsChanged() {
    _callbacks?.onSettingsChanged?.();
}

function getBookConfigMutable(settings, worldName) {
    if (!worldName) return normalizeBookConfig(null);
    if (!settings.books || typeof settings.books !== 'object') {
        settings.books = {};
    }
    if (!settings.books[worldName]) {
        settings.books[worldName] = normalizeBookConfig(null);
    } else {
        settings.books[worldName] = normalizeBookConfig(settings.books[worldName]);
    }
    return settings.books[worldName];
}

function saveBookConfigWithCleanEmpty(settings, worldName, bookConfig) {
    if (!worldName) return;
    const norm = normalizeBookConfig(bookConfig);
    if (!settings.books || typeof settings.books !== 'object') {
        settings.books = {};
    }
    if (norm.groups.length === 0 && Object.keys(norm.assignments).length === 0) {
        delete settings.books[worldName];
    } else {
        settings.books[worldName] = norm;
    }
    notifySettingsChanged();
}

function pushUndoSnapshot(worldName, bookConfig) {
    if (!worldName) return;
    if (!_undoStacks.has(worldName)) {
        _undoStacks.set(worldName, []);
    }
    const stack = _undoStacks.get(worldName);
    stack.push(cloneBookConfig(bookConfig));
    if (stack.length > MAX_UNDO_STEPS) {
        stack.shift();
    }
}

function getUndoCount(worldName) {
    if (!worldName) return 0;
    return _undoStacks.get(worldName)?.length || 0;
}

function popUndoSnapshot(worldName) {
    if (!worldName) return null;
    const stack = _undoStacks.get(worldName);
    if (!stack || stack.length === 0) return null;
    return stack.pop() || null;
}

// ============================================================================
// Three Native Host Entry Points:
// 1. Extensions Drawer (`#extensions_settings2`)
// 2. Magic Wand Menu (`#extensionsMenu`)
// 3. WorldInfo Toolbar (`#world_popup`)
// ============================================================================

export function ensureNativeShortcutButton() {
    if (typeof document === 'undefined') return null;
    let btn = document.getElementById(NATIVE_BTN_ID);
    if (btn) return btn;

    const importBtn = document.getElementById('world_import_button');
    const editorSelect = document.getElementById('world_editor_select');
    const editorRow = importBtn?.parentElement || editorSelect?.closest?.('.flex-container') || editorSelect?.parentElement;
    if (!editorRow) return null;

    btn = document.createElement('div');
    btn.id = NATIVE_BTN_ID;
    btn.className = 'menu_button fa-solid fa-fw fa-layer-group weg-native-entry-btn';
    btn.tabIndex = 0;
    btn.setAttribute('role', 'button');
    btn.title = '世界书条目分组（整组开关 / 切档锁线 / 情境开关）';

    if (importBtn && importBtn.parentElement === editorRow) {
        editorRow.insertBefore(btn, importBtn);
    } else {
        editorRow.appendChild(btn);
    }

    requestAnimationFrame(() => {
        if (!btn || !btn.isConnected) return;
        const ref = importBtn || editorRow.querySelector('.menu_button:not(#weg-native-entry-btn)');
        if (ref instanceof HTMLElement) {
            const rect = ref.getBoundingClientRect();
            if (rect.height >= 24 && rect.height <= 48) {
                btn.style.height = `${Math.round(rect.height)}px`;
                btn.style.minWidth = `${Math.round(rect.height)}px`;
            }
        }
    });

    const onTrigger = (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        void openEntryGroupsModal();
    };

    btn.addEventListener('click', onTrigger);
    btn.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' || ev.key === ' ') {
            onTrigger(ev);
        }
    });

    return btn;
}

function ensureWandMenuEntry() {
    if (typeof document === 'undefined') return null;
    let item = document.getElementById(WAND_ENTRY_ID);
    if (item) return item;

    const menu = document.getElementById('extensionsMenu');
    if (!menu) return null;

    item = document.createElement('div');
    item.id = WAND_ENTRY_ID;
    item.className = 'list-group-item flex-container flexGap5 interactable';
    item.tabIndex = 0;
    item.title = '打开世界书条目分组（快速切换 IF 线或分组开关）';
    item.innerHTML = `
        <i class="fa-solid fa-layer-group fa-fw extensionsMenuExtensionButton"></i>
        <span>世界书条目分组</span>
    `;
    item.addEventListener('click', (ev) => {
        ev.stopPropagation();
        menu.style.display = 'none';
        void openEntryGroupsModal();
    });

    menu.appendChild(item);
    return item;
}

function ensureExtensionSettingsDrawer() {
    if (typeof document === 'undefined') return null;
    let box = document.getElementById(EXT_DRAWER_ID);
    if (box) return box;

    const container = document.getElementById('extensions_settings2') || document.getElementById('extensions_settings');
    if (!container) return null;

    const settings = getSettings();
    box = document.createElement('div');
    box.id = EXT_DRAWER_ID;
    box.className = 'inline-drawer';
    box.innerHTML = `
        <div class="inline-drawer-toggle inline-drawer-header">
            <b>世界书条目分组 v${APP_VERSION}</b>
            <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content">
            <div class="weg-ext-drawer-body">
                <div class="weg-ext-route-hint" id="weg-ext-route-hint"></div>
                <div class="menu_button menu_button_icon weg-ext-open-btn" id="weg-ext-open-btn" tabindex="0" role="button">
                    <i class="fa-solid fa-layer-group"></i>
                    <span>打开条目分组管理</span>
                </div>
                <label class="checkbox_label" for="weg-ext-auto-chat-cb">
                    <input id="weg-ext-auto-chat-cb" type="checkbox" ${settings.autoSwitchOnChatChange !== false ? 'checked' : ''} />
                    <span>切换聊天存档时自动恢复本档 IF 线</span>
                </label>
                <label class="checkbox_label" for="weg-ext-scene-auto-cb">
                    <input id="weg-ext-scene-auto-cb" type="checkbox" ${settings.enableSceneAutoToggle !== false ? 'checked' : ''} />
                    <span>按最近对话自动开关情境组（如 NSFW）</span>
                </label>
            </div>
        </div>
    `;

    container.appendChild(box);

    box.querySelector('#weg-ext-open-btn')?.addEventListener('click', () => {
        void openEntryGroupsModal();
    });
    box.querySelector('#weg-ext-auto-chat-cb')?.addEventListener('change', (ev) => {
        const cur = getSettings();
        cur.autoSwitchOnChatChange = Boolean(ev.target?.checked);
        notifySettingsChanged();
    });
    box.querySelector('#weg-ext-scene-auto-cb')?.addEventListener('change', (ev) => {
        const cur = getSettings();
        cur.enableSceneAutoToggle = Boolean(ev.target?.checked);
        notifySettingsChanged();
    });

    return box;
}

export function ensureAllNativeEntryPoints() {
    ensureNativeShortcutButton();
    ensureWandMenuEntry();
    ensureExtensionSettingsDrawer();
}

export function syncAllNativeEntryPoints() {
    if (typeof document === 'undefined') return;
    const settings = getSettings();

    const wiBtn = document.getElementById(NATIVE_BTN_ID);
    if (wiBtn) wiBtn.hidden = settings.showNativeEntryBtn === false;

    const wandItem = document.getElementById(WAND_ENTRY_ID);
    if (wandItem) wandItem.hidden = settings.showWandMenuEntry === false;

    const drawer = document.getElementById(EXT_DRAWER_ID);
    if (drawer) {
        const autoChatCb = drawer.querySelector('#weg-ext-auto-chat-cb');
        if (autoChatCb instanceof HTMLInputElement) {
            autoChatCb.checked = settings.autoSwitchOnChatChange !== false;
        }
        const sceneCb = drawer.querySelector('#weg-ext-scene-auto-cb');
        if (sceneCb instanceof HTMLInputElement) {
            sceneCb.checked = settings.enableSceneAutoToggle !== false;
        }
        const hintEl = drawer.querySelector('#weg-ext-route-hint');
        if (hintEl instanceof HTMLElement) {
            const { saveCtx, profile } = getActiveChatBoundProfile();
            if (!saveCtx) {
                hintEl.textContent = '当前未打开聊天存档';
            } else if (profile) {
                hintEl.textContent = `当前存档路线：${profile.routeLabel}`;
            } else {
                hintEl.textContent = '当前存档暂未锁线（在面板开启任意 IF 线即可记住）';
            }
        }
    }
}

export const syncNativeShortcutButton = syncAllNativeEntryPoints;

export function isEntryGroupsModalOpen() {
    return _isOpen;
}

export function getCurrentModalWorldName() {
    return _isOpen ? _currentBook : '';
}

function applyModalThemeAttributes(modalEl) {
    if (!modalEl) return;
    const settings = getSettings();
    const palette = VALID_PALETTES.includes(settings.palette) ? settings.palette : 'paper';
    const modePref = VALID_COLOR_MODES.includes(settings.colorMode) ? settings.colorMode : 'auto';
    const resolvedScheme = modePref === 'auto' ? detectHostColorScheme() : modePref;

    modalEl.setAttribute('data-weg-palette', palette);
    modalEl.classList.toggle('weg-theme-light', resolvedScheme === 'light');
    modalEl.classList.toggle('weg-theme-dark', resolvedScheme !== 'light');
}

function closeFloatingMenu() {
    if (_floatingMenuCleanup) {
        _floatingMenuCleanup();
        _floatingMenuCleanup = null;
    }
    if (typeof document !== 'undefined') {
        document.getElementById(FLOATING_MENU_ID)?.remove();
    }
}

function openFloatingMenu(anchorEl, items) {
    closeFloatingMenu();
    if (!anchorEl || typeof document === 'undefined') return;

    const menu = document.createElement('div');
    menu.id = FLOATING_MENU_ID;
    menu.className = 'weg-floating-menu';
    menu.setAttribute('role', 'menu');
    applyModalThemeAttributes(menu);

    for (const item of items) {
        if (!item) continue;
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = `weg-floating-menu-item${item.danger ? ' is-danger' : ''}`;
        btn.disabled = Boolean(item.disabled);
        btn.setAttribute('role', 'menuitem');
        btn.innerHTML = `${item.icon ? `<i class="fa-solid ${esc(item.icon)} weg-menu-icon" aria-hidden="true"></i>` : ''}<span>${esc(item.label)}</span>`;
        btn.addEventListener('click', (ev) => {
            ev.stopPropagation();
            closeFloatingMenu();
            if (!item.disabled) item.onClick();
        });
        menu.appendChild(btn);
    }

    document.body.appendChild(menu);

    const anchorRect = anchorEl.getBoundingClientRect();
    const menuRect = menu.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const pad = 8;

    let left = anchorRect.right - menuRect.width;
    if (left < pad) left = pad;
    if (left + menuRect.width > vw - pad) left = Math.max(pad, vw - menuRect.width - pad);

    let top = anchorRect.bottom + 4;
    if (top + menuRect.height > vh - pad && anchorRect.top - menuRect.height - 4 >= pad) {
        top = anchorRect.top - menuRect.height - 4;
    } else if (top + menuRect.height > vh - pad) {
        top = Math.max(pad, vh - menuRect.height - pad);
    }

    menu.style.left = `${Math.round(left)}px`;
    menu.style.top = `${Math.round(top)}px`;

    const onOutsidePointer = (ev) => {
        const target = ev.target instanceof Node ? ev.target : null;
        if (target && (menu.contains(target) || anchorEl.contains(target))) return;
        closeFloatingMenu();
    };
    const onEscape = (ev) => {
        if (ev.key === 'Escape') {
            ev.stopPropagation();
            closeFloatingMenu();
        }
    };

    setTimeout(() => {
        document.addEventListener('pointerdown', onOutsidePointer, true);
        document.addEventListener('keydown', onEscape, true);
    }, 0);

    _floatingMenuCleanup = () => {
        document.removeEventListener('pointerdown', onOutsidePointer, true);
        document.removeEventListener('keydown', onEscape, true);
    };
}

async function loadBookIntoModal(worldName, { silent = false, preserveSelection = false } = {}) {
    const clean = String(worldName ?? '').trim();
    _currentBook = clean;
    _loadError = '';
    if (!preserveSelection) {
        _selectedUids.clear();
    }

    if (!clean) {
        _loadedSummaries = [];
        _greetingCharName = '';
        _greetingIndex = null;
        renderModalContents();
        return;
    }

    const settings = getSettings();
    if (settings.lastOpenedBook !== clean) {
        settings.lastOpenedBook = clean;
        notifySettingsChanged();
    }

    if (!silent) {
        _loadingBook = true;
        renderModalContents();
    }

    const [bookRes, greetRes] = await Promise.all([
        loadWorldbookSummariesUncached(clean),
        settings.syncGreetingTags !== false
            ? resolveGreetingCoordinationForBook(clean, { allowFetchShallow: false })
            : Promise.resolve({ characterName: '', greetingIndex: null }),
    ]);

    if (!_isOpen || _currentBook !== clean) return;

    _loadingBook = false;
    if (!bookRes.ok) {
        _loadError = bookRes.error || '读取世界书失败';
        _loadedSummaries = [];
        _greetingCharName = '';
        _greetingIndex = null;
        renderModalContents();
        return;
    }

    _loadedSummaries = bookRes.summaries;
    _greetingCharName = greetRes.characterName || '';
    _greetingIndex = greetRes.greetingIndex || null;
    void _greetingCharName;

    const curSettings = getSettings();
    if (curSettings.books?.[clean]) {
        const validSet = new Set(_loadedSummaries.map((e) => e.uid));
        const removed = pruneOrphanAssignments(curSettings.books[clean], validSet);
        if (removed > 0) {
            saveBookConfigWithCleanEmpty(curSettings, clean, curSettings.books[clean]);
        }
    }

    if (_selectedUids.size > 0) {
        const validSet = new Set(_loadedSummaries.map((e) => e.uid));
        for (const uid of [..._selectedUids]) {
            if (!validSet.has(uid)) _selectedUids.delete(uid);
        }
    }

    renderModalContents();
}

export async function refreshOpenModalBook({ silent = false } = {}) {
    if (!_isOpen || !_currentBook || _writingToggle) return;
    await loadBookIntoModal(_currentBook, { silent, preserveSelection: true });
}

export function handleExternalWorldbookRenamed(oldName, newName) {
    if (_undoStacks.has(oldName)) {
        _undoStacks.set(newName, _undoStacks.get(oldName));
        _undoStacks.delete(oldName);
    }
    if (_isOpen) {
        if (_currentBook === oldName) {
            _currentBook = newName;
        }
        renderModalContents();
    }
}

export function handleExternalWorldbookDeleted(deletedNames) {
    const delSet = new Set((deletedNames || []).map((n) => String(n ?? '').trim()).filter(Boolean));
    for (const name of delSet) {
        _undoStacks.delete(name);
    }
    if (_isOpen && delSet.has(_currentBook)) {
        const settings = getSettings();
        const fallback = getPreferredDefaultBook(settings);
        void loadBookIntoModal(fallback, { silent: false, preserveSelection: false });
    } else if (_isOpen) {
        renderModalContents();
    }
}

function ensureModalShell() {
    let backdrop = document.getElementById(MODAL_BACKDROP_ID);
    if (backdrop) return backdrop;

    backdrop = document.createElement('div');
    backdrop.id = MODAL_BACKDROP_ID;
    backdrop.className = 'weg-modal-backdrop';
    applyTauriSurface(backdrop, 'backdrop');

    backdrop.addEventListener('click', (ev) => {
        if (ev.target === backdrop) {
            ev.stopPropagation();
        }
    });

    const modal = document.createElement('div');
    modal.className = 'weg-modal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-label', '世界书条目分组');
    applyTauriSurface(modal, 'fullscreen-window');
    applyModalThemeAttributes(modal);

    modal.innerHTML = `
        <header class="weg-header" data-weg-drag-handle="1">
            <div class="weg-header-title-wrap">
                <span class="weg-header-title">世界书条目分组</span>
                <span class="weg-header-stats" id="weg-header-stats"></span>
            </div>
            <div class="weg-header-actions">
                <button type="button" class="weg-btn weg-btn-subtle" id="weg-btn-auto-detect" title="按标题前缀、分隔条、NSFW 或开场白注释自动建组">自动识别</button>
                <button type="button" class="weg-btn weg-btn-primary" id="weg-btn-new-group">新建分组</button>
                <button type="button" class="weg-icon-btn" id="weg-btn-settings" title="外观与联动设置" aria-label="设置">
                    <i class="fa-solid fa-sliders" aria-hidden="true"></i>
                </button>
                <button type="button" class="weg-icon-btn weg-close-btn" id="weg-btn-close" title="关闭窗口" aria-label="关闭">
                    <i class="fa-solid fa-xmark" aria-hidden="true"></i>
                </button>
            </div>
        </header>

        <div class="weg-toolbar">
            <div class="weg-book-bar">
                <select class="weg-select weg-book-select" id="weg-book-select" aria-label="选择世界书"></select>
                <button type="button" class="weg-icon-btn" id="weg-btn-refresh" title="重新读取当前世界书状态" aria-label="刷新">
                    <i class="fa-solid fa-rotate-right" aria-hidden="true"></i>
                </button>
            </div>
            <div class="weg-filter-bar">
                <div class="weg-search-wrap">
                    <i class="fa-solid fa-magnifying-glass weg-search-icon" aria-hidden="true"></i>
                    <input type="text" class="weg-input weg-search-input" id="weg-search-input" placeholder="搜索条目标题、触发词或 UID…" autocomplete="off" />
                    <button type="button" class="weg-clear-input-btn" id="weg-search-clear" title="清空搜索词" hidden>清空</button>
                </div>
                <select class="weg-select weg-status-select" id="weg-status-select" aria-label="筛选条目状态">
                    <option value="all">全部状态</option>
                    <option value="enabled">仅已开启</option>
                    <option value="disabled">仅已关闭</option>
                </select>
            </div>
        </div>

        <div class="weg-save-bar" id="weg-save-bar"></div>

        <main class="weg-body" id="weg-body"></main>

        <footer class="weg-footer" id="weg-footer"></footer>

        <div class="weg-submodal-host" id="weg-submodal-host" hidden></div>
    `;

    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);

    wireShellEvents(modal);
    setupDesktopDragging(modal);

    return backdrop;
}

function setupDesktopDragging(modal) {
    if (_dragCleanup) {
        _dragCleanup();
        _dragCleanup = null;
    }
    const header = modal.querySelector('[data-weg-drag-handle="1"]');
    if (!(header instanceof HTMLElement)) return;

    let dragging = false;
    let startX = 0;
    let startY = 0;
    let baseX = 0;
    let baseY = 0;

    const onPointerDown = (ev) => {
        if (isNarrowViewport()) return;
        if (ev.pointerType === 'mouse' && ev.button !== 0) return;
        const target = ev.target instanceof Element ? ev.target : null;
        if (target?.closest('button, select, input, a')) return;

        dragging = true;
        startX = ev.clientX;
        startY = ev.clientY;
        baseX = _dragOffset.x;
        baseY = _dragOffset.y;
        header.setPointerCapture?.(ev.pointerId);
    };

    const onPointerMove = (ev) => {
        if (!dragging) return;
        const maxDx = Math.max(40, (window.innerWidth - modal.offsetWidth) / 2 + 120);
        const maxDy = Math.max(30, (window.innerHeight - modal.offsetHeight) / 2 + 40);
        _dragOffset.x = Math.max(-maxDx, Math.min(maxDx, baseX + (ev.clientX - startX)));
        _dragOffset.y = Math.max(-maxDy, Math.min(maxDy, baseY + (ev.clientY - startY)));
        modal.style.transform = `translate(${Math.round(_dragOffset.x)}px, ${Math.round(_dragOffset.y)}px)`;
    };

    const onPointerUp = () => {
        dragging = false;
    };

    header.addEventListener('pointerdown', onPointerDown);
    header.addEventListener('pointermove', onPointerMove);
    header.addEventListener('pointerup', onPointerUp);
    header.addEventListener('pointercancel', onPointerUp);

    _dragCleanup = () => {
        header.removeEventListener('pointerdown', onPointerDown);
        header.removeEventListener('pointermove', onPointerMove);
        header.removeEventListener('pointerup', onPointerUp);
        header.removeEventListener('pointercancel', onPointerUp);
    };
}

function wireShellEvents(modal) {
    const closeBtn = modal.querySelector('#weg-btn-close');
    const newGroupBtn = modal.querySelector('#weg-btn-new-group');
    const autoDetectBtn = modal.querySelector('#weg-btn-auto-detect');
    const settingsBtn = modal.querySelector('#weg-btn-settings');
    const bookSelect = modal.querySelector('#weg-book-select');
    const refreshBtn = modal.querySelector('#weg-btn-refresh');
    const searchInput = modal.querySelector('#weg-search-input');
    const searchClearBtn = modal.querySelector('#weg-search-clear');
    const statusSelect = modal.querySelector('#weg-status-select');
    const saveBarEl = modal.querySelector('#weg-save-bar');
    const bodyEl = modal.querySelector('#weg-body');
    const footerEl = modal.querySelector('#weg-footer');

    closeBtn?.addEventListener('click', () => closeEntryGroupsModal());

    newGroupBtn?.addEventListener('click', () => {
        if (!_currentBook) {
            showToast('warning', '请先选择一本世界书');
            return;
        }
        openGroupFormSubmodal(null);
    });

    autoDetectBtn?.addEventListener('click', () => {
        if (!_currentBook || _loadedSummaries.length === 0) {
            showToast('warning', '当前世界书暂无可识别条目');
            return;
        }
        void openAutoDetectSubmodal();
    });

    settingsBtn?.addEventListener('click', () => {
        openSettingsSubmodal();
    });

    bookSelect?.addEventListener('change', (ev) => {
        const nextBook = String(ev.target?.value ?? '').trim();
        _batchMode = false;
        _selectedUids.clear();
        void loadBookIntoModal(nextBook, { silent: false, preserveSelection: false });
    });

    refreshBtn?.addEventListener('click', () => {
        if (!_currentBook) return;
        void loadBookIntoModal(_currentBook, { silent: false, preserveSelection: true });
    });

    if (searchInput instanceof HTMLInputElement) {
        searchInput.addEventListener('compositionstart', () => {
            _isComposing = true;
        });
        searchInput.addEventListener('compositionend', () => {
            _isComposing = false;
            _searchQuery = searchInput.value;
            if (searchClearBtn instanceof HTMLElement) {
                searchClearBtn.hidden = !_searchQuery;
            }
            renderBodyAndFooterOnly();
        });
        searchInput.addEventListener('input', () => {
            if (_isComposing) return;
            _searchQuery = searchInput.value;
            if (searchClearBtn instanceof HTMLElement) {
                searchClearBtn.hidden = !_searchQuery;
            }
            renderBodyAndFooterOnly();
        });
    }

    searchClearBtn?.addEventListener('click', () => {
        if (searchInput instanceof HTMLInputElement) {
            searchInput.value = '';
            if (!isNarrowViewport()) searchInput.focus();
        }
        _searchQuery = '';
        if (searchClearBtn instanceof HTMLElement) searchClearBtn.hidden = true;
        renderBodyAndFooterOnly();
    });

    statusSelect?.addEventListener('change', (ev) => {
        const v = ev.target?.value;
        _statusFilter = v === 'enabled' || v === 'disabled' ? v : 'all';
        renderBodyAndFooterOnly();
    });

    // Pure metadata per-chat save bar actions (zero chat history scan!)
    saveBarEl?.addEventListener('click', (ev) => {
        const target = ev.target instanceof Element ? ev.target : null;
        if (!target) return;
        const btn = target.closest('[data-weg-save-action]');
        if (!(btn instanceof HTMLElement) || btn.hasAttribute('disabled')) return;

        const action = btn.getAttribute('data-weg-save-action');
        if (action === 'bind-current') {
            if (!_currentBook || _loadedSummaries.length === 0) return;
            const prof = recordStateIntoActiveChatIfMatching(_currentBook, _loadedSummaries, {
                greetingIndex: _greetingIndex,
                force: true,
            });
            if (prof) {
                syncAllNativeEntryPoints();
                renderBodyAndFooterOnly();
                showToast('success', `已将当前状态记住到本存档（${prof.routeLabel}）`);
            }
        } else if (action === 'unbind-current') {
            saveActiveChatBoundProfile(null);
            syncAllNativeEntryPoints();
            renderBodyAndFooterOnly();
            showToast('info', '已解除当前聊天存档的路线绑定');
        }
    });

    bodyEl?.addEventListener('click', (ev) => {
        const target = ev.target instanceof Element ? ev.target : null;
        if (!target) return;

        const grpToggle = target.closest('[data-weg-group-toggle]');
        if (grpToggle instanceof HTMLElement) {
            ev.stopPropagation();
            const groupId = grpToggle.getAttribute('data-weg-group-toggle') || '';
            const nextEnabled = grpToggle.getAttribute('data-weg-next-enabled') === '1';
            void handleGroupToggle(groupId, nextEnabled);
            return;
        }

        const grpMenuBtn = target.closest('[data-weg-group-menu]');
        if (grpMenuBtn instanceof HTMLElement) {
            ev.stopPropagation();
            const groupId = grpMenuBtn.getAttribute('data-weg-group-menu') || '';
            openGroupActionsMenu(grpMenuBtn, groupId);
            return;
        }

        const grpHeader = target.closest('[data-weg-group-header]');
        if (grpHeader instanceof HTMLElement) {
            const groupId = grpHeader.getAttribute('data-weg-group-header') || '';
            toggleGroupCollapse(groupId);
            return;
        }

        const entryToggle = target.closest('[data-weg-entry-toggle]');
        if (entryToggle instanceof HTMLElement) {
            ev.stopPropagation();
            const uid = entryToggle.getAttribute('data-weg-entry-toggle') || '';
            const nextEnabled = entryToggle.getAttribute('data-weg-next-enabled') === '1';
            void handleEntryToggle(uid, nextEnabled);
            return;
        }

        const entryMenuBtn = target.closest('[data-weg-entry-menu]');
        if (entryMenuBtn instanceof HTMLElement) {
            ev.stopPropagation();
            const uid = entryMenuBtn.getAttribute('data-weg-entry-menu') || '';
            openEntryActionsMenu(entryMenuBtn, uid);
            return;
        }

        const entryRow = target.closest('[data-weg-entry-row]');
        if (_batchMode && entryRow instanceof HTMLElement) {
            const uid = entryRow.getAttribute('data-weg-entry-row') || '';
            if (!uid) return;
            if (_selectedUids.has(uid)) _selectedUids.delete(uid);
            else _selectedUids.add(uid);
            renderBodyAndFooterOnly();
        }
    });

    footerEl?.addEventListener('click', (ev) => {
        const target = ev.target instanceof Element ? ev.target : null;
        if (!target) return;
        const actionBtn = target.closest('[data-weg-footer-action]');
        if (!(actionBtn instanceof HTMLElement) || actionBtn.hasAttribute('disabled')) return;

        const action = actionBtn.getAttribute('data-weg-footer-action');
        if (action === 'enter-batch') {
            _batchMode = true;
            _selectedUids.clear();
            renderBodyAndFooterOnly();
        } else if (action === 'exit-batch') {
            _batchMode = false;
            _selectedUids.clear();
            renderBodyAndFooterOnly();
        } else if (action === 'select-visible') {
            toggleSelectAllVisibleEntries();
        } else if (action === 'batch-move') {
            if (_selectedUids.size === 0) {
                showToast('info', '请先点击条目勾选要移动的项');
                return;
            }
            openBatchMoveSubmodal([..._selectedUids]);
        } else if (action === 'toggle-collapse-all') {
            toggleCollapseAllGroups();
        } else if (action === 'undo') {
            handleUndoLastGroupChange();
        }
    });
}

export async function openEntryGroupsModal(opts = {}) {
    if (typeof document === 'undefined') return;
    const settings = getSettings();
    const backdrop = ensureModalShell();
    const modal = backdrop.querySelector('.weg-modal');
    if (modal instanceof HTMLElement) {
        applyModalThemeAttributes(modal);
        if (isNarrowViewport()) {
            _dragOffset = { x: 0, y: 0 };
            modal.style.transform = '';
        }
    }

    _isOpen = true;
    backdrop.hidden = false;

    const requestedBook = String(opts?.worldName ?? '').trim();
    const names = getWorldNames();
    let targetBook = '';
    if (requestedBook && names.includes(requestedBook)) {
        targetBook = requestedBook;
    } else if (_currentBook && names.includes(_currentBook)) {
        targetBook = _currentBook;
    } else {
        targetBook = getPreferredDefaultBook(settings);
    }

    await loadBookIntoModal(targetBook, { silent: false, preserveSelection: false });

    if (!isNarrowViewport()) {
        const searchInput = backdrop.querySelector('#weg-search-input');
        if (searchInput instanceof HTMLInputElement) {
            requestAnimationFrame(() => searchInput.focus({ preventScroll: true }));
        }
    }
}

export function closeEntryGroupsModal() {
    closeFloatingMenu();
    _submodal = null;
    _isOpen = false;
    _loadingBook = false;
    _loadError = '';
    _loadedSummaries = [];
    _greetingCharName = '';
    _greetingIndex = null;
    _batchMode = false;
    _selectedUids.clear();

    if (typeof document !== 'undefined') {
        const backdrop = document.getElementById(MODAL_BACKDROP_ID);
        if (backdrop) {
            backdrop.hidden = true;
            const bodyEl = backdrop.querySelector('#weg-body');
            if (bodyEl) bodyEl.innerHTML = '';
            const subHost = backdrop.querySelector('#weg-submodal-host');
            if (subHost instanceof HTMLElement) {
                subHost.hidden = true;
                subHost.innerHTML = '';
            }
        }
    }
}

export function teardownPanels() {
    closeEntryGroupsModal();
    if (_dragCleanup) {
        _dragCleanup();
        _dragCleanup = null;
    }
    _undoStacks.clear();
    if (typeof document !== 'undefined') {
        document.getElementById(MODAL_BACKDROP_ID)?.remove();
        document.getElementById(NATIVE_BTN_ID)?.remove();
        document.getElementById(WAND_ENTRY_ID)?.remove();
        document.getElementById(EXT_DRAWER_ID)?.remove();
    }
}

function toggleGroupCollapse(groupId) {
    if (!_currentBook) return;
    const settings = getSettings();
    const bookCfg = getBookConfigMutable(settings, _currentBook);

    if (groupId === SPECIAL_GROUP_UNGROUPED) {
        bookCfg.ungroupedCollapsed = !bookCfg.ungroupedCollapsed;
    } else {
        const grp = bookCfg.groups.find((g) => g.id === groupId);
        if (!grp) return;
        grp.collapsed = !grp.collapsed;
    }
    saveBookConfigWithCleanEmpty(settings, _currentBook, bookCfg);
    renderBodyAndFooterOnly();
}

function toggleCollapseAllGroups() {
    if (!_currentBook) return;
    const settings = getSettings();
    const bookCfg = getBookConfigMutable(settings, _currentBook);
    const allCollapsed = bookCfg.groups.every((g) => g.collapsed) && bookCfg.ungroupedCollapsed;
    const nextCollapsed = !allCollapsed;
    for (const g of bookCfg.groups) {
        g.collapsed = nextCollapsed;
    }
    bookCfg.ungroupedCollapsed = nextCollapsed;
    saveBookConfigWithCleanEmpty(settings, _currentBook, bookCfg);
    renderBodyAndFooterOnly();
}

function handleUndoLastGroupChange() {
    if (!_currentBook) return;
    const prev = popUndoSnapshot(_currentBook);
    if (!prev) return;
    const settings = getSettings();
    saveBookConfigWithCleanEmpty(settings, _currentBook, prev);
    renderModalContents();
    showToast('info', '已撤销上一步分组操作');
}

async function handleGroupToggle(groupId, targetEnabled, { forceBindChat = false } = {}) {
    if (!_currentBook || _writingToggle || _loadingBook) return;
    const settings = getSettings();
    const bookCfg = getBookConfigMutable(settings, _currentBook);
    const plan = computeGroupTogglePlan(_loadedSummaries, bookCfg, groupId, targetEnabled);

    const targetBook = _currentBook;
    const grp = bookCfg.groups.find((g) => g.id === groupId);

    if (plan.size > 0) {
        _writingToggle = true;
        renderBodyAndFooterOnly();

        const res = await applyWorldbookTogglePlan(targetBook, plan);
        _writingToggle = false;

        if (!_isOpen || _currentBook !== targetBook) return;
        if (!res.ok) {
            showToast('error', res.error || '切换整组开关失败');
            renderBodyAndFooterOnly();
            return;
        }
        _loadedSummaries = res.summaries;
    }

    // Do NOT overwrite save route binding when manually toggling a transient `scene` (NSFW) group!
    let bound = null;
    if (grp?.mode !== GROUP_MODES.SCENE || forceBindChat) {
        bound = recordStateIntoActiveChatIfMatching(targetBook, _loadedSummaries, {
            preferredIfGroupId: grp?.mode === GROUP_MODES.IF_LINE && targetEnabled ? grp.id : '',
            customLabel: grp?.mode === GROUP_MODES.IF_LINE && targetEnabled ? grp.name : '',
            greetingIndex: _greetingIndex,
            force: forceBindChat,
        });
        syncAllNativeEntryPoints();
    }

    if (grp?.mode === GROUP_MODES.IF_LINE && targetEnabled) {
        showToast(
            'success',
            bound
                ? `已切换本档阶段至「${grp.name}」`
                : `已切换至「${grp.name}」，其余 IF 线已自动关闭`,
        );
    }
    renderModalContents();
}

async function handleEntryToggle(uid, targetEnabled) {
    if (!_currentBook || _writingToggle || _loadingBook) return;
    const settings = getSettings();
    const bookCfg = getBookConfigMutable(settings, _currentBook);
    const plan = computeEntryTogglePlan(_loadedSummaries, bookCfg, uid, targetEnabled);
    if (plan.size === 0) return;

    _writingToggle = true;
    renderBodyAndFooterOnly();

    const targetBook = _currentBook;
    const res = await applyWorldbookTogglePlan(targetBook, plan);
    _writingToggle = false;

    if (!_isOpen || _currentBook !== targetBook) return;
    if (!res.ok) {
        showToast('error', res.error || '切换条目状态失败');
        renderBodyAndFooterOnly();
        return;
    }

    _loadedSummaries = res.summaries;
    recordStateIntoActiveChatIfMatching(targetBook, _loadedSummaries, {
        greetingIndex: _greetingIndex,
    });
    syncAllNativeEntryPoints();

    renderModalContents();
}

function toggleSelectAllVisibleEntries() {
    const settings = getSettings();
    const matchedSet = matchEntries(_loadedSummaries, _searchQuery, {
        multiTerm: Boolean(settings.searchMultiTerm),
        statusFilter: _statusFilter,
        greetingByUid: _greetingIndex?.byUid || null,
    });
    const visibleUids = [...matchedSet];
    if (visibleUids.length === 0) return;

    const allSelected = visibleUids.every((u) => _selectedUids.has(u));
    if (allSelected) {
        for (const u of visibleUids) _selectedUids.delete(u);
    } else {
        for (const u of visibleUids) _selectedUids.add(u);
    }
    renderBodyAndFooterOnly();
}

function openGroupActionsMenu(anchorEl, groupId) {
    if (!_currentBook) return;
    const settings = getSettings();
    const bookCfg = getBookConfigMutable(settings, _currentBook);

    if (groupId === SPECIAL_GROUP_UNGROUPED) {
        const ungroupedUids = _loadedSummaries
            .filter((e) => !bookCfg.assignments[e.uid])
            .map((e) => e.uid);

        openFloatingMenu(anchorEl, [
            {
                label: '勾选未分组条目批量移组',
                icon: 'fa-check-double',
                disabled: ungroupedUids.length === 0,
                onClick: () => {
                    _batchMode = true;
                    _selectedUids.clear();
                    for (const u of ungroupedUids) _selectedUids.add(u);
                    renderBodyAndFooterOnly();
                },
            },
            {
                label: '自动识别未分组条目',
                icon: 'fa-wand-magic-sparkles',
                disabled: ungroupedUids.length === 0,
                onClick: () => {
                    void openAutoDetectSubmodal();
                },
            },
        ]);
        return;
    }

    const idx = bookCfg.groups.findIndex((g) => g.id === groupId);
    const grp = idx >= 0 ? bookCfg.groups[idx] : null;
    if (!grp) return;

    const groupUids = _loadedSummaries
        .filter((e) => bookCfg.assignments[e.uid] === groupId)
        .map((e) => e.uid);

    const { saveCtx } = getActiveChatBoundProfile(_currentBook);
    const isCurrentChatBook = Boolean(saveCtx && saveCtx.primaryWorldName === _currentBook);

    openFloatingMenu(anchorEl, [
        ...(isCurrentChatBook && grp.mode !== GROUP_MODES.SCENE ? [{
            label: '切换到此线并记为本档当前阶段',
            icon: 'fa-bookmark',
            disabled: groupUids.length === 0,
            onClick: () => {
                if (grp.mode === GROUP_MODES.NORMAL) {
                    grp.mode = GROUP_MODES.IF_LINE;
                    saveBookConfigWithCleanEmpty(settings, _currentBook, bookCfg);
                }
                void handleGroupToggle(groupId, true, { forceBindChat: true });
            },
        }] : []),
        {
            label: '编辑名称、模式与触发词',
            icon: 'fa-pen',
            onClick: () => openGroupFormSubmodal(grp),
        },
        {
            label: grp.mode === GROUP_MODES.IF_LINE ? '改回普通组' : '设为 IF 线互斥组',
            icon: 'fa-code-branch',
            onClick: () => {
                pushUndoSnapshot(_currentBook, bookCfg);
                grp.mode = grp.mode === GROUP_MODES.IF_LINE ? GROUP_MODES.NORMAL : GROUP_MODES.IF_LINE;
                saveBookConfigWithCleanEmpty(settings, _currentBook, bookCfg);
                renderModalContents();
            },
        },
        {
            label: grp.mode === GROUP_MODES.SCENE ? '取消情境按需（改为普通组）' : '设为情境按需组（如 NSFW）',
            icon: 'fa-bolt',
            onClick: () => {
                pushUndoSnapshot(_currentBook, bookCfg);
                grp.mode = grp.mode === GROUP_MODES.SCENE ? GROUP_MODES.NORMAL : GROUP_MODES.SCENE;
                saveBookConfigWithCleanEmpty(settings, _currentBook, bookCfg);
                renderModalContents();
                showToast('info', grp.mode === GROUP_MODES.SCENE
                    ? `已将「${grp.name}」设为情境按需组（日常关 / 触发自动开）`
                    : `已将「${grp.name}」改回普通组`);
            },
        },
        {
            label: '勾选本组条目批量移动',
            icon: 'fa-check-double',
            disabled: groupUids.length === 0,
            onClick: () => {
                _batchMode = true;
                _selectedUids.clear();
                for (const u of groupUids) _selectedUids.add(u);
                renderBodyAndFooterOnly();
            },
        },
        {
            label: '复制开场白联动标签',
            icon: 'fa-copy',
            disabled: groupUids.length === 0,
            onClick: async () => {
                const tag = formatGreetingCommentTag(groupUids, 'lore');
                if (!tag) {
                    showToast('warning', '本组没有可导出数字 UID 的条目');
                    return;
                }
                const ok = await copyTextToClipboard(tag);
                showToast(ok ? 'success' : 'warning', ok
                    ? `已复制：${tag}`
                    : `请手动复制：${tag}`);
            },
        },
        {
            label: '上移分组',
            icon: 'fa-arrow-up',
            disabled: idx <= 0,
            onClick: () => {
                pushUndoSnapshot(_currentBook, bookCfg);
                const [item] = bookCfg.groups.splice(idx, 1);
                bookCfg.groups.splice(idx - 1, 0, item);
                saveBookConfigWithCleanEmpty(settings, _currentBook, bookCfg);
                renderBodyAndFooterOnly();
            },
        },
        {
            label: '下移分组',
            icon: 'fa-arrow-down',
            disabled: idx >= bookCfg.groups.length - 1,
            onClick: () => {
                pushUndoSnapshot(_currentBook, bookCfg);
                const [item] = bookCfg.groups.splice(idx, 1);
                bookCfg.groups.splice(idx + 1, 0, item);
                saveBookConfigWithCleanEmpty(settings, _currentBook, bookCfg);
                renderBodyAndFooterOnly();
            },
        },
        {
            label: '解散分组（条目退回未分组）',
            icon: 'fa-folder-minus',
            danger: true,
            onClick: () => {
                pushUndoSnapshot(_currentBook, bookCfg);
                bookCfg.groups.splice(idx, 1);
                for (const [u, gid] of Object.entries(bookCfg.assignments)) {
                    if (gid === groupId) delete bookCfg.assignments[u];
                }
                saveBookConfigWithCleanEmpty(settings, _currentBook, bookCfg);
                renderModalContents();
                showToast('info', `已解散分组「${grp.name}」，可随时点底部撤销恢复`);
            },
        },
    ]);
}

function openEntryActionsMenu(anchorEl, uid) {
    if (!_currentBook) return;
    const entry = _loadedSummaries.find((e) => e.uid === uid);
    if (!entry) return;

    const settings = getSettings();
    const bookCfg = getBookConfigMutable(settings, _currentBook);
    const currentGroupId = bookCfg.assignments[uid] || SPECIAL_GROUP_UNGROUPED;

    openFloatingMenu(anchorEl, [
        {
            label: '在酒馆原生编辑器中定位',
            icon: 'fa-location-crosshairs',
            onClick: async () => {
                const targetBook = _currentBook;
                const shouldClose = settings.closeOnLocate !== false;
                if (shouldClose) {
                    closeEntryGroupsModal();
                }
                const ok = await locateEntryInNativeEditor(targetBook, entry.uid, entry.rawComment || entry.title);
                if (!ok) {
                    showToast('info', `已打开世界书「${targetBook}」，请查看条目 #${entry.uid}`);
                }
            },
        },
        {
            label: '移入其他分组…',
            icon: 'fa-folder-tree',
            onClick: () => openBatchMoveSubmodal([uid]),
        },
        ...(currentGroupId !== SPECIAL_GROUP_UNGROUPED ? [{
            label: '移回未分组',
            icon: 'fa-rotate-left',
            onClick: () => {
                pushUndoSnapshot(_currentBook, bookCfg);
                delete bookCfg.assignments[uid];
                saveBookConfigWithCleanEmpty(settings, _currentBook, bookCfg);
                renderBodyAndFooterOnly();
            },
        }] : []),
        {
            label: '复制条目联动注释',
            icon: 'fa-copy',
            onClick: async () => {
                const tag = formatGreetingCommentTag([uid], 'lore');
                if (!tag) return;
                const ok = await copyTextToClipboard(tag);
                if (ok) showToast('success', `已复制：${tag}`);
            },
        },
    ]);
}

function renderModalContents() {
    if (!_isOpen || typeof document === 'undefined') return;
    const backdrop = document.getElementById(MODAL_BACKDROP_ID);
    if (!backdrop) return;

    const modal = backdrop.querySelector('.weg-modal');
    if (modal instanceof HTMLElement) {
        applyModalThemeAttributes(modal);
    }

    const bookSelect = backdrop.querySelector('#weg-book-select');
    if (bookSelect instanceof HTMLSelectElement) {
        const names = getWorldNames();
        if (names.length === 0) {
            bookSelect.innerHTML = '<option value="">暂无可用世界书</option>';
            bookSelect.disabled = true;
        } else {
            bookSelect.disabled = false;
            bookSelect.innerHTML = names
                .map((n) => `<option value="${esc(n)}"${n === _currentBook ? ' selected' : ''}>${esc(n)}</option>`)
                .join('');
        }
    }

    renderBodyAndFooterOnly();
    renderSubmodalHost();
}

function renderSaveBindingBar(saveBarEl) {
    if (!(saveBarEl instanceof HTMLElement)) return;

    const { saveCtx, profile } = getActiveChatBoundProfile(_currentBook);
    if (!saveCtx) {
        saveBarEl.innerHTML = `
            <span class="weg-save-bar-text is-muted">当前未进入聊天存档（进入对话后，开启任意 IF 线即可记住本档阶段）</span>
        `;
        return;
    }

    if (saveCtx.primaryWorldName !== _currentBook) {
        const hint = saveCtx.primaryWorldName
            ? `当前聊天角色主书为「${saveCtx.primaryWorldName}」，切回该书可管理本档路线`
            : '当前聊天角色尚未绑定主世界书';
        saveBarEl.innerHTML = `<span class="weg-save-bar-text is-muted">${esc(hint)}</span>`;
        return;
    }

    const shortChatId = saveCtx.chatId.length > 22 ? `${saveCtx.chatId.slice(0, 22)}…` : saveCtx.chatId;

    if (profile) {
        saveBarEl.innerHTML = `
            <div class="weg-save-bar-info" title="仅存储于当前存档元数据，不扫描聊天记录；剧情推进（如 18岁→30岁）时直接打开新阶段分组即可覆盖更新">
                <i class="fa-solid fa-bookmark weg-save-icon is-bound" aria-hidden="true"></i>
                <span class="weg-save-bar-text">本档当前阶段：<strong>${esc(profile.routeLabel)}</strong> <span class="weg-save-chatid">(${esc(shortChatId)})</span></span>
            </div>
            <div class="weg-save-bar-actions">
                <button type="button" class="weg-mini-btn" data-weg-save-action="bind-current" title="将当前开关组合更新为本档记忆">更新本档</button>
                <button type="button" class="weg-mini-btn is-muted" data-weg-save-action="unbind-current" title="解除本存档绑定">解除</button>
            </div>
        `;
    } else {
        saveBarEl.innerHTML = `
            <div class="weg-save-bar-info" title="聊天存档：${esc(saveCtx.chatId)}">
                <i class="fa-regular fa-bookmark weg-save-icon" aria-hidden="true"></i>
                <span class="weg-save-bar-text is-muted">当前存档（${esc(shortChatId)}）暂未锁线，直接打开目标 IF 线或点右侧即可记住</span>
            </div>
            <div class="weg-save-bar-actions">
                <button type="button" class="weg-mini-btn is-primary" data-weg-save-action="bind-current" ${_loadedSummaries.length === 0 ? 'disabled' : ''}>锁定当前状态到本档</button>
            </div>
        `;
    }
}

function renderBodyAndFooterOnly() {
    if (!_isOpen || typeof document === 'undefined') return;
    const backdrop = document.getElementById(MODAL_BACKDROP_ID);
    if (!backdrop) return;

    const statsEl = backdrop.querySelector('#weg-header-stats');
    const saveBarEl = backdrop.querySelector('#weg-save-bar');
    const bodyEl = backdrop.querySelector('#weg-body');
    const footerEl = backdrop.querySelector('#weg-footer');
    if (!(bodyEl instanceof HTMLElement) || !(footerEl instanceof HTMLElement)) return;

    const prevScrollTop = bodyEl.scrollTop;
    const settings = getSettings();
    const bookCfg = _currentBook ? getBookConfigMutable(settings, _currentBook) : normalizeBookConfig(null);
    const grouped = buildGroupedView(_loadedSummaries, bookCfg);

    renderSaveBindingBar(saveBarEl);

    if (statsEl instanceof HTMLElement) {
        if (!_currentBook) {
            statsEl.textContent = '';
        } else if (_loadingBook) {
            statsEl.textContent = '正在读取…';
        } else {
            statsEl.textContent = `已开 ${grouped.totalEnabled} / ${grouped.totalEntries} 条`;
        }
    }

    if (!_currentBook) {
        bodyEl.innerHTML = `
            <div class="weg-empty-state">
                <p class="weg-empty-title">当前还没有可管理的世界书</p>
                <p class="weg-empty-desc">先在酒馆导入或创建世界书后，即可在这里按分组、IF 线或情境管理条目开关。</p>
            </div>
        `;
    } else if (_loadingBook) {
        bodyEl.innerHTML = `
            <div class="weg-empty-state">
                <p class="weg-empty-title">正在读取「${esc(_currentBook)}」…</p>
                <p class="weg-empty-desc">采用不占宿主缓存的轻量直读方式，仅加载条目摘要。</p>
            </div>
        `;
    } else if (_loadError) {
        bodyEl.innerHTML = `
            <div class="weg-empty-state">
                <p class="weg-empty-title">${esc(_loadError)}</p>
                <p class="weg-empty-desc">请点击上方刷新按钮重试，或检查该世界书文件是否仍存在。</p>
            </div>
        `;
    } else if (_loadedSummaries.length === 0) {
        bodyEl.innerHTML = `
            <div class="weg-empty-state">
                <p class="weg-empty-title">「${esc(_currentBook)}」里还没有条目</p>
                <p class="weg-empty-desc">在酒馆原生世界书编辑器添加条目后，点击上方刷新即可开始分组。</p>
            </div>
        `;
    } else {
        const matchedUidSet = matchEntries(_loadedSummaries, _searchQuery, {
            multiTerm: Boolean(settings.searchMultiTerm),
            statusFilter: _statusFilter,
            greetingByUid: _greetingIndex?.byUid || null,
        });
        const isFiltering = Boolean(_searchQuery.trim()) || _statusFilter !== 'all';

        const conflictNoticeHtml = grouped.ifLineSummary.hasConflict ? `
            <div class="weg-inline-notice">
                <span>当前有 ${grouped.ifLineSummary.activeGroupNames.length} 条 IF 线同时存在开启条目（${esc(grouped.ifLineSummary.activeGroupNames.join('、'))}）。开启任意一条 IF 线组将自动收起其余线。</span>
            </div>
        ` : '';

        const sectionsHtml = [];
        for (const sec of grouped.sections) {
            if (sec.isUngrouped && sec.totalCount === 0 && grouped.sections.length > 1) {
                continue;
            }

            const visibleEntries = isFiltering
                ? sec.entries.filter((e) => matchedUidSet.has(e.uid))
                : sec.entries;

            if (isFiltering && visibleEntries.length === 0) {
                continue;
            }

            const effectiveCollapsed = isFiltering ? false : sec.collapsed;
            let modeBadge = '';
            if (sec.mode === GROUP_MODES.IF_LINE) {
                modeBadge = '<span class="weg-badge weg-badge-if" title="开启本组时自动关闭本书其他 IF 线组，并更新本档当前阶段">IF 互斥</span>';
            } else if (sec.mode === GROUP_MODES.SCENE) {
                const sceneAutoOn = settings.enableSceneAutoToggle !== false;
                modeBadge = `<span class="weg-badge weg-badge-scene" title="${sceneAutoOn ? '日常自动关闭，最近对话出现触发词时当轮自动开启' : '情境自动开关已在设置中关闭，当前仅手动控制'}">情境按需</span>`;
            } else if (sec.mode === GROUP_MODES.RADIO) {
                modeBadge = '<span class="weg-badge weg-badge-radio" title="开启本组任意一条时，自动关闭本组其余条目">组内单选</span>';
            }

            const switchOn = sec.mode === GROUP_MODES.RADIO ? sec.enabledCount > 0 : sec.allEnabled;
            const switchPartial = !switchOn && sec.someEnabled;
            const nextGroupEnabled = switchOn ? '0' : '1';

            let rowsHtml = '';
            if (!effectiveCollapsed) {
                if (visibleEntries.length === 0) {
                    rowsHtml = `<div class="weg-group-empty">暂无条目，可通过底部「多选移组」或条目菜单移入</div>`;
                } else {
                    rowsHtml = `<div class="weg-entry-list">${visibleEntries.map((entry) => renderEntryRowHtml(entry)).join('')}</div>`;
                }
            }

            sectionsHtml.push(`
                <section class="weg-group-card${sec.mode === GROUP_MODES.IF_LINE && sec.enabledCount > 0 ? ' is-active-if' : ''}">
                    <div class="weg-group-header" data-weg-group-header="${esc(sec.id)}">
                        <div class="weg-group-header-main">
                            <i class="fa-solid fa-chevron-${effectiveCollapsed ? 'right' : 'down'} weg-chevron" aria-hidden="true"></i>
                            <span class="weg-group-name">${esc(sec.name)}</span>
                            ${modeBadge}
                            <span class="weg-group-count">${sec.enabledCount}/${sec.totalCount}</span>
                        </div>
                        <div class="weg-row-controls">
                            <button
                                type="button"
                                class="weg-switch${switchOn ? ' is-on' : ''}${switchPartial ? ' is-partial' : ''}"
                                role="switch"
                                aria-checked="${switchOn ? 'true' : 'false'}"
                                aria-label="切换分组 ${esc(sec.name)}"
                                data-weg-group-toggle="${esc(sec.id)}"
                                data-weg-next-enabled="${nextGroupEnabled}"
                                ${sec.totalCount === 0 || _writingToggle ? 'disabled' : ''}
                            >
                                <span class="weg-switch-thumb"></span>
                            </button>
                            <button
                                type="button"
                                class="weg-more-btn"
                                aria-label="分组操作菜单"
                                data-weg-group-menu="${esc(sec.id)}"
                            >···</button>
                        </div>
                    </div>
                    ${rowsHtml}
                </section>
            `);
        }

        if (sectionsHtml.length === 0) {
            bodyEl.innerHTML = `
                <div class="weg-empty-state">
                    <p class="weg-empty-title">没有匹配的条目</p>
                    <p class="weg-empty-desc">尝试清空搜索词或将状态筛选切回「全部状态」。</p>
                </div>
            `;
        } else {
            bodyEl.innerHTML = `${conflictNoticeHtml}${sectionsHtml.join('')}`;
        }
    }

    bodyEl.scrollTop = prevScrollTop;

    const undoCount = getUndoCount(_currentBook);
    const allGroupsCollapsed = bookCfg.groups.every((g) => g.collapsed) && bookCfg.ungroupedCollapsed;

    if (_batchMode) {
        footerEl.innerHTML = `
            <div class="weg-footer-status">已选 <strong>${_selectedUids.size}</strong> 条（点击条目行可直接勾选）</div>
            <div class="weg-footer-buttons">
                <button type="button" class="weg-btn weg-btn-subtle" data-weg-footer-action="select-visible">全选当前</button>
                <button type="button" class="weg-btn weg-btn-primary" data-weg-footer-action="batch-move" ${_selectedUids.size === 0 ? 'disabled' : ''}>移入分组…</button>
                <button type="button" class="weg-btn weg-btn-subtle" data-weg-footer-action="exit-batch">完成</button>
            </div>
        `;
    } else {
        const customGroupCount = bookCfg.groups.length;
        const statusText = _writingToggle
            ? '正在单次合并保存世界书…'
            : (_currentBook ? `共 ${customGroupCount} 个自定义分组` : '未选择世界书');
        footerEl.innerHTML = `
            <div class="weg-footer-status">${esc(statusText)}</div>
            <div class="weg-footer-buttons">
                <button type="button" class="weg-btn weg-btn-subtle" data-weg-footer-action="enter-batch" ${_loadedSummaries.length === 0 ? 'disabled' : ''}>多选移组</button>
                <button type="button" class="weg-btn weg-btn-subtle" data-weg-footer-action="toggle-collapse-all" ${_loadedSummaries.length === 0 ? 'disabled' : ''}>${allGroupsCollapsed ? '全部展开' : '全部折叠'}</button>
                <button type="button" class="weg-btn weg-btn-subtle" data-weg-footer-action="undo" ${undoCount === 0 ? 'disabled' : ''}>撤销${undoCount > 0 ? ` (${undoCount})` : ''}</button>
            </div>
        `;
    }
}

function renderEntryRowHtml(entry) {
    const isEnabled = !entry.disabled;
    const isSelected = _selectedUids.has(entry.uid);

    let dotClass = 'is-normal';
    let dotTitle = '关键词触发条目';
    if (entry.constant) {
        dotClass = 'is-constant';
        dotTitle = '常驻条目（蓝灯）';
    } else if (entry.vectorized) {
        dotClass = 'is-vector';
        dotTitle = '向量触发条目';
    }

    let greetingBadgeHtml = '';
    const greetMeta = _greetingIndex?.byUid?.get?.(entry.uid);
    if (greetMeta) {
        const incList = greetMeta.includeGreetings;
        const excList = greetMeta.excludeGreetings;
        if (incList.length > 0) {
            const first = incList[0];
            const shortText = incList.length === 1
                ? (first.title ? `${first.label} ${first.title.slice(0, 8)}` : `开场白 ${first.label}`)
                : `开场白 ×${incList.length}`;
            const fullTip = `关联开场白注释（开启于：${incList.map((g) => (g.title ? `${g.label} ${g.title}` : g.label)).join('、')}）`;
            greetingBadgeHtml = `<span class="weg-greet-tag" title="${esc(fullTip)}">${esc(shortText)}</span>`;
        } else if (excList.length > 0) {
            const fullTip = `在开场白 ${excList.map((g) => (g.title ? `${g.label} ${g.title}` : g.label)).join('、')} 中自动排除关闭`;
            greetingBadgeHtml = `<span class="weg-greet-tag is-exclude" title="${esc(fullTip)}">排除联动</span>`;
        }
    }

    const keysPreview = entry.keys.length > 0 ? `触发词：${entry.keys.join('、')}` : '无触发词';
    const rowTooltip = `[#${entry.uid}] ${entry.title}\n${keysPreview}`;

    const batchCheckboxHtml = _batchMode
        ? `<span class="weg-checkbox${isSelected ? ' is-checked' : ''}" aria-hidden="true">${isSelected ? '✓' : ''}</span>`
        : '';

    return `
        <div class="weg-entry-row${isEnabled ? '' : ' is-disabled'}${_batchMode ? ' is-batch' : ''}${isSelected ? ' is-selected' : ''}" data-weg-entry-row="${esc(entry.uid)}">
            <div class="weg-entry-main" title="${esc(rowTooltip)}">
                ${batchCheckboxHtml}
                <span class="weg-strategy-dot ${dotClass}" title="${esc(dotTitle)}"></span>
                <span class="weg-entry-uid">#${esc(entry.uid)}</span>
                <span class="weg-entry-title">${esc(entry.title)}</span>
                ${greetingBadgeHtml}
            </div>
            <div class="weg-row-controls">
                <button
                    type="button"
                    class="weg-switch weg-switch-sm${isEnabled ? ' is-on' : ''}"
                    role="switch"
                    aria-checked="${isEnabled ? 'true' : 'false'}"
                    aria-label="切换条目 ${esc(entry.title)}"
                    data-weg-entry-toggle="${esc(entry.uid)}"
                    data-weg-next-enabled="${isEnabled ? '0' : '1'}"
                    ${_writingToggle ? 'disabled' : ''}
                >
                    <span class="weg-switch-thumb"></span>
                </button>
                <button
                    type="button"
                    class="weg-more-btn"
                    aria-label="条目操作菜单"
                    data-weg-entry-menu="${esc(entry.uid)}"
                >···</button>
            </div>
        </div>
    `;
}

// ============================================================================
// Submodals
// ============================================================================

function closeSubmodal() {
    _submodal = null;
    renderSubmodalHost();
}

function openGroupFormSubmodal(existingGroup = null) {
    _submodal = {
        type: 'group-form',
        groupId: existingGroup?.id || null,
        initialName: existingGroup?.name || '',
        mode: existingGroup?.mode || GROUP_MODES.NORMAL,
        sceneKeywordsText: (existingGroup?.sceneKeywords || []).join(', '),
        cooldownTurns: existingGroup?.cooldownTurns || 2,
    };
    renderSubmodalHost();
}

function openBatchMoveSubmodal(uids) {
    _submodal = {
        type: 'batch-move',
        uids: [...new Set(uids)],
    };
    renderSubmodalHost();
}

async function openAutoDetectSubmodal() {
    const settings = getSettings();
    const bookCfg = getBookConfigMutable(settings, _currentBook);
    const hasExistingAssignments = Object.keys(bookCfg.assignments).length > 0;

    if (!_greetingIndex && _currentBook) {
        const res = await resolveGreetingCoordinationForBook(_currentBook, { allowFetchShallow: true });
        if (res.greetingIndex) {
            _greetingCharName = res.characterName || '';
            _greetingIndex = res.greetingIndex;
        }
    }

    const strategy = 'smart';
    const onlyUngrouped = hasExistingAssignments;
    const proposals = detectAutoGroups(_loadedSummaries, {
        strategy,
        onlyUngrouped,
        existingAssignments: bookCfg.assignments,
        greetingIndex: _greetingIndex,
    });

    _submodal = {
        type: 'auto-detect',
        strategy,
        onlyUngrouped,
        proposals: proposals.map((p) => ({ ...p, checked: true, mode: p.suggestedMode })),
    };
    renderSubmodalHost();
}

function openSettingsSubmodal() {
    _submodal = { type: 'settings' };
    renderSubmodalHost();
}

function renderSubmodalHost() {
    if (typeof document === 'undefined') return;
    const host = document.querySelector(`#${MODAL_BACKDROP_ID} #weg-submodal-host`);
    if (!(host instanceof HTMLElement)) return;

    if (!_submodal) {
        host.hidden = true;
        host.innerHTML = '';
        return;
    }

    host.hidden = false;

    if (_submodal.type === 'group-form') {
        const isEdit = Boolean(_submodal.groupId);
        const showSceneOpts = _submodal.mode === GROUP_MODES.SCENE;
        host.innerHTML = `
            <div class="weg-submodal-card" role="dialog" aria-label="${isEdit ? '编辑分组' : '新建分组'}">
                <div class="weg-submodal-header">
                    <span class="weg-submodal-title">${isEdit ? '编辑分组' : '新建分组'}</span>
                    <button type="button" class="weg-icon-btn" data-weg-sub-close="1" aria-label="返回"><i class="fa-solid fa-xmark"></i></button>
                </div>
                <div class="weg-submodal-body">
                    <label class="weg-field-label" for="weg-group-name-input">分组名称</label>
                    <div class="weg-input-with-clear">
                        <input type="text" class="weg-input" id="weg-group-name-input" value="${esc(_submodal.initialName)}" placeholder="例如：18岁线 / 30岁线 / 亲密剧情 (NSFW)" maxlength="40" autocomplete="off" />
                        <button type="button" class="weg-clear-input-btn" id="weg-group-name-clear">清空</button>
                    </div>

                    <div class="weg-field-label" style="margin-top: 12px;">开关联动模式</div>
                    <div class="weg-mode-options" id="weg-group-mode-list">
                        ${renderModeOptionHtml(GROUP_MODES.NORMAL, _submodal.mode, '普通组', '整组一键全开或全关，与其他分组互不影响')}
                        ${renderModeOptionHtml(GROUP_MODES.IF_LINE, _submodal.mode, 'IF 线 / 阶段互斥组', '开启本组时自动关闭其他 IF 线组，并更新本存档当前阶段（支持 18岁→30岁跨阶段演进）')}
                        ${renderModeOptionHtml(GROUP_MODES.SCENE, _submodal.mode, '情境按需组（如 NSFW）', '日常对话保持关闭；最近消息出现触发词时当轮自动开启，脱离剧情后自动关回')}
                        ${renderModeOptionHtml(GROUP_MODES.RADIO, _submodal.mode, '组内单选组', '开启本组内任意一条时，自动关闭本组其余条目')}
                    </div>

                    <div class="weg-scene-extra" id="weg-scene-extra" ${showSceneOpts ? '' : 'hidden'}>
                        <label class="weg-field-label" for="weg-scene-kw-input" style="margin-top: 12px;">自定义情境触发词（留空则使用内置亲密剧情词库）</label>
                        <div class="weg-input-with-clear">
                            <input type="text" class="weg-input" id="weg-scene-kw-input" value="${esc(_submodal.sceneKeywordsText)}" placeholder="多个词用逗号分隔，留空默认适配亲密剧情…" autocomplete="off" />
                            <button type="button" class="weg-clear-input-btn" id="weg-scene-kw-clear">清空</button>
                        </div>
                        <div class="weg-scene-cooldown-row">
                            <span>脱离触发词后继续保持开启轮数</span>
                            <input type="number" class="weg-input weg-cooldown-input" id="weg-scene-cooldown-input" min="1" max="10" value="${Number(_submodal.cooldownTurns) || 2}" />
                        </div>
                    </div>
                </div>
                <div class="weg-submodal-footer">
                    <button type="button" class="weg-btn weg-btn-subtle" data-weg-sub-close="1">取消</button>
                    <button type="button" class="weg-btn weg-btn-primary" id="weg-group-save-btn">${isEdit ? '保存修改' : '创建分组'}</button>
                </div>
            </div>
        `;
        wireGroupFormSubmodal(host);
        return;
    }

    if (_submodal.type === 'batch-move') {
        const settings = getSettings();
        const bookCfg = getBookConfigMutable(settings, _currentBook);
        const count = _submodal.uids.length;

        const modeNameMap = {
            [GROUP_MODES.NORMAL]: '普通组',
            [GROUP_MODES.IF_LINE]: 'IF 互斥',
            [GROUP_MODES.SCENE]: '情境按需',
            [GROUP_MODES.RADIO]: '组内单选',
        };

        const groupItemsHtml = bookCfg.groups.map((g) => `
            <button type="button" class="weg-move-target-btn" data-weg-move-target="${esc(g.id)}">
                <span class="weg-move-target-name">${esc(g.name)}</span>
                <span class="weg-move-target-meta">${esc(modeNameMap[g.mode] || '普通组')}</span>
            </button>
        `).join('');

        host.innerHTML = `
            <div class="weg-submodal-card" role="dialog" aria-label="移动条目到分组">
                <div class="weg-submodal-header">
                    <span class="weg-submodal-title">移动已选的 ${count} 个条目</span>
                    <button type="button" class="weg-icon-btn" data-weg-sub-close="1" aria-label="返回"><i class="fa-solid fa-xmark"></i></button>
                </div>
                <div class="weg-submodal-body">
                    <div class="weg-field-label">选择已有分组</div>
                    <div class="weg-move-target-list">
                        ${groupItemsHtml || '<div class="weg-group-empty">当前还没有自定义分组，可在下方直接新建并移入</div>'}
                        <button type="button" class="weg-move-target-btn is-muted" data-weg-move-target="${SPECIAL_GROUP_UNGROUPED}">
                            <span class="weg-move-target-name">移回「未分组」</span>
                            <span class="weg-move-target-meta">解除分组归属</span>
                        </button>
                    </div>

                    <div class="weg-field-label" style="margin-top: 12px;">或直接新建分组并移入</div>
                    <div class="weg-inline-new-group">
                        <div class="weg-input-with-clear">
                            <input type="text" class="weg-input" id="weg-quick-new-group-input" placeholder="输入新分组名称…" maxlength="40" autocomplete="off" />
                            <button type="button" class="weg-clear-input-btn" id="weg-quick-new-clear">清空</button>
                        </div>
                        <button type="button" class="weg-btn weg-btn-primary" id="weg-quick-new-move-btn">新建并移入</button>
                    </div>
                </div>
                <div class="weg-submodal-footer">
                    <button type="button" class="weg-btn weg-btn-subtle" data-weg-sub-close="1">取消</button>
                </div>
            </div>
        `;
        wireBatchMoveSubmodal(host);
        return;
    }

    if (_submodal.type === 'auto-detect') {
        const proposals = _submodal.proposals || [];
        const checkedCount = proposals.filter((p) => p.checked).length;
        const sourceLabelMap = {
            scene: '情境识别',
            greeting: '开场白标签',
            divider: '分隔条区间',
            prefix: '标题前缀',
        };

        const listHtml = proposals.length === 0
            ? `<div class="weg-empty-state weg-empty-compact">
                <p class="weg-empty-title">未识别到可自动归类的分组</p>
                <p class="weg-empty-desc">可尝试切换上方识别方式，或取消勾选「仅识别未分组条目」。</p>
               </div>`
            : proposals.map((p, idx) => `
                <div class="weg-detect-row">
                    <label class="weg-detect-check-label">
                        <input type="checkbox" data-weg-detect-idx="${idx}" ${p.checked ? 'checked' : ''} />
                        <span class="weg-detect-name">${esc(p.name)}</span>
                        <span class="weg-badge">${esc(sourceLabelMap[p.source] || '自动')}</span>
                        <span class="weg-group-count">${p.uids.length} 条</span>
                    </label>
                    <select class="weg-select weg-detect-mode-select" data-weg-detect-mode="${idx}" aria-label="分组模式">
                        <option value="${GROUP_MODES.NORMAL}" ${p.mode === GROUP_MODES.NORMAL ? 'selected' : ''}>普通组</option>
                        <option value="${GROUP_MODES.IF_LINE}" ${p.mode === GROUP_MODES.IF_LINE ? 'selected' : ''}>IF 互斥</option>
                        <option value="${GROUP_MODES.SCENE}" ${p.mode === GROUP_MODES.SCENE ? 'selected' : ''}>情境按需</option>
                        <option value="${GROUP_MODES.RADIO}" ${p.mode === GROUP_MODES.RADIO ? 'selected' : ''}>组内单选</option>
                    </select>
                </div>
            `).join('');

        host.innerHTML = `
            <div class="weg-submodal-card weg-submodal-wide" role="dialog" aria-label="自动识别建组">
                <div class="weg-submodal-header">
                    <span class="weg-submodal-title">自动识别建组预览</span>
                    <button type="button" class="weg-icon-btn" data-weg-sub-close="1" aria-label="返回"><i class="fa-solid fa-xmark"></i></button>
                </div>
                <div class="weg-submodal-body">
                    <div class="weg-detect-controls">
                        <select class="weg-select" id="weg-detect-strategy" aria-label="识别规则">
                            <option value="smart" ${_submodal.strategy === 'smart' ? 'selected' : ''}>智能综合识别（含 NSFW / 前缀 / 分隔条）</option>
                            <option value="scene" ${_submodal.strategy === 'scene' ? 'selected' : ''}>仅识别亲密剧情 (NSFW) 条目</option>
                            <option value="prefix" ${_submodal.strategy === 'prefix' ? 'selected' : ''}>仅按标题前缀（如【世界观】/ 18岁线-）</option>
                            <option value="divider" ${_submodal.strategy === 'divider' ? 'selected' : ''}>仅按分隔条区间（如 === 设定 ===）</option>
                            <option value="greeting" ${_submodal.strategy === 'greeting' ? 'selected' : ''}>仅按角色开场白联动注释</option>
                        </select>
                        <label class="weg-inline-check">
                            <input type="checkbox" id="weg-detect-only-ungrouped" ${_submodal.onlyUngrouped ? 'checked' : ''} />
                            <span>仅识别未分组条目</span>
                        </label>
                    </div>
                    <div class="weg-detect-list">${listHtml}</div>
                </div>
                <div class="weg-submodal-footer">
                    <button type="button" class="weg-btn weg-btn-subtle" data-weg-sub-close="1">取消</button>
                    <button type="button" class="weg-btn weg-btn-primary" id="weg-detect-apply-btn" ${checkedCount === 0 ? 'disabled' : ''}>应用所选分组 (${checkedCount})</button>
                </div>
            </div>
        `;
        wireAutoDetectSubmodal(host);
        return;
    }

    if (_submodal.type === 'settings') {
        const settings = getSettings();
        const hasBookGroups = Boolean(_currentBook && settings.books?.[_currentBook]);
        host.innerHTML = `
            <div class="weg-submodal-card" role="dialog" aria-label="面板设置">
                <div class="weg-submodal-header">
                    <span class="weg-submodal-title">外观与联动设置</span>
                    <button type="button" class="weg-icon-btn" data-weg-sub-close="1" aria-label="返回"><i class="fa-solid fa-xmark"></i></button>
                </div>
                <div class="weg-submodal-body weg-settings-list">
                    <div class="weg-setting-row">
                        <div class="weg-setting-text">
                            <div class="weg-setting-name">切换聊天存档时自动恢复本档路线</div>
                            <div class="weg-setting-desc">仅读取存档头元数据（零聊天记录扫描），切档自动恢复对应 IF 线</div>
                        </div>
                        <button type="button" class="weg-switch${settings.autoSwitchOnChatChange !== false ? ' is-on' : ''}" id="weg-set-auto-chat-switch" role="switch" aria-checked="${settings.autoSwitchOnChatChange !== false}">
                            <span class="weg-switch-thumb"></span>
                        </button>
                    </div>

                    <div class="weg-setting-row">
                        <div class="weg-setting-text">
                            <div class="weg-setting-name">按最近对话自动开关情境组（如 NSFW）</div>
                            <div class="weg-setting-desc">仅检测最新 1~2 条消息片段，有相关剧情时当轮开启，恢复日常后自动关闭</div>
                        </div>
                        <button type="button" class="weg-switch${settings.enableSceneAutoToggle !== false ? ' is-on' : ''}" id="weg-set-scene-auto" role="switch" aria-checked="${settings.enableSceneAutoToggle !== false}">
                            <span class="weg-switch-thumb"></span>
                        </button>
                    </div>

                    <div class="weg-setting-row">
                        <div class="weg-setting-text">
                            <div class="weg-setting-name">弹窗配色方案</div>
                            <div class="weg-setting-desc">独立弹窗实底配色，确保不同主题下清晰易读</div>
                        </div>
                        <select class="weg-select weg-setting-control" id="weg-set-palette">
                            <option value="paper" ${settings.palette === 'paper' ? 'selected' : ''}>素雅纸墨</option>
                            <option value="ink" ${settings.palette === 'ink' ? 'selected' : ''}>素纸青岚</option>
                            <option value="warm" ${settings.palette === 'warm' ? 'selected' : ''}>暖笺琥珀</option>
                            <option value="sakura" ${settings.palette === 'sakura' ? 'selected' : ''}>雾粉紫烟</option>
                            <option value="host" ${settings.palette === 'host' ? 'selected' : ''}>跟随酒馆</option>
                        </select>
                    </div>

                    <div class="weg-setting-row">
                        <div class="weg-setting-text">
                            <div class="weg-setting-name">明暗模式</div>
                            <div class="weg-setting-desc">可跟随当前酒馆背景明暗或固定浅色、深色</div>
                        </div>
                        <select class="weg-select weg-setting-control" id="weg-set-colormode">
                            <option value="auto" ${settings.colorMode === 'auto' ? 'selected' : ''}>跟随酒馆</option>
                            <option value="light" ${settings.colorMode === 'light' ? 'selected' : ''}>浅色模式</option>
                            <option value="dark" ${settings.colorMode === 'dark' ? 'selected' : ''}>深色模式</option>
                        </select>
                    </div>

                    <div class="weg-setting-row">
                        <div class="weg-setting-text">
                            <div class="weg-setting-name">显示世界书面板快捷按钮</div>
                            <div class="weg-setting-desc">在世界书编辑器工具栏显示图标入口</div>
                        </div>
                        <button type="button" class="weg-switch${settings.showNativeEntryBtn !== false ? ' is-on' : ''}" id="weg-set-native-btn" role="switch" aria-checked="${settings.showNativeEntryBtn !== false}">
                            <span class="weg-switch-thumb"></span>
                        </button>
                    </div>

                    <div class="weg-setting-row">
                        <div class="weg-setting-text">
                            <div class="weg-setting-name">显示左下角魔法棒菜单入口</div>
                            <div class="weg-setting-desc">方便在聊天界面直接点开切换 18岁/30岁等阶段</div>
                        </div>
                        <button type="button" class="weg-switch${settings.showWandMenuEntry !== false ? ' is-on' : ''}" id="weg-set-wand-btn" role="switch" aria-checked="${settings.showWandMenuEntry !== false}">
                            <span class="weg-switch-thumb"></span>
                        </button>
                    </div>

                    <div class="weg-setting-row">
                        <div class="weg-setting-text">
                            <div class="weg-setting-name">定位条目时自动关闭本窗口</div>
                            <div class="weg-setting-desc">跳转回酒馆原生编辑器时自动让出编辑视野</div>
                        </div>
                        <button type="button" class="weg-switch${settings.closeOnLocate !== false ? ' is-on' : ''}" id="weg-set-close-locate" role="switch" aria-checked="${settings.closeOnLocate !== false}">
                            <span class="weg-switch-thumb"></span>
                        </button>
                    </div>

                    <div class="weg-setting-row">
                        <div class="weg-setting-text">
                            <div class="weg-setting-name">清空当前世界书的分组记录</div>
                            <div class="weg-setting-desc">仅重置插件内的分组归属，不修改世界书任何条目</div>
                        </div>
                        <button type="button" class="weg-btn weg-btn-danger weg-setting-control" id="weg-set-clear-book" ${hasBookGroups ? '' : 'disabled'}>清空本书分组</button>
                    </div>
                </div>
                <div class="weg-submodal-footer">
                    <button type="button" class="weg-btn weg-btn-primary" data-weg-sub-close="1">完成</button>
                </div>
            </div>
        `;
        wireSettingsSubmodal(host);
    }
}

function renderModeOptionHtml(modeValue, selectedMode, title, desc) {
    const active = modeValue === selectedMode;
    return `
        <label class="weg-mode-card${active ? ' is-active' : ''}">
            <input type="radio" name="weg_group_mode" value="${esc(modeValue)}" ${active ? 'checked' : ''} />
            <div class="weg-mode-card-body">
                <div class="weg-mode-card-title">${esc(title)}</div>
                <div class="weg-mode-card-desc">${esc(desc)}</div>
            </div>
        </label>
    `;
}

function wireCommonSubmodalClose(host) {
    host.querySelectorAll('[data-weg-sub-close]').forEach((btn) => {
        btn.addEventListener('click', () => closeSubmodal());
    });
}

function wireGroupFormSubmodal(host) {
    wireCommonSubmodalClose(host);
    const nameInput = host.querySelector('#weg-group-name-input');
    const clearBtn = host.querySelector('#weg-group-name-clear');
    const sceneExtra = host.querySelector('#weg-scene-extra');
    const sceneKwInput = host.querySelector('#weg-scene-kw-input');
    const sceneKwClear = host.querySelector('#weg-scene-kw-clear');
    const cooldownInput = host.querySelector('#weg-scene-cooldown-input');
    const saveBtn = host.querySelector('#weg-group-save-btn');
    const modeRadios = host.querySelectorAll('input[name="weg_group_mode"]');

    if (nameInput instanceof HTMLInputElement && !isNarrowViewport()) {
        requestAnimationFrame(() => {
            nameInput.focus();
            nameInput.select();
        });
    }

    clearBtn?.addEventListener('click', () => {
        if (nameInput instanceof HTMLInputElement) {
            nameInput.value = '';
            if (!isNarrowViewport()) nameInput.focus();
        }
    });

    sceneKwClear?.addEventListener('click', () => {
        if (sceneKwInput instanceof HTMLInputElement) {
            sceneKwInput.value = '';
            if (!isNarrowViewport()) sceneKwInput.focus();
        }
    });

    modeRadios.forEach((radio) => {
        radio.addEventListener('change', () => {
            if (!_submodal) return;
            _submodal.mode = radio.value;
            if (sceneExtra instanceof HTMLElement) {
                sceneExtra.hidden = radio.value !== GROUP_MODES.SCENE;
            }
            host.querySelectorAll('.weg-mode-card').forEach((card) => {
                const inp = card.querySelector('input[name="weg_group_mode"]');
                card.classList.toggle('is-active', Boolean(inp?.checked));
            });
        });
    });

    const submit = () => {
        if (!_submodal || !_currentBook) return;
        const rawName = nameInput instanceof HTMLInputElement ? nameInput.value.trim() : '';
        if (!rawName) {
            showToast('warning', '请填写分组名称');
            return;
        }

        const settings = getSettings();
        const bookCfg = getBookConfigMutable(settings, _currentBook);
        const duplicate = bookCfg.groups.find((g) => g.name === rawName && g.id !== _submodal.groupId);
        if (duplicate) {
            showToast('warning', `已存在同名分组「${rawName}」`);
            return;
        }

        pushUndoSnapshot(_currentBook, bookCfg);
        const chosenMode = (
            _submodal.mode === GROUP_MODES.IF_LINE ||
            _submodal.mode === GROUP_MODES.RADIO ||
            _submodal.mode === GROUP_MODES.SCENE
        )
            ? _submodal.mode
            : GROUP_MODES.NORMAL;

        const kwList = sceneKwInput instanceof HTMLInputElement
            ? normalizeKeywordList(sceneKwInput.value)
            : [];
        const rawCd = cooldownInput instanceof HTMLInputElement
            ? Number.parseInt(cooldownInput.value, 10)
            : 2;
        const cooldownTurns = Number.isInteger(rawCd) ? Math.max(1, Math.min(10, rawCd)) : 2;

        if (_submodal.groupId) {
            const target = bookCfg.groups.find((g) => g.id === _submodal.groupId);
            if (target) {
                target.name = rawName;
                target.mode = chosenMode;
                target.sceneKeywords = kwList;
                target.cooldownTurns = cooldownTurns;
            }
        } else {
            bookCfg.groups.push({
                id: createGroupId('grp'),
                name: rawName,
                mode: chosenMode,
                collapsed: false,
                sceneKeywords: kwList,
                cooldownTurns,
            });
        }

        saveBookConfigWithCleanEmpty(settings, _currentBook, bookCfg);
        closeSubmodal();
        renderModalContents();
    };

    saveBtn?.addEventListener('click', submit);
    nameInput?.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' && !_isComposing) {
            ev.preventDefault();
            submit();
        }
    });
}

function wireBatchMoveSubmodal(host) {
    wireCommonSubmodalClose(host);
    const uids = _submodal?.uids || [];
    const quickInput = host.querySelector('#weg-quick-new-group-input');
    const quickClear = host.querySelector('#weg-quick-new-clear');
    const quickMoveBtn = host.querySelector('#weg-quick-new-move-btn');

    const applyMoveToGroupId = (targetGroupId, targetLabel) => {
        if (!_currentBook || uids.length === 0) return;
        const settings = getSettings();
        const bookCfg = getBookConfigMutable(settings, _currentBook);
        pushUndoSnapshot(_currentBook, bookCfg);

        for (const uid of uids) {
            if (targetGroupId === SPECIAL_GROUP_UNGROUPED) {
                delete bookCfg.assignments[uid];
            } else {
                bookCfg.assignments[uid] = targetGroupId;
            }
        }

        saveBookConfigWithCleanEmpty(settings, _currentBook, bookCfg);
        _batchMode = false;
        _selectedUids.clear();
        closeSubmodal();
        renderModalContents();
        showToast('success', `已将 ${uids.length} 个条目移入「${targetLabel}」`);
    };

    host.querySelectorAll('[data-weg-move-target]').forEach((btn) => {
        btn.addEventListener('click', () => {
            const gid = btn.getAttribute('data-weg-move-target') || SPECIAL_GROUP_UNGROUPED;
            const settings = getSettings();
            const bookCfg = getBookConfigMutable(settings, _currentBook);
            const label = gid === SPECIAL_GROUP_UNGROUPED
                ? '未分组'
                : (bookCfg.groups.find((g) => g.id === gid)?.name || '目标分组');
            applyMoveToGroupId(gid, label);
        });
    });

    quickClear?.addEventListener('click', () => {
        if (quickInput instanceof HTMLInputElement) {
            quickInput.value = '';
            if (!isNarrowViewport()) quickInput.focus();
        }
    });

    const createAndMove = () => {
        const name = quickInput instanceof HTMLInputElement ? quickInput.value.trim() : '';
        if (!name) {
            showToast('warning', '请先输入新分组名称');
            return;
        }
        const settings = getSettings();
        const bookCfg = getBookConfigMutable(settings, _currentBook);
        let group = bookCfg.groups.find((g) => g.name === name);
        pushUndoSnapshot(_currentBook, bookCfg);
        if (!group) {
            group = {
                id: createGroupId('grp'),
                name,
                mode: GROUP_MODES.NORMAL,
                collapsed: false,
                sceneKeywords: [],
                cooldownTurns: 2,
            };
            bookCfg.groups.push(group);
        }
        for (const uid of uids) {
            bookCfg.assignments[uid] = group.id;
        }
        saveBookConfigWithCleanEmpty(settings, _currentBook, bookCfg);
        _batchMode = false;
        _selectedUids.clear();
        closeSubmodal();
        renderModalContents();
        showToast('success', `已新建分组「${name}」并移入 ${uids.length} 个条目`);
    };

    quickMoveBtn?.addEventListener('click', createAndMove);
    quickInput?.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') {
            ev.preventDefault();
            createAndMove();
        }
    });
}

function wireAutoDetectSubmodal(host) {
    wireCommonSubmodalClose(host);
    const strategySelect = host.querySelector('#weg-detect-strategy');
    const onlyUngroupedCheck = host.querySelector('#weg-detect-only-ungrouped');
    const applyBtn = host.querySelector('#weg-detect-apply-btn');

    const recomputeProposals = () => {
        if (!_submodal || !_currentBook) return;
        const settings = getSettings();
        const bookCfg = getBookConfigMutable(settings, _currentBook);
        const strategy = strategySelect instanceof HTMLSelectElement ? strategySelect.value : 'smart';
        const onlyUngrouped = onlyUngroupedCheck instanceof HTMLInputElement ? onlyUngroupedCheck.checked : true;
        const nextProposals = detectAutoGroups(_loadedSummaries, {
            strategy,
            onlyUngrouped,
            existingAssignments: bookCfg.assignments,
            greetingIndex: _greetingIndex,
        });
        _submodal.strategy = strategy;
        _submodal.onlyUngrouped = onlyUngrouped;
        _submodal.proposals = nextProposals.map((p) => ({ ...p, checked: true, mode: p.suggestedMode }));
        renderSubmodalHost();
    };

    strategySelect?.addEventListener('change', recomputeProposals);
    onlyUngroupedCheck?.addEventListener('change', recomputeProposals);

    host.querySelectorAll('[data-weg-detect-idx]').forEach((cb) => {
        cb.addEventListener('change', () => {
            if (!_submodal) return;
            const idx = Number(cb.getAttribute('data-weg-detect-idx'));
            if (_submodal.proposals[idx]) {
                _submodal.proposals[idx].checked = cb.checked;
            }
            const checkedCount = _submodal.proposals.filter((p) => p.checked).length;
            if (applyBtn instanceof HTMLButtonElement) {
                applyBtn.disabled = checkedCount === 0;
                applyBtn.textContent = `应用所选分组 (${checkedCount})`;
            }
        });
    });

    host.querySelectorAll('[data-weg-detect-mode]').forEach((sel) => {
        sel.addEventListener('change', () => {
            if (!_submodal) return;
            const idx = Number(sel.getAttribute('data-weg-detect-mode'));
            if (_submodal.proposals[idx]) {
                _submodal.proposals[idx].mode = sel.value;
            }
        });
    });

    applyBtn?.addEventListener('click', () => {
        if (!_submodal || !_currentBook) return;
        const chosen = (_submodal.proposals || []).filter((p) => p.checked);
        if (chosen.length === 0) return;

        const settings = getSettings();
        const bookCfg = getBookConfigMutable(settings, _currentBook);
        pushUndoSnapshot(_currentBook, bookCfg);

        const nextCfg = applyAutoGroupProposals(bookCfg, chosen, {
            replaceExisting: !_submodal.onlyUngrouped,
        });
        saveBookConfigWithCleanEmpty(settings, _currentBook, nextCfg);
        closeSubmodal();
        renderModalContents();
        showToast('success', `已生成 ${chosen.length} 个条目分组，点底部「撤销」可随时还原`);
    });
}

function wireSettingsSubmodal(host) {
    wireCommonSubmodalClose(host);
    const settings = getSettings();

    const autoChatSwitch = host.querySelector('#weg-set-auto-chat-switch');
    const sceneAutoSwitch = host.querySelector('#weg-set-scene-auto');
    const paletteSel = host.querySelector('#weg-set-palette');
    const modeSel = host.querySelector('#weg-set-colormode');
    const nativeBtnSwitch = host.querySelector('#weg-set-native-btn');
    const wandBtnSwitch = host.querySelector('#weg-set-wand-btn');
    const closeLocateSwitch = host.querySelector('#weg-set-close-locate');
    const clearBookBtn = host.querySelector('#weg-set-clear-book');

    paletteSel?.addEventListener('change', () => {
        if (paletteSel instanceof HTMLSelectElement) {
            settings.palette = paletteSel.value;
            notifySettingsChanged();
            renderModalContents();
        }
    });

    modeSel?.addEventListener('change', () => {
        if (modeSel instanceof HTMLSelectElement) {
            settings.colorMode = modeSel.value;
            notifySettingsChanged();
            renderModalContents();
        }
    });

    const bindSwitch = (el, key, onAfter) => {
        el?.addEventListener('click', () => {
            settings[key] = !settings[key];
            notifySettingsChanged();
            onAfter?.();
            renderSubmodalHost();
            renderBodyAndFooterOnly();
        });
    };

    bindSwitch(autoChatSwitch, 'autoSwitchOnChatChange');
    bindSwitch(sceneAutoSwitch, 'enableSceneAutoToggle');
    bindSwitch(nativeBtnSwitch, 'showNativeEntryBtn');
    bindSwitch(wandBtnSwitch, 'showWandMenuEntry');
    bindSwitch(closeLocateSwitch, 'closeOnLocate');

    clearBookBtn?.addEventListener('click', () => {
        if (!_currentBook || !settings.books?.[_currentBook]) return;
        pushUndoSnapshot(_currentBook, settings.books[_currentBook]);
        delete settings.books[_currentBook];
        notifySettingsChanged();
        closeSubmodal();
        renderModalContents();
        showToast('info', `已清空「${_currentBook}」的分组配置，点底部撤销可恢复`);
    });
}
