import { Agent, OpenAIProvider, Runner, tool } from '@openai/agents';
import { actionSchemas, AGENT_INSTRUCTIONS, descriptions, jsonSchemaFor, LIMITS } from '../src/agent/searchContract';
import type { ActionName } from '../src/agent/searchContract';
import { SearchSession } from '../src/agent/searchSession';
import { ToolExecutor } from '../src/tools/toolExecutor';
import { getServerCoordinator } from './serverDuckDb';

/** SDK owns model/tool turns. SearchSession alone owns the search contract. */
export async function runProjectionAgent({ messages, origin, signal, taskSpec, onTrace }: {
    messages: Array<{ role: string; content: string }>;
    origin: string;
    signal?: AbortSignal;
    taskSpec?: unknown;
    onTrace?: (event: unknown) => void;
}) {
    const key = process.env.OPENROUTER_API_KEY;
    if (!key) throw new Error('OpenRouter API key not configured');
    const query = [...messages].reverse().find(m => m.role === 'user')?.content || '';
    if (!query.trim()) throw new Error('A user query is required');
    const coordinator = await getServerCoordinator();
    const rows = (await coordinator.query('SELECT MIN(projection_x) min_x, MAX(projection_x) max_x, MIN(projection_y) min_y, MAX(projection_y) max_y FROM reviews')).toArray();
    const b = rows[0];
    const session = new SearchSession(query, { min_x: Number(b.min_x), max_x: Number(b.max_x), min_y: Number(b.min_y), max_y: Number(b.max_y) });
    session.onChange = () => onTrace?.({ snapshot: session.snapshot() });
    if (query.startsWith('IMPORTANT: The user selected '))
        session.end('unsupported', 'Selected-map-subset requests require an explicit scope adapter; no full-map search was performed.');
    const timeout = AbortSignal.timeout(LIMITS.elapsedMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const executor = new ToolExecutor(coordinator, { analyzerUrl: `${origin}/api/analyzer`, signal: combined });
    const usage = { requests: 0, prompt_tokens: 0, completion_tokens: 0, agent_tokens: 0, analyzer_tokens: 0, total_tokens: 0 };
    const account = (u?: { requests: number; inputTokens: number; outputTokens: number; totalTokens: number }) => {
        if (!u) return;
        session.recordTokens(Math.max(0, u.totalTokens - usage.agent_tokens));
        usage.requests = u.requests; usage.prompt_tokens = u.inputTokens;
        usage.completion_tokens = u.outputTokens; usage.agent_tokens = u.totalTokens;
    };
    const tools = (Object.keys(actionSchemas) as ActionName[]).map(name => tool({
        name, description: descriptions[name],
        // Validate in SearchSession even when the provider uses non-strict schemas.
        parameters: jsonSchemaFor(name), strict: false,
        async execute(input, context) {
            account(context?.usage);
            session.observeModelRequest(context?.usage?.requests ?? 0);
            const result = await session.act(name, input, executor);
            onTrace?.({ snapshot: session.snapshot() });
            return JSON.stringify(result);
        }
    }));
    const provider = new OpenAIProvider({ apiKey: key, baseURL: 'https://openrouter.ai/api/v1', useResponses: false });
    const agent = new Agent({
        name: 'Projection Search Agent', model: process.env.OPENROUTER_MODEL || 'z-ai/glm-5.3-flash',
        instructions: `${AGENT_INSTRUCTIONS}\nActual XY bounds: ${JSON.stringify(session.bounds)}`,
        tools,
        modelSettings: { temperature: 0, maxTokens: 1800, parallelToolCalls: false, toolChoice: 'required', reasoning: { effort: 'low' } },
        toolUseBehavior: () => session.terminal
            ? { isFinalOutput: true, isInterrupted: undefined, finalOutput: session.answer() }
            : { isFinalOutput: false, isInterrupted: undefined }
    });
    const runner = new Runner({ modelProvider: provider, tracingDisabled: true, toolExecution: { maxFunctionToolConcurrency: 1 } });
    const abort = () => session.end('budget_exhausted', 'request cancelled or elapsed-time budget reached');
    combined.addEventListener('abort', abort, { once: true });
    try {
        if (taskSpec) session.seedOracleTask();
        if (!session.terminal) {
            const input = `${messages.slice(-6).map(m => `[${m.role}] ${m.content}`).join('\n\n')}\nInitial SESSION: ${JSON.stringify(session.modelState())}`;
            const result = await runner.run(agent, input, { maxTurns: LIMITS.actions, signal: combined });
            account(result.runContext.usage);
        }
        if (!session.terminal) session.end('runtime_error', 'Model ended without an accepted complete_answer request');
    } catch (error) {
        const e = error as { state?: { _context?: { usage?: Parameters<typeof account>[0] } }; name?: string; message?: string };
        account(e.state?._context?.usage);
        session.end(combined.aborted ? 'budget_exhausted' : 'runtime_error', combined.aborted ? 'request cancelled or elapsed-time budget reached' : `${e.name || 'Error'}: ${e.message || 'runtime failed'}`);
    } finally { combined.removeEventListener('abort', abort); }
    const presentation = session.presentation();
    usage.analyzer_tokens = session.results.reduce((sum, r) => sum + (Number(r.result?.analyzer_usage?.total_tokens) || 0), 0);
    usage.total_tokens = usage.agent_tokens + usage.analyzer_tokens;
    onTrace?.({ snapshot: session.snapshot(), usage });
    return { content: session.answer(), terminal: session.terminal!, searchPolicy: session.snapshot(),
        toolResults: presentation ? [...session.results, presentation] : session.results,
        toolSequence: session.events.filter(e => e.status === 'completed').map(e => e.tool),
        usage, taskSource: taskSpec ? 'unsupported_oracle_task_spec' : 'agent_compiled' };
}
