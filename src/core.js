/**
 * Worldbook Entry Groups — Pure domain model, IF-line mutex planner,
 * greeting comment coordinator, and prefix/divider auto-grouping engine.
 *
 * Zero DOM or browser globals required so every function is deterministic
 * and directly testable in Node.js.
 */

export const MODULE_NAME = 'worldbook_entry_groups';

export const SPECIAL_GROUP_UNGROUPED = '__ungrouped__';

export const GROUP_MODES = Object.freeze({
    NORMAL: 'normal',
    IF_LINE: 'if_line',
    RADIO: 'radio',
});

export const VALID_PALETTES = Object.freeze(['paper', 'ink', 'warm', 'sakura', 'host']);
export const VALID_COLOR_MODES = Object.freeze(['auto', 'light', 'dark']);

const TITLE_TAG_REGEX = /<!---?[\s\u3000]*title[\s\u3000]*[:：][\s\u3000]*(.*?)[\s\u3000]*-?-->/i;
const DESC_TAG_REGEX = /<!---?[\s\u3000]*desc[\s\u3000]*[:：][\s\u3000]*(.*?)[\s\u3000]*-?-->/i;
const LORE_TAG_REGEX = /<!---?[\s\u3000]*lore[\s\u3000]*[:：][\s\u3000]*([\d,\s\u3000，]+)[\s\u3000]*-?-->/i;
const EXCLUDE_TAG_REGEX = /<!---?[\s\u3000]*exclude[\s\u3000]*[:：][\s\u3000]*([\d,\s\u3000，]+)[\s\u3000]*-?-->/i;

const IF_NAME_HINT_REGEX = /(?:^|[\s【\[「(（·\-_/:：|｜])(?:if\s*线?|分支|路线|支线|世界线|结局线|if\d+)(?:$|[\s】\]」)）·\-_/:：|｜\d])/i;

/**
 * Generate a compact unique group ID.
 * @param {string} [prefix='grp']
 * @returns {string}
 */
export function createGroupId(prefix = 'grp') {
    const rand = Math.random().toString(36).slice(2, 7);
    return `${prefix}_${Date.now().toString(36)}_${rand}`;
}

/**
 * Normalize a single book's group configuration in place or from raw data.
 * Never touches worldbook entries; stores only plugin-local group metadata.
 *
 * @param {any} raw
 * @returns {{ groups: Array<{ id: string, name: string, mode: 'normal' | 'if_line' | 'radio', collapsed: boolean }>, assignments: Record<string, string>, ungroupedCollapsed: boolean }}
 */
export function normalizeBookConfig(raw) {
    const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    const seenIds = new Set();
    const groups = [];

    if (Array.isArray(src.groups)) {
        for (const item of src.groups) {
            if (!item || typeof item !== 'object') continue;
            const id = String(item.id ?? '').trim();
            const name = String(item.name ?? '').trim();
            if (!id || !name || id === SPECIAL_GROUP_UNGROUPED || seenIds.has(id)) continue;
            seenIds.add(id);
            const rawMode = String(item.mode ?? '').trim();
            const mode = rawMode === GROUP_MODES.IF_LINE || rawMode === GROUP_MODES.RADIO
                ? rawMode
                : GROUP_MODES.NORMAL;
            groups.push({
                id,
                name,
                mode,
                collapsed: Boolean(item.collapsed),
            });
        }
    }

    const assignments = {};
    if (src.assignments && typeof src.assignments === 'object' && !Array.isArray(src.assignments)) {
        for (const [rawUid, rawGroupId] of Object.entries(src.assignments)) {
            const uid = String(rawUid ?? '').trim();
            const groupId = String(rawGroupId ?? '').trim();
            if (!uid || !groupId || !seenIds.has(groupId)) continue;
            assignments[uid] = groupId;
        }
    }

    return {
        groups,
        assignments,
        ungroupedCollapsed: Boolean(src.ungroupedCollapsed),
    };
}

/**
 * Clone a book configuration cleanly for the undo stack.
 * @param {any} bookConfig
 */
export function cloneBookConfig(bookConfig) {
    const norm = normalizeBookConfig(bookConfig);
    return {
        groups: norm.groups.map((g) => ({ ...g })),
        assignments: { ...norm.assignments },
        ungroupedCollapsed: norm.ungroupedCollapsed,
    };
}

/**
 * Normalize top-level extension settings while preserving unknown user keys.
 * @param {any} raw
 * @returns {Record<string, any>}
 */
export function normalizeSettings(raw) {
    const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    const palette = VALID_PALETTES.includes(src.palette) ? src.palette : 'paper';
    const colorMode = VALID_COLOR_MODES.includes(src.colorMode) ? src.colorMode : 'auto';

    const books = {};
    if (src.books && typeof src.books === 'object' && !Array.isArray(src.books)) {
        for (const [bookName, cfg] of Object.entries(src.books)) {
            const cleanName = String(bookName ?? '').trim();
            if (!cleanName) continue;
            const normalizedCfg = normalizeBookConfig(cfg);
            if (normalizedCfg.groups.length > 0 || Object.keys(normalizedCfg.assignments).length > 0) {
                books[cleanName] = normalizedCfg;
            }
        }
    }

    return {
        ...src,
        version: 1,
        palette,
        colorMode,
        showNativeEntryBtn: src.showNativeEntryBtn !== false,
        closeOnLocate: src.closeOnLocate !== false,
        syncGreetingTags: src.syncGreetingTags !== false,
        searchMultiTerm: Boolean(src.searchMultiTerm),
        lastOpenedBook: String(src.lastOpenedBook ?? '').trim(),
        books,
    };
}

