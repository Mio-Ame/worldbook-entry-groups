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
    computeGreetingPresetPlan,
    computeGroupTogglePlan,
    detectAutoGroups,
    evaluateSceneAutoToggle,
    extractExternalScriptRouteLabel,
    extractWorldbookEntrySummaries,
    formatGreetingCommentTag,
    matchEntries,
    migrateSettingsOnWorldRename,
    normalizeSettings,
    pruneOrphanAssignments,
    removeDeletedWorldsFromSettings,
} from '../src/core.js';
import {
    applyGreetingPresetToWorldbook,
    captureExternalWorldbookSwitchForActiveChat,
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
                comment: '【通用线】王朝地理',
                key: ['王都', '皇城'],
                content: '大段世界观正文内容……'.repeat(50),
                disable: false,
                constant: true,
                displayIndex: 1,
                group: 'keep_native_inclusion_group',
            },
            2: {
                uid: 2,
                comment: '【通用线】势力分布',
                key: ['公会'],
                content: '势力正文……',
                disable: false,
                constant: false,
                displayIndex: 2,
            },
            10: {
                uid: 10,
                comment: '【18岁线】少年意气',
                key: ['十八岁'],
                content: '18岁线设定 1',
                disable: false,
                displayIndex: 3,
            },
            11: {
                uid: 11,
                comment: '【18岁线】课桌秘密',
                key: ['教室'],
                content: '18岁线设定 2',
                disable: false,
                displayIndex: 4,
            },
            20: {
                uid: 20,
                comment: '【30岁线】久别重逢',
                key: ['酒会'],
                content: '30岁线设定 1',
                disable: true,
                displayIndex: 5,
            },
            21: {
                uid: 21,
                comment: '【30岁线】沉稳克制',
                key: ['办公室'],
                content: '30岁线设定 2',
                disable: true,
                displayIndex: 6,
            },
            30: {
                uid: 30,
                comment: '【通用线】nfsw亲密反应',
                key: ['呼吸'],
                content: '亲密设定正文',
                disable: true,
                constant: true,
                displayIndex: 7,
            },
            40: {
                uid: 40,
                comment: '——⬇️⬇️USER身份自选⬇️⬇️——',
                key: [],
                content: '',
                disable: true,
                displayIndex: 8,
            },
            41: {
                uid: 41,
                comment: '高门贵女user',
                key: [],
                content: '身份1',
                disable: true,
                displayIndex: 9,
            },
            42: {
                uid: 42,
                comment: '江湖侠客user',
                key: [],
                content: '身份2',
                disable: true,
                displayIndex: 10,
            },
            43: {
                uid: 43,
                comment: '——⬆️⬆️USER身份自选⬆️⬆️——',
                key: [],
                content: '',
                disable: true,
                displayIndex: 11,
            },
            44: {
                uid: 44,
                comment: '【状态栏】心声格式',
                key: [],
                content: '状态栏正文',
                disable: false,
                displayIndex: 12,
            },
        },
    };
}

test('Paired ⬇️...⬆️ dividers close cleanly, common lore stays NORMAL, and nfsw typo is recognized', () => {
    const summaries = extractWorldbookEntrySummaries(createSamplePayload());
    const proposals = detectAutoGroups(summaries, { strategy: 'smart', onlyUngrouped: true });

    const byName = new Map(proposals.map((p) => [p.name, p]));

    // 1. Typo `nfsw` recognized into `亲密剧情 (NSFW)` (`scene`)
    assert.equal(byName.get('亲密剧情 (NSFW)')?.suggestedMode, GROUP_MODES.SCENE);
    assert.deepEqual(byName.get('亲密剧情 (NSFW)')?.uids, ['30']);

    // 2. Bounded `⬇️⬇️USER身份自选⬇️⬇️` ... `⬆️⬆️USER身份自选⬆️⬆️` captures 41, 42 as RADIO,
    // excludes pure banner UIDs 40 & 43, and does NOT swallow UID 44 after `⬆️⬆️`!
    assert.equal(byName.get('USER身份自选')?.suggestedMode, GROUP_MODES.RADIO);
    assert.deepEqual(byName.get('USER身份自选')?.uids, ['41', '42']);

    // 3. `通用线` MUST stay `NORMAL`, while `18岁线` & `30岁线` become `IF_LINE`!
    assert.equal(byName.get('通用线')?.suggestedMode, GROUP_MODES.NORMAL);
    assert.deepEqual(byName.get('通用线')?.uids, ['1', '2']);
    assert.equal(byName.get('18岁线')?.suggestedMode, GROUP_MODES.IF_LINE);
    assert.equal(byName.get('30岁线')?.suggestedMode, GROUP_MODES.IF_LINE);
});

