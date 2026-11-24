/**
 * Worldbook Entry Groups — Pure domain model, IF-line mutex planner,
 * O(1) metadata-only per-chat route memory (supports in-save timeline jumps like 18yo -> 30yo),
 * scene-triggered auto-groups (e.g. NSFW off in daily plot / on during intimate scenes),
 * and prefix/divider/greeting auto-grouping engine.
 *
 * Zero DOM or browser globals required; zero multi-floor chat history scanning.
 */

export const MODULE_NAME = 'worldbook_entry_groups';

export const SPECIAL_GROUP_UNGROUPED = '__ungrouped__';

export const GROUP_MODES = Object.freeze({
    NORMAL: 'normal',
    IF_LINE: 'if_line',
    RADIO: 'radio',
    SCENE: 'scene',
});

export const VALID_PALETTES = Object.freeze(['paper', 'ink', 'warm', 'sakura', 'host']);
export const VALID_COLOR_MODES = Object.freeze(['auto', 'light', 'dark']);

const MAX_STORED_CHAT_PROFILES = 120;

const TITLE_TAG_REGEX = /<!---?[\s\u3000]*title[\s\u3000]*[:：][\s\u3000]*(.*?)[\s\u3000]*-?-->/i;
const DESC_TAG_REGEX = /<!---?[\s\u3000]*desc[\s\u3000]*[:：][\s\u3000]*(.*?)[\s\u3000]*-?-->/i;
const LORE_TAG_REGEX = /<!---?[\s\u3000]*lore[\s\u3000]*[:：][\s\u3000]*([\d,\s\u3000，]+)[\s\u3000]*-?-->/i;
const EXCLUDE_TAG_REGEX = /<!---?[\s\u3000]*exclude[\s\u3000]*[:：][\s\u3000]*([\d,\s\u3000，]+)[\s\u3000]*-?-->/i;

const IF_NAME_HINT_REGEX = /(?:^|[\s【\[「(（·\-_/:：|｜])(?:if\s*线?|分支|路线|支线|世界线|结局线|if\d+|\d+岁线?)(?:$|[\s】\]」)）·\-_/:：|｜\d])/i;
const NSFW_TITLE_HINT_REGEX = /\b(?:nsfw|r18|18\+|smut|ero)\b|(?:亲密剧情|亲密行为|亲密设定|情事|床笫|欢爱|肉体设定|敏感带|敏感点|性癖|瑟瑟|涩涩|成人向|情欲|交合|体位)/i;

/**
 * Built-in default trigger cues when a `scene` group leaves custom keywords blank.
 * Matched ONLY against the latest 1–2 turn snippets (capped to ~600 chars per turn).
 */
export const DEFAULT_SCENE_KEYWORDS = Object.freeze([
    '亲吻', '深吻', '接吻', '吻住', '唇舌', '舌尖',
    '喘息', '低喘', '娇喘', '呻吟',
    '褪去', '解开衣', '衣扣', '衣衫半解', '赤裸', '寸缕',
    '锁骨', '耳垂', '腰肢', '腿间', '私密', '下身',
    '情欲', '动情', '欲望', '滚烫', '缠绵',
    '交合', '进入身体', '抵住', '抽送', '顶弄', '高潮', '痉挛',
    'nsfw', 'r18',
]);

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
 * Parse a comma/newline separated keyword string into a deduplicated string list.
 * @param {string | string[] | null | undefined} raw
 * @returns {string[]}
 */
export function normalizeKeywordList(raw) {
    const items = Array.isArray(raw)
        ? raw
        : String(raw ?? '').split(/[,，、;\n\r]+/);
    const seen = new Set();
    const out = [];
    for (const item of items) {
        const clean = String(item ?? '').trim().toLowerCase();
        if (clean && !seen.has(clean)) {
            seen.add(clean);
            out.push(clean);
        }
    }
    return out.slice(0, 60);
}

