/**
 * Worldbook Entry Groups — Entry module for SillyTavern & TauriTavern.
 *
 * Lifecycle guarantees:
 * - Zero polling & zero background worldbook scanning.
 * - Per-chat save route recognition & auto-switching (`CHAT_CHANGED` + floor-0 `MESSAGE_SWIPED`):
 *   runs after external floor-0 scripts settle so multi-floor & branched chat saves always
 *   restore their true IF-line / entry state cleanly.
 * - Coordinates with companion `worldbook-organizer` (`wbo:worldbook-renamed` / `wbo:worldbook-deleted`).
 * - Deterministic cleanup (`onDisable` / `onClean`) removes all listeners, observers, and DOM mounts.
 */

import {
    migrateSettingsOnWorldRename,
    removeDeletedWorldsFromSettings,
} from './src/core.js';
import {
    ensureWorldInfoModule,
    getCurrentCharacterPrimaryWorldName,
    getHostContext,
    getSettings,
    isWithinSelfWriteWindow,
    saveSettings,
    syncWorldbookForActiveChat,
    waitForTauriReadyIfPresent,
} from './src/host.js';
import {
    bindPanelCallbacks,
    ensureNativeShortcutButton,
    getCurrentModalWorldName,
    handleExternalWorldbookDeleted,
    handleExternalWorldbookRenamed,
    isEntryGroupsModalOpen,
    openEntryGroupsModal,
    refreshOpenModalBook,
    syncNativeShortcutButton,
    teardownPanels,
} from './src/panel.js';

const STYLE_ASSET_VERSION = '0.2.0';

let _initialized = false;
let _nativeMountObserver = null;
let _greetingSyncTimer = null;
let _chatSwitchSyncTimer = null;
/** @type {Array<{ event: string, handler: Function }>} */
const _boundHostEvents = [];
let _onWboRenamed = null;
let _onWboDeleted = null;
let _onWegOpenPanel = null;

/**
 * Bust stale browser/WebView disk cache on `style.css` after updates without FOUC.
 */
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
        // Ignore in restricted or test runtimes
    }
}

/**
 * Subscribe safely to host `eventSource` with deterministic teardown tracking.
 * @param {any} eventSource
 * @param {string | undefined} eventName
 * @param {Function} handler
 */
function trackHostEvent(eventSource, eventName, handler) {
    if (!eventSource || !eventName || typeof eventSource.on !== 'function') return;
    eventSource.on(eventName, handler);
    _boundHostEvents.push({ event: eventName, handler });
}

/**
 * Debounced refresh for open modal when worldbook state is modified externally.
 * @param {number} [delayMs=480]
 */
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

/**
 * Debounced per-chat save route recognition & worldbook switch.
 * Runs at ~650ms on `CHAT_CHANGED` (deliberately AFTER floor-0 scripts' 300ms timer!)
 * so multi-floor or branched saves never stay stuck on another save's IF line.
 *
 * @param {'chat-changed' | 'floor0-swipe'} reason
 * @param {number} delayMs
 */
function scheduleChatSaveRouteSync(reason, delayMs) {
    clearTimeout(_chatSwitchSyncTimer);
    _chatSwitchSyncTimer = setTimeout(async () => {
        _chatSwitchSyncTimer = null;
        if (!_initialized) return;
        const settings = getSettings();
        if (settings.autoSwitchOnChatChange === false) {
            if (isEntryGroupsModalOpen()) {
                void refreshOpenModalBook({ silent: true, reason });
            }
            return;
        }

        await syncWorldbookForActiveChat({
            reason,
            silentToast: reason === 'floor0-swipe',
        });

        if (_initialized && isEntryGroupsModalOpen()) {
            void refreshOpenModalBook({ silent: true, reason });
        }
    }, delayMs);
}

/**
 * Watch `#WorldInfo` / `#world_popup` lightly so if the host lazily mounts the WorldInfo toolbar,
 * our shortcut button attaches cleanly with zero polling.
 */