test('Emoji-decorated full-book section layers (——🐰🐰...🦊🦊——) preserve exact author layering without banner bloat', () => {
    const layeredPayload = {
        entries: [
            { uid: 100, displayIndex: 1, disable: true, comment: '——🐰🐰背景信息选择🦊🦊——', content: '', key: [] },
            { uid: 101, displayIndex: 2, disable: false, comment: '【常规线背景】名利场', content: 'A', key: [] },
            { uid: 102, displayIndex: 3, disable: true, comment: '【其他背景】二选一', content: 'B', key: [] },
            { uid: 200, displayIndex: 4, disable: false, comment: '——🐰🐰变量信息选择🦊🦊——', content: '', key: [] },
            { uid: 201, displayIndex: 5, disable: false, comment: '【常规变量】阶段设定', content: 'C', key: [] },
            { uid: 202, displayIndex: 6, disable: true, comment: '【分支变量】阶段覆盖', content: 'D', key: [] },
            { uid: 300, displayIndex: 7, disable: false, comment: '——🐰🐰开场白场景选择🦊🦊——', content: '', key: [] },
            { uid: 301, displayIndex: 8, disable: true, comment: '【常规·助理线】', content: 'E', key: [] },
            { uid: 302, displayIndex: 9, disable: true, comment: '【常规·演员线】', content: 'F', key: [] },
        ],
    };

    const summaries = extractWorldbookEntrySummaries(layeredPayload);
    const proposals = detectAutoGroups(summaries, { strategy: 'smart', onlyUngrouped: true });
    assert.equal(proposals.length, 3);
    assert.equal(proposals[0].name, '背景信息选择');
    assert.deepEqual(proposals[0].uids, ['101', '102']);
    assert.equal(proposals[1].name, '变量信息选择');
    assert.deepEqual(proposals[1].uids, ['201', '202']);
    assert.equal(proposals[2].name, '开场白场景选择');
    assert.equal(proposals[2].suggestedMode, GROUP_MODES.RADIO);
    assert.deepEqual(proposals[2].uids, ['301', '302']);
});

test('Overlapping greeting lore presets (shared common lore + distinct route lore) switch cleanly without losing common lore', () => {
    const summaries = extractWorldbookEntrySummaries(createSamplePayload());
    const greetIdx = buildGreetingCoordinationIndex({
        firstMes: '<!-- title: 目录 -->',
        alternateGreetings: [
            '<!-- title: 少年初遇 -->\n<!-- lore: 1, 2, 10, 11 -->\n开场1',
            '<!-- title: 重逢酒会 -->\n<!-- lore: 1, 2, 20, 21 -->\n<!-- exclude: 10 -->\n开场2',
        ],
    });

    const preset2 = computeGreetingPresetPlan(summaries, greetIdx, 2);
    assert.ok(preset2);
    assert.equal(preset2.routeLabel, '#2 重逢酒会');
    // Common lore 1 & 2 stay ENABLED (`disabled = false`), 20 & 21 ENABLED, while 10 & 11 turn OFF (`disabled = true`)!
    assert.equal(preset2.plan.get('1'), false);
    assert.equal(preset2.plan.get('2'), false);
    assert.equal(preset2.plan.get('20'), false);
    assert.equal(preset2.plan.get('21'), false);
    assert.equal(preset2.plan.get('10'), true);
    assert.equal(preset2.plan.get('11'), true);
});

