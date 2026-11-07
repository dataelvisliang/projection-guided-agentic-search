import assert from 'node:assert/strict';
import test from 'node:test';
import { tool } from '@openai/agents';
import { SearchSession } from '../src/agent/searchSession';
import { actionSchemas, jsonSchemaFor } from '../src/agent/searchContract';
import type { ActionName, PlaybookId } from '../src/agent/searchContract';
import type { ToolCall, ToolResult } from '../src/tools/toolExecutor';

const bounds = { min_x: 0, max_x: 20, min_y: 0, max_y: 20 };
const ring = { min_x: 1, max_x: 2, min_y: 3, max_y: 4 };
const sibling = { min_x: 5, max_x: 6, min_y: 7, max_y: 8 };
class Fixture {
    calls: ToolCall[] = [];
    rings: Array<typeof ring & { support: number }> = [];
    intent = 0.9;
    extra: Record<string, unknown> = {};
    evidence = [7];
    async execute(call: ToolCall): Promise<ToolResult> {
        this.calls.push(call);
        const args = JSON.parse(call.function.arguments);
        return { name: call.function.name, call_id: call.id, result: call.function.name === 'sql_query'
            ? { rows: [{ n: 8 }], candidate_rings: this.rings }
            : { category: 'Pepper Syrah', themes: ['pepper'], summary: 'Pepper appears in these reviews.',
                intent_fit: this.intent, evidence_ids: this.evidence, region: args.region || null, seed_islands: [],
                sample_count: 10, scope_count: 12, coherence: 'coherent', ...this.extra } };
    }
}
const load = (s: SearchSession, f: Fixture, playbook_id: PlaybookId = 'topic_exploration') => s.act('load_workflow_playbook', { playbook_id }, f);
const sql = (s: SearchSession, f: Fixture, value = 1) => s.act('sql_query', { sql: `SELECT ${value} AS n FROM reviews`, purpose: 'structured count' }, f);
const judge = (s: SearchSession, f: Fixture, region: typeof ring | undefined = ring, query = 'pepper') => s.act('flexible_search', { prompt: 'peppery wine', query, region, reason: 'check the sample' }, f);
const finish = (s: SearchSession, f: Fixture, patch: Record<string, unknown> = {}) => s.act('complete_answer', {
    ready_to_answer: true, suggested_followups: [], categories: ['Pepper Syrah'], bounded: false,
    explanation: 'Pepper is a recurring flavor in these reviews.', ...patch
}, f);
const error = (value: unknown) => String((value as { error?: string }).error || '');

