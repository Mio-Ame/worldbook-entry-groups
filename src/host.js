/**
 * Worldbook Entry Groups — Dual-host adapter for SillyTavern & TauriTavern.
 *
 * Key guarantees:
 * 1. Uncached direct reads (`/api/worldinfo/get`) extract lightweight entry summaries
 *    and immediately drop raw JSON payloads so iOS WKWebView never bloats `worldInfoCache`.
 * 2. Batch group / IF-line switches perform a single `/api/worldinfo/edit` write,
 *    preserving 100% of original entry fields while keeping any already-cached active
 *    worldbook and open native editor synchronized.
 * 3. Per-chat save route binding (`chatMetadata` + fallback `chatProfiles`): remembers
 *    which IF line / entry state each chat save uses (even 100+ floors deep or in branched saves)
 *    and restores it automatically on `CHAT_CHANGED`.
 */

import {
    MODULE_NAME,
    applyTogglePlanToPayload,
    buildChatProfileFromCurrentState,
    buildGreetingCoordinationIndex,
    computeChatProfileRestorePlan,
    extractWorldbookEntrySummaries,
    inferChatRouteFromMessages,
    normalizeBookConfig,
    normalizeChatProfile,
    normalizeSettings,
    upsertStoredChatProfile,
} from './core.js';

let _worldInfoModule = null;
let _worldInfoModuleTried = false;
let _selfWriteGuardUntil = 0;

/**
 * Return SillyTavern / TauriTavern global context safely.
 * @returns {any | null}
 */
export function getHostContext() {
    try {
        return globalThis.SillyTavern?.getContext?.() || null;
    } catch {
        return null;
    }
}

/**
 * Detect whether the extension is running inside TauriTavern.
 * @returns {boolean}
 */
export function isTauriTavern() {
    return Boolean(globalThis.__TAURITAVERN__ || globalThis.__TAURI_RUNNING__);
}

/**
 * Apply TauriTavern mobile surface attribute cleanly when applicable.
 * @param {HTMLElement | null} el
 * @param {'fullscreen-window' | 'backdrop' | 'free-window'} surface
 */
export function applyTauriSurface(el, surface) {
    if (!el || !isTauriTavern()) return;
    el.setAttribute('data-tt-mobile-surface', surface);
}

/**
 * Wait for TauriTavern host readiness if present (no-op on standard SillyTavern).
 */
export async function waitForTauriReadyIfPresent() {
    const readyPromise =
        globalThis.__TAURITAVERN__?.ready ??
        globalThis.__TAURITAVERN_MAIN_READY__ ??
        null;
    if (readyPromise && typeof readyPromise.then === 'function') {
        try {
            await readyPromise;
        } catch {
            // Do not block fallback initialization
        }
    }
}

/**
 * Lazily import `/scripts/world-info.js` once to access authoritative `world_names`
 * and inspect `worldInfoCache` without triggering extra network requests.
 */
export async function ensureWorldInfoModule() {
    if (_worldInfoModuleTried) return _worldInfoModule;
    _worldInfoModuleTried = true;
    try {
        const url = new URL('/scripts/world-info.js', globalThis.location.href).href;
        _worldInfoModule = await import(/* @vite-ignore */ url);
    } catch {
        _worldInfoModule = null;
    }
    return _worldInfoModule;
}

/**
 * Build request headers compatible with ST 1.14–1.19+ and TauriTavern.
 */
function buildRequestHeaders() {
    const ctx = getHostContext();
    if (typeof ctx?.getRequestHeaders === 'function') {
        return ctx.getRequestHeaders();
    }
    return { 'Content-Type': 'application/json' };
}

/**
 * Emit a decoupled browser CustomEvent safely (no-op in Node test environments).
 * @param {string} type
 * @param {Record<string, any>} [detail]
 */
export function emitBridgeEvent(type, detail = {}) {
    try {
        if (typeof window !== 'undefined' && typeof CustomEvent === 'function') {
            window.dispatchEvent(new CustomEvent(type, { detail }));
        }
    } catch {
        // Ignore in headless/non-browser runtimes
    }
}

/**
 * Read and normalize persisted extension settings in place.
 * @returns {Record<string, any>}
 */
