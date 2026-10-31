import { actionSchemas, CONTRACT_VERSION, LIMITS, PLAYBOOKS } from './searchContract';
import type { ActionName, PlaybookId } from './searchContract';
import type { ToolCall, ToolResult } from '../tools/toolExecutor';
import { classifyIntentFit, validateTopicSql } from '../tools/mapSearch';
import type { Bounds, Region } from '../tools/mapSearch';

type Executor = { execute(call: ToolCall): Promise<ToolResult> };
type Event = { sequence: number; tool: string; status: 'accepted' | 'completed' | 'blocked' | 'failed'; parameters?: unknown; detail?: string };
export type Terminal = { state: 'success' | 'partial_success' | 'no_evidence' | 'budget_exhausted' | 'runtime_error' | 'unsupported'; reason: string };
export interface Judgment {
    id: string;
    region: Region | null;
    category: string;
    themes: string[];
    summary: string;
    intent_fit: number;
    intent_fit_label: 'high' | 'medium' | 'low';
    evidence_ids: number[];
    fallback: boolean;
    requires_expansion: boolean;
}
interface Probe { id: string; region: Region; support: number; source: string; judged: boolean }

const SEARCH_TOOLS = new Set<ActionName>(['sql_query', 'map_search', 'flexible_search']);
const NARROW_PLAYBOOKS = new Set<PlaybookId>(['exact_analytics', 'row_examples']);

/** Validates Topic Ring Probe decisions. It does not choose the next ring. */
export class SearchSession {
    terminal: Terminal | null = null;
    readonly results: ToolResult[] = [];
    readonly events: Event[] = [];
    readonly judgments: Judgment[] = [];
    readonly probes: Probe[] = [];
    onChange?: () => void;
    readonly limits: typeof LIMITS;
    readonly query: string;
    readonly bounds: Bounds;
    playbook: PlaybookId | null = null;
    private actions = 0;
    private tokens = 0;
    private sqlThisTurn = 0;
    private refinements = 0;
    private nonImproving = 0;
    private judgedSearches = 0;
    private bestIntent = -1;
    private dimensionSql = 0;
    private dimensionFlexible = 0;
    private awaitingJudge = false;
    private mustStopSearching = false;
    private requiresExpansion = false;
    private shapes = new Set<string>();
    private requestGeneration = -1;
    private cited: string[] = [];
    private explanation = '';
    private bounded = false;
    private started: number;
    private busy = false;
    private now: () => number;
    private sequence = 0;

    constructor(query: string, bounds: Bounds, limits: Partial<typeof LIMITS> = {}, now = Date.now) {
        this.query = query;
        this.bounds = bounds;
        this.now = now;
        this.started = now();
        this.limits = { ...LIMITS, ...limits };
    }

    recordTokens(tokens: number): void { if (Number.isFinite(tokens) && tokens > 0) this.tokens += tokens; }

    /** A new model request closes the previous assistant turn, including its SQL count. */
    observeModelRequest(requests: number): void {
        if (requests === this.requestGeneration) return;
        this.requestGeneration = requests;
        this.sqlThisTurn = 0;
    }

    end(state: Terminal['state'], reason: string): void {
        if (this.terminal) return;
        this.terminal = { state, reason };
        this.onChange?.();
    }

    seedOracleTask(): unknown {
        this.end('unsupported', 'Oracle task specs are outside Topic Ring Probe. The agent compiles the search from the question.');
        return { terminal: this.terminal };
    }

    checkBudget(): boolean {
        if (!this.terminal && (this.actions >= this.limits.actions || this.tokens >= this.limits.tokens || this.now() - this.started >= this.limits.elapsedMs))
            this.end('budget_exhausted', 'search action, token or elapsed-time budget reached');
        return Boolean(this.terminal);
    }

    async act(name: ActionName, input: unknown, executor: Executor): Promise<unknown> {
        if (this.busy) return this.deny(name, 'Observe the current tool result before another action.');
        if (this.terminal) return { terminal: this.terminal, session: this.modelState() };
        if (this.checkBudget()) return { terminal: this.terminal, session: this.modelState() };
        const parsed = actionSchemas[name].safeParse(input);
        if (!parsed.success) return this.deny(name, parsed.error.message);
        if (this.actions >= 33 && name !== 'complete_answer' && name !== 'report_progress')
            return this.deny(name, 'Iteration 34 of 35. Stop searching and call complete_answer.');
        this.actions++;
        if (name !== 'load_workflow_playbook' && !this.playbook)
            return this.deny(name, 'required_next_step: Call load_workflow_playbook first');
        if (name === 'load_workflow_playbook') return this.loadPlaybook(actionSchemas.load_workflow_playbook.parse(input).playbook_id);
        if (name === 'report_progress') {
            this.event('report_progress', 'completed', parsed.data);
            return { acknowledged: true, session: this.modelState() };
        }
        if (name === 'complete_answer') return this.complete(actionSchemas.complete_answer.parse(input));
        return this.search(name, parsed.data as Record<string, unknown>, executor);
    }