/**
 * Normalize a single book's group configuration in place or from raw data.
 * Never touches worldbook entries; stores only plugin-local group metadata.
 *
 * @param {any} raw
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
            const mode = (
                rawMode === GROUP_MODES.IF_LINE ||
                rawMode === GROUP_MODES.RADIO ||
                rawMode === GROUP_MODES.SCENE
            )
                ? rawMode
                : GROUP_MODES.NORMAL;

            const rawCooldown = Number.parseInt(String(item.cooldownTurns ?? 2), 10);
            const cooldownTurns = Number.isInteger(rawCooldown)
                ? Math.max(1, Math.min(10, rawCooldown))
                : 2;

            groups.push({
                id,
                name,
                mode,
                collapsed: Boolean(item.collapsed),
                sceneKeywords: normalizeKeywordList(item.sceneKeywords),
                cooldownTurns,
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
 * Normalize a per-chat worldbook route profile (`chatMetadata` or fallback `chatProfiles[chatKey]`).
 * Lightweight metadata (~100-300 bytes), O(1) read/write, zero chat message scanning!
 *
 * @param {any} raw
 */
export function normalizeChatProfile(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const worldName = String(raw.worldName ?? '').trim();
    if (!worldName) return null;

    const entryDisabledMap = {};
    if (raw.entryDisabledMap && typeof raw.entryDisabledMap === 'object' && !Array.isArray(raw.entryDisabledMap)) {
        for (const [uid, dis] of Object.entries(raw.entryDisabledMap)) {
            const cleanUid = String(uid ?? '').trim();
            if (!cleanUid) continue;
            entryDisabledMap[cleanUid] = Boolean(dis);
        }
    }

    const ifGroupId = String(raw.ifGroupId ?? '').trim();
    const routeLabel = String(raw.routeLabel ?? '').trim();

    if (!ifGroupId && Object.keys(entryDisabledMap).length === 0) return null;

    return {
        worldName,
        routeLabel,
        ifGroupId,
        entryDisabledMap,
        updatedAt: Number.isFinite(Number(raw.updatedAt)) ? Number(raw.updatedAt) : 0,
    };
}

/**
 * Clone a book configuration cleanly for the undo stack.
 * @param {any} bookConfig
 */