export function getSettings() {
    const ctx = getHostContext();
    const fallbackRoot = globalThis.extension_settings;
    const container = ctx?.extensionSettings || fallbackRoot;
    if (!container || typeof container !== 'object') {
        return normalizeSettings(null);
    }
    if (!container[MODULE_NAME]) {
        container[MODULE_NAME] = normalizeSettings(null);
    } else {
        const normalized = normalizeSettings(container[MODULE_NAME]);
        Object.assign(container[MODULE_NAME], normalized);
    }
    return container[MODULE_NAME];
}

/**
 * Persist extension settings via host debounced saver.
 */
export function saveSettings() {
    const ctx = getHostContext();
    if (typeof ctx?.saveSettingsDebounced === 'function') {
        ctx.saveSettingsDebounced();
    }
    emitBridgeEvent('weg:settings-updated', { reason: 'save' });
}

/**
 * Check whether a recent write came from this extension itself (prevents echo loops).
 * @returns {boolean}
 */
export function isWithinSelfWriteWindow() {
    return Date.now() < _selfWriteGuardUntil;
}

/**
 * Return the authoritative list of worldbook names from host memory (never resurrects deleted DOM options).
 * @returns {string[]}
 */
export function getWorldNames() {
    const ctx = getHostContext();
    let rawList = [];

    if (typeof ctx?.getWorldInfoNames === 'function') {
        const list = ctx.getWorldInfoNames();
        if (Array.isArray(list) && list.length > 0) {
            rawList = list;
        }
    }
    if (rawList.length === 0 && Array.isArray(_worldInfoModule?.world_names) && _worldInfoModule.world_names.length > 0) {
        rawList = _worldInfoModule.world_names;
    }

    const seen = new Set();
    const cleanList = [];
    for (const item of rawList) {
        const name = String(item ?? '').trim();
        if (name && !seen.has(name)) {
            seen.add(name);
            cleanList.push(name);
        }
    }

    if (cleanList.length === 0 && typeof document !== 'undefined') {
        const sel = document.getElementById('world_editor_select') || document.getElementById('world_info');
        if (sel) {
            sel.querySelectorAll('option').forEach((opt) => {
                const t = (opt.textContent || '').trim();
                if (opt.value !== '' && t && !seen.has(t)) {
                    seen.add(t);
                    cleanList.push(t);
                }
            });
        }
    }

    return cleanList;
}

/**
 * Return the worldbook currently open in SillyTavern's native editor, if any.
 * @returns {string | null}
 */
export function getCurrentEditorWorldName() {
    if (typeof document === 'undefined') return null;
    const sel = document.getElementById('world_editor_select');
    if (!sel) return null;
    const selectedOpt = sel.selectedOptions?.[0];
    if (!selectedOpt || selectedOpt.value === '') return null;
    return (selectedOpt.textContent || '').trim() || null;
}

/**
 * Return the current active chat character's primary worldbook (or chat-bound worldbook).
 * @returns {string | null}
 */
export function getCurrentCharacterPrimaryWorldName() {
    try {
        const thPrimary = globalThis.TavernHelper?.getCurrentCharPrimaryLorebook?.();
        if (typeof thPrimary === 'string' && thPrimary.trim()) {
            return thPrimary.trim();
        }
    } catch {
        // Ignore if TavernHelper is absent or not ready
    }

    const ctx = getHostContext();
    if (!ctx) return null;

    if (!ctx.groupId && ctx.characterId !== undefined && ctx.characterId !== null && ctx.characterId !== '') {
        const ch = ctx.characters?.[Number(ctx.characterId)];
        const charWorld = ch?.data?.extensions?.world;
        if (typeof charWorld === 'string' && charWorld.trim()) {
            return charWorld.trim();
        }
        const wboCached = ctx?.extensionSettings?.worldbook_organizer?.cachedCharBindings?.[ch?.avatar];
        if (typeof wboCached?.primary === 'string' && wboCached.primary.trim()) {
            return wboCached.primary.trim();
        }
    }

    const chatWorld = ctx?.chatMetadata?.world_info;
    if (typeof chatWorld === 'string' && chatWorld.trim()) {
        return chatWorld.trim();
    }

    return null;
}

