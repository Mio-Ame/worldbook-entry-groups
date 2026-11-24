import test from 'node:test';
import assert from 'node:assert/strict';

import {
    GROUP_MODES,
    SPECIAL_GROUP_UNGROUPED,
    applyAutoGroupProposals,
    applyTogglePlanToPayload,
    buildGreetingCoordinationIndex,
    buildGroupedView,
    computeEntryTogglePlan,
    computeGroupTogglePlan,
    detectAutoGroups,
    evaluateSceneAutoToggle,
    extractWorldbookEntrySummaries,
    formatGreetingCommentTag,
    matchEntries,
    migrateSettingsOnWorldRename,
    normalizeSettings,
    pruneOrphanAssignments,
    removeDeletedWorldsFromSettings,
} from '../src/core.js';
import {
    applyWorldbookTogglePlan,
    clearRuntimeBookSnapshots,
    loadWorldbookSummariesUncached,
    recordStateIntoActiveChatIfMatching,
    switchNamedGroupInActiveChat,
    syncSceneGroupsBeforeGeneration,
    syncWorldbookForActiveChat,
} from '../src/host.js';

function createSamplePayload() {
    return {
        entries: {
            0: {
                uid: 0,
                comment: '=== 基础设定 ===',
                key: [],
                content: '',
                disable: true,
                constant: false,
                displayIndex: 0,
                group: 'keep_native_inclusion_group',
            },
            1: {
                uid: 1,
                comment: '【世界观】王都地理',
                key: ['王都', '皇城'],
                content: '大段世界观正文内容……'.repeat(50),
                disable: false,
                constant: true,
                displayIndex: 1,
                group: 'keep_native_inclusion_group',
            },
            2: {
                uid: 2,
                comment: '【世界观】势力分布',
                key: ['公会'],
                content: '势力正文……',
                disable: false,
                constant: false,
                displayIndex: 2,
            },
            10: {
                uid: 10,
                comment: '[18岁线] 少年意气',
                key: ['十八岁'],
                content: '18岁线设定 1',
                disable: false,
                displayIndex: 3,
            },
            11: {
                uid: 11,
                comment: '[18岁线] 课桌秘密',
                key: ['教室'],
                content: '18岁线设定 2',
                disable: false,
                displayIndex: 4,
            },
            20: {
                uid: 20,
                comment: '[30岁线] 久别重逢',
                key: ['酒会'],
                content: '30岁线设定 1',
                disable: true,
                displayIndex: 5,
            },
            21: {
                uid: 21,
                comment: '[30岁线] 沉稳克制',
                key: ['办公室'],
                content: '30岁线设定 2',
                disable: true,
                displayIndex: 6,
            },
            30: {
                uid: 30,
                comment: '[NSFW] 身体敏感带与亲密反应',
                key: ['呼吸'],
                content: '亲密设定正文',
                disable: true,
                constant: true,
                displayIndex: 7,
            },
        },
    };
}

test('extractWorldbookEntrySummaries strips heavy content and detects dividers', () => {
    const summaries = extractWorldbookEntrySummaries(createSamplePayload());
    assert.equal(summaries.length, 8);
    assert.equal(summaries[0].uid, '0');
    assert.equal(summaries[0].isDivider, true);
    assert.equal(summaries[0].dividerLabel, '基础设定');
    assert.equal('content' in summaries[1], false);
    assert.equal(summaries[1].constant, true);
});

test('IF-line mutex group toggle enables target line and disables sibling IF lines without touching normal or scene groups', () => {
    const payload = createSamplePayload();
    const summaries = extractWorldbookEntrySummaries(payload);
    const bookCfg = {
        groups: [
            { id: 'g_lore', name: '基础设定', mode: GROUP_MODES.NORMAL, collapsed: false },
            { id: 'g_18', name: '18岁线', mode: GROUP_MODES.IF_LINE, collapsed: false },
            { id: 'g_30', name: '30岁线', mode: GROUP_MODES.IF_LINE, collapsed: false },
            { id: 'g_nsfw', name: '亲密剧情 (NSFW)', mode: GROUP_MODES.SCENE, collapsed: false },
        ],
        assignments: {
            1: 'g_lore',
            2: 'g_lore',
            10: 'g_18',
            11: 'g_18',
            20: 'g_30',
            21: 'g_30',
            30: 'g_nsfw',
        },
    };

    const plan = computeGroupTogglePlan(summaries, bookCfg, 'g_30', true);
    assert.equal(plan.get('20'), false);
    assert.equal(plan.get('21'), false);
    assert.equal(plan.get('10'), true);
    assert.equal(plan.get('11'), true);
    assert.equal(plan.has('1'), false);
    assert.equal(plan.has('30'), false);

    const res = applyTogglePlanToPayload(payload, plan);
    assert.equal(res.changedCount, 4);
    assert.equal(payload.entries[1].group, 'keep_native_inclusion_group');
});