/**
 * Check whether an entry comment looks like a visual section divider banner,
 * e.g. `=== 角色设定 ===`, `--- IF线：校园 ---`, `────── 剧情 ──────`.
 *
 * @param {string} rawComment
 * @param {{ disabled?: boolean, hasContent?: boolean, keyCount?: number }} [meta]
 * @returns {{ isDivider: boolean, label: string }}
 */
export function parseDividerComment(rawComment, meta = {}) {
    const text = String(rawComment ?? '').trim();
    if (!text) return { isDivider: false, label: '' };

    // Explicit decorative line wrappers on one or both sides (2+ symbols)
    const wrappedMatch = text.match(
        /^(?:[=\-—─━═_*~～✦✧★☆◆◇■□▼▽▸▹#]{2,}|【[\s=\-—─━═_*~～]{1,})\s*(.+?)\s*(?:[=\-—─━═_*~～✦✧★☆◆◇■□▼▽◂◃#]{2,}|[\s=\-—─━═_*~～]{1,}】)?$/,
    );
    if (wrappedMatch) {
        const cleaned = wrappedMatch[1]
            .replace(/^[【\[「(（\s=\-—─━═_*~～]+|[】\]」)）\s=\-—─━═_*~～]+$/g, '')
            .trim();
        if (cleaned.length >= 1 && cleaned.length <= 28 && !/^[=\-—─━═_*~～\d\s]+$/.test(cleaned)) {
            return { isDivider: true, label: cleaned };
        }
    }

    // Pure symbol line without text (not usable as a named group header)
    if (/^[=\-—─━═_*~～✦✧★☆◆◇■□\s]+$/.test(text)) {
        return { isDivider: false, label: '' };
    }

    // Disabled, empty-body, keyless banner entry such as `【以下是世界观】` or `▼ 校园线 ▼`
    if (meta.disabled && !meta.hasContent && (meta.keyCount || 0) === 0) {
        const bannerClean = text
            .replace(/^(?:以下是|下面是|▼|▽|◆|■|●|▶|▸)\s*/, '')
            .replace(/\s*(?:部分|专区|分割线|分隔线|▼|▽|◆|■|●|◀|◂)$/, '')
            .replace(/^[【\[「(（\s]+|[】\]」)）\s]+$/g, '')
            .trim();
        if (bannerClean.length >= 2 && bannerClean.length <= 24 && bannerClean !== text) {
            return { isDivider: true, label: bannerClean };
        }
    }

    return { isDivider: false, label: '' };
}

/**
 * Extract lightweight entry summaries from a raw worldbook JSON object.
 * Discards `entry.content` immediately so 200+ entries consume minimal memory on iOS WebViews.
 *
 * @param {any} payload
 * @returns {Array<{
 *   uid: string,
 *   numericUid: number | null,
 *   title: string,
 *   rawComment: string,
 *   keys: string[],
 *   disabled: boolean,
 *   constant: boolean,
 *   vectorized: boolean,
 *   selective: boolean,
 *   order: number,
 *   displayIndex: number,
 *   isDivider: boolean,
 *   dividerLabel: string
 * }>}
 */
export function extractWorldbookEntrySummaries(payload) {
    const entriesObj = payload?.entries;
    if (!entriesObj || typeof entriesObj !== 'object') return [];

    const pairs = Array.isArray(entriesObj)
        ? entriesObj.map((e, i) => [String(e?.uid ?? i), e])
        : Object.entries(entriesObj);

    const summaries = [];
    for (let i = 0; i < pairs.length; i += 1) {
        const [fallbackKey, entry] = pairs[i];
        if (!entry || typeof entry !== 'object') continue;

        const uid = String(entry.uid ?? fallbackKey).trim();
        if (!uid) continue;
        const num = Number(uid);
        const numericUid = Number.isInteger(num) && num >= 0 ? num : null;

        const rawComment = String(entry.comment ?? '').trim();
        const allKeys = Array.isArray(entry.key)
            ? entry.key.map((k) => String(k ?? '').trim()).filter(Boolean)
            : [];
        const keys = allKeys.slice(0, 6);
        const disabled = Boolean(entry.disable);
        const hasContent = Boolean(String(entry.content ?? '').trim());
        const dividerInfo = parseDividerComment(rawComment, {
            disabled,
            hasContent,
            keyCount: allKeys.length,
        });

        const title = rawComment || keys.slice(0, 2).join(' / ') || `未命名条目 #${uid}`;
        const order = Number.isFinite(Number(entry.order)) ? Number(entry.order) : 100;
        const displayIndex = Number.isFinite(Number(entry.displayIndex))
            ? Number(entry.displayIndex)
            : (Number.isFinite(Number(entry.order)) ? Number(entry.order) : (numericUid ?? i));

        summaries.push({
            uid,
            numericUid,
            title,
            rawComment,
            keys,
            disabled,
            constant: Boolean(entry.constant),
            vectorized: Boolean(entry.vectorized),
            selective: Boolean(entry.selective),
            order,
            displayIndex,
            isDivider: dividerInfo.isDivider,
            dividerLabel: dividerInfo.label,
        });
    }

    summaries.sort((a, b) => {
        if (a.displayIndex !== b.displayIndex) return a.displayIndex - b.displayIndex;
        if (a.numericUid !== null && b.numericUid !== null) return a.numericUid - b.numericUid;
        return a.uid.localeCompare(b.uid);
    });

    return summaries;
}

/**
 * Remove orphan entry UID assignments that no longer exist in the authoritative worldbook.
 *
 * @param {{ groups: any[], assignments: Record<string, string> }} bookConfig
 * @param {Set<string>} validUidSet
 * @returns {number} Number of removed orphan assignments
 */
export function pruneOrphanAssignments(bookConfig, validUidSet) {
    if (!bookConfig?.assignments || !(validUidSet instanceof Set)) return 0;
    const groupIds = new Set((bookConfig.groups || []).map((g) => g.id));
    let removed = 0;
    for (const [uid, groupId] of Object.entries(bookConfig.assignments)) {
        if (!validUidSet.has(uid) || !groupIds.has(groupId)) {
            delete bookConfig.assignments[uid];
            removed += 1;
        }
    }
    return removed;
}

/**
 * Build the structured group sections view purely from authoritative entries + bookConfig.
 *
 * @param {Array<any>} entries
 * @param {any} rawBookConfig
 */
export function buildGroupedView(entries, rawBookConfig) {
    const bookConfig = normalizeBookConfig(rawBookConfig);
    const list = Array.isArray(entries) ? entries : [];
    const validUidSet = new Set(list.map((e) => e.uid));

    /** @type {Map<string, any[]>} */
    const bucketMap = new Map();
    for (const grp of bookConfig.groups) {
        bucketMap.set(grp.id, []);
    }
    const ungroupedEntries = [];

    for (const entry of list) {
        const assignedId = bookConfig.assignments[entry.uid];
        if (assignedId && bucketMap.has(assignedId)) {
            bucketMap.get(assignedId).push(entry);
        } else {
            ungroupedEntries.push(entry);
        }
    }

    const sections = bookConfig.groups.map((grp) => {
        const items = bucketMap.get(grp.id) || [];
        const totalCount = items.length;
        const enabledCount = items.filter((e) => !e.disabled).length;
        return {
            id: grp.id,
            name: grp.name,
            mode: grp.mode,
            collapsed: Boolean(grp.collapsed),
            isUngrouped: false,
            entries: items,
            totalCount,
            enabledCount,
            allEnabled: totalCount > 0 && enabledCount === totalCount,
            someEnabled: enabledCount > 0 && enabledCount < totalCount,
        };
    });

    const ungroupedEnabledCount = ungroupedEntries.filter((e) => !e.disabled).length;
    sections.push({
        id: SPECIAL_GROUP_UNGROUPED,
        name: '未分组',
        mode: GROUP_MODES.NORMAL,
        collapsed: Boolean(bookConfig.ungroupedCollapsed),
        isUngrouped: true,
        entries: ungroupedEntries,
        totalCount: ungroupedEntries.length,
        enabledCount: ungroupedEnabledCount,
        allEnabled: ungroupedEntries.length > 0 && ungroupedEnabledCount === ungroupedEntries.length,
        someEnabled: ungroupedEnabledCount > 0 && ungroupedEnabledCount < ungroupedEntries.length,
    });

    const ifLineSections = sections.filter((s) => !s.isUngrouped && s.mode === GROUP_MODES.IF_LINE);
    const activeIfLineSections = ifLineSections.filter((s) => s.enabledCount > 0);

    let orphanCount = 0;
    for (const uid of Object.keys(bookConfig.assignments)) {
        if (!validUidSet.has(uid)) orphanCount += 1;
    }

    const totalEnabled = list.filter((e) => !e.disabled).length;

    return {
        sections,
        totalEntries: list.length,
        totalEnabled,
        orphanCount,
        ifLineSummary: {
            groupCount: ifLineSections.length,
            activeGroupIds: activeIfLineSections.map((s) => s.id),
            activeGroupNames: activeIfLineSections.map((s) => s.name),
            hasConflict: activeIfLineSections.length > 1,
        },
    };
}

/**
 * Filter entries by search query and optional state filter.
 * Supports complete-phrase matching by default (with optional multi-term AND mode).
 *
 * @param {Array<any>} entries
 * @param {string} query
 * @param {{ multiTerm?: boolean, statusFilter?: 'all' | 'enabled' | 'disabled', greetingByUid?: Map<string, any> | null }} [opts]
 * @returns {Set<string>} Set of matching entry UIDs
 */
export function matchEntries(entries, query, { multiTerm = false, statusFilter = 'all', greetingByUid = null } = {}) {
    const list = Array.isArray(entries) ? entries : [];
    const rawQ = String(query ?? '').trim().toLowerCase();
    const terms = rawQ
        ? (multiTerm ? rawQ.split(/\s+/).filter(Boolean) : [rawQ])
        : [];

    const matched = new Set();
    for (const entry of list) {
        if (statusFilter === 'enabled' && entry.disabled) continue;
        if (statusFilter === 'disabled' && !entry.disabled) continue;

        if (terms.length === 0) {
            matched.add(entry.uid);
            continue;
        }

        const greetInfo = greetingByUid?.get?.(entry.uid);
        const greetText = greetInfo
            ? [
                ...greetInfo.includeGreetings.map((g) => `${g.label} ${g.title}`),
                ...greetInfo.excludeGreetings.map((g) => `${g.label} ${g.title}`),
            ].join(' ')
            : '';

        const haystack = `${entry.uid} ${entry.title} ${(entry.keys || []).join(' ')} ${greetText}`.toLowerCase();
        if (terms.every((t) => haystack.includes(t))) {
            matched.add(entry.uid);
        }
    }
    return matched;
}

/**
 * Compute a single-pass batch toggle plan (`Map<uid, nextDisabled>`) when toggling an entire group.
 * - Normal group: enables/disables all entries in the group.
 * - IF-line group (`if_line`): when turning ON, enables all entries in this group AND
 *   disables all entries in every other `if_line` group of the same worldbook!
 * - Radio group (`radio`): when turning OFF, disables all entries in the group;
 *   when turning ON and none are enabled, enables the first entry and disables the rest.
 *
 * @param {Array<any>} entries
 * @param {any} rawBookConfig
 * @param {string} groupId
 * @param {boolean} targetEnabled
 * @returns {Map<string, boolean>} Map of `uid -> nextDisabled`
 */
export function computeGroupTogglePlan(entries, rawBookConfig, groupId, targetEnabled) {
    const bookConfig = normalizeBookConfig(rawBookConfig);
    const list = Array.isArray(entries) ? entries : [];
    const plan = new Map();

    if (groupId === SPECIAL_GROUP_UNGROUPED) {
        for (const entry of list) {
            const assigned = bookConfig.assignments[entry.uid];
            if (!assigned) {
                plan.set(entry.uid, !targetEnabled);
            }
        }
        return plan;
    }

    const targetGroup = bookConfig.groups.find((g) => g.id === groupId);
    if (!targetGroup) return plan;

    const groupEntries = list.filter((e) => bookConfig.assignments[e.uid] === groupId);
    if (groupEntries.length === 0) return plan;

    if (targetGroup.mode === GROUP_MODES.RADIO) {
        if (!targetEnabled) {
            for (const entry of groupEntries) {
                plan.set(entry.uid, true);
            }
        } else {
            const alreadyActive = groupEntries.find((e) => !e.disabled) || groupEntries[0];
            for (const entry of groupEntries) {
                plan.set(entry.uid, entry.uid !== alreadyActive.uid);
            }
        }
        return plan;
    }

    for (const entry of groupEntries) {
        plan.set(entry.uid, !targetEnabled);
    }

    // Mutually exclusive IF-line groups: enabling one automatically turns off sibling IF-line groups
    if (targetEnabled && targetGroup.mode === GROUP_MODES.IF_LINE) {
        const siblingIfIds = new Set(
            bookConfig.groups
                .filter((g) => g.mode === GROUP_MODES.IF_LINE && g.id !== groupId)
                .map((g) => g.id),
        );
        if (siblingIfIds.size > 0) {
            for (const entry of list) {
                const assigned = bookConfig.assignments[entry.uid];
                if (assigned && siblingIfIds.has(assigned)) {
                    plan.set(entry.uid, true);
                }
            }
        }
    }

    return plan;
}

/**
 * Compute a single-pass batch toggle plan (`Map<uid, nextDisabled>`) when toggling a single entry.
 * - Inside a `radio` group: turning ON an entry automatically turns OFF other entries in that group.
 * - Inside an `if_line` group: turning ON an entry automatically turns OFF entries in other `if_line` groups.
 *
 * @param {Array<any>} entries
 * @param {any} rawBookConfig
 * @param {string} uid
 * @param {boolean} targetEnabled
 * @returns {Map<string, boolean>} Map of `uid -> nextDisabled`
 */
export function computeEntryTogglePlan(entries, rawBookConfig, uid, targetEnabled) {
    const bookConfig = normalizeBookConfig(rawBookConfig);
    const list = Array.isArray(entries) ? entries : [];
    const targetUid = String(uid ?? '').trim();
    const plan = new Map();
    if (!targetUid) return plan;

    plan.set(targetUid, !targetEnabled);

    if (!targetEnabled) return plan;

    const groupId = bookConfig.assignments[targetUid];
    if (!groupId) return plan;

    const group = bookConfig.groups.find((g) => g.id === groupId);
    if (!group) return plan;

    if (group.mode === GROUP_MODES.RADIO) {
        for (const entry of list) {
            if (bookConfig.assignments[entry.uid] === groupId && entry.uid !== targetUid) {
                plan.set(entry.uid, true);
            }
        }
    } else if (group.mode === GROUP_MODES.IF_LINE) {
        const siblingIfIds = new Set(
            bookConfig.groups
                .filter((g) => g.mode === GROUP_MODES.IF_LINE && g.id !== groupId)
                .map((g) => g.id),
        );
        if (siblingIfIds.size > 0) {
            for (const entry of list) {
                const assigned = bookConfig.assignments[entry.uid];
                if (assigned && siblingIfIds.has(assigned)) {
                    plan.set(entry.uid, true);
                }
            }
        }
    }

    return plan;
}

/**
 * Apply a `uid -> nextDisabled` toggle plan onto a raw worldbook JSON payload in place.
 * Modifies ONLY `entry.disable`; 100% of titles, content, inclusion groups, and extensions remain untouched.
 *
 * @param {any} payload
 * @param {Map<string, boolean>} togglePlan
 * @returns {{ changedCount: number, appliedChanges: Array<{ uid: string, disabled: boolean }> }}
 */
export function applyTogglePlanToPayload(payload, togglePlan) {
    const entriesObj = payload?.entries;
    if (!entriesObj || typeof entriesObj !== 'object' || !(togglePlan instanceof Map) || togglePlan.size === 0) {
        return { changedCount: 0, appliedChanges: [] };
    }

    const appliedChanges = [];
    const values = Array.isArray(entriesObj) ? entriesObj : Object.values(entriesObj);

    // Build fast lookup by `String(entry.uid)` (with fallback to object key)
    const entryByUid = new Map();
    if (Array.isArray(entriesObj)) {
        entriesObj.forEach((entry, idx) => {
            if (entry && typeof entry === 'object') {
                entryByUid.set(String(entry.uid ?? idx), entry);
            }
        });
    } else {
        for (const [k, entry] of Object.entries(entriesObj)) {
            if (entry && typeof entry === 'object') {
                entryByUid.set(String(entry.uid ?? k), entry);
            }
        }
    }

    for (const [uid, nextDisabled] of togglePlan.entries()) {
        const entry = entryByUid.get(String(uid));
        if (!entry) continue;
        const currentDisabled = Boolean(entry.disable);
        if (currentDisabled !== Boolean(nextDisabled)) {
            entry.disable = Boolean(nextDisabled);
            appliedChanges.push({ uid: String(uid), disabled: Boolean(nextDisabled) });
        }
    }

    void values;
    return {
        changedCount: appliedChanges.length,
        appliedChanges,
    };
}

/**
 * Parse greeting HTML comment tags (`<!-- title / desc / lore / exclude -->`)
 * used by greeting-to-worldbook automation scripts.
 *
 * @param {string} rawText
 * @returns {{ title: string, desc: string, loreUids: string[], excludeUids: string[] }}
 */
export function parseGreetingCommentTags(rawText) {
    const text = String(rawText ?? '');
    if (!text) return { title: '', desc: '', loreUids: [], excludeUids: [] };

    const titleMatch = text.match(TITLE_TAG_REGEX);
    const descMatch = text.match(DESC_TAG_REGEX);
    const loreMatch = text.match(LORE_TAG_REGEX);
    const excludeMatch = text.match(EXCLUDE_TAG_REGEX);

    const parseUidList = (matchObj) => {
        if (!matchObj?.[1]) return [];
        const seen = new Set();
        const out = [];
        for (const token of matchObj[1].split(/[,，]/)) {
            const n = Number.parseInt(token.trim(), 10);
            if (!Number.isNaN(n) && n >= 0) {
                const s = String(n);
                if (!seen.has(s)) {
                    seen.add(s);
                    out.push(s);
                }
            }
        }
        return out;
    };

    return {
        title: titleMatch?.[1]?.trim() || '',
        desc: descMatch?.[1]?.trim() || '',
        loreUids: parseUidList(loreMatch),
        excludeUids: parseUidList(excludeMatch),
    };
}

/**
 * Build a greeting coordination index from a character's `first_mes` + `alternate_greetings`
 * (or floor-0 chat swipes), mapping which greetings auto-enable or auto-exclude each entry UID.
 *
 * @param {{ firstMes?: string, alternateGreetings?: string[], swipes?: string[], currentSwipeId?: number | null }} source
 */
export function buildGreetingCoordinationIndex(source = {}) {
    /** @type {string[]} */
    let rawGreetings = [];
    if (Array.isArray(source.swipes) && source.swipes.length > 0) {
        rawGreetings = source.swipes.map((s) => String(s ?? ''));
    } else {
        const first = String(source.firstMes ?? '');
        const alts = Array.isArray(source.alternateGreetings)
            ? source.alternateGreetings.map((s) => String(s ?? ''))
            : [];
        if (first || alts.length > 0) {
            rawGreetings = [first, ...alts];
        }
    }

    const greetings = [];
    /** @type {Map<string, { includeGreetings: Array<{ swipeIndex: number, label: string, title: string }>, excludeGreetings: Array<{ swipeIndex: number, label: string, title: string }> }>} */
    const byUid = new Map();
    const managedUidSet = new Set();

    rawGreetings.forEach((raw, swipeIndex) => {
        const parsed = parseGreetingCommentTags(raw);
        const label = `#${swipeIndex}`;
        const info = {
            swipeIndex,
            label,
            title: parsed.title,
            desc: parsed.desc,
            loreUids: parsed.loreUids,
            excludeUids: parsed.excludeUids,
        };
        greetings.push(info);

        for (const uid of parsed.loreUids) {
            managedUidSet.add(uid);
            if (!byUid.has(uid)) byUid.set(uid, { includeGreetings: [], excludeGreetings: [] });
            byUid.get(uid).includeGreetings.push({ swipeIndex, label, title: parsed.title });
        }
        for (const uid of parsed.excludeUids) {
            if (!byUid.has(uid)) byUid.set(uid, { includeGreetings: [], excludeGreetings: [] });
            byUid.get(uid).excludeGreetings.push({ swipeIndex, label, title: parsed.title });
        }
    });

    const currentSwipeId = Number.isInteger(source.currentSwipeId) && source.currentSwipeId >= 0
        ? source.currentSwipeId
        : null;
    const activeGreeting = currentSwipeId !== null && greetings[currentSwipeId]
        ? greetings[currentSwipeId]
        : null;

    return {
        hasManagedEntries: managedUidSet.size > 0 || byUid.size > 0,
        greetings,
        byUid,
        managedUidSet,
        currentSwipeId,
        activeGreeting,
    };
}

/**
 * Format a group's entry UIDs as a standard greeting automation HTML comment
 * (`<!-- lore: 1,2,3 -->` or `<!-- exclude: 1,2,3 -->`) for 1-click author copy.
 *
 * @param {string[]} uids
 * @param {'lore' | 'exclude'} [tagType='lore']
 * @returns {string}
 */
export function formatGreetingCommentTag(uids, tagType = 'lore') {
    const nums = [...new Set(
        (uids || [])
            .map((u) => Number.parseInt(String(u).trim(), 10))
            .filter((n) => Number.isInteger(n) && n >= 0),
    )].sort((a, b) => a - b);
    if (nums.length === 0) return '';
    const tag = tagType === 'exclude' ? 'exclude' : 'lore';
    return `<!-- ${tag}: ${nums.join(',')} -->`;
}

/**
 * Infer whether a group title likely represents an IF route / mutually exclusive branch.
 * @param {string} groupName
 * @returns {boolean}
 */
export function looksLikeIfLineName(groupName) {
    const clean = String(groupName ?? '').trim();
    if (!clean) return false;
    return IF_NAME_HINT_REGEX.test(clean);
}

/**
 * Extract a candidate group prefix from an entry title, e.g.:
 * - `【世界观】王都地理` -> `世界观`
 * - `[IF1·青梅] 初遇` -> `IF1·青梅`
 * - `角色设定 - 外貌` -> `角色设定`
 * - `IF线A：开局` -> `IF线A`
 *
 * Avoids grouping pure bare numbers (`01`, `12`) so numbered flat lists don't collide.
 *
 * @param {string} rawTitle
 * @returns {string | null}
 */
export function extractEntryTitlePrefix(rawTitle) {
    let text = String(rawTitle ?? '').trim();
    if (!text) return null;

    // Strip leading pure index badge like `01.` / `1、` when followed by a bracket/prefix
    const strippedIndex = text.replace(/^\d{1,3}[.、)\s]+\s*/, '');
    if (strippedIndex.length >= 3) {
        text = strippedIndex;
    }

    // 1. Leading bracketed prefix: 【前缀】正文 / [前缀]正文 / 「前缀」正文 / （前缀）正文
    const bracketMatch = text.match(/^(?:【([^】]{1,18})】|\[([^\]]{1,18})\]|「([^」]{1,18})」|（([^）]{1,18})）|\(([^)]{1,18})\))\s*(.+)$/);
    if (bracketMatch) {
        const candidate = (bracketMatch[1] || bracketMatch[2] || bracketMatch[3] || bracketMatch[4] || bracketMatch[5] || '').trim();
        if (candidate && !/^\d+$/.test(candidate)) {
            return candidate;
        }
    }

    // 2. Delimiter prefix: `前缀 - 正文` / `前缀：正文` / `前缀｜正文` / `前缀_正文`
    const delimMatch = text.match(/^([^:：\-—_｜|/·]{2,16}?)\s*(?:[:：｜|/]|[-—_]{1,2}|·)\s*(.+)$/);
    if (delimMatch) {
        const candidate = delimMatch[1].trim();
        const rest = delimMatch[2].trim();
        if (candidate && rest && !/^\d+$/.test(candidate)) {
            return candidate;
        }
    }

    return null;
}

