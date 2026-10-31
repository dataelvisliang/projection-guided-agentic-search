import assert from 'node:assert/strict';
import { tool } from '@openai/agents';
import { SearchSession } from '../src/agent/searchSession';
import { actionSchemas, jsonSchemaFor } from '../src/agent/searchContract';
import type { ActionName } from '../src/agent/searchContract';
import type { ToolCall, ToolResult } from '../src/tools/toolExecutor';

const bounds = { min_x: 0, max_x: 20, min_y: 0, max_y: 20 };
const ring = { min_x: 1, max_x: 2, min_y: 3, max_y: 4 };
for (const name of Object.keys(actionSchemas) as ActionName[]) {
    assert.doesNotThrow(() => tool({ name, description: name, parameters: jsonSchemaFor(name), strict: false, execute: async () => 'fixture' }));
}

class Fixture {
    calls: ToolCall[] = [];
    rings = false;
    intent = 0.9;
    async execute(call: ToolCall): Promise<ToolResult> {
        this.calls.push(call);
        const args = JSON.parse(call.function.arguments);
        if (call.function.name === 'sql_query') {
            return { name: 'sql_query', call_id: call.id, result: { rows: [], candidate_rings: this.rings ? [{ ...ring, support: 12 }] : [] } };
        }
        return { name: call.function.name, call_id: call.id, result: {
            category: 'Pepper Syrah', themes: ['pepper'], summary: 'Pepper shows up in the sample.',
            intent_fit: this.intent, evidence_ids: [7], region: args.region || null, seed_islands: [], candidate_rings: []
        } };
    }
}
const playbook = (s: SearchSession, f: Fixture, playbook_id = 'topic_exploration') => s.act('load_workflow_playbook', { playbook_id }, f);
const sql = (s: SearchSession, f: Fixture, statement = 'SELECT 1 AS n FROM reviews') => s.act('sql_query', { sql: statement, purpose: 'count reviews' }, f);

{
    const s = new SearchSession('peppery syrah', bounds); const f = new Fixture();
    await s.act('sql_query', { sql: 'SELECT 1 AS n FROM reviews', purpose: 'count' }, f);
    assert.equal(f.calls.length, 0);
    assert.match(String((await s.act('map_search', { query: 'syrah', reason: 'seed' }, f) as { error?: string }).error), /load_workflow_playbook/);
}
{
    const s = new SearchSession('peppery syrah', bounds); const f = new Fixture();
    await playbook(s, f); await sql(s, f); await sql(s, f, 'SELECT 2 AS n FROM reviews');
    const blocked = await sql(s, f, 'SELECT 3 AS n FROM reviews') as { error?: string };
    assert.match(blocked.error || '', /two SQL/);
    assert.equal(f.calls.length, 2);
}
{
    const s = new SearchSession('peppery syrah', bounds); const f = new Fixture();
    f.rings = true; await playbook(s, f); await sql(s, f);
    const blocked = await sql(s, f, 'SELECT 2 AS n FROM reviews') as { error?: string };
    assert.match(blocked.error || '', /region-constrained flexible_search/);
    await s.act('flexible_search', { prompt: 'peppery syrah', query: 'pepper syrah', region: ring, reason: 'judge the ring' }, f);
    assert.equal(s.modelState().judgments[0].intent_fit_label, 'high');
    await s.act('complete_answer', { ready_to_answer: true, suggested_followups: [], categories: ['Pepper Syrah'], bounded: false, explanation: 'Peppered Syrah forms a coherent ring.' }, f);
    assert.equal(s.terminal?.state, 'success');
    assert.match(s.answer(), /\{\{Pepper Syrah\}\}/);
    const calls = f.calls.length;
    await sql(s, f, 'SELECT 9 AS n FROM reviews');
    assert.equal(f.calls.length, calls, 'terminal state is absorbing');
}
{
    const s = new SearchSession('peppery syrah', bounds); const f = new Fixture();
    await playbook(s, f); await sql(s, f);
    const repeated = await sql(s, f) as { error?: string };
    assert.match(repeated.error || '', /search shape/);
}
{
    const s = new SearchSession('peppery syrah', bounds); const f = new Fixture();
    f.intent = 0.4; await playbook(s, f);
    await s.act('flexible_search', { prompt: 'peppery syrah', query: 'pepper', reason: 'judge a focused reading' }, f);
    const blocked = await s.act('complete_answer', { ready_to_answer: true, suggested_followups: [], categories: ['Pepper Syrah'], bounded: true, explanation: 'The sample is off intent.' }, f) as { error?: string };
    assert.match(blocked.error || '', /low intent_fit/);
}
{
    const s = new SearchSession('peppery syrah', bounds); const f = new Fixture();
    f.intent = 0.6; await playbook(s, f);
    await s.act('flexible_search', { prompt: 'peppery syrah', query: 'pepper', reason: 'judge a focused reading' }, f);
    const blocked = await s.act('complete_answer', { ready_to_answer: true, suggested_followups: [], categories: ['Pepper Syrah'], bounded: false, explanation: 'Medium evidence.' }, f) as { error?: string };
    assert.match(blocked.error || '', /bounded/);
    await s.act('complete_answer', { ready_to_answer: true, suggested_followups: [{ kind: 'investigate', text: 'Look at a neighboring ring.' }], categories: ['Pepper Syrah'], bounded: true, explanation: 'The ring is only a partial match.' }, f);
    assert.equal(s.terminal?.state, 'partial_success');
}
{
    const s = new SearchSession('which country separates pepper', bounds); const f = new Fixture();
    await playbook(s, f, 'dimension_signal_scan');
    for (let i = 0; i < 4; i++) await sql(s, f, `SELECT ${i} AS n FROM reviews`);
    const stopped = await sql(s, f, 'SELECT 9 AS n FROM reviews') as { stop_condition_met?: boolean };
    assert.equal(stopped.stop_condition_met, true);
    assert.equal(f.calls.length, 4);
}
{
    const s = new SearchSession('how many peppery wines', bounds); const f = new Fixture();
    await playbook(s, f, 'semantic_count');
    const blocked = await sql(s, f) as { error?: string };
    assert.match(blocked.error || '', /forbids SQL/);
}
{
    const s = new SearchSession('peppery syrah', bounds); const f = new Fixture();
    await playbook(s, f);
    const blocked = await s.act('sql_query', { sql: 'DELETE FROM reviews', purpose: 'remove' }, f) as { error?: string };
    assert.match(blocked.error || '', /SELECT or WITH|forbidden/i);
    const binned = await s.act('sql_query', { sql: 'SELECT FLOOR(projection_x / 48) AS gx FROM reviews', purpose: 'bad bins' }, f) as { error?: string };
    assert.match(binned.error || '', /injected projection bounds/);
}
{
    let now = 0; const s = new SearchSession('query', bounds, {}, () => now); const f = new Fixture();
    now = 120001; await playbook(s, f);
    assert.equal(s.terminal?.state, 'budget_exhausted');
    assert.equal(f.calls.length, 0);
}
{
    const s = new SearchSession('query', bounds);
    s.seedOracleTask();
    assert.equal(s.terminal?.state, 'unsupported');
}
console.log('search contract: topic ring probe invariants passed');
