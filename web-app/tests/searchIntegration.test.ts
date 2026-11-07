import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import * as duckdb from '@duckdb/duckdb-wasm/blocking';
import { scopeCoordinator } from '../api/searchScope';
import { ToolExecutor } from '../src/tools/toolExecutor';
import { SearchSession } from '../src/agent/searchSession';
import { normalizedColumnSql, normalizeSearchText, prepareTopicSql } from '../src/tools/mapSearch';
import { extractHighlightIds } from '../src/hooks/useAgentChat';

const require = createRequire(import.meta.url);
const db = await duckdb.createDuckDB({ mvp: {
    mainModule: require.resolve('@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm'),
    mainWorker: require.resolve('@duckdb/duckdb-wasm/dist/duckdb-node-mvp.worker.cjs')
} }, new duckdb.VoidLogger(), duckdb.NODE_RUNTIME);
await db.instantiate();
const connection = db.connect();
connection.query(`CREATE TABLE reviews AS SELECT * FROM (VALUES
    (1, 'Pepper & Beef''s', 'A', 92, 18, 'Syrah', 'France', 1.0, 1.0),
    (2, 'pepper and beef', 'B', 89, 15, 'Syrah', 'France', 1.01, 1.01),
    (3, 'pepper oak', 'C', 87, 12, 'Syrah', 'France', 1.03, 1.03),
    (4, 'apple pear', 'D', 90, 22, 'Chardonnay', 'USA', 8.0, 8.0),
    (5, 'pepper beef outside', 'E', 95, 40, 'Syrah', 'USA', 0.99, 0.99)
) AS t(__row_index__, description, title, points, price, variety, country, projection_x, projection_y)`);
const base = { async query(sql: string) { return connection.query(sql); } };
const bounds = { min_x: 0, max_x: 10, min_y: 0, max_y: 10 };
const ring = { min_x: 1, max_x: 2, min_y: 1, max_y: 2 };

test('real DuckDB: JS/SQL normalization and aggregate ID injection agree', () => {
    const text = 'Pepper & Beef’s';
    const normalized = connection.query(`SELECT ${normalizedColumnSql("'" + text + "'")} AS text`).toArray()[0].text;
    assert.equal(normalized, normalizeSearchText(text));
    const rows = connection.query(prepareTopicSql('SELECT COUNT(*) AS n FROM reviews')).toArray();
    assert.equal(Number(rows[0].n), 5);
    assert.equal(Number(connection.query(prepareTopicSql('SELECT description FROM reviews LIMIT 1')).toArray()[0].__row_index__), 1);
    assert.doesNotThrow(() => connection.query(prepareTopicSql('WITH subset AS (SELECT * FROM reviews) SELECT COUNT(*) AS n FROM subset')));
});
test('selection scopes SQL, recall, islands and neighbors without mutating the base relation', async () => {
    const scoped = scopeCoordinator(base, [1, 2, 3]);
    const executor = new ToolExecutor(scoped.coordinator);
    const count = await executor.execute({ id: 'count', type: 'function', function: { name: 'sql_query', arguments: JSON.stringify({ sql: 'SELECT COUNT(*) AS n FROM reviews' }) } });
    assert.equal(count.error, undefined); assert.equal(count.result.rows[0].n, 3);
    const found = await executor.execute({ id: 'find', type: 'function', function: { name: 'map_search', arguments: JSON.stringify({ query: 'pepper', bounds, expand_clusters: true }) } });
    assert.equal(found.error, undefined);
    assert.ok(found.result.rows.every((r: { id: number }) => [1, 2, 3].includes(r.id)));
    assert.ok(found.result.expanded_rows.every((r: { id: number }) => [1, 2, 3].includes(r.id)));
    assert.equal(found.result.scope_count, 3);
    assert.equal(Number((await base.query('SELECT COUNT(*) AS n FROM reviews')).toArray()[0].n), 5);
    const empty = scopeCoordinator(base, []);
    assert.equal(Number((await empty.coordinator.query('SELECT COUNT(*) AS n FROM reviews')).toArray()[0].n), 0);
    assert.equal(scopeCoordinator(base, [3, 1, 2]).scopeKey, scoped.scopeKey);
});
test('full pipeline keeps region neighbors bounded and publishes only direct relevant evidence', async () => {
    const originalFetch = globalThis.fetch;
    let analyzerIds: number[] = [];
    globalThis.fetch = async (_input, init) => {
        const body = JSON.parse(String(init?.body));
        analyzerIds = body.reviews.map((r: { id: number }) => r.id);
        return new Response(JSON.stringify({ category: 'Pepper Syrah', themes: ['pepper'], summary: 'Pepper in this sample.', intent_fit: 0.9, coherence: 'coherent', representative_evidence_ids: [1, 2, 999] }), { status: 200 });
    };
    try {
        const executor = new ToolExecutor(base, { analyzerUrl: 'http://fixture/analyzer' });
        const session = new SearchSession('peppery wines', bounds);
        await session.act('load_workflow_playbook', { playbook_id: 'topic_exploration' }, executor);
        const judged = await session.act('flexible_search', { prompt: 'peppery wines', query: 'pepper', region: ring, reason: 'check region' }, executor) as { result: Record<string, unknown> };
        assert.ok(analyzerIds.length > 0); assert.ok(analyzerIds.every(id => [1, 2, 3].includes(id)));
        assert.deepEqual(judged.result.evidence_ids, [1, 2]);
        await session.act('complete_answer', { ready_to_answer: true, suggested_followups: [], categories: ['Pepper Syrah'], bounded: false, explanation: 'Pepper recurs in the sampled reviews.' }, executor);
        assert.equal(session.terminal?.state, 'success');
        assert.deepEqual(session.presentation()[0].result.record_ids, [1, 2]);
    } finally { globalThis.fetch = originalFetch; }
});
test('AND mode has consistent retrieval and count semantics', async () => {
    const result = await new ToolExecutor(base).execute({ id: 'and', type: 'function', function: { name: 'map_search', arguments: JSON.stringify({ query: 'pepper', terms: ['beef'], match_mode: 'AND', bounds }) } });
    assert.equal(result.error, undefined); assert.equal(result.result.lexical_match_count, 3);
    assert.deepEqual(result.result.rows.map((r: { id: number }) => r.id).sort(), [1, 2, 5]);
});
test('UI highlights exclude neighbor context and failed calls', () => {
    assert.deepEqual(extractHighlightIds([
        { name: 'flexible_search', call_id: 'a', result: { rows: [{ id: 1 }, { id: 99 }], evidence_ids: [1] } },
        { name: 'map_search', call_id: 'b', result: { rows: [{ id: 2, match_type: 'direct' }, { id: 98, match_type: 'cluster_neighbor' }] } },
        { name: 'sql_query', call_id: 'c', error: 'failed', result: { rows: [{ id: 97 }] } }
    ]), [1, 2]);
});