/**
 * Detect candidate entry groups automatically using divider banners, title prefixes,
 * or greeting `<!-- lore: ... -->` comment tags.
 *
 * @param {Array<any>} entries
 * @param {{
 *   strategy?: 'smart' | 'divider' | 'prefix' | 'greeting',
 *   onlyUngrouped?: boolean,
 *   existingAssignments?: Record<string, string>,
 *   greetingIndex?: ReturnType<typeof buildGreetingCoordinationIndex> | null
 * }} [opts]
 * @returns {Array<{ key: string, name: string, suggestedMode: 'normal' | 'if_line', uids: string[], source: 'greeting' | 'divider' | 'prefix' }>}
 */
export function detectAutoGroups(entries, {
    strategy = 'smart',
    onlyUngrouped = true,
    existingAssignments = {},
    greetingIndex = null,
} = {}) {
    const list = Array.isArray(entries) ? entries : [];
    const assignedObj = existingAssignments && typeof existingAssignments === 'object' ? existingAssignments : {};
    const validEntryMap = new Map(list.map((e) => [e.uid, e]));

    const isEligible = (uid) => !onlyUngrouped || !assignedObj[uid];

    // Helper: Greeting comment tag detection
    const detectFromGreetings = (claimedSet) => {
        /** @type {Array<{ key: string, name: string, suggestedMode: 'normal' | 'if_line', uids: string[], source: 'greeting' }>} */
        const out = [];
        const greets = greetingIndex?.greetings || [];
        for (const g of greets) {
            if (!Array.isArray(g.loreUids) || g.loreUids.length === 0) continue;
            const uids = g.loreUids.filter((uid) => validEntryMap.has(uid) && isEligible(uid) && !claimedSet.has(uid));
            if (uids.length === 0) continue;
            for (const uid of uids) claimedSet.add(uid);
            const cleanTitle = g.title ? g.title.slice(0, 24) : `开场白 ${g.label}`;
            const groupName = g.title ? `IF · ${cleanTitle}` : `IF · 开场白 ${g.label}`;
            out.push({
                key: `greeting_${g.swipeIndex}`,
                name: groupName,
                suggestedMode: GROUP_MODES.IF_LINE,
                uids,
                source: 'greeting',
            });
        }
        return out;
    };

    // Helper: Divider section detection (walks entries in natural display order)
    const detectFromDividers = (claimedSet) => {
        /** @type {Array<{ label: string, uids: string[] }>} */
        const rawBlocks = [];
        let currentBlock = null;

        for (const entry of list) {
            if (entry.isDivider && entry.dividerLabel) {
                currentBlock = {
                    label: entry.dividerLabel,
                    uids: [],
                };
                if (isEligible(entry.uid) && !claimedSet.has(entry.uid)) {
                    currentBlock.uids.push(entry.uid);
                }
                rawBlocks.push(currentBlock);
                continue;
            }
            if (currentBlock && isEligible(entry.uid) && !claimedSet.has(entry.uid)) {
                currentBlock.uids.push(entry.uid);
            }
        }

        // Require at least 2 meaningful divider sections (with >= 2 entries or >1 non-empty section)
        const meaningful = rawBlocks.filter((b) => b.uids.length >= 1);
        if (meaningful.length < 2) return [];

        /** @type {Map<string, string[]>} */
        const mergedByLabel = new Map();
        for (const b of meaningful) {
            if (!mergedByLabel.has(b.label)) mergedByLabel.set(b.label, []);
            mergedByLabel.get(b.label).push(...b.uids);
        }

        const out = [];
        let idx = 0;
        for (const [label, uids] of mergedByLabel.entries()) {
            if (uids.length === 0) continue;
            for (const uid of uids) claimedSet.add(uid);
            out.push({
                key: `divider_${idx++}_${label}`,
                name: label,
                suggestedMode: looksLikeIfLineName(label) ? GROUP_MODES.IF_LINE : GROUP_MODES.NORMAL,
                uids,
                source: 'divider',
            });
        }
        return out;
    };

    // Helper: Title prefix clustering (>= 2 entries sharing the same prefix)
    const detectFromPrefixes = (claimedSet) => {
        /** @type {Map<string, string[]>} */
        const buckets = new Map();
        for (const entry of list) {
            if (entry.isDivider) continue;
            if (!isEligible(entry.uid) || claimedSet.has(entry.uid)) continue;
            const prefix = extractEntryTitlePrefix(entry.rawComment || entry.title);
            if (!prefix) continue;
            if (!buckets.has(prefix)) buckets.set(prefix, []);
            buckets.get(prefix).push(entry.uid);
        }

        const out = [];
        let idx = 0;
        for (const [prefix, uids] of buckets.entries()) {
            // Allow 1-entry group ONLY if it explicitly looks like an IF branch (e.g. `[IF3] 隐藏结局`)
            if (uids.length < 2 && !looksLikeIfLineName(prefix)) continue;
            for (const uid of uids) claimedSet.add(uid);
            out.push({
                key: `prefix_${idx++}_${prefix}`,
                name: prefix,
                suggestedMode: looksLikeIfLineName(prefix) ? GROUP_MODES.IF_LINE : GROUP_MODES.NORMAL,
                uids,
                source: 'prefix',
            });
        }
        return out;
    };

    const claimed = new Set();
    if (strategy === 'greeting') {
        return detectFromGreetings(claimed);
    }
    if (strategy === 'divider') {
        return detectFromDividers(claimed);
    }
    if (strategy === 'prefix') {
        return detectFromPrefixes(claimed);
    }

    // Smart combined strategy:
    // 1) Greeting IF-line tags (if present) -> 2) Divider sections -> 3) Prefix clusters on remaining entries
    const results = [];
    if (greetingIndex?.hasManagedEntries) {
        results.push(...detectFromGreetings(claimed));
    }
    results.push(...detectFromDividers(claimed));
    results.push(...detectFromPrefixes(claimed));
    return results;
}