test('all tool schemas are accepted by the SDK', () => {
    for (const name of Object.keys(actionSchemas) as ActionName[])
        assert.doesNotThrow(() => tool({ name, description: name, parameters: jsonSchemaFor(name), strict: false, execute: async () => 'fixture' }));
});
test('playbook is first and alone, completion waits for a separate model turn', async () => {
    const s = new SearchSession('pepper', bounds), f = new Fixture();
    assert.match(error(await sql(s, f)), /load_workflow_playbook/);
    s.observeModelRequest(1); await load(s, f);
    assert.match(error(await judge(s, f)), /only tool/);
    s.observeModelRequest(2); await judge(s, f);
    assert.match(error(await finish(s, f)), /only non-progress/);
    s.observeModelRequest(3); await finish(s, f);
    assert.equal(s.terminal?.state, 'success');
});
test('two SQL calls per assistant turn; next model turn resets count', async () => {
    const s = new SearchSession('pepper', bounds), f = new Fixture(); await load(s, f);
    await sql(s, f, 1); await sql(s, f, 2);
    assert.match(error(await sql(s, f, 3)), /two SQL/);
    s.observeModelRequest(1); await sql(s, f, 3);
    assert.equal(f.calls.length, 3);
});
test('new viable rings force a judge, but siblings do not deadlock refinement', async () => {
    const s = new SearchSession('pepper', bounds), f = new Fixture(); await load(s, f);
    f.rings = [{ ...ring, support: 12 }, { ...sibling, support: 8 }]; await sql(s, f);
    assert.match(error(await sql(s, f, 2)), /region-constrained/);
    await judge(s, f);
    f.rings = []; await sql(s, f, 3);
    assert.equal(f.calls.length, 3);
    assert.match(error(await finish(s, f)), /frontier/);
    await finish(s, f, { bounded: true });
    assert.equal(s.terminal?.state, 'partial_success');
});
test('mixed can refine once; weak and off-intent can move away from pending rings', async () => {
    for (const transition of ['mixed', 'weak', 'off_intent']) {
        const s = new SearchSession('pepper', bounds), f = new Fixture(); await load(s, f);
        f.rings = [{ ...ring, support: 12 }]; await sql(s, f);
        assert.equal(error(await s.act('transition_ring', { region: ring, transition, reason: 'sample is mixed' }, f)), '');
        f.rings = []; await sql(s, f, 2);
        assert.equal(f.calls.length, 2);
        if (transition === 'mixed') assert.match(error(await s.act('transition_ring', { region: ring, transition, reason: 'again' }, f)), /only once/);
    }
});
test('regionless, low, fallback, empty and incoherent judgments cannot support topic answers', async () => {
    for (const variant of ['regionless', 'low', 'fallback', 'empty', 'incoherent', 'no_support']) {
        const s = new SearchSession('pepper', bounds), f = new Fixture(); await load(s, f);
        if (variant === 'low') f.intent = 0.4;
        if (variant === 'fallback') f.extra.fallback = true;
        if (variant === 'empty') f.evidence = [];
        if (variant === 'incoherent') f.extra.coherence = 'low';
        if (variant === 'no_support') f.extra.scope_count = 0;
        await judge(s, f, variant === 'regionless' ? undefined : ring);
        // Explicit undefined takes the default argument; use the tool directly for discovery.
        if (variant === 'regionless') {
            const fresh = new SearchSession('pepper', bounds); await load(fresh, f);
            await fresh.act('flexible_search', { prompt: 'pepper', query: 'pepper', reason: 'discover islands' }, f);
            assert.match(error(await finish(fresh, f, { bounded: true })), /eligible/);
        } else assert.match(error(await finish(s, f, { bounded: true })), /eligible/, variant);
    }
});
test('a high fit cannot override coverage warnings', async () => {
    const s = new SearchSession('all themes', bounds), f = new Fixture(); await load(s, f);
    f.extra.coverage_warning = { requires_expansion_for_broad_scope: true };
    await judge(s, f);
    assert.match(error(await finish(s, f)), /Coverage/);
    await finish(s, f, { bounded: true });
    assert.equal(s.terminal?.state, 'partial_success');
    assert.match(s.answer(), /below 100/);
});
test('medium fit requires bounded language; rejected completion does not save cards', async () => {
    const s = new SearchSession('pepper', bounds), f = new Fixture(); await load(s, f); f.intent = 0.6;
    await judge(s, f); assert.match(error(await finish(s, f)), /bounded/);
    s.end('budget_exhausted', 'limit'); assert.deepEqual(s.presentation(), []);
});
test('exact SQL and direct rows use independent evidence paths', async () => {
    for (const playbook of ['exact_analytics', 'row_examples'] as const) {
        const s = new SearchSession('count reviews', bounds), f = new Fixture(); await load(s, f, playbook); await sql(s, f);
        await finish(s, f, { categories: [], evidence_kind: playbook === 'exact_analytics' ? 'exact_sql' : 'row_examples', result_set_ids: ['set-1'] });
        assert.equal(s.terminal?.state, 'success'); assert.doesNotMatch(s.answer(), /No accepted ring/);
    }
});
test('semantic SQL cannot run before observed evidence and proxy completion stays bounded', async () => {
    const s = new SearchSession('how many peppery wines', bounds), f = new Fixture(); await load(s, f, 'semantic_count');
    assert.match(error(await sql(s, f)), /forbids SQL/);
    await judge(s, f);
    await s.act('sql_query', { sql: "SELECT COUNT(*) AS n FROM reviews WHERE description ILIKE '%pepper%'", purpose: 'literal proxy count of pepper' }, f);
    assert.equal(f.calls.length, 2);
    await finish(s, f, { categories: [], evidence_kind: 'literal_proxy', result_set_ids: ['set-2'], bounded: true });
    assert.equal(s.terminal?.state, 'partial_success');
});
test('dimension budget works across model turns and stops at four SQL calls', async () => {
    const s = new SearchSession('dimension', bounds), f = new Fixture(); await load(s, f, 'dimension_signal_scan');
    for (let i = 0; i < 4; i++) { s.observeModelRequest(i + 1); await sql(s, f, i); }
    assert.equal((await sql(s, f, 9) as { stop_condition_met: boolean }).stop_condition_met, true);
    assert.equal(f.calls.length, 4);
});
test('changing only the prompt cannot bypass repeat protection', async () => {
    const s = new SearchSession('pepper', bounds), f = new Fixture(); await load(s, f); await judge(s, f);
    assert.match(error(await s.act('flexible_search', { prompt: 'a different explanation', query: 'pepper', region: ring, reason: 'retry' }, f)), /search shape/);
});
test('third refinement receives its judge before retrieval stops', async () => {
    const s = new SearchSession('pepper', bounds), f = new Fixture(); await load(s, f); await judge(s, f);
    for (let i = 0; i < 3; i++) {
        f.evidence = [10 + i]; await judge(s, f, { ...ring, min_x: 1 + i / 10 }, `pepper ${i}`);
    }
    assert.equal(s.snapshot().refinements_used, 3);
    assert.equal(s.snapshot().must_stop_searching, true);
    assert.equal(f.calls.length, 4);
});
test('historical ledger is navigation only and scoped to the same data selection', async () => {
    const s = new SearchSession('pepper', bounds), f = new Fixture(); await load(s, f); await judge(s, f);
    const context = s.context();
    const next = new SearchSession('pepper', bounds); next.setContext(context, 'full-map'); await load(next, f);
    assert.equal(next.judgments.length, 0);
    assert.match(error(await judge(next, f)), /already accepted/);
    const changed = new SearchSession('pepper', bounds); changed.setContext(context, 'different-selection'); await load(changed, f);
    assert.equal(error(await judge(changed, f)), '');
});
test('budgets and terminal states prevent later execution', async () => {
    let now = 0; const s = new SearchSession('pepper', bounds, {}, () => now), f = new Fixture();
    now = 120001; await load(s, f); assert.equal(s.terminal?.state, 'budget_exhausted'); await sql(s, f); assert.equal(f.calls.length, 0);
    const t = new SearchSession('pepper', bounds); t.recordTokens(80000); await load(t, f); assert.equal(t.terminal?.state, 'budget_exhausted');
});

