/**
 * Worldbook Entry Groups — Entry module for SillyTavern & TauriTavern.
 *
 * Lifecycle guarantees:
 * - Zero polling, zero background worldbook scanning, zero multi-floor chat history scanning.
 * - Mounts in 3 native places: Extensions Drawer (`#extensions_settings2`), Magic Wand Menu (`#extensionsMenu`),
 *   and WorldInfo Toolbar (`#world_popup`).
 * - O(1) metadata-based per-chat route restoration on `CHAT_CHANGED` + pre-WorldInfo scene auto-toggle
 *   on `GENERATION_AFTER_COMMANDS`.
 */

import {
    migrateSettingsOnWorldRename,
    removeDeletedWorldsFromSettings,
} from './src/core.js';
import {
    captureExternalWorldbookSwitchForActiveChat,
    clearRuntimeBookSnapshots,
    ensureWorldInfoModule,
    getCurrentCharacterPrimaryWorldName,
    getHostContext,
    getSettings,
    isWithinSelfWriteWindow,
    saveSettings,
    switchNamedGroupInActiveChat,
    syncSceneGroupsBeforeGeneration,
    syncWorldbookForActiveChat,
    waitForTauriReadyIfPresent,
} from './src/host.js';
import {
    bindPanelCallbacks,
    ensureAllNativeEntryPoints,
    getCurrentModalWorldName,
    handleExternalWorldbookDeleted,
    handleExternalWorldbookRenamed,
    isEntryGroupsModalOpen,
    openEntryGroupsModal,
    refreshOpenModalBook,
    syncAllNativeEntryPoints,
    teardownPanels,
} from './src/panel.js';

const STYLE_ASSET_VERSION = '0.4.0';

let _initialized = false;
let _nativeMountObserver = null;
let _greetingSyncTimer = null;
let _chatSwitchSyncTimer = null;
let _externalFollowTimer = null;
let _suppressExternalFollowUntil = 0;
/** @type {Array<{ event: string, handler: Function }>} */
const _boundHostEvents = [];
let _onWboRenamed = null;
let _onWboDeleted = null;
let _onWegOpenPanel = null;

function ensureFreshStylesheet() {
    if (typeof document === 'undefined' || !document.head) return;
    try {
        const targetHref = new URL(`./style.css?v=${STYLE_ASSET_VERSION}`, import.meta.url).href;
        const links = [...document.querySelectorAll('link[rel="stylesheet"]')];
        const existing = links.filter((el) => {
            const h = el.getAttribute('href') || '';
            return h.includes('worldbook-entry-groups/style.css');
        });
        if (existing.some((el) => el.href === targetHref)) return;
        const fresh = document.createElement('link');
        fresh.rel = 'stylesheet';
        fresh.href = targetHref;
        fresh.setAttribute('data-weg-style-ver', STYLE_ASSET_VERSION);
        fresh.addEventListener('load', () => {
            for (const old of existing) {
                if (old !== fresh) old.remove();
            }
        });
        document.head.appendChild(fresh);
    } catch {
        // Ignore
    }
}

function trackHostEvent(eventSource, eventName, handler) {
    if (!eventSource || !eventName || typeof eventSource.on !== 'function') return;
    eventSource.on(eventName, handler);
    _boundHostEvents.push({ event: eventName, handler });
}

function scheduleOpenModalSync(delayMs = 480) {
    if (!isEntryGroupsModalOpen()) return;

    clearTimeout(_greetingSyncTimer);
    _greetingSyncTimer = setTimeout(() => {
        _greetingSyncTimer = null;
        if (!_initialized || !isEntryGroupsModalOpen()) return;
        if (isWithinSelfWriteWindow()) return;

        const openBook = getCurrentModalWorldName();
        const activeCharBook = getCurrentCharacterPrimaryWorldName();
        if (openBook && (!activeCharBook || openBook === activeCharBook)) {
            void refreshOpenModalBook({ silent: true, reason: 'external-sync' });
        }
    }, delayMs);
}

function scheduleChatSaveRouteSync(reason, delayMs) {
    clearTimeout(_chatSwitchSyncTimer);
    _chatSwitchSyncTimer = setTimeout(async () => {
        _chatSwitchSyncTimer = null;
        if (!_initialized) return;
        const settings = getSettings();
        if (settings.autoSwitchOnChatChange === false) {
            syncAllNativeEntryPoints();
            if (isEntryGroupsModalOpen()) {
                void refreshOpenModalBook({ silent: true, reason });
            }
            return;
        }

        await syncWorldbookForActiveChat({
            reason,
            silentToast: reason === 'floor0-swipe',
        });

        if (!_initialized) return;
        syncAllNativeEntryPoints();
        if (isEntryGroupsModalOpen()) {
            void refreshOpenModalBook({ silent: true, reason });
        }
    }, delayMs);
}

