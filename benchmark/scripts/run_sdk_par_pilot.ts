/**
 * Live integration pilot for the Topic Ring Probe contract.
 *
 * Run from web-app:
 *   npm exec -- tsx ../benchmark/scripts/run_sdk_par_pilot.ts
 *   npm exec -- tsx ../benchmark/scripts/run_sdk_par_pilot.ts wine-dev-005
 */
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import analyzerHandler from '../../web-app/api/analyzer';
import { runProjectionAgent } from '../../web-app/api/agentRuntime';

type Query = {
    query_id: string;
    query: string;
    intent?: string;
    task_type?: 'exact' | 'semantic' | 'exploration' | 'comparison';
    target_count?: number;
    hard_constraints?: Record<string, unknown>;
};

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const outputDir = path.join(root, 'benchmark', 'runs', 'sdk-pilot');
const defaultQueryIds = ['wine-dev-005', 'wine-dev-006', 'wine-dev-010'];
let traceWrites = Promise.resolve();

function timestamp(): string {
    return new Date().toISOString().replace(/[-:.]/g, '').replace('Z', 'Z');
}

async function loadEnv(): Promise<void> {
    const text = await readFile(path.join(root, 'web-app', '.env.local'), 'utf8');
    for (const line of text.split(/\r?\n/)) {
        const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
        if (match && !process.env[match[1]]) process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
    }
}

async function loadQueries(ids: string[]): Promise<Query[]> {
    const text = await readFile(path.join(root, 'benchmark', 'queries', 'queries_v1.jsonl'), 'utf8');
    const queries = text.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line) as Query);
    const selected = ids.map(id => queries.find(query => query.query_id === id)).filter((query): query is Query => Boolean(query));
    if (selected.length !== ids.length) throw new Error(`Unknown query IDs: ${ids.filter(id => !selected.some(query => query.query_id === id)).join(', ')}`);
    return selected;
}

/** Route the server executor's internal Analyzer fetch locally, without a deployed URL. */
function installLocalAnalyzerRoute(): () => void {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
        if (String(input) !== 'http://sdk-pilot.local/api/analyzer') return originalFetch(input, init);
        let statusCode = 200;
        let body: unknown;
        const response = {
            setHeader() { /* Vercel response compatibility */ },
            status(code: number) { statusCode = code; return response; },
            json(value: unknown) { body = value; return response; },
            end() { return response; }
        };
        await analyzerHandler({
            method: init?.method || 'GET',
            headers: { referer: 'http://sdk-pilot.local' },
            body: JSON.parse(String(init?.body || '{}'))
        } as never, response as never);
        return new Response(JSON.stringify(body), {
            status: statusCode,
            headers: { 'Content-Type': 'application/json' }
        });
    };
    return () => { globalThis.fetch = originalFetch; };
}

function compactCandidates(candidates: Array<Record<string, unknown>>) {
    return candidates.map(item => {
        const candidate = { ...item, ...(item.evidence && typeof item.evidence === 'object' ? item.evidence : {}) } as Record<string, unknown>;
        return ({
        id: candidate.id,
        category: candidate.category,
        purity: candidate.purity,
        intent_match: candidate.intent_match,
        utility: candidate.utility,
        recommended_action: candidate.recommended_action,
        acceptance_tier: candidate.acceptance_tier,
        hard_constraint_match: candidate.hard_constraint_match,
        analysis_failed: candidate.analysis_failed ?? candidate.status === 'failed',
        status: candidate.status
    }); });
}