test('IF-line mutex group toggle and scene (NSFW) cooldown work independently', () => {
    const payload = createSamplePayload();
    const summaries = extractWorldbookEntrySummaries(payload);
    const bookCfg = {
        groups: [
            { id: 'g_lore', name: '通用线', mode: GROUP_MODES.NORMAL, collapsed: false },
            { id: 'g_18', name: '18岁线', mode: GROUP_MODES.IF_LINE, collapsed: false },
            { id: 'g_30', name: '30岁线', mode: GROUP_MODES.IF_LINE, collapsed: false },
            { id: 'g_nsfw', name: '亲密剧情 (NSFW)', mode: GROUP_MODES.SCENE, cooldownTurns: 1 },
        ],
        assignments: { 1: 'g_lore', 2: 'g_lore', 10: 'g_18', 11: 'g_18', 20: 'g_30', 21: 'g_30', 30: 'g_nsfw' },
    };

    const plan = computeGroupTogglePlan(summaries, bookCfg, 'g_30', true);
    const res = applyTogglePlanToPayload(payload, plan);
    assert.equal(res.changedCount, 4);
    assert.equal(payload.entries[1].group, 'keep_native_inclusion_group');

    const hitEval = evaluateSceneAutoToggle({
        entries: [{ uid: '30', disabled: true }],
        bookConfig: bookCfg,
        recentText: '他低喘着深吻下来。',
        cooldownByGroupId: {},
    });
    assert.equal(hitEval.togglePlan.get('30'), false);
});