/**
 * Return identity & primary worldbook metadata for the currently open chat save, if any.
 * @returns {{ chatId: string, chatKey: string, characterName: string, primaryWorldName: string, floorCount: number } | null}
 */
export function getCurrentChatSaveContext() {
    const ctx = getHostContext();
    if (!ctx) return null;

    let rawChatId = '';
    if (typeof ctx.getCurrentChatId === 'function') {
        try {
            rawChatId = String(ctx.getCurrentChatId() ?? '').trim();
        } catch {
            rawChatId = '';
        }
    }
    if (!rawChatId) {
        rawChatId = String(ctx.chatId ?? '').trim();
    }

    let avatarKey = '';
    let characterName = '';
    if (ctx.groupId) {
        avatarKey = `group_${ctx.groupId}`;
        characterName = '群聊';
    } else if (ctx.characterId !== undefined && ctx.characterId !== null && ctx.characterId !== '') {
        const ch = ctx.characters?.[Number(ctx.characterId)];
        avatarKey = String(ch?.avatar ?? '').trim();
        characterName = String(ch?.name || ch?.data?.name || '').trim();
        if (!rawChatId && ch?.chat) {
            rawChatId = String(ch.chat).trim();
        }
    }

    if (!rawChatId) return null;

    const primaryWorldName = getCurrentCharacterPrimaryWorldName() || '';
    const floorCount = Array.isArray(ctx.chat) ? ctx.chat.length : 0;

    return {
        chatId: rawChatId,
        chatKey: `${avatarKey || 'chat'}::${rawChatId}`,
        characterName,
        primaryWorldName,
        floorCount,
    };
}

/**
 * Read the bound route profile for the currently active chat save (if any).
 * Checks per-chat `chatMetadata.worldbook_entry_groups` first, falling back to `settings.chatProfiles[chatKey]`.
 *
 * @param {string} [expectedWorldName]
 */
export function getActiveChatBoundProfile(expectedWorldName = '') {
    const saveCtx = getCurrentChatSaveContext();
    if (!saveCtx) return { saveCtx: null, profile: null };

    const ctx = getHostContext();
    const settings = getSettings();

    const metaProfile = normalizeChatProfile(ctx?.chatMetadata?.[MODULE_NAME]);
    const storedProfile = normalizeChatProfile(settings.chatProfiles?.[saveCtx.chatKey]);
    const candidate = metaProfile || storedProfile || null;

    const cleanExpected = String(expectedWorldName ?? '').trim();
    if (candidate && cleanExpected && candidate.worldName !== cleanExpected) {
        return { saveCtx, profile: null };
    }

    return { saveCtx, profile: candidate };
}

/**
 * Persist a route profile into BOTH the active chat's `.jsonl` `chatMetadata` AND `settings.chatProfiles`.
 * Pass `null` to unbind the active chat save.
 *
 * @param {any | null} rawProfile
 * @returns {boolean}
 */
export function saveActiveChatBoundProfile(rawProfile) {
    const saveCtx = getCurrentChatSaveContext();
    if (!saveCtx) return false;

    const ctx = getHostContext();
    const settings = getSettings();
    const norm = rawProfile ? normalizeChatProfile(rawProfile) : null;

    if (ctx?.chatMetadata && typeof ctx.chatMetadata === 'object') {
        if (norm) {
            ctx.chatMetadata[MODULE_NAME] = norm;
        } else {
            delete ctx.chatMetadata[MODULE_NAME];
        }
        if (typeof ctx.saveMetadataDebounced === 'function') {
            try { ctx.saveMetadataDebounced(); } catch { /* ignore */ }
        } else if (typeof ctx.saveMetadata === 'function') {
            try { void ctx.saveMetadata(); } catch { /* ignore */ }
        }
    }

    upsertStoredChatProfile(settings, saveCtx.chatKey, norm);
    saveSettings();
    return true;
}

/**
 * Pick the most helpful initial worldbook when opening the panel.
 *
 * @param {Record<string, any>} settings
 * @returns {string}
 */
