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
    extractWorldbookEntrySummaries,
    formatGreetingCommentTag,
    inferChatRouteFromMessages,
    matchEntries,
    migrateSettingsOnWorldRename,
    normalizeSettings,
    pruneOrphanAssignments,
    removeDeletedWorldsFromSettings,
} from '../src/core.js';
import {
    applyWorldbookTogglePlan,
    loadWorldbookSummariesUncached,
    recordStateIntoActiveChatIfMatching,
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
        },
    };
}

test('extractWorldbookEntrySummaries strips heavy content and detects dividers', () => {
    const summaries = extractWorldbookEntrySummaries(createSamplePayload());
    assert.equal(summaries.length, 7);
    assert.equal(summaries[0].uid, '0');
    assert.equal(summaries[0].isDivider, true);
    assert.equal(summaries[0].dividerLabel, '基础设定');
    assert.equal('content' in summaries[1], false);
    assert.equal(summaries[1].constant, true);
    assert.deepEqual(summaries[1].keys, ['王都', '皇城']);
});

test('IF-line mutex group toggle enables target line and disables sibling IF lines without touching normal groups', () => {
    const payload = createSamplePayload();
    const summaries = extractWorldbookEntrySummaries(payload);
    const bookCfg = {
        groups: [
            { id: 'g_lore', name: '基础设定', mode: GROUP_MODES.NORMAL, collapsed: false },
            { id: 'g_18', name: '18岁线', mode: GROUP_MODES.IF_LINE, collapsed: false },
            { id: 'g_30', name: '30岁线', mode: GROUP_MODES.IF_LINE, collapsed: false },
        ],
        assignments: {
            1: 'g_lore',
            2: 'g_lore',
            10: 'g_18',
            11: 'g_18',
            20: 'g_30',
            21: 'g_30',
        },
    };

    const plan = computeGroupTogglePlan(summaries, bookCfg, 'g_30', true);
    assert.equal(plan.get('20'), false);
    assert.equal(plan.get('21'), false);
    assert.equal(plan.get('10'), true);
    assert.equal(plan.get('11'), true);
    assert.equal(plan.has('1'), false);

    const res = applyTogglePlanToPayload(payload, plan);
    assert.equal(res.changedCount, 4);
    assert.equal(payload.entries[10].disable, true);
    assert.equal(payload.entries[20].disable, false);
    assert.equal(payload.entries[1].group, 'keep_native_inclusion_group');
    assert.equal(payload.entries[10].comment, '[18岁线] 少年意气');
});

test('Radio mode group ensures single-entry exclusivity within the group', () => {
    const summaries = [
        { uid: '1', title: '文风·清冷', disabled: false, keys: [] },
        { uid: '2', title: '文风·热烈', disabled: true, keys: [] },
        { uid: '3', title: '文风·悬疑', disabled: true, keys: [] },
    ];
    const bookCfg = {
        groups: [{ id: 'g_style', name: '文风档位', mode: GROUP_MODES.RADIO, collapsed: false }],
        assignments: { 1: 'g_style', 2: 'g_style', 3: 'g_style' },
    };

    const plan = computeEntryTogglePlan(summaries, bookCfg, '3', true);
    assert.equal(plan.get('3'), false);
    assert.equal(plan.get('1'), true);
    assert.equal(plan.get('2'), true);
});

