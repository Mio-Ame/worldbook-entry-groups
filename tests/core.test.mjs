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
    matchEntries,
    migrateSettingsOnWorldRename,
    normalizeSettings,
    pruneOrphanAssignments,
    removeDeletedWorldsFromSettings,
} from '../src/core.js';
import {
    applyWorldbookTogglePlan,
    loadWorldbookSummariesUncached,
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
                comment: '[IF1·青梅线] 童年约定',
                key: ['青梅'],
                content: '青梅线设定 1',
                disable: false,
                displayIndex: 3,
            },
            11: {
                uid: 11,
                comment: '[IF1·青梅线] 同桌日常',
                key: ['教室'],
                content: '青梅线设定 2',
                disable: false,
                displayIndex: 4,
            },
            20: {
                uid: 20,
                comment: '[IF2·宿敌线] 边境交锋',
                key: ['战场'],
                content: '宿敌线设定 1',
                disable: true,
                displayIndex: 5,
            },
            21: {
                uid: 21,
                comment: '[IF2·宿敌线] 停战谈判',
                key: ['议和'],
                content: '宿敌线设定 2',
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
    // Heavy `content` must not remain attached to lightweight summaries
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
            { id: 'g_if1', name: 'IF1·青梅线', mode: GROUP_MODES.IF_LINE, collapsed: false },
            { id: 'g_if2', name: 'IF2·宿敌线', mode: GROUP_MODES.IF_LINE, collapsed: false },
        ],
        assignments: {
            1: 'g_lore',
            2: 'g_lore',
            10: 'g_if1',
            11: 'g_if1',
            20: 'g_if2',
            21: 'g_if2',
        },
    };

    // Enable IF2 -> should enable 20, 21 AND automatically disable 10, 11 while leaving 1, 2 untouched!
    const plan = computeGroupTogglePlan(summaries, bookCfg, 'g_if2', true);
    assert.equal(plan.get('20'), false);
    assert.equal(plan.get('21'), false);
    assert.equal(plan.get('10'), true);
    assert.equal(plan.get('11'), true);
    assert.equal(plan.has('1'), false);

    const res = applyTogglePlanToPayload(payload, plan);
    assert.equal(res.changedCount, 4);
    assert.equal(payload.entries[10].disable, true);
    assert.equal(payload.entries[20].disable, false);
    // Zero pollution check: comment and native `group` field remain 100% untouched
    assert.equal(payload.entries[1].group, 'keep_native_inclusion_group');
    assert.equal(payload.entries[10].comment, '[IF1·青梅线] 童年约定');
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
        swipes: [
            '<!-- title: 目录页 -->\n欢迎选择开场白',
            '<!-- title: 青梅竹马篇 -->\n<!-- lore: 10, 11 -->\n<!-- exclude: 2 -->\n开场白正文 1',
            '<!-- title：宿敌重逢篇 -->\n<!-- lore：20，21 -->\n开场白正文 2',
        ],
        currentSwipeId: 1,
    });

    assert.equal(greetIndex.hasManagedEntries, true);
    assert.equal(greetIndex.activeGreeting?.title, '青梅竹马篇');
    assert.deepEqual(greetIndex.byUid.get('10')?.includeGreetings.map((g) => g.swipeIndex), [1]);
    assert.deepEqual(greetIndex.byUid.get('2')?.excludeGreetings.map((g) => g.swipeIndex), [1]);

    const proposals = detectAutoGroups(summaries, {
        strategy: 'greeting',
        onlyUngrouped: true,
        greetingIndex: greetIndex,
    });
    assert.equal(proposals.length, 2);
    assert.equal(proposals[0].name, 'IF · 青梅竹马篇');
    assert.equal(proposals[0].suggestedMode, GROUP_MODES.IF_LINE);
    assert.deepEqual(proposals[0].uids, ['10', '11']);

    assert.equal(formatGreetingCommentTag(['21', '10', '10'], 'lore'), '<!-- lore: 10,21 -->');
});