export function getPreferredDefaultBook(settings) {
    const names = getWorldNames();
    if (names.length === 0) return '';
    const nameSet = new Set(names);

    const editorBook = getCurrentEditorWorldName();
    if (editorBook && nameSet.has(editorBook)) return editorBook;

    const charBook = getCurrentCharacterPrimaryWorldName();
    if (charBook && nameSet.has(charBook)) return charBook;

    const lastBook = String(settings?.lastOpenedBook ?? '').trim();
    if (lastBook && nameSet.has(lastBook)) return lastBook;

    return names[0];
}

/**
 * Read raw worldbook JSON directly from `/api/worldinfo/get` WITHOUT populating
 * SillyTavern's persistent `worldInfoCache` (prevents mobile WebView OOM).
 *
 * @param {string} worldName
 * @returns {Promise<any | null>}
 */
async function fetchWorldInfoUncached(worldName) {
    const clean = String(worldName ?? '').trim();
    if (!clean) return null;

    try {
        const res = await fetch('/api/worldinfo/get', {
            method: 'POST',
            headers: buildRequestHeaders(),
            body: JSON.stringify({ name: clean }),
        });
        if (res.ok) {
            return await res.json();
        }
    } catch {
        // Fallback below only if host customizes worldinfo loading
    }

    try {
        const ctx = getHostContext();
        await ensureWorldInfoModule();
        const loader = ctx?.loadWorldInfo || _worldInfoModule?.loadWorldInfo;
        if (typeof loader === 'function') {
            return await loader(clean);
        }
    } catch {
        // Ignore
    }
    return null;
}

/**
 * Read a single worldbook's lightweight entry summaries without retaining `content` in memory.
 *
 * @param {string} worldName
 * @returns {Promise<{ ok: boolean, summaries: Array<any>, error?: string }>}
 */
export async function loadWorldbookSummariesUncached(worldName) {
    const clean = String(worldName ?? '').trim();
    if (!clean) return { ok: false, summaries: [], error: '未选择世界书' };

    let payload = await fetchWorldInfoUncached(clean);
    if (!payload || typeof payload !== 'object' || !('entries' in payload)) {
        return { ok: false, summaries: [], error: `无法读取世界书「${clean}」` };
    }

    const summaries = extractWorldbookEntrySummaries(payload);
    payload = null;

    return { ok: true, summaries };
}

/**
 * Sync SillyTavern's already-cached `worldInfoCache` entry (if and ONLY if already cached!)
 * and refresh `#world_popup_entries_list` if this worldbook is currently open in the native editor.
 *
 * @param {string} worldName
 * @param {any} updatedPayload
 * @param {Array<{ uid: string, disabled: boolean }>} appliedChanges
 */
async function syncHostCacheAndOpenEditorIfPresent(worldName, updatedPayload, appliedChanges) {
    await ensureWorldInfoModule();
    const cache = _worldInfoModule?.worldInfoCache;

    let wasInCache = false;
    if (cache instanceof Map && cache.has(worldName)) {
        wasInCache = true;
        const cachedObj = cache.get(worldName);
        if (cachedObj && typeof cachedObj === 'object' && cachedObj.entries && typeof cachedObj.entries === 'object') {
            const changeMap = new Map(appliedChanges.map((c) => [c.uid, c.disabled]));
            for (const [k, entry] of Object.entries(cachedObj.entries)) {
                if (!entry || typeof entry !== 'object') continue;
                const uid = String(entry.uid ?? k);
                if (changeMap.has(uid)) {
                    entry.disable = Boolean(changeMap.get(uid));
                }
            }
        } else {
            cache.set(worldName, updatedPayload);
        }
    } else if (cache && typeof cache === 'object' && !(cache instanceof Map) && Object.hasOwn(cache, worldName)) {
        wasInCache = true;
        cache[worldName] = updatedPayload;
    }

    if (getCurrentEditorWorldName() === worldName && typeof document !== 'undefined') {
        if (typeof _worldInfoModule?.reloadEditor === 'function' && wasInCache) {
            try {
                _worldInfoModule.reloadEditor(worldName);
                return;
            } catch {
                // Fall back to lightweight DOM class sync below
            }
        }

        const listEl = document.getElementById('world_popup_entries_list');
        if (listEl) {
            for (const { uid, disabled } of appliedChanges) {
                const row = listEl.querySelector(`.world_entry[uid="${CSS.escape(uid)}"]`);
                if (!row) continue;
                const killSwitch = row.querySelector('.killSwitch');
                if (killSwitch) {
                    killSwitch.classList.toggle('fa-toggle-off', disabled);
                    killSwitch.classList.toggle('fa-toggle-on', !disabled);
                    killSwitch.classList.toggle('disabled', disabled);
                }
            }
        }
    }
}