/**
 * Apply selected auto-detected group proposals into a bookConfig cleanly.
 * Merges into an existing group if one with the exact same name already exists!
 *
 * @param {any} rawBookConfig
 * @param {Array<{ name: string, suggestedMode?: 'normal' | 'if_line' | 'radio', mode?: 'normal' | 'if_line' | 'radio', uids: string[] }>} proposals
 * @param {{ replaceExisting?: boolean }} [opts]
 */
export function applyAutoGroupProposals(rawBookConfig, proposals, { replaceExisting = false } = {}) {
    const next = replaceExisting
        ? { groups: [], assignments: {}, ungroupedCollapsed: false }
        : cloneBookConfig(rawBookConfig);

    for (const item of proposals || []) {
        const name = String(item?.name ?? '').trim();
        const uids = Array.isArray(item?.uids) ? item.uids.map((u) => String(u).trim()).filter(Boolean) : [];
        if (!name || uids.length === 0) continue;

        const desiredMode = item.mode || item.suggestedMode || GROUP_MODES.NORMAL;
        let group = next.groups.find((g) => g.name === name);
        if (!group) {
            group = {
                id: createGroupId('grp'),
                name,
                mode: desiredMode === GROUP_MODES.IF_LINE || desiredMode === GROUP_MODES.RADIO
                    ? desiredMode
                    : GROUP_MODES.NORMAL,
                collapsed: false,
            };
            next.groups.push(group);
        } else if (group.mode === GROUP_MODES.NORMAL && desiredMode === GROUP_MODES.IF_LINE) {
            group.mode = GROUP_MODES.IF_LINE;
        }

        for (const uid of uids) {
            next.assignments[uid] = group.id;
        }
    }

    return next;
}