test('Smart auto-detect identifies NSFW scene entries alongside age/IF prefix groups', () => {
    const summaries = extractWorldbookEntrySummaries(createSamplePayload());
    const proposals = detectAutoGroups(summaries, {
        strategy: 'smart',
        onlyUngrouped: true,
        existingAssignments: { 1: 'existing_grp', 2: 'existing_grp' },
    });

    const nsfwProp = proposals.find((p) => p.source === 'scene');
    assert.ok(nsfwProp);
    assert.equal(nsfwProp.name, '亲密剧情 (NSFW)');
    assert.equal(nsfwProp.suggestedMode, GROUP_MODES.SCENE);
    assert.deepEqual(nsfwProp.uids, ['30']);

    const ifProps = proposals.filter((p) => p.suggestedMode === GROUP_MODES.IF_LINE);
    assert.equal(ifProps.length, 2);
    assert.equal(ifProps[0].name, '18岁线');
    assert.equal(ifProps[1].name, '30岁线');

    const applied = applyAutoGroupProposals({ groups: [], assignments: {} }, proposals);
    assert.equal(applied.groups.length, 3);
});

test('Scene group (NSFW) stays OFF in daily plot, turns ON on cue, holds during cooldown, and auto-closes afterward', () => {
    const bookCfg = {
        groups: [{ id: 'g_nsfw', name: '亲密剧情 (NSFW)', mode: GROUP_MODES.SCENE, cooldownTurns: 2 }],
        assignments: { 30: 'g_nsfw' },
    };

    // 1. Daily plot, already disabled -> 0 changes!
    const t1 = evaluateSceneAutoToggle({
        entries: [{ uid: '30', disabled: true }],
        bookConfig: bookCfg,
        recentText: '今天一起去图书馆复习高数吧。',
        cooldownByGroupId: {},
    });
    assert.equal(t1.togglePlan.size, 0);

    // 2. Intimate scene cue -> turns ON (`disabled = false`) and sets cooldown = 2
    const t2 = evaluateSceneAutoToggle({
        entries: [{ uid: '30', disabled: true }],
        bookConfig: bookCfg,
        recentText: '他低喘着吻住你的锁骨，指尖解开衣扣。',
        cooldownByGroupId: t1.nextCooldownByGroupId,
    });
    assert.equal(t2.togglePlan.get('30'), false);
    assert.deepEqual(t2.activatedGroups, ['亲密剧情 (NSFW)']);
    assert.equal(t2.nextCooldownByGroupId.g_nsfw, 2);

    // 3. Brief mid-scene dialogue without explicit keyword -> cooldown decrements 2 -> 1, stays ON!
    const t3 = evaluateSceneAutoToggle({
        entries: [{ uid: '30', disabled: false }],
        bookConfig: bookCfg,
        recentText: '“别看我……”你偏过头小声说。',
        cooldownByGroupId: t2.nextCooldownByGroupId,
    });
    assert.equal(t3.togglePlan.size, 0);
    assert.equal(t3.nextCooldownByGroupId.g_nsfw, 1);

    // 4. Another non-keyword turn -> cooldown decrements 1 -> 0, still ON for this transition turn
    const t4 = evaluateSceneAutoToggle({
        entries: [{ uid: '30', disabled: false }],
        bookConfig: bookCfg,
        recentText: '窗外的雨渐渐停了。',
        cooldownByGroupId: t3.nextCooldownByGroupId,
    });
    assert.equal(t4.togglePlan.size, 0);
    assert.equal(t4.nextCooldownByGroupId.g_nsfw, 0);

    // 5. Next peaceful daily turn (`cooldown === 0`) -> automatically closes NSFW group (`disabled = true`)!
    const t5 = evaluateSceneAutoToggle({
        entries: [{ uid: '30', disabled: false }],
        bookConfig: bookCfg,
        recentText: '第二天清晨，你们去食堂吃早饭。',
        cooldownByGroupId: t4.nextCooldownByGroupId,
    });
    assert.equal(t5.togglePlan.get('30'), true);
    assert.deepEqual(t5.deactivatedGroups, ['亲密剧情 (NSFW)']);
});