/**
 * Apply a batch toggle plan (`Map<uid, nextDisabled>`) to a worldbook in ONE single disk write.
 * Always reads the freshest payload right before applying so external changes are never overwritten.
 *
 * @param {string} worldName
 * @param {Map<string, boolean>} togglePlan
 * @returns {Promise<{ ok: boolean, changedCount: number, appliedChanges: Array<{ uid: string, disabled: boolean }>, summaries: Array<any>, error?: string }>}
 */
export async function applyWorldbookTogglePlan(worldName, togglePlan) {
    const clean = String(worldName ?? '').trim();
    if (!clean) {
        return { ok: false, changedCount: 0, appliedChanges: [], summaries: [], error: '未选择世界书' };
    }

    let payload = await fetchWorldInfoUncached(clean);
    if (!payload || typeof payload !== 'object' || !('entries' in payload)) {
        return { ok: false, changedCount: 0, appliedChanges: [], summaries: [], error: `无法读取世界书「${clean}」` };
    }

    const { changedCount, appliedChanges } = applyTogglePlanToPayload(payload, togglePlan);
    if (changedCount === 0) {
        const summaries = extractWorldbookEntrySummaries(payload);
        payload = null;
        return { ok: true, changedCount: 0, appliedChanges: [], summaries };
    }

    _selfWriteGuardUntil = Date.now() + 1200;

    try {
        const res = await fetch('/api/worldinfo/edit', {
            method: 'POST',
            headers: buildRequestHeaders(),
            body: JSON.stringify({ name: clean, data: payload }),
        });
        if (!res.ok) {
            throw new Error(`HTTP ${res.status}`);
        }
    } catch (err) {
        payload = null;
        return {
            ok: false,
            changedCount: 0,
            appliedChanges: [],
            summaries: [],
            error: `保存世界书失败：${err?.message || err}`,
        };
    }

    await syncHostCacheAndOpenEditorIfPresent(clean, payload, appliedChanges);

    const summaries = extractWorldbookEntrySummaries(payload);
    payload = null;

    emitBridgeEvent('weg:entries-toggled', {
        worldName: clean,
        changedCount,
        changes: appliedChanges,
    });

    return {
        ok: true,
        changedCount,
        appliedChanges,
        summaries,
    };
}

/**
 * Resolve greeting comment coordination (`<!-- lore / exclude / title -->`) for the character
 * bound to `worldName`, ALWAYS combining full character-card greetings with live floor-0 swipes
 * so multi-floor or branched chats never lose sibling IF-line UID sets!
 *
 * @param {string} worldName
 * @param {{ allowFetchShallow?: boolean }} [opts]
 * @returns {Promise<{ characterName: string, greetingIndex: ReturnType<typeof buildGreetingCoordinationIndex> | null }>}
 */