test('Prefix and divider auto-detect work cleanly and respect existing assignments', () => {
    const summaries = extractWorldbookEntrySummaries(createSamplePayload());
    const prefixProposals = detectAutoGroups(summaries, {
        strategy: 'prefix',
        onlyUngrouped: true,
        existingAssignments: { 1: 'existing_grp', 2: 'existing_grp' },
    });

    assert.equal(prefixProposals.length, 2);
    assert.equal(prefixProposals[0].name, 'IF1·青梅线');
    assert.equal(prefixProposals[0].suggestedMode, GROUP_MODES.IF_LINE);
    assert.equal(prefixProposals[1].name, 'IF2·宿敌线');

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
    });

    // Orphan check before and after pruning
    const viewBefore = buildGroupedView(summaries, settings.books['旧世界书']);
    assert.equal(viewBefore.sections[0].totalCount, 1);
    assert.equal(viewBefore.orphanCount, 1);

    const removed = pruneOrphanAssignments(settings.books['旧世界书'], new Set(summaries.map((s) => s.uid)));
    assert.equal(removed, 1);
    assert.equal('999' in settings.books['旧世界书'].assignments, false);

    // Search phrase vs multi-term
    const singlePhraseHits = matchEntries(summaries, 'IF1 童年', { multiTerm: false });
    assert.equal(singlePhraseHits.size, 0);
    const multiTermHits = matchEntries(summaries, 'IF1 童年', { multiTerm: true });
    assert.deepEqual([...multiTermHits], ['10']);

    // Cross-plugin rename & delete
    assert.equal(migrateSettingsOnWorldRename(settings, '旧世界书', '新世界书'), true);
    assert.equal(settings.lastOpenedBook, '新世界书');
    assert.equal('旧世界书' in settings.books, false);
    assert.equal(settings.books['新世界书'].groups[0].name, '世界观');

    assert.equal(removeDeletedWorldsFromSettings(settings, ['新世界书']), true);
    assert.equal(settings.lastOpenedBook, '');
    assert.equal('新世界书' in settings.books, false);
    assert.equal(viewBefore.sections.at(-1)?.id, SPECIAL_GROUP_UNGROUPED);
});

test('Host adapter performs uncached read and exactly 1 disk write for multi-entry IF switch', async () => {
    const diskStore = createSamplePayload();
    const apiCalls = [];

    const origFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
        const body = JSON.parse(init.body);
        apiCalls.push({ url, name: body.name });
        if (url === '/api/worldinfo/get') {
            return {
                ok: true,
                status: 200,
                json: async () => structuredClone(diskStore),
            };
        }
        if (url === '/api/worldinfo/edit') {
            Object.assign(diskStore, structuredClone(body.data));
            return { ok: true, status: 200, json: async () => ({ ok: true }) };
        }
        throw new Error(`Unexpected URL: ${url}`);
    };

    try {
        const readRes = await loadWorldbookSummariesUncached('测试角色书');
        assert.equal(readRes.ok, true);
        assert.equal(readRes.summaries.length, 7);
        assert.deepEqual(apiCalls, [{ url: '/api/worldinfo/get', name: '测试角色书' }]);

        apiCalls.length = 0;
        const togglePlan = new Map([
            ['10', true],
            ['11', true],
            ['20', false],
            ['21', false],
        ]);
        const writeRes = await applyWorldbookTogglePlan('测试角色书', togglePlan);
        assert.equal(writeRes.ok, true);
        assert.equal(writeRes.changedCount, 4);
        // Exactly 1 fresh read + 1 single disk write for 4 toggled entries!
        assert.deepEqual(apiCalls, [
            { url: '/api/worldinfo/get', name: '测试角色书' },
            { url: '/api/worldinfo/edit', name: '测试角色书' },
        ]);
        assert.equal(diskStore.entries[10].disable, true);
        assert.equal(diskStore.entries[20].disable, false);
    } finally {
        globalThis.fetch = origFetch;
    }
});