test('Zero chat-history scan on huge 5000-floor saves + in-save 18岁 -> 30岁 progression + pre-WorldInfo NSFW hook', async () => {
    clearRuntimeBookSnapshots();
    const diskStore = createSamplePayload();
    const apiCalls = [];

    const saveAMetadata = {};
    const saveBMetadata = {};
    const extensionSettings = {
        worldbook_entry_groups: normalizeSettings({
            books: {
                角色主书: {
                    groups: [
                        { id: 'g_18', name: '18岁线', mode: GROUP_MODES.IF_LINE, collapsed: false },
                        { id: 'g_30', name: '30岁线', mode: GROUP_MODES.IF_LINE, collapsed: false },
                        { id: 'g_nsfw', name: '亲密剧情 (NSFW)', mode: GROUP_MODES.SCENE, cooldownTurns: 1 },
                    ],
                    assignments: { 10: 'g_18', 11: 'g_18', 20: 'g_30', 21: 'g_30', 30: 'g_nsfw' },
                },
            },
        }),
    };

    // Create a poisoned 5000-floor chat array that THROWS if `CHAT_CHANGED` dares to read ANY message content!
    const poisoned5000FloorChat = new Proxy([], {
        get(target, prop) {
            if (prop === 'length') return 5000;
            if (typeof prop === 'string' && /^\d+$/.test(prop)) {
                throw new Error(`FORBIDDEN: scanned chat floor ${prop} during CHAT_CHANGED!`);
            }
            return Reflect.get(target, prop);
        },
    });

    let activeChatId = 'save_A';
    let activeChatMetadata = saveAMetadata;
    let activeChatMessages = poisoned5000FloorChat;

    const origFetch = globalThis.fetch;
    const origST = globalThis.SillyTavern;

    globalThis.SillyTavern = {
        getContext: () => ({
            characterId: 0,
            characters: [{
                avatar: 'hero.png',
                name: '陆砚驰',
                data: { extensions: { world: '角色主书' } },
            }],
            getCurrentChatId: () => activeChatId,
            chatMetadata: activeChatMetadata,
            chat: activeChatMessages,
            extensionSettings,
            saveSettingsDebounced: () => {},
            saveMetadataDebounced: () => {},
        }),
    };

    globalThis.fetch = async (url, init) => {
        const body = JSON.parse(init.body);
        apiCalls.push({ url, name: body.name });
        if (url === '/api/worldinfo/get') {
            return { ok: true, status: 200, json: async () => structuredClone(diskStore) };
        }
        if (url === '/api/worldinfo/edit') {
            Object.assign(diskStore, structuredClone(body.data));
            return { ok: true, status: 200, json: async () => ({ ok: true }) };
        }
        throw new Error(`Unexpected URL: ${url}`);
    };

    try {
        // 1. Lock Save A initially to `18岁线`
        const initRead = await loadWorldbookSummariesUncached('角色主书');
        recordStateIntoActiveChatIfMatching('角色主书', initRead.summaries, {
            preferredIfGroupId: 'g_18',
            customLabel: '18岁线',
            force: true,
        });

        // 2. Mid-save timeline jump in Save A: 18岁线 -> 30岁线 via `/weg 30岁线`!
        const jumpRes = await switchNamedGroupInActiveChat('30岁线');
        assert.equal(jumpRes.matched, true);
        assert.equal(diskStore.entries[20].disable, false);
        assert.equal(diskStore.entries[10].disable, true);
        assert.equal(saveAMetadata.worldbook_entry_groups.routeLabel, '30岁线');

        // 3. Switch to Save B (`18岁线`)
        activeChatId = 'save_B';
        activeChatMetadata = saveBMetadata;
        await switchNamedGroupInActiveChat('18岁线');
        assert.equal(diskStore.entries[10].disable, false);
        assert.equal(diskStore.entries[20].disable, true);

        // 4. Switch BACK to 5000-floor Save A (`poisoned5000FloorChat`)!
        // Must NOT touch any chat floor, and must restore Save A's updated `30岁线` stage!
        apiCalls.length = 0;
        activeChatId = 'save_A';
        activeChatMetadata = saveAMetadata;
        activeChatMessages = poisoned5000FloorChat;
        const restoreA = await syncWorldbookForActiveChat({ reason: 'chat-changed', silentToast: true });
        assert.equal(restoreA.routeLabel, '30岁线');
        assert.equal(restoreA.changedCount, 4);
        assert.equal(diskStore.entries[20].disable, false);
        assert.equal(diskStore.entries[10].disable, true);
        assert.equal(apiCalls.filter((c) => c.url === '/api/worldinfo/edit').length, 1);

        // 5. Test pre-WorldInfo NSFW hook: idle daily turn does ZERO fetch & ZERO write!
        apiCalls.length = 0;
        activeChatMessages = [
            { is_user: true, mes: '今天天气不错，去散步吧。' },
        ];
        const idleGen = await syncSceneGroupsBeforeGeneration('normal', false);
        assert.equal(idleGen.changedCount, 0);
        assert.equal(apiCalls.length, 0);

        // 6. Intimate turn triggers NSFW ON right before generation!
        activeChatMessages = [
            { is_user: true, mes: '他低喘着深吻下来，指尖滚烫。' },
        ];
        const nsfwGen = await syncSceneGroupsBeforeGeneration('normal', false);
        assert.equal(nsfwGen.changedCount, 1);
        assert.equal(diskStore.entries[30].disable, false);
        // Save A's route binding remains `30岁线` (unpolluted by transient NSFW toggle)
        assert.equal(saveAMetadata.worldbook_entry_groups.routeLabel, '30岁线');
    } finally {
        globalThis.fetch = origFetch;
        globalThis.SillyTavern = origST;
    }
});