export async function resolveGreetingCoordinationForBook(worldName, { allowFetchShallow = false } = {}) {
    const clean = String(worldName ?? '').trim();
    if (!clean) return { characterName: '', greetingIndex: null };

    const ctx = getHostContext();
    const characters = Array.isArray(ctx?.characters) ? ctx.characters : [];

    if (ctx && !ctx.groupId && ctx.characterId !== undefined && ctx.characterId !== null && ctx.characterId !== '') {
        const activeChar = characters[Number(ctx.characterId)];
        const activeBook = getCurrentCharacterPrimaryWorldName();
        if (activeChar && activeBook === clean) {
            const msg0 = ctx.chat?.[0];
            const swipes = Array.isArray(msg0?.swipes) && msg0.swipes.length > 0 ? msg0.swipes : null;
            const currentSwipeId = Number.isInteger(msg0?.swipe_id) ? msg0.swipe_id : null;
            const idx = buildGreetingCoordinationIndex({
                swipes,
                firstMes: activeChar.first_mes || activeChar.data?.first_mes || '',
                alternateGreetings: activeChar.data?.alternate_greetings || [],
                currentSwipeId,
            });
            return {
                characterName: String(activeChar.name || activeChar.data?.name || '').trim(),
                greetingIndex: idx,
            };
        }
    }

    const matchedLoaded = characters.find(
        (ch) => ch && !ch.shallow && String(ch?.data?.extensions?.world ?? '').trim() === clean,
    );
    if (matchedLoaded) {
        const idx = buildGreetingCoordinationIndex({
            firstMes: matchedLoaded.first_mes || matchedLoaded.data?.first_mes || '',
            alternateGreetings: matchedLoaded.data?.alternate_greetings || [],
            currentSwipeId: null,
        });
        return {
            characterName: String(matchedLoaded.name || matchedLoaded.data?.name || '').trim(),
            greetingIndex: idx,
        };
    }

    if (allowFetchShallow) {
        const wboBindings = ctx?.extensionSettings?.worldbook_organizer?.cachedCharBindings;
        let targetAvatar = null;
        if (wboBindings && typeof wboBindings === 'object') {
            for (const [avatar, meta] of Object.entries(wboBindings)) {
                if (meta?.primary === clean) {
                    targetAvatar = avatar;
                    break;
                }
            }
        }
        if (targetAvatar) {
            try {
                const res = await fetch('/api/characters/get', {
                    method: 'POST',
                    headers: buildRequestHeaders(),
                    body: JSON.stringify({ avatar_url: targetAvatar }),
                });
                if (res.ok) {
                    let fullChar = await res.json();
                    const idx = buildGreetingCoordinationIndex({
                        firstMes: fullChar?.first_mes || fullChar?.data?.first_mes || '',
                        alternateGreetings: fullChar?.data?.alternate_greetings || [],
                        currentSwipeId: null,
                    });
                    const charName = String(fullChar?.name || fullChar?.data?.name || '').trim();
                    fullChar = null;
                    return { characterName: charName, greetingIndex: idx };
                }
            } catch {
                // Ignore
            }
        }
    }

    return { characterName: '', greetingIndex: null };
}

/**
 * Automatically recognize & restore the active chat save's IF-line / entry state!
 * - On `floor0-swipe` (when `chat.length === 1`): updates this save's bound route to match the newly chosen greeting.
 * - On `chat-changed` (even 100+ floors deep or in `/branch` saves): uses the save's bound `chatMetadata` profile,
 *   or infers the route from `ctx.chat` messages + character card greetings, binds it, and restores the worldbook
 *   in a single write if any entry differs!
 *
 * @param {{ reason?: 'chat-changed' | 'floor0-swipe' | 'manual', silentToast?: boolean }} [opts]
 * @returns {Promise<{ synced: boolean, changedCount: number, routeLabel: string, worldName: string }>}
 */
