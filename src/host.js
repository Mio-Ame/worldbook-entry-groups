/**
 * Worldbook Entry Groups — Dual-host adapter for SillyTavern & TauriTavern.
 *
 * Key guarantees:
 * 1. Zero chat-history scanning: `CHAT_CHANGED` reads ONLY `chatMetadata` (~200B, O(1)),
 *    so 100MB+ / multi-thousand-floor chats never incur regex loops or memory spikes.
 * 2. In-save timeline progression (e.g. 18岁 -> 30岁): switching an IF-line group updates
 *    the save's `chatMetadata` stage immediately and is never reverted by floor-0 openings.
 * 3. Pre-WorldInfo scene auto-toggle (`GENERATION_AFTER_COMMANDS`): inspects ONLY the latest
 *    1–2 turn snippets (~1200 chars max) with a zero-I/O fast path on normal turns, enabling
 *    `scene` (e.g. NSFW) groups right before `getWorldInfoPrompt` and cooling down automatically.
 */

import {
    GROUP_MODES,
    MODULE_NAME,
    applyTogglePlanToPayload,
    buildChatProfileFromCurrentState,
    buildGreetingCoordinationIndex,
    buildInitialProfileFromFloorZero,
    computeChatProfileRestorePlan,
    computeGreetingPresetPlan,
    computeGroupTogglePlan,
    evaluateSceneAutoToggle,
    extractExternalScriptRouteLabel,
    extractWorldbookEntrySummaries,
    normalizeBookConfig,
    normalizeChatProfile,
    normalizeSettings,
    upsertStoredChatProfile,
} from './core.js';

let _worldInfoModule = null;
let _worldInfoModuleTried = false;
let _selfWriteGuardUntil = 0;

/** @type {Map<string, Record<string, number>>} chatKey -> (groupId -> remainingCooldownTurns) */
const _sceneCooldownByChat = new Map();
/** @type {Map<string, Map<string, boolean>>} worldName -> (uid -> disabled) lightweight state cache */
const _knownEntryDisabledByBook = new Map();

export function getHostContext() {
    try {
        return globalThis.SillyTavern?.getContext?.() || null;
    } catch {
        return null;
    }
}

export function isTauriTavern() {
    return Boolean(globalThis.__TAURITAVERN__ || globalThis.__TAURI_RUNNING__);
}

export function applyTauriSurface(el, surface) {
    if (!el || !isTauriTavern()) return;
    el.setAttribute('data-tt-mobile-surface', surface);
}

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

function buildRequestHeaders() {
    const ctx = getHostContext();
    if (typeof ctx?.getRequestHeaders === 'function') {
        return ctx.getRequestHeaders();
    }
    return { 'Content-Type': 'application/json' };
}

export function emitBridgeEvent(type, detail = {}) {
    try {
        if (typeof window !== 'undefined' && typeof CustomEvent === 'function') {
            window.dispatchEvent(new CustomEvent(type, { detail }));
        }
    } catch {
        // Ignore in headless/non-browser runtimes
    }
}

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

export function saveSettings() {
    const ctx = getHostContext();
    if (typeof ctx?.saveSettingsDebounced === 'function') {
        ctx.saveSettingsDebounced();
    }
    emitBridgeEvent('weg:settings-updated', { reason: 'save' });
}

export function isWithinSelfWriteWindow() {
    return Date.now() < _selfWriteGuardUntil;
}

function cacheLightDisabledSnapshot(worldName, summaries) {
    if (!worldName || !Array.isArray(summaries)) return;
    if (_knownEntryDisabledByBook.size > 12 && !_knownEntryDisabledByBook.has(worldName)) {
        const oldest = _knownEntryDisabledByBook.keys().next().value;
        if (oldest !== undefined) _knownEntryDisabledByBook.delete(oldest);
    }
    _knownEntryDisabledByBook.set(
        worldName,
        new Map(summaries.map((s) => [s.uid, Boolean(s.disabled)])),
    );
}

export function clearRuntimeBookSnapshots(worldName = '') {
    if (worldName) {
        _knownEntryDisabledByBook.delete(worldName);
    } else {
        _knownEntryDisabledByBook.clear();
        _sceneCooldownByChat.clear();
    }
}

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