function startToolbarMountObserver() {
    if (_nativeMountObserver || typeof MutationObserver === 'undefined' || typeof document === 'undefined') return;
    const target = document.getElementById('WorldInfo') || document.getElementById('world_popup');
    if (!target) return;

    _nativeMountObserver = new MutationObserver(() => {
        if (!document.getElementById('weg-native-entry-btn')) {
            ensureAllNativeEntryPoints();
            syncAllNativeEntryPoints();
        }
    });
    _nativeMountObserver.observe(target, { childList: true, subtree: true });
}

/**
 * Register `/weg [分组名 | 世界书名称]` slash command:
 * - `/weg` -> opens panel
 * - `/weg 30岁线` -> if matching a group in active character's primary worldbook, directly switches & locks stage!
 * - `/weg 世界书名` -> opens that worldbook in panel
 */
function registerSlashCommand(ctx) {
    try {
        const { SlashCommandParser, SlashCommand, SlashCommandArgument, ARGUMENT_TYPE } = ctx || {};
        if (!SlashCommandParser || !SlashCommand) return;

        SlashCommandParser.addCommandObject(
            SlashCommand.fromProps({
                name: 'weg',
                callback: async (_namedArgs, unnamedArgs) => {
                    const arg = String(unnamedArgs ?? '').trim();
                    if (!arg) {
                        await openEntryGroupsModal();
                        return 'opened';
                    }
                    const switched = await switchNamedGroupInActiveChat(arg);
                    if (switched.matched) {
                        syncAllNativeEntryPoints();
                        if (isEntryGroupsModalOpen()) {
                            void refreshOpenModalBook({ silent: true, reason: 'slash-switch' });
                        }
                        return switched.groupName || arg;
                    }
                    await openEntryGroupsModal({ worldName: arg });
                    return arg;
                },
                unnamedArgumentList: SlashCommandArgument && ARGUMENT_TYPE ? [
                    SlashCommandArgument.fromProps({
                        description: '可选：分组名称（直接切换本档路线，如 30岁线）或世界书名称',
                        typeList: [ARGUMENT_TYPE.STRING],
                        isRequired: false,
                    }),
                ] : [],
                helpString: '打开世界书条目分组面板，或直接切换本档分组路线：/weg [分组名|世界书名称]',
            }),
        );
    } catch {
        // Non-fatal
    }
}

export async function init() {
    if (_initialized) return;
    _initialized = true;

    await waitForTauriReadyIfPresent();
    const ctx = getHostContext();
    if (!ctx) {
        _initialized = false;
        return;
    }

    getSettings();
    await ensureWorldInfoModule();

    bindPanelCallbacks({
        onSettingsChanged: () => {
            saveSettings();
            syncAllNativeEntryPoints();
        },
    });

    ensureAllNativeEntryPoints();
    syncAllNativeEntryPoints();
    startToolbarMountObserver();

    if (typeof window !== 'undefined') {
        if (!_onWboRenamed) {
            _onWboRenamed = (ev) => {
                const oldName = String(ev?.detail?.oldName ?? '').trim();
                const newName = String(ev?.detail?.newName ?? '').trim();
                if (!oldName || !newName) return;
                clearRuntimeBookSnapshots(oldName);
                const settings = getSettings();
                if (migrateSettingsOnWorldRename(settings, oldName, newName)) {
                    saveSettings();
                }
                handleExternalWorldbookRenamed(oldName, newName);
            };
            window.addEventListener('wbo:worldbook-renamed', _onWboRenamed);
        }

        if (!_onWboDeleted) {
            _onWboDeleted = (ev) => {
                const names = Array.isArray(ev?.detail?.names) ? ev.detail.names : [];
                if (names.length === 0) return;
                for (const n of names) clearRuntimeBookSnapshots(String(n ?? '').trim());
                const settings = getSettings();
                if (removeDeletedWorldsFromSettings(settings, names)) {
                    saveSettings();
                }
                handleExternalWorldbookDeleted(names);
            };
            window.addEventListener('wbo:worldbook-deleted', _onWboDeleted);
        }

        if (!_onWegOpenPanel) {
            _onWegOpenPanel = (ev) => {
                const worldName = String(ev?.detail?.worldName ?? '').trim();
                void openEntryGroupsModal(worldName ? { worldName } : {});
            };
            window.addEventListener('weg:open-panel', _onWegOpenPanel);
        }
    }

    const eventSource = ctx.eventSource;
    const et = ctx.eventTypes || ctx.event_types || {};

    const syncEntryPointsIdle = () => {
        const run = () => {
            if (!_initialized) return;
            ensureAllNativeEntryPoints();
            syncAllNativeEntryPoints();
        };
        if (typeof globalThis.requestIdleCallback === 'function') {
            globalThis.requestIdleCallback(run, { timeout: 1000 });
        } else {
            setTimeout(run, 120);
        }
    };

    trackHostEvent(eventSource, et.APP_READY, syncEntryPointsIdle);
    trackHostEvent(eventSource, et.EXTENSION_SETTINGS_LOADED, syncEntryPointsIdle);
    trackHostEvent(eventSource, et.WORLDINFO_SETTINGS_UPDATED, () => {
        syncEntryPointsIdle();
        if (isEntryGroupsModalOpen() && !isWithinSelfWriteWindow()) {
            scheduleOpenModalSync(380);
        }
    });
    trackHostEvent(eventSource, et.WORLDINFO_ENTRIES_LOADED, syncEntryPointsIdle);
    trackHostEvent(eventSource, et.WORLDINFO_UPDATED, (worldName) => {
        const cleanUpdated = worldName ? String(worldName).trim() : '';
        if (cleanUpdated) clearRuntimeBookSnapshots(cleanUpdated);
        if (isWithinSelfWriteWindow()) return;

        // Follow external Tavern Helper script switches (unless right in the middle of a chat switch!)
        if (Date.now() > _suppressExternalFollowUntil) {
            clearTimeout(_externalFollowTimer);
            _externalFollowTimer = setTimeout(async () => {
                _externalFollowTimer = null;
                if (!_initialized || isWithinSelfWriteWindow() || Date.now() <= _suppressExternalFollowUntil) return;
                await captureExternalWorldbookSwitchForActiveChat(cleanUpdated);
                syncAllNativeEntryPoints();
            }, 460);
        }

        if (!isEntryGroupsModalOpen()) return;
        const openBook = getCurrentModalWorldName();
        if (!cleanUpdated || cleanUpdated === openBook) {
            scheduleOpenModalSync(320);
        }
    });

    trackHostEvent(eventSource, et.MESSAGE_SWIPED, (msgId) => {
        if (Number(msgId) === 0 || msgId === undefined) {
            scheduleChatSaveRouteSync('floor0-swipe', 520);
        }
    });
    trackHostEvent(eventSource, et.CHARACTER_MESSAGE_RENDERED, (msgId) => {
        if (Number(msgId) === 0) {
            scheduleOpenModalSync(480);
        }
    });

    // O(1) metadata restore when switching chat saves (`CHAT_CHANGED`)
    trackHostEvent(eventSource, et.CHAT_CHANGED, () => {
        // Suppress external floor-0 script echo during the first 900ms of a chat switch so our saved route wins!
        _suppressExternalFollowUntil = Date.now() + 900;
        clearTimeout(_externalFollowTimer);
        _externalFollowTimer = null;
        syncEntryPointsIdle();
        scheduleChatSaveRouteSync('chat-changed', 650);
    });

    // Awaited pre-WorldInfo hook: turns `scene` (NSFW) groups ON/OFF right before prompt assembly!
    trackHostEvent(eventSource, et.GENERATION_AFTER_COMMANDS, async (type, _opts, dryRun) => {
        const res = await syncSceneGroupsBeforeGeneration(type, Boolean(dryRun));
        if (res.changedCount > 0 && isEntryGroupsModalOpen()) {
            void refreshOpenModalBook({ silent: true, reason: 'scene-auto' });
        }
    });

    registerSlashCommand(ctx);
    ensureFreshStylesheet();
}