export async function syncWorldbookForActiveChat({ reason = 'chat-changed', silentToast = false } = {}) {
    const settings = getSettings();
    if (reason !== 'manual' && settings.autoSwitchOnChatChange === false) {
        return { synced: false, changedCount: 0, routeLabel: '', worldName: '' };
    }

    const ctx = getHostContext();
    const saveCtx = getCurrentChatSaveContext();
    if (!ctx || !saveCtx || !saveCtx.primaryWorldName) {
        return { synced: false, changedCount: 0, routeLabel: '', worldName: '' };
    }

    const worldName = saveCtx.primaryWorldName;
    const bookConfig = normalizeBookConfig(settings.books?.[worldName]);
    const chatMessages = Array.isArray(ctx.chat) ? ctx.chat : [];

    let { profile } = getActiveChatBoundProfile(worldName);

    // When swiping floor 0 on a brand-new 1-message chat, re-infer route from the new greeting!
    const isFreshFloorZeroSwipe = reason === 'floor0-swipe' && chatMessages.length <= 1;

    if (!profile || isFreshFloorZeroSwipe) {
        const { greetingIndex } = await resolveGreetingCoordinationForBook(worldName, { allowFetchShallow: false });
        const inferred = inferChatRouteFromMessages({
            worldName,
            chatMessages,
            greetingIndex,
            bookConfig,
        });
        if (inferred) {
            profile = inferred;
            saveActiveChatBoundProfile(profile);
        }
    }

    if (!profile) {
        return { synced: false, changedCount: 0, routeLabel: '', worldName };
    }

    const readRes = await loadWorldbookSummariesUncached(worldName);
    if (!readRes.ok || readRes.summaries.length === 0) {
        return { synced: false, changedCount: 0, routeLabel: profile.routeLabel, worldName };
    }

    const restorePlan = computeChatProfileRestorePlan(readRes.summaries, bookConfig, profile);
    if (restorePlan.size === 0) {
        return { synced: true, changedCount: 0, routeLabel: profile.routeLabel, worldName };
    }

    const writeRes = await applyWorldbookTogglePlan(worldName, restorePlan);
    if (writeRes.ok && writeRes.changedCount > 0 && !silentToast) {
        showToast('info', `已按当前存档切换至「${profile.routeLabel}」（同步 ${writeRes.changedCount} 个条目）`);
    }

    return {
        synced: Boolean(writeRes.ok),
        changedCount: writeRes.changedCount || 0,
        routeLabel: profile.routeLabel,
        worldName,
    };
}

/**
 * Capture and bind the worldbook's current IF-line / entry state to the active chat save
 * whenever `worldName` matches the active chat's primary worldbook.
 *
 * @param {string} worldName
 * @param {Array<any>} summaries
 * @param {{ preferredIfGroupId?: string, customLabel?: string, greetingIndex?: any, force?: boolean }} [opts]
 */
export function recordStateIntoActiveChatIfMatching(worldName, summaries, opts = {}) {
    const cleanWorld = String(worldName ?? '').trim();
    if (!cleanWorld) return null;

    const settings = getSettings();
    if (!opts.force && settings.autoSwitchOnChatChange === false) return null;

    const saveCtx = getCurrentChatSaveContext();
    if (!saveCtx || saveCtx.primaryWorldName !== cleanWorld) return null;

    const bookConfig = normalizeBookConfig(settings.books?.[cleanWorld]);
    const profile = buildChatProfileFromCurrentState(cleanWorld, summaries, bookConfig, opts);
    if (!profile) return null;

    saveActiveChatBoundProfile(profile);
    return profile;
}

/**
 * Open `worldName` in SillyTavern's native `#WorldInfo` editor and scroll + highlight `uid`.
 *
 * @param {string} worldName
 * @param {string} uid
 * @param {string} [entryTitle='']
 * @returns {Promise<boolean>}
 */