export function getCurrentEditorWorldName() {
    if (typeof document === 'undefined') return null;
    const sel = document.getElementById('world_editor_select');
    if (!sel) return null;
    const selectedOpt = sel.selectedOptions?.[0];
    if (!selectedOpt || selectedOpt.value === '') return null;
    return (selectedOpt.textContent || '').trim() || null;
}

export function getCurrentCharacterPrimaryWorldName() {
    try {
        const thPrimary = globalThis.TavernHelper?.getCurrentCharPrimaryLorebook?.();
        if (typeof thPrimary === 'string' && thPrimary.trim()) {
            return thPrimary.trim();
        }
    } catch {
        // Ignore
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
 * O(1) chat identity lookup — reads ONLY lightweight scalar properties, NEVER iterates `ctx.chat`.
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
 * O(1) read of the bound route profile for the active chat save.
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
 * Persist a route profile into BOTH `chatMetadata` AND `settings.chatProfiles`.
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
        // Fallback below
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

export async function loadWorldbookSummariesUncached(worldName) {
    const clean = String(worldName ?? '').trim();
    if (!clean) return { ok: false, summaries: [], error: '未选择世界书' };

    let payload = await fetchWorldInfoUncached(clean);
    if (!payload || typeof payload !== 'object' || !('entries' in payload)) {
        return { ok: false, summaries: [], error: `无法读取世界书「${clean}」` };
    }

    const summaries = extractWorldbookEntrySummaries(payload);
    payload = null;
    cacheLightDisabledSnapshot(clean, summaries);

    return { ok: true, summaries };
}

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
        cacheLightDisabledSnapshot(clean, summaries);
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
    cacheLightDisabledSnapshot(clean, summaries);

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
 * Pure O(1) metadata-driven save route restoration!
 * - NEVER scans or iterates multi-floor chat history (100% safe on 500MB+ chat files).
 * - Only inspects `chat[0]` header (~1.2KB slice) when `chat.length === 1` (freshly created 1-message save).
 * - Once bound in `chatMetadata` (e.g. `18岁线`, or later switched to `30岁线` mid-save), restores `chatMetadata` directly!
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
    let { profile } = getActiveChatBoundProfile(worldName);

    // ONLY inspect floor 0 header when the chat is a brand-new 1-floor opening (`floorCount === 1`)!
    if (saveCtx.floorCount === 1 && (!profile || reason === 'floor0-swipe')) {
        const floorZeroHeader = String(ctx.chat?.[0]?.mes ?? '').slice(0, 1200);
        if (floorZeroHeader.includes('<!--')) {
            const { greetingIndex } = await resolveGreetingCoordinationForBook(worldName, { allowFetchShallow: false });
            const initial = buildInitialProfileFromFloorZero({
                worldName,
                floorZeroMes: floorZeroHeader,
                greetingIndex,
                bookConfig,
            });
            if (initial) {
                profile = initial;
                saveActiveChatBoundProfile(profile);
            }
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
        showToast('info', `已按当前存档切换至「${profile.routeLabel}」`);
    }

    return {
        synced: Boolean(writeRes.ok),
        changedCount: writeRes.changedCount || 0,
        routeLabel: profile.routeLabel,
        worldName,
    };
}

/**
 * Switch a named group (e.g. `/weg 30岁线`) directly in the active character's primary worldbook
 * and update the active chat save's stage binding (supports instant 18岁 -> 30岁 mid-save jump!).
 *
 * @param {string} groupNameQuery
 * @returns {Promise<{ matched: boolean, groupName?: string, error?: string }>}
 */
export async function switchNamedGroupInActiveChat(groupNameQuery) {
    const query = String(groupNameQuery ?? '').trim();
    if (!query) return { matched: false };

    const worldName = getCurrentCharacterPrimaryWorldName();
    if (!worldName) return { matched: false };

    const settings = getSettings();
    const bookCfg = normalizeBookConfig(settings.books?.[worldName]);
    if (bookCfg.groups.length === 0) return { matched: false };

    const targetGrp = bookCfg.groups.find((g) => g.name === query)
        || bookCfg.groups.find((g) => g.name.toLowerCase() === query.toLowerCase());
    if (!targetGrp) return { matched: false };

    const readRes = await loadWorldbookSummariesUncached(worldName);
    if (!readRes.ok) return { matched: true, groupName: targetGrp.name, error: readRes.error };

    const plan = computeGroupTogglePlan(readRes.summaries, bookCfg, targetGrp.id, true);
    let latestSummaries = readRes.summaries;
    if (plan.size > 0) {
        const writeRes = await applyWorldbookTogglePlan(worldName, plan);
        if (!writeRes.ok) return { matched: true, groupName: targetGrp.name, error: writeRes.error };
        latestSummaries = writeRes.summaries;
    }

    recordStateIntoActiveChatIfMatching(worldName, latestSummaries, {
        preferredIfGroupId: targetGrp.mode === GROUP_MODES.IF_LINE ? targetGrp.id : '',
        customLabel: targetGrp.name,
        force: true,
    });

    showToast('success', `已切换本档至「${targetGrp.name}」`);
    return { matched: true, groupName: targetGrp.name };
}

/**
 * Pre-WorldInfo generation hook (`GENERATION_AFTER_COMMANDS`):
 * Automatically enables `scene` groups (e.g. NSFW lore) right before SillyTavern calls
 * `getWorldInfoPrompt()` when recent dialogue hits scene cues, and automatically turns them
 * back OFF once the conversation returns to normal plot!
 *
 * Fast-path: 0ms & 0 I/O when no `scene` groups exist or when state requires no transition!
 */
export async function syncSceneGroupsBeforeGeneration(type, dryRun = false) {
    if (dryRun || type === 'quiet') return { changedCount: 0 };

    const settings = getSettings();
    if (settings.enableSceneAutoToggle === false) return { changedCount: 0 };

    const ctx = getHostContext();
    const saveCtx = getCurrentChatSaveContext();
    if (!ctx || !saveCtx || !saveCtx.primaryWorldName) return { changedCount: 0 };

    const worldName = saveCtx.primaryWorldName;
    const bookConfig = normalizeBookConfig(settings.books?.[worldName]);
    if (!bookConfig.groups.some((g) => g.mode === GROUP_MODES.SCENE)) {
        return { changedCount: 0 };
    }

    // Read ONLY the tail ~600 chars of the latest 2 messages (never touches earlier chat history!)
    const chatArr = Array.isArray(ctx.chat) ? ctx.chat : [];
    const tailCount = Math.min(2, chatArr.length);
    const snippets = [];
    for (let i = chatArr.length - tailCount; i < chatArr.length; i += 1) {
        const raw = String(chatArr[i]?.mes ?? '');
        if (raw) snippets.push(raw.slice(-600));
    }
    const recentText = snippets.join('\n');

    // Use lightweight in-memory disabled snapshot (or `worldInfoCache`) first to avoid `fetch` on idle turns!
    await ensureWorldInfoModule();
    let probeEntries = null;
    const hostCache = _worldInfoModule?.worldInfoCache;
    if (hostCache instanceof Map && hostCache.has(worldName)) {
        const cachedPayload = hostCache.get(worldName);
        if (cachedPayload?.entries) {
            probeEntries = Object.entries(cachedPayload.entries).map(([k, e]) => ({
                uid: String(e?.uid ?? k),
                disabled: Boolean(e?.disable),
            }));
        }
    } else if (_knownEntryDisabledByBook.has(worldName)) {
        const knownMap = _knownEntryDisabledByBook.get(worldName);
        probeEntries = [...knownMap.entries()].map(([uid, disabled]) => ({ uid, disabled }));
    }

    if (!probeEntries) {
        const readRes = await loadWorldbookSummariesUncached(worldName);
        if (!readRes.ok) return { changedCount: 0 };
        probeEntries = readRes.summaries;
    }

    const prevCooldown = _sceneCooldownByChat.get(saveCtx.chatKey) || {};
    const evalRes = evaluateSceneAutoToggle({
        entries: probeEntries,
        bookConfig,
        recentText,
        cooldownByGroupId: prevCooldown,
    });
    _sceneCooldownByChat.set(saveCtx.chatKey, evalRes.nextCooldownByGroupId);

    if (evalRes.togglePlan.size === 0) {
        return { changedCount: 0 };
    }

    const writeRes = await applyWorldbookTogglePlan(worldName, evalRes.togglePlan);
    if (writeRes.ok && writeRes.changedCount > 0) {
        if (evalRes.activatedGroups.length > 0) {
            showToast('info', `检测到剧情信号，已临时开启「${evalRes.activatedGroups.join('、')}」`);
        } else if (evalRes.deactivatedGroups.length > 0) {
            showToast('info', `剧情已恢复日常，已自动收起「${evalRes.deactivatedGroups.join('、')}」`);
        }
    }

    return {
        changedCount: writeRes.changedCount || 0,
        activatedGroups: evalRes.activatedGroups,
        deactivatedGroups: evalRes.deactivatedGroups,
    };
}

export function recordStateIntoActiveChatIfMatching(worldName, summaries, opts = {}) {
    const cleanWorld = String(worldName ?? '').trim();
    if (!cleanWorld) return null;

    const settings = getSettings();
    if (!opts.force && settings.autoSwitchOnChatChange === false) return null;

    const ctx = getHostContext();
    const saveCtx = getCurrentChatSaveContext();
    if (!saveCtx || saveCtx.primaryWorldName !== cleanWorld) return null;

    const bookConfig = normalizeBookConfig(settings.books?.[cleanWorld]);
    const externalRouteHint = extractExternalScriptRouteLabel(ctx?.chatMetadata);
    const profile = buildChatProfileFromCurrentState(cleanWorld, summaries, bookConfig, {
        ...opts,
        externalRouteHint,
    });
    if (!profile) return null;

    saveActiveChatBoundProfile(profile);
    return profile;
}

/**
 * Automatically follow & snapshot worldbook switches made by any author's Tavern Helper script
 * (e.g. `setLorebookEntries` triggered by custom route buttons or opening managers) into the
 * active chat save's `chatMetadata` so switching saves later restores all layers seamlessly!
 */
export async function captureExternalWorldbookSwitchForActiveChat(worldName = '') {
    const settings = getSettings();
    if (settings.autoSwitchOnChatChange === false || isWithinSelfWriteWindow()) return null;

    const saveCtx = getCurrentChatSaveContext();
    if (!saveCtx || !saveCtx.primaryWorldName) return null;
    if (worldName && String(worldName).trim() !== saveCtx.primaryWorldName) return null;

    const readRes = await loadWorldbookSummariesUncached(saveCtx.primaryWorldName);
    if (!readRes.ok || readRes.summaries.length === 0) return null;

    return recordStateIntoActiveChatIfMatching(saveCtx.primaryWorldName, readRes.summaries);
}

/**
 * Apply a character card's greeting preset (`<!-- lore / exclude -->`) in 1 single disk write
 * and lock the resulting multi-group entry combination onto the active chat save!
 */
export async function applyGreetingPresetToWorldbook(worldName, greetingIndex, swipeIndex) {
    const cleanWorld = String(worldName ?? '').trim();
    if (!cleanWorld || !greetingIndex) {
        return { ok: false, error: '缺少开场白联动方案数据' };
    }

    const readRes = await loadWorldbookSummariesUncached(cleanWorld);
    if (!readRes.ok) {
        return { ok: false, error: readRes.error };
    }

    const preset = computeGreetingPresetPlan(readRes.summaries, greetingIndex, swipeIndex);
    if (!preset) {
        return { ok: false, error: '该开场白未配置世界书联动标签' };
    }

    const writeRes = await applyWorldbookTogglePlan(cleanWorld, preset.plan);
    if (!writeRes.ok) {
        return { ok: false, error: writeRes.error };
    }

    recordStateIntoActiveChatIfMatching(cleanWorld, writeRes.summaries, {
        customLabel: preset.routeLabel,
        force: true,
    });

    return {
        ok: true,
        changedCount: writeRes.changedCount,
        routeLabel: preset.routeLabel,
        summaries: writeRes.summaries,
    };
}

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

export function showToast(type, message) {
    const toastr = globalThis.toastr;
    if (toastr && typeof toastr[type] === 'function') {
        toastr[type](message, '世界书条目分组');
    } else {
        console.log(`[WorldbookEntryGroups][${type}] ${message}`);
    }
}