function startToolbarMountObserver() {
    if (_nativeMountObserver || typeof MutationObserver === 'undefined' || typeof document === 'undefined') return;
    const target = document.getElementById('WorldInfo') || document.getElementById('world_popup');
    if (!target) return;

    _nativeMountObserver = new MutationObserver(() => {
        if (!document.getElementById('weg-native-entry-btn')) {
            ensureNativeShortcutButton();
            syncNativeShortcutButton();
        }
    });
    _nativeMountObserver.observe(target, { childList: true, subtree: true });
}

/**
 * Register `/weg [worldName]` slash command when `SlashCommandParser` is available.
 */
function registerSlashCommand(ctx) {
    try {
        const { SlashCommandParser, SlashCommand, SlashCommandArgument, ARGUMENT_TYPE } = ctx || {};
        if (!SlashCommandParser || !SlashCommand) return;

        SlashCommandParser.addCommandObject(
            SlashCommand.fromProps({
                name: 'weg',
                callback: async (_namedArgs, unnamedArgs) => {
                    const worldName = String(unnamedArgs ?? '').trim();
                    await openEntryGroupsModal(worldName ? { worldName } : {});
                    return worldName || 'opened';
                },
                unnamedArgumentList: SlashCommandArgument && ARGUMENT_TYPE ? [
                    SlashCommandArgument.fromProps({
                        description: '可选：指定要打开的世界书名称',
                        typeList: [ARGUMENT_TYPE.STRING],
                        isRequired: false,
                    }),
                ] : [],
                helpString: '打开世界书条目分组面板：/weg [世界书名称]',
            }),
        );
    } catch {
        // Non-fatal across older ST builds
    }
}

/**
 * Idempotent initialization routine.
 */
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
            syncNativeShortcutButton();
        },
    });

    ensureNativeShortcutButton();
    syncNativeShortcutButton();
    startToolbarMountObserver();

    // Cross-plugin CustomEvent bridge (`INTEGRATION.md`)
    if (typeof window !== 'undefined') {
        if (!_onWboRenamed) {
            _onWboRenamed = (ev) => {
                const oldName = String(ev?.detail?.oldName ?? '').trim();
                const newName = String(ev?.detail?.newName ?? '').trim();
                if (!oldName || !newName) return;
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

    const syncToolbarIdle = () => {
        const run = () => {
            if (!_initialized) return;
            ensureNativeShortcutButton();
            syncNativeShortcutButton();
        };
        if (typeof globalThis.requestIdleCallback === 'function') {
            globalThis.requestIdleCallback(run, { timeout: 1000 });
        } else {
            setTimeout(run, 120);
        }
    };

    trackHostEvent(eventSource, et.APP_READY, syncToolbarIdle);
    trackHostEvent(eventSource, et.EXTENSION_SETTINGS_LOADED, syncToolbarIdle);
    trackHostEvent(eventSource, et.WORLDINFO_SETTINGS_UPDATED, () => {
        syncToolbarIdle();
        if (isEntryGroupsModalOpen() && !isWithinSelfWriteWindow()) {
            scheduleOpenModalSync(380);
        }
    });
    trackHostEvent(eventSource, et.WORLDINFO_ENTRIES_LOADED, syncToolbarIdle);
    trackHostEvent(eventSource, et.WORLDINFO_UPDATED, (worldName) => {
        if (!isEntryGroupsModalOpen() || isWithinSelfWriteWindow()) return;
        const openBook = getCurrentModalWorldName();
        if (!worldName || String(worldName).trim() === openBook) {
            scheduleOpenModalSync(320);
        }
    });

    // Floor-0 greeting swipe: record newly picked route for a fresh 1-message save & sync modal
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

    // Chat save switch (`CHAT_CHANGED`): restore this save's bound or inferred IF-line state!
    trackHostEvent(eventSource, et.CHAT_CHANGED, () => {
        syncToolbarIdle();
        scheduleChatSaveRouteSync('chat-changed', 650);
    });

    registerSlashCommand(ctx);
    ensureFreshStylesheet();
}

export async function onActivate() {
    await init();
}

/**
 * Deterministic cleanup on extension disable or uninstall.
 */
export function onDisable() {
    clearTimeout(_greetingSyncTimer);
    _greetingSyncTimer = null;
    clearTimeout(_chatSwitchSyncTimer);
    _chatSwitchSyncTimer = null;

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