test('Greeting comment tags parse accurately and generate auto-detect IF-line groups', () => {
    const payload = createSamplePayload();
    const summaries = extractWorldbookEntrySummaries(payload);
    const greetIndex = buildGreetingCoordinationIndex({
        firstMes: '<!-- title: 目录页 -->\n<greetings>目录</greetings>',
        alternateGreetings: [
            '<!-- title: 18岁少年篇 -->\n<!-- lore: 10, 11 -->\n<!-- exclude: 2 -->\n十八岁的盛夏，蝉鸣吵得人睡不着觉，少年趴在课桌上回头看你。',
            '<!-- title：30岁重逢篇 -->\n<!-- lore：20，21 -->\n三十岁的雨夜，酒会散场后的走廊里，他替你挡住了迎面吹来的冷风。',
        ],
        currentSwipeId: 1,
    });

    assert.equal(greetIndex.hasManagedEntries, true);
    assert.equal(greetIndex.activeGreeting?.title, '18岁少年篇');
    assert.deepEqual(greetIndex.byUid.get('10')?.includeGreetings.map((g) => g.swipeIndex), [1]);

    const proposals = detectAutoGroups(summaries, {
        strategy: 'greeting',
        onlyUngrouped: true,
        greetingIndex: greetIndex,
    });
    assert.equal(proposals.length, 2);
    assert.equal(proposals[0].name, 'IF · 18岁少年篇');
    assert.equal(proposals[0].suggestedMode, GROUP_MODES.IF_LINE);
    assert.deepEqual(proposals[0].uids, ['10', '11']);
    assert.equal(formatGreetingCommentTag(['21', '10', '10'], 'lore'), '<!-- lore: 10,21 -->');
});

test('Multi-floor & branched chat save recognition recovers route even when comments or swipe_id are lost or jumped mid-chat', () => {
    const greetIndex = buildGreetingCoordinationIndex({
        firstMes: '<!-- title: 目录页 -->\n<greetings>请选择时间线</greetings>',
        alternateGreetings: [
            '<!-- title: 18岁少年篇 -->\n<!-- lore: 10, 11 -->\n十八岁的盛夏，蝉鸣吵得人睡不着觉，少年趴在课桌上回头看你。',
            '<!-- title: 30岁重逢篇 -->\n<!-- lore: 20, 21 -->\n三十岁的雨夜，酒会散场后的走廊里，他替你挡住了迎面吹来的冷风。',
        ],
        // Simulate branched save where `swipes` was trimmed to 1 item and `swipe_id` disappeared!
        swipes: ['十八岁的盛夏，蝉鸣吵得人睡不着觉，少年趴在课桌上回头看你。'],
        currentSwipeId: null,
    });

    // Case 1: 6 floors deep, HTML comments stripped from floor 0 -> reverse-matches narrative text!
    const route18 = inferChatRouteFromMessages({
        worldName: '角色主书',
        chatMessages: [
            { is_user: false, mes: '十八岁的盛夏，蝉鸣吵得人睡不着觉，少年趴在课桌上回头看你。' },
            { is_user: true, mes: '你醒啦？' },
            { is_user: false, mes: '他揉了揉眼睛笑起来。' },
        ],
        greetingIndex: greetIndex,
    });
    assert.ok(route18);
    assert.equal(route18.routeLabel, '18岁少年篇');
    assert.equal(route18.entryDisabledMap['10'], false);
    assert.equal(route18.entryDisabledMap['11'], false);
    // Sibling 30yo route entries are still cleanly disabled even though branched `swipes` lacked them!
    assert.equal(route18.entryDisabledMap['20'], true);
    assert.equal(route18.entryDisabledMap['21'], true);

    // Case 2: Mid-chat timeline jump inserted at floor 4 -> newest greeting floor wins over floor 0!
    const routeJumpedTo30 = inferChatRouteFromMessages({
        worldName: '角色主书',
        chatMessages: [
            { is_user: false, mes: '<!-- title: 18岁少年篇 -->\n<!-- lore: 10, 11 -->\n十八岁的盛夏，蝉鸣吵得人睡不着觉，少年趴在课桌上回头看你。' },
            { is_user: true, mes: '十年后见。' },
            { is_user: false, mes: '时光飞逝。' },
            { is_user: false, mes: '<!-- title: 30岁重逢篇 -->\n<!-- lore: 20, 21 -->\n三十岁的雨夜，酒会散场后的走廊里，他替你挡住了迎面吹来的冷风。' },
            { is_user: true, mes: '好久不见。' },
        ],
        greetingIndex: greetIndex,
    });
    assert.ok(routeJumpedTo30);
    assert.equal(routeJumpedTo30.routeLabel, '30岁重逢篇');
    assert.equal(routeJumpedTo30.entryDisabledMap['20'], false);
    assert.equal(routeJumpedTo30.entryDisabledMap['10'], true);
});