export function cloneBookConfig(bookConfig) {
    const norm = normalizeBookConfig(bookConfig);
    return {
        groups: norm.groups.map((g) => ({
            ...g,
            sceneKeywords: [...(g.sceneKeywords || [])],
        })),
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

    const chatProfiles = {};
    if (src.chatProfiles && typeof src.chatProfiles === 'object' && !Array.isArray(src.chatProfiles)) {
        const validPairs = [];
        for (const [chatKey, prof] of Object.entries(src.chatProfiles)) {
            const cleanKey = String(chatKey ?? '').trim();
            if (!cleanKey) continue;
            const normProf = normalizeChatProfile(prof);
            if (normProf) {
                validPairs.push([cleanKey, normProf]);
            }
        }
        validPairs.sort((a, b) => (b[1].updatedAt || 0) - (a[1].updatedAt || 0));
        for (const [k, v] of validPairs.slice(0, MAX_STORED_CHAT_PROFILES)) {
            chatProfiles[k] = v;
        }
    }

    return {
        ...src,
        version: 1,
        palette,
        colorMode,
        showNativeEntryBtn: src.showNativeEntryBtn !== false,
        showWandMenuEntry: src.showWandMenuEntry !== false,
        closeOnLocate: src.closeOnLocate !== false,
        syncGreetingTags: src.syncGreetingTags !== false,
        autoSwitchOnChatChange: src.autoSwitchOnChatChange !== false,
        enableSceneAutoToggle: src.enableSceneAutoToggle !== false,
        searchMultiTerm: Boolean(src.searchMultiTerm),
        lastOpenedBook: String(src.lastOpenedBook ?? '').trim(),
        books,
        chatProfiles,
    };
}

/**
 * Store or update a fallback per-chat route profile inside `settings.chatProfiles` with LRU cap.
 */
export function upsertStoredChatProfile(settings, chatKey, rawProfile) {
    const cleanKey = String(chatKey ?? '').trim();
    if (!settings || !cleanKey) return;
    if (!settings.chatProfiles || typeof settings.chatProfiles !== 'object') {
        settings.chatProfiles = {};
    }
    const norm = normalizeChatProfile(rawProfile);
    if (!norm) {
        delete settings.chatProfiles[cleanKey];
        return;
    }
    settings.chatProfiles[cleanKey] = norm;

    const keys = Object.keys(settings.chatProfiles);
    if (keys.length > MAX_STORED_CHAT_PROFILES) {
        keys.sort((a, b) => (settings.chatProfiles[b]?.updatedAt || 0) - (settings.chatProfiles[a]?.updatedAt || 0));
        for (const staleKey of keys.slice(MAX_STORED_CHAT_PROFILES)) {
            delete settings.chatProfiles[staleKey];
        }
    }
}

/**
 * Check whether an entry comment looks like a visual section divider banner.
 */
export function parseDividerComment(rawComment, meta = {}) {
    const text = String(rawComment ?? '').trim();
    if (!text) return { isDivider: false, label: '' };

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

    if (/^[=\-—─━═_*~～✦✧★☆◆◇■□\s]+$/.test(text)) {
        return { isDivider: false, label: '' };
    }

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
 */
export function buildGroupedView(entries, rawBookConfig) {
    const bookConfig = normalizeBookConfig(rawBookConfig);
    const list = Array.isArray(entries) ? entries : [];
    const validUidSet = new Set(list.map((e) => e.uid));

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
            sceneKeywords: grp.sceneKeywords || [],
            cooldownTurns: grp.cooldownTurns || 2,
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
        sceneKeywords: [],
        cooldownTurns: 2,
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
 * Evaluate `scene` groups (e.g. NSFW / intimate lore) right before prompt WorldInfo assembly!
 * Inspects ONLY a tiny recent turn snippet (`recentText`, capped ~1200 chars — zero chat history scan):
 * - Turns ON a `scene` group immediately when its trigger cues appear in the latest 1–2 turns,
 *   setting its remaining active window to `cooldownTurns` (default 2 turns).
 * - Keeps it ON while `cooldown > 0` so brief dialogue exchanges mid-scene don't flicker off.
 * - Turns it OFF automatically once `cooldown` reaches 0 in normal peaceful plot!
 *
 * @param {{
 *   entries: Array<any>,
 *   bookConfig: any,
 *   recentText: string,
 *   cooldownByGroupId?: Record<string, number>
 * }} params
 * @returns {{
 *   togglePlan: Map<string, boolean>,
 *   nextCooldownByGroupId: Record<string, number>,
 *   activatedGroups: string[],
 *   deactivatedGroups: string[]
 * }}
 */
export function evaluateSceneAutoToggle({
    entries,
    bookConfig: rawBookConfig,
    recentText,
    cooldownByGroupId = {},
}) {
    const bookConfig = normalizeBookConfig(rawBookConfig);
    const list = Array.isArray(entries) ? entries : [];
    const togglePlan = new Map();
    const nextCooldownByGroupId = { ...(cooldownByGroupId || {}) };
    const activatedGroups = [];
    const deactivatedGroups = [];

    const sceneGroups = bookConfig.groups.filter((g) => g.mode === GROUP_MODES.SCENE);
    if (sceneGroups.length === 0 || list.length === 0) {
        return { togglePlan, nextCooldownByGroupId, activatedGroups, deactivatedGroups };
    }

    const sample = String(recentText ?? '').slice(-1500).toLowerCase();

    for (const grp of sceneGroups) {
        const groupEntries = list.filter((e) => bookConfig.assignments[e.uid] === grp.id);
        if (groupEntries.length === 0) continue;

        const keywords = grp.sceneKeywords && grp.sceneKeywords.length > 0
            ? grp.sceneKeywords
            : DEFAULT_SCENE_KEYWORDS;

        const isHit = Boolean(sample) && keywords.some((kw) => kw && sample.includes(kw));
        const prevCooldown = Number(nextCooldownByGroupId[grp.id] || 0);

        let shouldBeEnabled = false;
        if (isHit) {
            shouldBeEnabled = true;
            nextCooldownByGroupId[grp.id] = grp.cooldownTurns || 2;
        } else if (prevCooldown > 0) {
            shouldBeEnabled = true;
            nextCooldownByGroupId[grp.id] = prevCooldown - 1;
        } else {
            shouldBeEnabled = false;
            nextCooldownByGroupId[grp.id] = 0;
        }

        const desiredDisabled = !shouldBeEnabled;
        let anyChangedInGroup = false;
        for (const entry of groupEntries) {
            if (Boolean(entry.disabled) !== desiredDisabled) {
                togglePlan.set(entry.uid, desiredDisabled);
                anyChangedInGroup = true;
            }
        }

        if (anyChangedInGroup) {
            if (shouldBeEnabled) activatedGroups.push(grp.name);
            else deactivatedGroups.push(grp.name);
        }
    }

    return {
        togglePlan,
        nextCooldownByGroupId,
        activatedGroups,
        deactivatedGroups,
    };
}

/**
 * Apply a `uid -> nextDisabled` toggle plan onto a raw worldbook JSON payload in place.
 * Modifies ONLY `entry.disable`; 100% of titles, content, inclusion groups, and extensions remain untouched.
 */
export function applyTogglePlanToPayload(payload, togglePlan) {
    const entriesObj = payload?.entries;
    if (!entriesObj || typeof entriesObj !== 'object' || !(togglePlan instanceof Map) || togglePlan.size === 0) {
        return { changedCount: 0, appliedChanges: [] };
    }

    const appliedChanges = [];
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

    return {
        changedCount: appliedChanges.length,
        appliedChanges,
    };
}

/**
 * Parse greeting HTML comment tags (`<!-- title / desc / lore / exclude -->`) on a single greeting string.
 */
export function parseGreetingCommentTags(rawText) {
    const text = String(rawText ?? '').slice(0, 1200);
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
 * Build a greeting coordination index purely from character card greeting headers (reads first 1200 chars per greeting).
 */
export function buildGreetingCoordinationIndex(source = {}) {
    const cardGreetingsRaw = [];
    const first = String(source.firstMes ?? '');
    const alts = Array.isArray(source.alternateGreetings)
        ? source.alternateGreetings.map((s) => String(s ?? ''))
        : [];
    if (first || alts.length > 0) {
        cardGreetingsRaw.push(first, ...alts);
    }

    const swipeRaw = Array.isArray(source.swipes) && source.swipes.length > 0
        ? source.swipes.map((s) => String(s ?? ''))
        : [];

    const baseList = cardGreetingsRaw.length >= swipeRaw.length && cardGreetingsRaw.length > 0
        ? cardGreetingsRaw
        : swipeRaw;

    const greetings = [];
    const byUid = new Map();
    const managedUidSet = new Set();

    baseList.forEach((raw, swipeIndex) => {
        const parsedCard = parseGreetingCommentTags(raw);
        const parsedSwipe = swipeRaw[swipeIndex] ? parseGreetingCommentTags(swipeRaw[swipeIndex]) : null;
        const parsed = (parsedSwipe && (parsedSwipe.loreUids.length > 0 || parsedSwipe.excludeUids.length > 0 || parsedSwipe.title))
            ? parsedSwipe
            : parsedCard;

        const label = `#${swipeIndex}`;
        const info = {
            swipeIndex,
            label,
            title: parsed.title || parsedCard.title,
            desc: parsed.desc || parsedCard.desc,
            loreUids: parsed.loreUids,
            excludeUids: parsed.excludeUids,
        };
        greetings.push(info);

        for (const uid of info.loreUids) {
            managedUidSet.add(uid);
            if (!byUid.has(uid)) byUid.set(uid, { includeGreetings: [], excludeGreetings: [] });
            byUid.get(uid).includeGreetings.push({ swipeIndex, label, title: info.title });
        }
        for (const uid of info.excludeUids) {
            if (!byUid.has(uid)) byUid.set(uid, { includeGreetings: [], excludeGreetings: [] });
            byUid.get(uid).excludeGreetings.push({ swipeIndex, label, title: info.title });
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
 * Capture initial route ONLY on a brand-new 1-message chat (`chat.length === 1`)
 * by reading the first 1200 chars of `floorZeroMes`.
 * NEVER touches or iterates multi-floor chat history!
 */
export function buildInitialProfileFromFloorZero({
    worldName,
    floorZeroMes,
    greetingIndex = null,
    bookConfig = null,
}) {
    const cleanWorld = String(worldName ?? '').trim();
    if (!cleanWorld || !floorZeroMes) return null;

    const parsed = parseGreetingCommentTags(floorZeroMes);
    if (parsed.loreUids.length === 0 && parsed.excludeUids.length === 0) return null;

    const normBook = normalizeBookConfig(bookConfig);
    const ifGroups = normBook.groups.filter((g) => g.mode === GROUP_MODES.IF_LINE);
    const allManagedUids = greetingIndex?.managedUidSet || new Set();

    const activeSet = new Set(parsed.loreUids);
    const excludeSet = new Set(parsed.excludeUids);
    const entryDisabledMap = {};

    for (const uid of allManagedUids) {
        entryDisabledMap[uid] = !(activeSet.has(uid) && !excludeSet.has(uid));
    }
    for (const uid of activeSet) {
        entryDisabledMap[uid] = excludeSet.has(uid);
    }
    for (const uid of excludeSet) {
        entryDisabledMap[uid] = true;
    }

    let matchedIfGroup = null;
    let bestOverlap = 0;
    for (const grp of ifGroups) {
        const grpUids = Object.entries(normBook.assignments)
            .filter(([, gid]) => gid === grp.id)
            .map(([u]) => u);
        const overlap = grpUids.filter((u) => activeSet.has(u)).length;
        if (overlap > bestOverlap) {
            bestOverlap = overlap;
            matchedIfGroup = grp;
        }
    }

    const routeLabel = matchedIfGroup?.name || parsed.title || '开场白初始路线';
    return normalizeChatProfile({
        worldName: cleanWorld,
        routeLabel,
        ifGroupId: matchedIfGroup?.id || '',
        entryDisabledMap,
        updatedAt: Date.now(),
    });
}

/**
 * Snapshot the current worldbook's IF-line & non-scene grouped entry states into a per-chat save profile.
 * Supports seamless in-save timeline jumps (e.g., switching from 18岁线 -> 30岁线 mid-save updates `chatMetadata`
 * to 30岁线 immediately, and excludes transient `scene`/NSFW toggles from permanent route lock!).
 */
export function buildChatProfileFromCurrentState(worldName, entries, rawBookConfig, opts = {}) {
    const cleanWorld = String(worldName ?? '').trim();
    const list = Array.isArray(entries) ? entries : [];
    if (!cleanWorld || list.length === 0) return null;

    const bookConfig = normalizeBookConfig(rawBookConfig);
    const sceneGroupIds = new Set(
        bookConfig.groups.filter((g) => g.mode === GROUP_MODES.SCENE).map((g) => g.id),
    );
    const managedGreetingUids = opts.greetingIndex?.managedUidSet || new Set();

    let activeIfGroup = null;
    if (opts.preferredIfGroupId) {
        activeIfGroup = bookConfig.groups.find(
            (g) => g.id === opts.preferredIfGroupId && g.mode === GROUP_MODES.IF_LINE,
        ) || null;
    }
    if (!activeIfGroup) {
        const enabledIfGroups = bookConfig.groups.filter((g) => {
            if (g.mode !== GROUP_MODES.IF_LINE) return false;
            return list.some((e) => bookConfig.assignments[e.uid] === g.id && !e.disabled);
        });
        if (enabledIfGroups.length === 1) {
            activeIfGroup = enabledIfGroups[0];
        }
    }

    const nonSceneAssignedCount = Object.values(bookConfig.assignments).filter((gid) => !sceneGroupIds.has(gid)).length;
    const hasAnyGroupOrManaged = nonSceneAssignedCount > 0 || managedGreetingUids.size > 0;
    const entryDisabledMap = {};

    for (const entry of list) {
        const gid = bookConfig.assignments[entry.uid];
        // Never lock transient `scene` (NSFW) group states into the save's permanent route profile
        if (gid && sceneGroupIds.has(gid)) continue;
        if (!hasAnyGroupOrManaged || gid || managedGreetingUids.has(entry.uid)) {
            entryDisabledMap[entry.uid] = Boolean(entry.disabled);
        }
    }

    const enabledCount = list.filter((e) => !e.disabled).length;
    const routeLabel = String(opts.customLabel ?? '').trim()
        || activeIfGroup?.name
        || `本档配置（已开 ${enabledCount} 条）`;

    return normalizeChatProfile({
        worldName: cleanWorld,
        routeLabel,
        ifGroupId: activeIfGroup?.id || '',
        entryDisabledMap,
        updatedAt: Date.now(),
    });
}

/**
 * Compute the single-pass `Map<uid, nextDisabled>` needed to restore a chat save's bound profile!
 */
export function computeChatProfileRestorePlan(entries, rawBookConfig, rawChatProfile) {
    const profile = normalizeChatProfile(rawChatProfile);
    const list = Array.isArray(entries) ? entries : [];
    const plan = new Map();
    if (!profile || list.length === 0) return plan;

    const bookConfig = normalizeBookConfig(rawBookConfig);
    const sceneGroupIds = new Set(
        bookConfig.groups.filter((g) => g.mode === GROUP_MODES.SCENE).map((g) => g.id),
    );
    const validUidSet = new Set(list.map((e) => e.uid));

    if (profile.ifGroupId && bookConfig.groups.some((g) => g.id === profile.ifGroupId)) {
        const groupPlan = computeGroupTogglePlan(list, bookConfig, profile.ifGroupId, true);
        for (const [uid, nextDisabled] of groupPlan.entries()) {
            plan.set(uid, nextDisabled);
        }
    }

    for (const [uid, nextDisabled] of Object.entries(profile.entryDisabledMap)) {
        if (!validUidSet.has(uid)) continue;
        const gid = bookConfig.assignments[uid];
        if (gid && sceneGroupIds.has(gid)) continue;
        plan.set(uid, Boolean(nextDisabled));
    }

    const currentByUid = new Map(list.map((e) => [e.uid, Boolean(e.disabled)]));
    for (const [uid, nextDisabled] of [...plan.entries()]) {
        if (currentByUid.get(uid) === nextDisabled) {
            plan.delete(uid);
        }
    }

    return plan;
}

/**
 * Format a group's entry UIDs as a standard greeting automation HTML comment.
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

export function looksLikeIfLineName(groupName) {
    const clean = String(groupName ?? '').trim();
    if (!clean) return false;
    return IF_NAME_HINT_REGEX.test(clean);
}

export function looksLikeNsfwEntry(titleOrKeys) {
    const clean = String(titleOrKeys ?? '').trim();
    if (!clean) return false;
    return NSFW_TITLE_HINT_REGEX.test(clean);
}

export function extractEntryTitlePrefix(rawTitle) {
    let text = String(rawTitle ?? '').trim();
    if (!text) return null;

    const strippedIndex = text.replace(/^\d{1,3}[.、)\s]+\s*/, '');
    if (strippedIndex.length >= 3) {
        text = strippedIndex;
    }

    const bracketMatch = text.match(/^(?:【([^】]{1,18})】|\[([^\]]{1,18})\]|「([^」]{1,18})」|（([^）]{1,18})）|\(([^)]{1,18})\))\s*(.+)$/);
    if (bracketMatch) {
        const candidate = (bracketMatch[1] || bracketMatch[2] || bracketMatch[3] || bracketMatch[4] || bracketMatch[5] || '').trim();
        if (candidate && !/^\d+$/.test(candidate)) {
            return candidate;
        }
    }

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
 * Detect candidate entry groups automatically using NSFW scene hints, greeting tags,
 * divider banners, and title prefixes.
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

    const detectNsfwSceneGroup = (claimedSet) => {
        const nsfwUids = [];
        for (const entry of list) {
            if (entry.isDivider) continue;
            if (!isEligible(entry.uid) || claimedSet.has(entry.uid)) continue;
            const probe = `${entry.rawComment || entry.title} ${(entry.keys || []).join(' ')}`;
            if (looksLikeNsfwEntry(probe)) {
                nsfwUids.push(entry.uid);
            }
        }
        if (nsfwUids.length === 0) return [];
        for (const uid of nsfwUids) claimedSet.add(uid);
        return [{
            key: 'scene_nsfw',
            name: '亲密剧情 (NSFW)',
            suggestedMode: GROUP_MODES.SCENE,
            uids: nsfwUids,
            source: 'scene',
        }];
    };

    const detectFromGreetings = (claimedSet) => {
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

    const detectFromDividers = (claimedSet) => {
        const rawBlocks = [];
        let currentBlock = null;

        for (const entry of list) {
            if (entry.isDivider && entry.dividerLabel) {
                currentBlock = { label: entry.dividerLabel, uids: [] };
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

        const meaningful = rawBlocks.filter((b) => b.uids.length >= 1);
        if (meaningful.length < 2) return [];

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
            const suggestedMode = looksLikeNsfwEntry(label)
                ? GROUP_MODES.SCENE
                : (looksLikeIfLineName(label) ? GROUP_MODES.IF_LINE : GROUP_MODES.NORMAL);
            out.push({
                key: `divider_${idx++}_${label}`,
                name: label,
                suggestedMode,
                uids,
                source: 'divider',
            });
        }
        return out;
    };

    const detectFromPrefixes = (claimedSet) => {
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
            const isSpecial = looksLikeIfLineName(prefix) || looksLikeNsfwEntry(prefix);
            if (uids.length < 2 && !isSpecial) continue;
            for (const uid of uids) claimedSet.add(uid);
            const suggestedMode = looksLikeNsfwEntry(prefix)
                ? GROUP_MODES.SCENE
                : (looksLikeIfLineName(prefix) ? GROUP_MODES.IF_LINE : GROUP_MODES.NORMAL);
            out.push({
                key: `prefix_${idx++}_${prefix}`,
                name: prefix,
                suggestedMode,
                uids,
                source: 'prefix',
            });
        }
        return out;
    };

    const claimed = new Set();
    if (strategy === 'scene') return detectNsfwSceneGroup(claimed);
    if (strategy === 'greeting') return detectFromGreetings(claimed);
    if (strategy === 'divider') return detectFromDividers(claimed);
    if (strategy === 'prefix') return detectFromPrefixes(claimed);

    const results = [];
    results.push(...detectNsfwSceneGroup(claimed));
    if (greetingIndex?.hasManagedEntries) {
        results.push(...detectFromGreetings(claimed));
    }
    results.push(...detectFromDividers(claimed));
    results.push(...detectFromPrefixes(claimed));
    return results;
}

/**
 * Apply selected auto-detected group proposals into a bookConfig cleanly.
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
        const validMode = (
            desiredMode === GROUP_MODES.IF_LINE ||
            desiredMode === GROUP_MODES.RADIO ||
            desiredMode === GROUP_MODES.SCENE
        )
            ? desiredMode
            : GROUP_MODES.NORMAL;

        let group = next.groups.find((g) => g.name === name);
        if (!group) {
            group = {
                id: createGroupId('grp'),
                name,
                mode: validMode,
                collapsed: false,
                sceneKeywords: [],
                cooldownTurns: 2,
            };
            next.groups.push(group);
        } else if (group.mode === GROUP_MODES.NORMAL && validMode !== GROUP_MODES.NORMAL) {
            group.mode = validMode;
        }

        for (const uid of uids) {
            next.assignments[uid] = group.id;
        }
    }

    return next;
}

/**
 * Migrate plugin settings when `worldbook-organizer` renames a worldbook.
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

    if (settings.chatProfiles && typeof settings.chatProfiles === 'object') {
        for (const prof of Object.values(settings.chatProfiles)) {
            if (prof && prof.worldName === cleanOld) {
                prof.worldName = cleanNew;
                changed = true;
            }
        }
    }

    if (settings.lastOpenedBook === cleanOld) {
        settings.lastOpenedBook = cleanNew;
        changed = true;
    }

    return changed;
}

/**
 * Clean up plugin settings when worldbooks are deleted.
 */
export function removeDeletedWorldsFromSettings(settings, deletedNames) {
    if (!settings || !Array.isArray(deletedNames) || deletedNames.length === 0) return false;
    const delSet = new Set(deletedNames.map((n) => String(n ?? '').trim()).filter(Boolean));
    if (delSet.size === 0) return false;

    let changed = false;
    for (const clean of delSet) {
        if (settings.books && typeof settings.books === 'object' && clean in settings.books) {
            delete settings.books[clean];
            changed = true;
        }
        if (settings.lastOpenedBook === clean) {
            settings.lastOpenedBook = '';
            changed = true;
        }
    }

    if (settings.chatProfiles && typeof settings.chatProfiles === 'object') {
        for (const [chatKey, prof] of Object.entries(settings.chatProfiles)) {
            if (prof && delSet.has(prof.worldName)) {
                delete settings.chatProfiles[chatKey];
                changed = true;
            }
        }
    }

    return changed;
}