export async function onActivate() {
    await init();
}

export function onDisable() {
    clearTimeout(_greetingSyncTimer);
    _greetingSyncTimer = null;
    clearTimeout(_chatSwitchSyncTimer);
    _chatSwitchSyncTimer = null;
    clearTimeout(_externalFollowTimer);
    _externalFollowTimer = null;

    if (_nativeMountObserver) {
        _nativeMountObserver.disconnect();
        _nativeMountObserver = null;
    }

    if (typeof window !== 'undefined') {
        if (_onWboRenamed) {
            window.removeEventListener('wbo:worldbook-renamed', _onWboRenamed);
            _onWboRenamed = null;
        }
        if (_onWboDeleted) {
            window.removeEventListener('wbo:worldbook-deleted', _onWboDeleted);
            _onWboDeleted = null;
        }
        if (_onWegOpenPanel) {
            window.removeEventListener('weg:open-panel', _onWegOpenPanel);
            _onWegOpenPanel = null;
        }
    }

    const ctx = getHostContext();
    const eventSource = ctx?.eventSource;
    if (eventSource) {
        const removeFn = eventSource.removeListener || eventSource.off;
        if (typeof removeFn === 'function') {
            for (const { event, handler } of _boundHostEvents) {
                try {
                    removeFn.call(eventSource, event, handler);
                } catch {
                    // Ignore
                }
            }
        }
    }
    _boundHostEvents.length = 0;

    clearRuntimeBookSnapshots();
    teardownPanels();
    _initialized = false;
}

export const onClean = onDisable;

function boot() {
    if (typeof document === 'undefined') return;
    const start = () => {
        if (typeof globalThis.requestIdleCallback === 'function') {
            globalThis.requestIdleCallback(() => { void init(); }, { timeout: 1500 });
        } else {
            setTimeout(() => { void init(); }, 250);
        }
    };

    const ctx = getHostContext();
    const eventSource = ctx?.eventSource;
    const et = ctx?.eventTypes || ctx?.event_types;

    if (eventSource && et?.APP_READY && typeof eventSource.once === 'function') {
        eventSource.once(et.APP_READY, start);
    }

    if (typeof globalThis.jQuery === 'function') {
        globalThis.jQuery(() => {
            setTimeout(start, 400);
        });
    } else if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', start, { once: true });
    } else {
        start();
    }
}

boot();