test('Prefix auto-detect recognizes age/IF routes (18岁线 / 30岁线) and respects existing assignments', () => {
    const summaries = extractWorldbookEntrySummaries(createSamplePayload());
    const prefixProposals = detectAutoGroups(summaries, {
        strategy: 'prefix',
        onlyUngrouped: true,
        existingAssignments: { 1: 'existing_grp', 2: 'existing_grp' },
    });

    assert.equal(prefixProposals.length, 2);
    assert.equal(prefixProposals[0].name, '18岁线');
    assert.equal(prefixProposals[0].suggestedMode, GROUP_MODES.IF_LINE);
    assert.equal(prefixProposals[1].name, '30岁线');
    assert.equal(prefixProposals[1].suggestedMode, GROUP_MODES.IF_LINE);

    const applied = applyAutoGroupProposals({ groups: [], assignments: {} }, prefixProposals);
    assert.equal(applied.groups.length, 2);
    assert.equal(Object.keys(applied.assignments).length, 4);
});

test('Orphan UID pruning, search matching, and wbo rename/delete migrations stay consistent', () => {
    const summaries = extractWorldbookEntrySummaries(createSamplePayload());
    const settings = normalizeSettings({
        lastOpenedBook: '旧世界书',
        books: {
            旧世界书: {
                groups: [{ id: 'g1', name: '世界观', mode: 'normal', collapsed: false }],
                assignments: { 1: 'g1', 999: 'g1' },
            },
        },
        chatProfiles: {
            'char.png::save1': {
                worldName: '旧世界书',
                routeLabel: '18岁线',
                ifGroupId: 'g1',
                entryDisabledMap: { 10: false },
                updatedAt: 100,
            },
        },
    });

    const viewBefore = buildGroupedView(summaries, settings.books['旧世界书']);
    assert.equal(viewBefore.sections[0].totalCount, 1);
    assert.equal(viewBefore.orphanCount, 1);

    const removed = pruneOrphanAssignments(settings.books['旧世界书'], new Set(summaries.map((s) => s.uid)));
    assert.equal(removed, 1);

    const singlePhraseHits = matchEntries(summaries, '18岁 少年', { multiTerm: false });
    assert.equal(singlePhraseHits.size, 0);
    const multiTermHits = matchEntries(summaries, '18岁 少年', { multiTerm: true });
    assert.deepEqual([...multiTermHits], ['10']);

    assert.equal(migrateSettingsOnWorldRename(settings, '旧世界书', '新世界书'), true);
    assert.equal(settings.lastOpenedBook, '新世界书');
    assert.equal(settings.chatProfiles['char.png::save1'].worldName, '新世界书');

    assert.equal(removeDeletedWorldsFromSettings(settings, ['新世界书']), true);
    assert.equal(settings.lastOpenedBook, '');
    assert.equal('char.png::save1' in settings.chatProfiles, false);
    assert.equal(viewBefore.sections.at(-1)?.id, SPECIAL_GROUP_UNGROUPED);
});