    private loadPlaybook(id: PlaybookId): unknown {
        if (this.playbook) return this.deny('load_workflow_playbook', 'A playbook is already loaded for this turn.');
        this.playbook = id;
        this.event('load_workflow_playbook', 'completed', { playbook_id: id });
        return { playbook_id: id, title: PLAYBOOKS[id].title, playbook: PLAYBOOKS[id].text, session: this.modelState() };
    }

    private async search(name: ActionName, data: Record<string, unknown>, executor: Executor): Promise<unknown> {
        if (!SEARCH_TOOLS.has(name)) return this.deny(name, 'Unsupported tool.');
        if (this.mustStopSearching) return this.deny(name, 'Refinement budget is spent. Call complete_answer with a caveat.');
        const playbook = this.playbook!;
        const narrow = NARROW_PLAYBOOKS.has(playbook);
        if (!narrow && this.awaitingJudge && name !== 'flexible_search')
            return this.deny(name, 'A viable ring exists. The next data tool must be region-constrained flexible_search.');
        if (name === 'sql_query' && !narrow && this.sqlThisTurn >= this.limits.sqlPerTurnBeforeJudge && !this.judgedSearches)
            return this.deny(name, 'At most two SQL queries in one assistant turn before the first flexible_search.');
        if ((playbook === 'semantic_count' || playbook === 'facet_use_case_discovery') && name === 'sql_query' && !this.judgedSearches && !this.results.some(result => result.name === 'map_search' || result.name === 'flexible_search'))
            return this.deny(name, 'This playbook forbids SQL until map_search or flexible_search has defined the terms or anchors.');
        if (playbook === 'dimension_signal_scan' && ((name === 'sql_query' && this.dimensionSql >= this.limits.dimensionSql) || (name === 'flexible_search' && this.dimensionFlexible >= this.limits.dimensionFlexible)))
            return this.stopDimension();
        const shape = searchShape(name, data);
        if (this.shapes.has(shape)) return this.deny(name, 'Repeating a search shape is forbidden. Change the interpretation, region, or anchors.');
        if (name === 'flexible_search') {
            const region = data.region as Region | undefined;
            if ((this.awaitingJudge || this.probes.length) && !region)
                return this.deny(name, 'Judging a ring requires its exact region.');
            if (!region && !String(data.query || '') && !(data.terms as string[] | undefined)?.length)
                return this.deny(name, 'flexible_search needs terms or a region.');
        }
        if (name === 'map_search' && !String(data.query || '') && !(data.terms as string[] | undefined)?.length && !data.region)
            return this.deny(name, 'map_search needs terms or a region.');
        if (name === 'sql_query') {
            const problem = validateTopicSql(String(data.sql));
            if (problem) return this.deny(name, problem);
        }
        if (this.judgedSearches && (name === 'sql_query' || name === 'map_search')) {
            if (this.refinements >= this.limits.refinements) return this.deny(name, 'Three refinement attempts have been used. Call complete_answer.');
            this.refinements++;
        }
        this.shapes.add(shape);
        if (name === 'sql_query') this.sqlThisTurn++;
        if (playbook === 'dimension_signal_scan' && name === 'sql_query') this.dimensionSql++;
        if (playbook === 'dimension_signal_scan' && name === 'flexible_search') this.dimensionFlexible++;
        this.busy = true;
        let executed: ToolResult;
        try {
            executed = await executor.execute({
                id: `call-${this.sequence + 1}`, type: 'function',
                function: { name, arguments: JSON.stringify({ ...data, bounds: this.bounds }) }
            });
        } finally { this.busy = false; }
        this.results.push(executed);
        if (executed.error) {
            this.event(name, 'failed', data, executed.error);
            return { error: executed.error, session: this.modelState() };
        }
        this.ingest(executed.result);
        if (this.refinements >= this.limits.refinements || this.nonImproving >= this.limits.nonImproving) this.mustStopSearching = true;
        this.event(name, 'completed', data);
        return { result: executed.result, session: this.modelState() };
    }