export async function locateEntryInNativeEditor(worldName, uid, entryTitle = '') {
    const cleanWorld = String(worldName ?? '').trim();
    const uidStr = String(uid ?? '').trim();
    if (!cleanWorld || !uidStr || typeof document === 'undefined') return false;

    const ctx = getHostContext();
    await ensureWorldInfoModule();

    const drawer = document.getElementById('WorldInfo');
    if (drawer && drawer.classList.contains('closedDrawer')) {
        const icon = document.querySelector('#WI-SP-button .drawer-icon');
        if (icon instanceof HTMLElement) icon.click();
    }

    const selectEl = document.getElementById('world_editor_select');
    if (!selectEl) return false;

    const et = ctx?.eventTypes || ctx?.event_types || {};
    if (ctx?.eventSource && et.WORLDINFO_ENTRIES_LOADED && typeof ctx.eventSource.emit === 'function') {
        try {
            ctx.eventSource.emit(et.WORLDINFO_ENTRIES_LOADED, cleanWorld);
        } catch {
            // Non-fatal
        }
    }

    let targetOpt = Array.from(selectEl.querySelectorAll('option')).find(
        (opt) => opt.value !== '' && (opt.textContent || '').trim() === cleanWorld,
    );

    if (!targetOpt) {
        const allNames = getWorldNames();
        const worldIdx = allNames.indexOf(cleanWorld);
        if (worldIdx >= 0) {
            const tempOpt = document.createElement('option');
            tempOpt.value = String(worldIdx);
            tempOpt.textContent = cleanWorld;
            selectEl.appendChild(tempOpt);
            targetOpt = tempOpt;
        }
    }

    if (!targetOpt) return false;

    if (getCurrentEditorWorldName() !== cleanWorld) {
        const $ = globalThis.jQuery;
        if ($) {
            $(selectEl).val(targetOpt.value).trigger('change');
        } else {
            selectEl.value = targetOpt.value;
            selectEl.dispatchEvent(new Event('change', { bubbles: true }));
        }
    }

    return await new Promise((resolve) => {
        let tries = 0;
        let triedSearchFallback = false;

        const highlightElement = (entryEl) => {
            try {
                entryEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
            } catch {
                entryEl.scrollIntoView();
            }
            entryEl.classList.remove('weg-entry-locate-flash');
            void entryEl.offsetWidth;
            entryEl.classList.add('weg-entry-locate-flash');
            setTimeout(() => entryEl.classList.remove('weg-entry-locate-flash'), 2000);
        };

        const attemptLocate = () => {
            const list = document.getElementById('world_popup_entries_list');
            const entryEl = list?.querySelector(`.world_entry[uid="${CSS.escape(uidStr)}"]`);
            if (entryEl instanceof HTMLElement) {
                highlightElement(entryEl);
                resolve(true);
                return;
            }

            if (!triedSearchFallback && tries >= 4 && list && list.children.length > 0) {
                const searchInput = document.getElementById('world_info_search');
                if (searchInput instanceof HTMLInputElement) {
                    triedSearchFallback = true;
                    const queryHint = String(entryTitle || '').trim();
                    if (searchInput.value.trim() !== '') {
                        searchInput.value = '';
                        searchInput.dispatchEvent(new Event('input', { bubbles: true }));
                    } else if (queryHint) {
                        searchInput.value = queryHint;
                        searchInput.dispatchEvent(new Event('input', { bubbles: true }));
                    }
                }
            }

            if (tries < 16) {
                tries += 1;
                setTimeout(attemptLocate, 120);
            } else {
                resolve(false);
            }
        };

        setTimeout(attemptLocate, 160);
    });
}

/**
 * Copy plain text to clipboard with fallback for restricted WebViews.
 * @param {string} text
 * @returns {Promise<boolean>}
 */
export async function copyTextToClipboard(text) {
    const content = String(text ?? '');
    if (!content) return false;
    try {
        if (globalThis.navigator?.clipboard?.writeText) {
            await globalThis.navigator.clipboard.writeText(content);
            return true;
        }
    } catch {
        // Fallback below
    }
    try {
        const ta = document.createElement('textarea');
        ta.value = content;
        ta.setAttribute('readonly', 'true');
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        ta.style.pointerEvents = 'none';
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand('copy');
        ta.remove();
        return Boolean(ok);
    } catch {
        return false;
    }
}

/**
 * Detect whether the active SillyTavern theme background is light or dark.
 * @returns {'light' | 'dark'}
 */
export function detectHostColorScheme() {
    if (typeof document === 'undefined' || typeof getComputedStyle !== 'function') return 'dark';
    try {
        const probe = document.getElementById('world_popup') || document.body;
        const rawBg = getComputedStyle(probe).backgroundColor || '';
        const match = rawBg.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
        if (match) {
            const r = Number(match[1]);
            const g = Number(match[2]);
            const b = Number(match[3]);
            const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
            if (luminance > 0.56) return 'light';
            if (luminance < 0.44) return 'dark';
        }
    } catch {
        // Ignore
    }
    if (globalThis.matchMedia?.('(prefers-color-scheme: light)')?.matches) {
        return 'light';
    }
    return 'dark';
}

/**
 * Display a concise toast message.
 * @param {'success' | 'info' | 'warning' | 'error'} type
 * @param {string} message
 */
export function showToast(type, message) {
    const toastr = globalThis.toastr;
    if (toastr && typeof toastr[type] === 'function') {
        toastr[type](message, '世界书条目分组');
    } else {
        console.log(`[WorldbookEntryGroups][${type}] ${message}`);
    }
}