test('End-to-end multi-save switching (Save A 18岁线 <-> Save B 30岁线) restores worldbook in 1 write per switch', async () => {
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
                    ],
                    assignments: { 10: 'g_18', 11: 'g_18', 20: 'g_30', 21: 'g_30' },
                },
            },
        }),
    };

    let activeChatId = 'save_18yo';
    let activeChatMetadata = saveAMetadata;
    let activeChatMessages = [
        { is_user: false, mes: '十八岁的盛夏，蝉鸣吵得人睡不着觉，少年趴在课桌上回头看你。' },
        { is_user: true, mes: '聊了好几层之后的内容' },
    ];

    const origFetch = globalThis.fetch;
    const origST = globalThis.SillyTavern;

    globalThis.SillyTavern = {
        getContext: () => ({
            characterId: 0,
            characters: [{
                avatar: 'hero.png',
                name: '陆砚驰',
                first_mes: '<!-- title: 目录页 -->\n目录',
                data: {
                    extensions: { world: '角色主书' },
                    alternate_greetings: [
                        '<!-- title: 18岁线 -->\n<!-- lore: 10, 11 -->\n十八岁的盛夏，蝉鸣吵得人睡不着觉，少年趴在课桌上回头看你。',
                        '<!-- title: 30岁线 -->\n<!-- lore: 20, 21 -->\n三十岁的雨夜，酒会散场后的走廊里，他替你挡住了迎面吹来的冷风。',
                    ],
                },
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
        // 1. In Save A (18yo): already has 10,11 enabled & 20,21 disabled -> recognizes Save A & performs 0 writes!
        const resA1 = await syncWorldbookForActiveChat({ reason: 'chat-changed', silentToast: true });
        assert.equal(resA1.routeLabel, '18岁线');
        assert.equal(resA1.changedCount, 0);
        assert.equal(apiCalls.filter((c) => c.url === '/api/worldinfo/edit').length, 0);

        // 2. Switch to Save B (30yo, 10 floors deep, manually locked to `30岁线` without needing comments!)
        activeChatId = 'save_30yo';
        activeChatMetadata = saveBMetadata;
        activeChatMessages = [{ is_user: false, mes: '普通无注释开场' }, { is_user: true, mes: '第2层' }];

        // User turns on `30岁线` in Save B -> binds Save B to `30岁线`
        await applyWorldbookTogglePlan('角色主书', new Map([['10', true], ['11', true], ['20', false], ['21', false]]));
        const readAfterB = await loadWorldbookSummariesUncached('角色主书');
        recordStateIntoActiveChatIfMatching('角色主书', readAfterB.summaries, {
            preferredIfGroupId: 'g_30',
            customLabel: '30岁线',
        });
        assert.equal(diskStore.entries[20].disable, false);
        assert.equal(diskStore.entries[10].disable, true);

        // 3. Now switch BACK to Save A (18yo, deep in chat)! -> Automatically flips back to 18岁线 in 1 write!
        apiCalls.length = 0;
        activeChatId = 'save_18yo';
        activeChatMetadata = saveAMetadata;
        const resBackToA = await syncWorldbookForActiveChat({ reason: 'chat-changed', silentToast: true });
        assert.equal(resBackToA.routeLabel, '18岁线');
        assert.equal(resBackToA.changedCount, 4);
        assert.equal(apiCalls.filter((c) => c.url === '/api/worldinfo/edit').length, 1);
        assert.equal(diskStore.entries[10].disable, false);
        assert.equal(diskStore.entries[20].disable, true);

        // 4. Switch to Save B again -> Automatically flips back to 30岁线 in 1 write!
        apiCalls.length = 0;
        activeChatId = 'save_30yo';
        activeChatMetadata = saveBMetadata;
        const resBackToB = await syncWorldbookForActiveChat({ reason: 'chat-changed', silentToast: true });
        assert.equal(resBackToB.routeLabel, '30岁线');
        assert.equal(resBackToB.changedCount, 4);
        assert.equal(apiCalls.filter((c) => c.url === '/api/worldinfo/edit').length, 1);
        assert.equal(diskStore.entries[20].disable, false);
        assert.equal(diskStore.entries[10].disable, true);
    } finally {
        globalThis.fetch = origFetch;
        globalThis.SillyTavern = origST;
    }
});
