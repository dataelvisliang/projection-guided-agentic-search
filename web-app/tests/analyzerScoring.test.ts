import assert from 'node:assert/strict';
import { clampIntentFit, classifyIntentFit } from '../src/tools/mapSearch';

assert.equal(classifyIntentFit(0.8), 'high');
assert.equal(classifyIntentFit(0.55), 'medium');
assert.equal(classifyIntentFit(0.549), 'low');
assert.equal(clampIntentFit(1.4), 1);
assert.equal(clampIntentFit(-1), 0);
assert.equal(clampIntentFit('nope'), 0.75);

console.log('analyzer scoring: intent_fit thresholds passed');

import test from 'node:test';
import analyzerHandler from '../api/analyzer';
import type { VercelRequest, VercelResponse } from '@vercel/node';

test('Analyzer retries malformed scores, filters provenance and accounts for both calls', async () => {
    const originalFetch = globalThis.fetch;
    const originalKey = process.env.OPENROUTER_API_KEY;
    process.env.OPENROUTER_API_KEY = 'fixture-key';
    let calls = 0;
    let payload: unknown;
    const response = { setHeader() {}, status() { return response; }, json(value: unknown) { payload = value; return response; } };
    globalThis.fetch = async (_input, init) => {
        const sent = JSON.parse(String(init?.body));
        assert.deepEqual(sent.reasoning, { enabled: false });
        calls++;
        const content = calls === 1 ? { category: 'Missing Score' } : { category: 'Pepper Syrah', intent_fit: 0.9, coherence: 'coherent', representative_evidence_ids: [1, 999] };
        return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }), { status: 200 });
    };
    try {
        await analyzerHandler({ method: 'POST', headers: {}, body: { reviews: [{ id: 1, text: 'pepper' }], prompt: 'peppery wine' } } as VercelRequest, response as unknown as VercelResponse);
        const result = payload as { fallback: boolean; intent_fit: number; representative_evidence_ids: number[]; analyzer_usage: { total_tokens: number } };
        assert.equal(calls, 2); assert.equal(result.fallback, false); assert.equal(result.intent_fit, 0.9);
        assert.deepEqual(result.representative_evidence_ids, [1]); assert.equal(result.analyzer_usage.total_tokens, 30);
    } finally {
        globalThis.fetch = originalFetch;
        if (originalKey === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = originalKey;
    }
});