    private stopDimension(): unknown {
        this.mustStopSearching = true;
        this.event('dimension_signal_scan', 'completed', { stop_condition_met: true });
        return { stop_condition_met: true, session: this.modelState() };
    }

    private ingest(result: { candidate_rings?: Array<Region & { support?: number }>; seed_islands?: Array<{ bbox: Region; support_count?: number }>; intent_fit?: number; category?: string; themes?: string[]; summary?: string; evidence_ids?: number[]; fallback?: boolean; coverage_warning?: { requires_expansion_for_broad_scope?: boolean } | null; region?: Region }): void {
        const rings = [
            ...(result.candidate_rings || []).map(ring => ({ region: ring, support: Number(ring.support || 0), source: 'sql' })),
            ...(result.seed_islands || []).map(island => ({ region: island.bbox, support: Number(island.support_count || 0), source: 'seed_island' }))
        ];
        for (const ring of rings) {
            if (this.probes.some(probe => sameRegion(probe.region, ring.region))) continue;
            this.probes.push({ id: `ring-${this.probes.length + 1}`, region: ring.region, support: ring.support, source: ring.source, judged: false });
        }
        if (typeof result.intent_fit === 'number') {
            const fit = result.intent_fit;
            const label = classifyIntentFit(fit);
            const judgment: Judgment = {
                id: `judge-${this.judgments.length + 1}`,
                region: result.region || null,
                category: String(result.category || 'Unlabeled sample'),
                themes: Array.isArray(result.themes) ? result.themes.map(String) : [],
                summary: String(result.summary || ''),
                intent_fit: fit,
                intent_fit_label: label,
                evidence_ids: Array.isArray(result.evidence_ids) ? result.evidence_ids.filter(id => Number.isInteger(id)) : [],
                fallback: Boolean(result.fallback),
                requires_expansion: Boolean(result.coverage_warning?.requires_expansion_for_broad_scope)
            };
            this.judgments.push(judgment);
            if (judgment.region) {
                const probe = [...this.probes].reverse().find(item => sameRegion(item.region, judgment.region!));
                if (probe) probe.judged = true;
            }
            if (this.judgedSearches > 0 && fit <= this.bestIntent) this.nonImproving++;
            this.bestIntent = Math.max(this.bestIntent, fit);
            this.judgedSearches++;
            if (judgment.requires_expansion) this.requiresExpansion = true;
            if (this.nonImproving >= this.limits.nonImproving || this.refinements >= this.limits.refinements) this.mustStopSearching = true;
        }
        this.awaitingJudge = this.probes.some(probe => !probe.judged);
    }

    private complete(data: { categories: string[]; bounded: boolean; explanation: string; suggested_followups: Array<{ kind: string; text: string }> }): unknown {
        const cited = data.categories.map(category => this.judgments.find(item => item.category === category));
        if (cited.some(item => !item)) return this.deny('complete_answer', 'Cite only category names returned by flexible_search.');
        const judgments = cited as Judgment[];
        if (judgments.some(item => item.intent_fit < 0.55)) return this.deny('complete_answer', 'A low intent_fit ring cannot support an answer.');
        if (judgments.some(item => item.intent_fit < 0.8) && !data.bounded) return this.deny('complete_answer', 'A medium intent_fit ring requires bounded language.');
        if (this.probes.some(probe => !probe.judged) && !data.bounded)
            return this.deny('complete_answer', 'Unjudged rings remain. Judge them or mark the answer bounded.');
        if ((this.requiresExpansion || this.mustStopSearching) && !data.bounded && !judgments.some(item => item.intent_fit >= 0.8))
            return this.deny('complete_answer', 'Coverage or the refinement budget requires a bounded answer.');
        if (!judgments.length && !data.bounded) return this.deny('complete_answer', 'An empty answer must say it is bounded by missing evidence.');
        this.cited = data.categories;
        this.explanation = data.explanation;
        this.bounded = data.bounded || judgments.every(item => item.intent_fit < 0.8);
        this.event('complete_answer', 'completed', data);
        const high = judgments.some(item => item.intent_fit >= 0.8);
        this.end(high ? 'success' : judgments.length ? 'partial_success' : 'no_evidence', high ? 'accepted_rings' : data.bounded ? 'bounded_evidence' : 'no_accepted_ring');
        return { terminal: this.terminal, session: this.modelState() };
    }