test('Zero chat-history scan + external Tavern Helper script auto-follow + greeting preset lock across saves', async () => {
    clearRuntimeBookSnapshots();
    const diskStore = createSamplePayload();
    const apiCalls = [];

    const saveAMetadata = { variables: { custom_route: { name: '定制脚本A线' } } };
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

    const poisonedChat = new Proxy([], {
        get(target, prop) {
            if (prop === 'length') return 5000;
            if (typeof prop === 'string' && /^\d+$/.test(prop)) {
                throw new Error(`FORBIDDEN: scanned chat floor ${prop}!`);
            }
            return Reflect.get(target, prop);
        },
    });

    let activeChatId = 'save_A';
    let activeChatMetadata = saveAMetadata;
    let activeChatMessages = poisonedChat;

    const origFetch = globalThis.fetch;
    const origST = globalThis.SillyTavern;

    globalThis.SillyTavern = {
        getContext: () => ({
            characterId: 0,
            characters: [{
                avatar: 'hero.png',
                name: '测试角色',
                first_mes: '<!-- title: 目录 -->',
                data: {
                    extensions: { world: '角色主书' },
                    alternate_greetings: [
                        '<!-- title: 18岁篇 -->\n<!-- lore: 1, 2, 10, 11 -->',
                        '<!-- title: 30岁篇 -->\n<!-- lore: 1, 2, 20, 21 -->',
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
        // 1. External Tavern Helper script flips entries in Save A (e.g. turns on 41, turns off 42)
        diskStore.entries[41].disable = false;
        diskStore.entries[42].disable = true;
        assert.equal(extractExternalScriptRouteLabel(saveAMetadata), '定制脚本A线');
        const followed = await captureExternalWorldbookSwitchForActiveChat('角色主书');
        assert.ok(followed);
        assert.equal(saveAMetadata.worldbook_entry_groups.entryDisabledMap['41'], false);

        // 2. Switch to Save B and apply Greeting Preset #2 (`30岁篇`)
        activeChatId = 'save_B';
        activeChatMetadata = saveBMetadata;
        diskStore.entries[41].disable = true;
        diskStore.entries[42].disable = false;
        const greetIdx = buildGreetingCoordinationIndex({
            firstMes: '<!-- title: 目录 -->',
            alternateGreetings: [
                '<!-- title: 18岁篇 -->\n<!-- lore: 1, 2, 10, 11 -->',
                '<!-- title: 30岁篇 -->\n<!-- lore: 1, 2, 20, 21 -->',
            ],
        });
        const presetRes = await applyGreetingPresetToWorldbook('角色主书', greetIdx, 2);
        assert.equal(presetRes.ok, true);
        assert.equal(diskStore.entries[20].disable, false);
        assert.equal(diskStore.entries[10].disable, true);

        // Wait for self-write guard window not needed for `syncWorldbookForActiveChat`!
        // 3. Switch back to 5000-floor Save A -> restores BOTH 18岁线 AND external script's entry 41/42 state with ZERO chat scan!
        activeChatId = 'save_A';
        activeChatMetadata = saveAMetadata;
        activeChatMessages = poisonedChat;
        const restoreA = await syncWorldbookForActiveChat({ reason: 'chat-changed', silentToast: true });
        assert.equal(restoreA.synced, true);
        assert.equal(diskStore.entries[10].disable, false);
        assert.equal(diskStore.entries[20].disable, true);
        assert.equal(diskStore.entries[41].disable, false);
        assert.equal(diskStore.entries[42].disable, true);

        // 4. Mid-save `/weg 30岁线` progression + NSFW pre-generation test
        await switchNamedGroupInActiveChat('30岁线');
        assert.equal(saveAMetadata.worldbook_entry_groups.routeLabel, '30岁线');

        activeChatMessages = [{ is_user: true, mes: '日常买菜' }];
        const idleGen = await syncSceneGroupsBeforeGeneration('normal', false);
        assert.equal(idleGen.changedCount, 0);

        const initRead = await loadWorldbookSummariesUncached('角色主书');
        assert.ok(initRead.ok);
        assert.ok(recordStateIntoActiveChatIfMatching('角色主书', initRead.summaries));
    } finally {
        globalThis.fetch = origFetch;
        globalThis.SillyTavern = origST;
    }
});

test('Radio mode, search, orphan pruning, and wbo rename/delete migrations work cleanly', () => {
    const summaries = extractWorldbookEntrySummaries(createSamplePayload());
    const radioPlan = computeEntryTogglePlan(
        [
            { uid: '41', title: 'A', disabled: false, keys: [] },
            { uid: '42', title: 'B', disabled: true, keys: [] },
        ],
        { groups: [{ id: 'r1', name: '单选', mode: GROUP_MODES.RADIO }], assignments: { 41: 'r1', 42: 'r1' } },
        '42',
        true,
    );
    assert.equal(radioPlan.get('42'), false);
    assert.equal(radioPlan.get('41'), true);
    assert.equal(formatGreetingCommentTag(['11', '10'], 'lore'), '<!-- lore: 10,11 -->');

    const settings = normalizeSettings({
        lastOpenedBook: '旧书',
        books: { 旧书: { groups: [{ id: 'g1', name: '组', mode: 'normal' }], assignments: { 1: 'g1', 999: 'g1' } } },
    });
    assert.equal(pruneOrphanAssignments(settings.books['旧书'], new Set(summaries.map((s) => s.uid))), 1);
    assert.equal(matchEntries(summaries, '18岁 少年', { multiTerm: true }).has('10'), true);
    assert.equal(migrateSettingsOnWorldRename(settings, '旧书', '新书'), true);
    assert.equal(removeDeletedWorldsFromSettings(settings, ['新书']), true);
    assert.equal(applyAutoGroupProposals(null, [{ name: '测试组', uids: ['1'], mode: 'normal' }]).groups.length, 1);
    assert.equal(buildGroupedView(summaries, null).sections[0].id, SPECIAL_GROUP_UNGROUPED);
});