/**
 * Migrate plugin settings when `worldbook-organizer` renames a worldbook (`wbo:worldbook-renamed`).
 *
 * @param {Record<string, any>} settings
 * @param {string} oldName
 * @param {string} newName
 * @returns {boolean} True if settings were updated
 */
export function migrateSettingsOnWorldRename(settings, oldName, newName) {
    const cleanOld = String(oldName ?? '').trim();
    const cleanNew = String(newName ?? '').trim();
    if (!settings || !cleanOld || !cleanNew || cleanOld === cleanNew) return false;

    let changed = false;
    if (settings.books && typeof settings.books === 'object' && settings.books[cleanOld]) {
        if (!settings.books[cleanNew]) {
            settings.books[cleanNew] = settings.books[cleanOld];
        } else {
            // Merge without losing existing groups on newName
            const merged = cloneBookConfig(settings.books[cleanNew]);
            const oldCfg = normalizeBookConfig(settings.books[cleanOld]);
            for (const g of oldCfg.groups) {
                let target = merged.groups.find((x) => x.name === g.name);
                if (!target) {
                    target = { ...g, id: merged.groups.some((x) => x.id === g.id) ? createGroupId('grp') : g.id };
                    merged.groups.push(target);
                }
                for (const [uid, gid] of Object.entries(oldCfg.assignments)) {
                    if (gid === g.id && !merged.assignments[uid]) {
                        merged.assignments[uid] = target.id;
                    }
                }
            }
            settings.books[cleanNew] = merged;
        }
        delete settings.books[cleanOld];
        changed = true;
    }

    if (settings.lastOpenedBook === cleanOld) {
        settings.lastOpenedBook = cleanNew;
        changed = true;
    }

    return changed;
}

/**
 * Clean up plugin settings when `worldbook-organizer` deletes worldbooks (`wbo:worldbook-deleted`).
 *
 * @param {Record<string, any>} settings
 * @param {string[]} deletedNames
 * @returns {boolean} True if settings were updated
 */
export function removeDeletedWorldsFromSettings(settings, deletedNames) {
    if (!settings || !Array.isArray(deletedNames) || deletedNames.length === 0) return false;
    let changed = false;
    for (const rawName of deletedNames) {
        const clean = String(rawName ?? '').trim();
        if (!clean) continue;
        if (settings.books && typeof settings.books === 'object' && clean in settings.books) {
            delete settings.books[clean];
            changed = true;
        }
        if (settings.lastOpenedBook === clean) {
            settings.lastOpenedBook = '';
            changed = true;
        }
    }
    return changed;
}
