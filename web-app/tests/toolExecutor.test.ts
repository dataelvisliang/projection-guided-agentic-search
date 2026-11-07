import assert from 'node:assert/strict';
import { ToolExecutor } from '../src/tools/toolExecutor';

class FixtureCoordinator {
    sql: string[] = [];
    async query(sql: string) {
        this.sql.push(sql);
        const review = { __row_index__: 42, description: 'pepper and beef', title: 'Fixture', points: 90, price: 20, variety: 'Syrah', country: 'France', projection_x: 1, projection_y: 1 };
        if (sql.includes('AS lexical_score') || sql.includes('__row_index__ IN')) return { toArray: () => [review] };
        if (sql.includes('__row_index__ AS id')) return { toArray: () => [{ id: 42 }] };
        if (sql.includes('GROUP BY gx')) return { toArray: () => [{ gx: 1, gy: 2, support: 4, min_x: 0.2, max_x: 0.8, min_y: 0.2, max_y: 0.8, sample_id: 42 }] };
        if (sql.includes('AS cells')) return { toArray: () => [{ cells: 20 }] };
        if (sql.includes('AS scope_count')) return { toArray: () => [{ scope_count: 12 }] };
        if (sql.includes('AS matches')) return { toArray: () => [{ matches: 1 }] };
        if (sql.includes('topic_sql')) return { toArray: () => [{ cnt: 8, min_x: 0, max_x: 1, min_y: 0, max_y: 1 }] };
        return { toArray: () => [] };
    }
}

const bounds = { min_x: 0, max_x: 10, min_y: 0, max_y: 10 };
const coordinator = new FixtureCoordinator();
const executor = new ToolExecutor(coordinator, { analyzerUrl: 'http://fixture/analyzer' });
const blocked = await executor.execute({ id: 'bad-sql', type: 'function', function: { name: 'sql_query', arguments: JSON.stringify({ sql: 'DELETE FROM reviews' }) } });
assert.match(blocked.error || '', /SELECT or WITH/);
const grid = await executor.execute({ id: 'grid', type: 'function', function: { name: 'sql_query', arguments: JSON.stringify({ sql: 'SELECT COUNT(*) AS cnt, MIN(projection_x) AS min_x, MAX(projection_x) AS max_x, MIN(projection_y) AS min_y, MAX(projection_y) AS max_y FROM reviews' }) } });
assert.equal(grid.result.candidate_rings.length, 1);
assert.match(coordinator.sql.at(-1) || '', /LIMIT 1000/);

const originalFetch = globalThis.fetch;
globalThis.fetch = async () => new Response(JSON.stringify({
    coherence: 'coherent', category: 'Pepper Syrah', themes: ['pepper'], summary: 'Pepper in the sample.', intent_fit: 0.91,
    intent_fit_label: 'high', off_intent_signals: [], refinement_suggestion: '', representative_evidence_ids: [42], metadata_insights: {}
}), { status: 200, headers: { 'Content-Type': 'application/json' } });
try {
    const found = await executor.execute({ id: 'search', type: 'function', function: { name: 'map_search', arguments: JSON.stringify({ query: 'pepper & beef', bounds, reason: 'seed' }) } });
    assert.equal(found.error, undefined);
    assert.equal(found.result.rows[0].id, 42);
    assert.ok(coordinator.sql.some(sql => sql.includes('pepper and beef')), 'SQL normalization folds & the same way as JS');
    assert.equal(found.result.seed_islands.length, 1);
    const judged = await executor.execute({ id: 'judge', type: 'function', function: { name: 'flexible_search', arguments: JSON.stringify({ prompt: 'peppery syrah', query: 'pepper', region: { min_x: 0, max_x: 2, min_y: 0, max_y: 2 }, bounds }) } });
    assert.equal(judged.result.intent_fit, 0.91);
    assert.deepEqual(judged.result.evidence_ids, [42]);
} finally { globalThis.fetch = originalFetch; }

console.log('toolExecutor tests passed');