async function runQuery(query: Query, tracePath: string) {
    const started = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120_000);
    let result: Awaited<ReturnType<typeof runProjectionAgent>>;
    try {
        result = await runProjectionAgent({
            messages: [{ role: 'user', content: query.query }],
            origin: 'http://sdk-pilot.local',
            signal: controller.signal,
            taskSpec: process.argv.includes('--oracle-task-spec') ? { unsupported: true } : undefined,
            onTrace: event => { traceWrites = traceWrites.then(() => appendFile(tracePath, `${JSON.stringify({ query_id: query.query_id, ...event as object })}\n`, 'utf8')); }
        });
    } finally {
        clearTimeout(timeout);
    }
    const policy = result.searchPolicy;
    const candidates = policy.candidates as unknown as Array<Record<string, unknown>>;
    const accepted = candidates.filter(candidate => candidate.recommended_action === 'accept');
    const rejected = candidates.filter(candidate => candidate.recommended_action === 'reject');
    const judgedRing = result.toolResults.some(tool => tool.name === 'flexible_search' && typeof tool.result?.intent_fit === 'number');
    return {
        query_id: query.query_id,
        query: query.query,
        tool_sequence: result.toolSequence,
        trajectory: policy.trajectory,
        accepted: compactCandidates(accepted),
        rejected: compactCandidates(rejected),
        frontier: compactCandidates(policy.frontier as unknown as Array<Record<string, unknown>>),
        purity: Object.fromEntries(candidates.map(candidate => [candidate.id as string, candidate.purity])),
        intent_match: Object.fromEntries(candidates.map(candidate => [candidate.id as string, candidate.intent_match])),
        stop_reason: result.terminal.reason,
        terminal_state: result.terminal.state,
        final_answer: result.content,
        tokens: result.usage,
        cost: { usd: null, status: 'unavailable; token counts are not a price estimate' },
        task_source: result.taskSource,
        compiled_task: policy.task,
        selected_ids: policy.selected_ids,
        failed: candidates.filter(candidate => candidate.status === 'failed'),
        latency_ms: Date.now() - started,
        contract_pass: result.toolSequence.includes('load_workflow_playbook') &&
            judgedRing &&
            result.toolSequence.includes('complete_answer') &&
            ['success', 'partial_success', 'no_evidence', 'budget_exhausted'].includes(result.terminal.state) &&
            policy.must_stop && policy.stop_reason === result.terminal.reason &&
            result.content.trim().length >= 80,
        task_success: result.terminal.state === 'success',
        runtime: 'topic-ring-probe-v1',
        models: {
            agent: process.env.OPENROUTER_MODEL || 'z-ai/glm-5.3-flash',
            analyzer: process.env.OPENROUTER_ANALYZER_MODEL || process.env.OPENROUTER_MODEL || 'z-ai/glm-5.3-flash'
        }
    };
}

async function main(): Promise<void> {
    await loadEnv();
    if (!process.env.OPENROUTER_API_KEY) throw new Error('OPENROUTER_API_KEY is missing from web-app/.env.local');
    const requestedIds = process.argv.slice(2).filter(arg => !arg.startsWith('--'));
    const queryIds = requestedIds.length ? requestedIds : defaultQueryIds;
    const queries = await loadQueries(queryIds);
    await mkdir(outputDir, { recursive: true });
    const output = path.join(outputDir, `sdk_par_pilot_${timestamp()}.jsonl`);
    const restoreFetch = installLocalAnalyzerRoute();
    try {
        for (const query of queries) {
            console.log(JSON.stringify({ stage: 'started', query_id: query.query_id }));
            const started = Date.now();
            let record: any;
            try {
                record = await runQuery(query, output.replace('.jsonl', '.trace.jsonl'));
            } catch (error) {
                record = {
                    query_id: query.query_id,
                    query: query.query,
                    tool_sequence: [],
                    trajectory: [{ tool: 'runner', status: 'failed', detail: error instanceof Error ? error.message : String(error) }],
                    accepted: [], rejected: [], frontier: [], purity: {}, intent_match: {},
                    stop_reason: `runner_failure:${error instanceof Error ? error.name : 'unknown'}`,
                    terminal_state: 'runtime_error',
                    final_answer: '', tokens: null, latency_ms: Date.now() - started,
                    contract_pass: false, task_success: false, runtime: 'topic-ring-probe-v1',
                    models: {
                        agent: process.env.OPENROUTER_MODEL || 'z-ai/glm-5.3-flash',
                        analyzer: process.env.OPENROUTER_ANALYZER_MODEL || process.env.OPENROUTER_MODEL || 'z-ai/glm-5.3-flash'
                    }
                };
            }
            await appendFile(output, `${JSON.stringify(record)}\n`, 'utf8');
            console.log(JSON.stringify({
                stage: 'finished', query_id: query.query_id,
                contract_pass: record.contract_pass,
                accepted: record.accepted.length,
                rejected: record.rejected.length,
                frontier: record.frontier.length,
                stop_reason: record.stop_reason,
                tokens: record.tokens?.total_tokens ?? null,
                latency_ms: record.latency_ms
            }));
        }
    } finally {
        await traceWrites;
        restoreFetch();
    }
    console.log(JSON.stringify({ stage: 'written', output }));
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