test('workspace scopes use current direct ids and reject nonexistent or aggregate-only sets', async () => {
    const s = new SearchSession('pepper', bounds), f = new Fixture(); await load(s, f); await judge(s, f);
    assert.match(error(await s.act('map_search', { query: 'beef', workspace_set_id: 'missing', reason: 'scope' }, f)), /successful result/);
    await s.act('map_search', { query: 'beef', workspace_set_id: 'set-1', reason: 'scope' }, f);
    assert.deepEqual(JSON.parse(f.calls.at(-1)!.function.arguments).workspace_ids, [7]);
    const t = new SearchSession('count', bounds), g = new Fixture(); await load(t, g, 'exact_analytics'); await sql(t, g);
    assert.match(error(await t.act('map_search', { query: 'pepper', workspace_set_id: 'set-1', reason: 'scope' }, g)), /no row ids/);
});
test('isolated relevant rows can survive rejection of the surrounding ring', async () => {
    const s = new SearchSession('pepper', bounds), f = new Fixture(); await load(s, f); f.intent = 0.4;
    f.extra.rows = [{ id: 7, excerpt: 'pepper' }]; await judge(s, f);
    await finish(s, f, { categories: [], evidence_kind: 'row_examples', result_set_ids: ['set-1'], bounded: true });
    assert.equal(s.terminal?.state, 'partial_success'); assert.deepEqual(s.presentation(), []);
});
test('explanation cannot inject unvalidated category cards', async () => {
    const s = new SearchSession('pepper', bounds), f = new Fixture(); await load(s, f); await judge(s, f);
    assert.match(error(await finish(s, f, { explanation: '{{Invented Category}}' })), /card tokens/);
});
test('new relevant evidence resets consecutive non-improving judgments', async () => {
    const s = new SearchSession('pepper', bounds), f = new Fixture(); await load(s, f); await judge(s, f);
    await judge(s, f, sibling, 'oak'); assert.equal(s.snapshot().non_improving_searches, 1);
    f.evidence = [8]; await judge(s, f, { ...sibling, max_x: 7 }, 'beef');
    assert.equal(s.snapshot().non_improving_searches, 0); assert.equal(s.snapshot().must_stop_searching, false);
});