test('workspace execution intersects the request selection', async () => {
    const { createScopedExecutor } = await import('../api/searchScope');
    const executor = createScopedExecutor(base, [1, 2]);
    const counted = await executor.execute({ id: 'workspace', type: 'function', function: { name: 'sql_query', arguments: JSON.stringify({ sql: 'SELECT COUNT(*) AS n FROM reviews', workspace_ids: [2, 4, 5] }) } });
    assert.equal(counted.error, undefined); assert.equal(counted.result.rows[0].n, 1);
});

test('Agents SDK completes exact analytics with real tools and no Analyzer', async () => {
    const { runProjectionAgent } = await import('../api/agentRuntime');
    const originalFetch = globalThis.fetch;
    const originalKey = process.env.OPENROUTER_API_KEY;
    process.env.OPENROUTER_API_KEY = 'fixture-key';
    let calls = 0;
    const steps = [
        ['load_workflow_playbook', { playbook_id: 'exact_analytics' }],
        ['sql_query', { sql: 'SELECT COUNT(*) AS n FROM reviews', purpose: 'count selected reviews' }],
        ['complete_answer', { ready_to_answer: true, suggested_followups: [], categories: [], evidence_kind: 'exact_sql', result_set_ids: ['set-1'], bounded: false, explanation: 'There are 2 selected reviews.' }]
    ] as const;
    globalThis.fetch = async (input) => {
        assert.match(String(input), /openrouter/);
        const [name, args] = steps[calls++];
        return new Response(JSON.stringify({ id: `chatcmpl-${calls}`, object: 'chat.completion', created: 1, model: 'anthropic/claude-haiku-5.5', choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [{ id: `tool-${calls}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    try {
        const result = await runProjectionAgent({ messages: [{ role: 'user', content: 'How many selected reviews?' }], context: { selection_ids: [1, 2], probed_regions: [] }, origin: 'http://fixture', sourceCoordinator: base });
        assert.equal(result.terminal.state, 'success', JSON.stringify(result.searchPolicy.trajectory));
        assert.equal(result.toolResults[0].result.rows[0].n, 2);
        assert.equal(calls, 3); assert.equal(result.usage.agent_tokens, 45); assert.equal(result.usage.analyzer_tokens, 0);
    } finally {
        globalThis.fetch = originalFetch;
        if (originalKey === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = originalKey;
    }
});