test('Radio mode, greeting tags, orphan pruning, and wbo rename/delete migrations work cleanly', () => {
    const summaries = extractWorldbookEntrySummaries(createSamplePayload());
    const radioPlan = computeEntryTogglePlan(
        [
            { uid: '1', title: 'A', disabled: false, keys: [] },
            { uid: '2', title: 'B', disabled: true, keys: [] },
        ],
        { groups: [{ id: 'r1', name: '单选', mode: GROUP_MODES.RADIO }], assignments: { 1: 'r1', 2: 'r1' } },
        '2',
        true,
    );
    assert.equal(radioPlan.get('2'), false);
    assert.equal(radioPlan.get('1'), true);

    const greetIdx = buildGreetingCoordinationIndex({
        firstMes: '<!-- title: 18岁篇 -->\n<!-- lore: 10, 11 -->\n正文',
    });
    assert.equal(greetIdx.hasManagedEntries, true);
    assert.equal(formatGreetingCommentTag(['11', '10'], 'lore'), '<!-- lore: 10,11 -->');

    const settings = normalizeSettings({
        lastOpenedBook: '旧书',
        books: { 旧书: { groups: [{ id: 'g1', name: '组', mode: 'normal' }], assignments: { 1: 'g1', 999: 'g1' } } },
    });
    assert.equal(pruneOrphanAssignments(settings.books['旧书'], new Set(summaries.map((s) => s.uid))), 1);
    assert.equal(matchEntries(summaries, '18岁 少年', { multiTerm: true }).has('10'), true);
    assert.equal(migrateSettingsOnWorldRename(settings, '旧书', '新书'), true);
    assert.equal(removeDeletedWorldsFromSettings(settings, ['新书']), true);
    assert.equal(buildGroupedView(summaries, null).sections[0].id, SPECIAL_GROUP_UNGROUPED);
});