    private event(tool: string, status: Event['status'], parameters?: unknown, detail?: string) {
        this.events.push({ sequence: ++this.sequence, tool, status, parameters, detail });
        this.onChange?.();
    }

    private deny(tool: string, reason: string): unknown {
        this.event(tool, 'blocked', undefined, reason);
        return { error: reason, session: this.modelState() };
    }

    modelState() {
        const ledger = this.probes.slice(-20).map(probe => ({
            id: probe.id, region: probe.region, support: probe.support, source: probe.source, judged: probe.judged
        }));
        return {
            contract: CONTRACT_VERSION,
            bounds: this.bounds,
            playbook: this.playbook,
            terminal: this.terminal,
            awaiting_judge: this.awaitingJudge,
            sql_this_turn: this.sqlThisTurn,
            refinements_used: this.refinements,
            non_improving_searches: this.nonImproving,
            must_stop_searching: this.mustStopSearching,
            next_required: this.mustStopSearching || this.actions >= 33 ? 'complete_answer' : this.awaitingJudge ? 'flexible_search' : null,
            probed_regions: ledger,
            judgments: this.judgments.map(item => ({ id: item.id, category: item.category, intent_fit: item.intent_fit, intent_fit_label: item.intent_fit_label, region: item.region }))
        };
    }

    snapshot() {
        return {
            contract: CONTRACT_VERSION,
            task: { playbook: this.playbook },
            terminal: this.terminal,
            must_stop: Boolean(this.terminal),
            stop_reason: this.terminal?.reason || null,
            candidates: this.judgments.map(item => ({
                id: item.id, category: item.category, intent_fit: item.intent_fit, status: item.intent_fit >= 0.8 ? 'accepted' : item.intent_fit >= 0.55 ? 'frontier' : 'rejected',
                recommended_action: item.intent_fit >= 0.8 ? 'accept' : item.intent_fit < 0.55 ? 'reject' : 'bounded'
            })),
            frontier: this.probes.filter(probe => !probe.judged),
            selected_ids: [...this.cited],
            accepted_region_count: this.judgments.filter(item => item.intent_fit >= 0.8).length,
            trajectory: [...this.events],
            elapsed_ms: this.now() - this.started
        };
    }

    answer(): string {
        if (!this.terminal) throw new Error('Cannot answer before terminal state');
        const cards = this.cited.map(category => this.judgments.find(item => item.category === category)).filter((item): item is Judgment => Boolean(item));
        const lines = [this.explanation || this.terminal.reason, ...cards.map(card => `{{${card.category}}}`)];
        if (this.bounded) lines.push('Scope: this is a bounded reading of the sampled rings, not a census of the map.');
        if (!cards.length) lines.push('No accepted ring was strong enough to name.');
        return lines.join('\n\n');
    }

    presentation(): ToolResult | null {
        if (!this.terminal) throw new Error('Presentation requires terminal state');
        const cards = this.cited.map(category => this.judgments.find(item => item.category === category)).filter((item): item is Judgment => Boolean(item));
        const ids = [...new Set(cards.flatMap(card => card.evidence_ids))];
        if (!ids.length) return null;
        return { name: 'save_selection', call_id: 'presentation', result: { saved: true, label: cards[0]?.category || 'Accepted ring', record_ids: ids, categories: cards.map(card => card.category), controller_generated: true } };
    }
}

function searchShape(name: string, data: Record<string, unknown>): string {
    if (name === 'sql_query') return `sql:${String(data.sql).replace(/\s+/g, ' ').trim().toLowerCase()}`;
    const region = data.region as Region | undefined;
    const box = region ? [region.min_x, region.max_x, region.min_y, region.max_y].map(value => value.toFixed(4)).join(',') : '-';
    const terms = [String(data.query || ''), ...((data.terms as string[] | undefined) || [])].map(term => term.toLowerCase().trim()).filter(Boolean).sort().join('|');
    return `${name}:${box}:${terms}:${String(data.prompt || '')}`;
}

function sameRegion(a: Region, b: Region): boolean {
    return [a.min_x - b.min_x, a.max_x - b.max_x, a.min_y - b.min_y, a.max_y - b.max_y].every(delta => Math.abs(delta) < 1e-6);
}

export type SearchPolicySnapshot = ReturnType<SearchSession['snapshot']>;
