import { actionSchemas, CONTRACT_VERSION, LIMITS, PLAYBOOKS } from './searchContract';
import type { ActionName, PlaybookId, SearchContext } from './searchContract';
import type { ToolCall, ToolResult } from '../tools/toolExecutor';
import { classifyIntentFit, normalizeSearchText, validateTopicSql } from '../tools/mapSearch';
import type { Bounds, Region } from '../tools/mapSearch';

type Executor = { execute(call: ToolCall): Promise<ToolResult> };
type Event = { sequence: number; tool: string; status: 'completed' | 'blocked' | 'failed'; parameters?: unknown; detail?: string };
export type Terminal = { state: 'success' | 'partial_success' | 'no_evidence' | 'budget_exhausted' | 'runtime_error' | 'unsupported'; reason: string };
export interface Judgment {
    id: string; region: Region | null; category: string; themes: string[]; summary: string;
    intent_fit: number; intent_fit_label: 'high' | 'medium' | 'low'; evidence_ids: number[];
    fallback: boolean; requires_expansion: boolean; sample_count: number; support: number;
    coherence: string; eligible: boolean;
}
interface Probe {
    id: string; region: Region; support: number; source: string;
    status: 'candidate' | 'judged' | 'refined' | 'discarded';
}
const NARROW = new Set<PlaybookId>(['exact_analytics', 'row_examples']);
const SEARCH = new Set<ActionName>(['sql_query', 'map_search', 'flexible_search']);

/** The model chooses navigation. This session validates evidence and termination. */
export class SearchSession {
    terminal: Terminal | null = null;
    readonly results: ToolResult[] = [];
    readonly events: Event[] = [];
    readonly judgments: Judgment[] = [];
    readonly probes: Probe[] = [];
    onChange?: () => void;
    readonly limits: typeof LIMITS;
    playbook: PlaybookId | null = null;
    private actions = 0;
    private tokens = 0;
    private sqlThisTurn = 0;
    private refinements = 0;
    private nonImproving = 0;
    private dimensionSql = 0;
    private dimensionFlexible = 0;
    private awaitingJudge = false;
    private mustStopSearching = false;
    private requiresExpansion = false;
    private shapes = new Set<string>();
    private refined = new Set<string>();
    private requestGeneration = -1;
    private playbookRequest = -2;
    private dataRequest = -2;
    private cited: Judgment[] = [];
    private explanation = '';
    private bounded = false;
    private evidenceKind = 'no_evidence';
    private followups: Array<{ kind: string; text: string }> = [];
    private started: number;
    private busy = false;
    private sequence = 0;
    private scopeKey = 'full-map';
    private prior: SearchContext['probed_regions'] = [];
    private priorSameQuery = false;
    private coveredCells = new Set<string>();
    private coverageScopeCells = 0;
    readonly query: string;
    readonly bounds: Bounds;
    private now: () => number;

    constructor(query: string, bounds: Bounds, limits: Partial<typeof LIMITS> = {}, now = Date.now) {
        this.query = query;
        this.bounds = bounds;
        this.now = now;
        this.started = now();
        this.limits = { ...LIMITS, ...limits };
    }

    setContext(context: SearchContext | undefined, scopeKey: string): void {
        this.scopeKey = scopeKey;
        if (context?.scope_key === scopeKey) {
            this.prior = context.probed_regions;
            this.priorSameQuery = context.query === this.query;
        }
    }
    recordTokens(tokens: number): void { if (Number.isFinite(tokens) && tokens > 0) this.tokens += tokens; }
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
        this.end('unsupported', 'Oracle task specs are outside Topic Ring Probe.');
        return { terminal: this.terminal };
    }
    checkBudget(): boolean {
        if (!this.terminal && (this.actions >= this.limits.actions || this.tokens >= this.limits.tokens || this.now() - this.started >= this.limits.elapsedMs))
            this.end('budget_exhausted', 'search action, token or elapsed-time budget reached');
        return Boolean(this.terminal);
    }
    async act(name: ActionName, input: unknown, executor: Executor): Promise<unknown> {
        if (this.busy) return this.deny(name, 'Observe the current tool result before another action.');
        if (this.terminal || this.checkBudget()) return { terminal: this.terminal, session: this.modelState() };
        this.actions++;
        const parsed = actionSchemas[name].safeParse(input);
        if (!parsed.success) return this.deny(name, parsed.error.message);
        if (this.actions >= this.limits.actions - 1 && name !== 'complete_answer' && name !== 'report_progress')
            return this.deny(name, 'Wrap up: call complete_answer with the available evidence.');
        if (name === 'load_workflow_playbook') {
            if (this.playbook) return this.deny(name, 'A playbook is already loaded.');
            this.playbook = actionSchemas.load_workflow_playbook.parse(input).playbook_id;
            this.playbookRequest = this.requestGeneration;
            this.event(name, 'completed', parsed.data);
            return { playbook: PLAYBOOKS[this.playbook], session: this.modelState() };
        }
        if (!this.playbook) return this.deny(name, 'required_next_step: Call load_workflow_playbook first');
        if (this.requestGeneration >= 0 && this.playbookRequest === this.requestGeneration)
            return this.deny(name, 'load_workflow_playbook must be the only tool in its assistant turn.');
        if (name === 'report_progress') {
            this.event(name, 'completed', parsed.data);
            return { acknowledged: true };
        }
        if (name === 'complete_answer') {
            if (this.requestGeneration >= 0 && this.dataRequest === this.requestGeneration)
                return this.deny(name, 'complete_answer must be the only non-progress tool in its assistant turn.');
            return this.complete(actionSchemas.complete_answer.parse(input));
        }
        this.dataRequest = this.requestGeneration;
        if (name === 'transition_ring') return this.transition(actionSchemas.transition_ring.parse(input));
        return this.search(name, parsed.data as Record<string, unknown>, executor);
    }
    private transition(data: { region: Region; transition: 'mixed' | 'weak' | 'off_intent'; reason: string }): unknown {
        const probe = this.probes.find(item => sameRegion(item.region, data.region));
        if (!probe) return this.deny('transition_ring', 'Transition requires a known ring.');
        const key = regionKey(data.region);
        if (data.transition === 'mixed') {
            if (this.refined.has(key)) return this.deny('transition_ring', 'A mixed ring can be split or shifted only once.');
            this.refined.add(key);
            probe.status = 'refined';
        } else probe.status = 'discarded';
        this.awaitingJudge = false;
        this.event('transition_ring', 'completed', data);
        return { session: this.modelState() };
    }
    private async search(name: ActionName, data: Record<string, unknown>, executor: Executor): Promise<unknown> {
        if (!SEARCH.has(name)) return this.deny(name, 'Unsupported tool.');
        if (this.mustStopSearching) return this.deny(name, 'Refinement budget is spent. Call complete_answer with a caveat.');
        const narrow = NARROW.has(this.playbook!);
        if (this.playbook === 'dimension_signal_scan' && (this.dimensionSql >= this.limits.dimensionSql || this.dimensionFlexible >= this.limits.dimensionFlexible)) {
            this.mustStopSearching = true;
            return { stop_condition_met: true, session: this.modelState() };
        }
        if (!narrow && this.awaitingJudge && name !== 'flexible_search')
            return this.deny(name, 'A viable ring exists. Next use region-constrained flexible_search or transition_ring.');
        if (name === 'sql_query' && !narrow && this.sqlThisTurn >= this.limits.sqlPerTurnBeforeJudge && !this.judgments.length)
            return this.deny(name, 'At most two SQL queries in one assistant turn before the first flexible_search.');
        const successfulSearch = this.results.some(r => !r.error && (r.name === 'map_search' || r.name === 'flexible_search') && (r.result?.lexical_match_count > 0 || r.result?.sample_count > 0 || r.result?.rows?.length));
        if (name === 'sql_query') {
            if ((this.playbook === 'semantic_count' || this.playbook === 'facet_use_case_discovery') && !successfulSearch)
                return this.deny(name, 'This playbook forbids SQL until a successful search has established terms or anchors.');
            const sql = String(data.sql);
            const problem = validateTopicSql(sql);
            if (problem) return this.deny(name, problem);
            if (/\bdescription\b/i.test(sql) && /\b(?:like|ilike|regexp_matches|contains)\b/i.test(sql)) {
                const explicitLiteral = this.playbook === 'exact_analytics' && /["'“”‘’]/.test(this.query);
                const proxy = this.playbook === 'semantic_count' && successfulSearch && /literal|proxy/i.test(String(data.purpose));
                if (!explicitLiteral && !proxy) return this.deny(name, 'SQL text matching is only for an explicit literal count or an established, labeled literal/proxy condition.');
            }
        }
        const shape = searchShape(name, data);
        if (this.shapes.has(shape)) return this.deny(name, 'Repeating a search shape is forbidden; changing only the explanation is not a new search.');
        const region = data.region as Region | undefined;
        let workspaceIds: number[] | undefined;
        if (data.workspace_set_id) {
            const source = this.results.find(r => !r.error && r.result?.result_set_id === data.workspace_set_id);
            if (!source) return this.deny(name, 'workspace_set_id must name a successful result from this turn.');
            const ids: number[] = source.name === 'flexible_search' ? source.result.evidence_ids || [] : (source.result.rows || []).filter((r: { match_type?: string }) => r.match_type !== 'cluster_neighbor').map((r: { id?: number; __row_index__?: number }) => r.id ?? r.__row_index__);
            workspaceIds = [...new Set(ids.filter(Number.isSafeInteger))];
            if (!workspaceIds.length) return this.deny(name, 'This result set contains no row ids to scope a query.');
        }
        if (name === 'flexible_search' && this.awaitingJudge && !region)
            return this.deny(name, 'Judging a ring requires its exact region.');
        if (name !== 'sql_query' && !region && !String(data.query || '') && !(data.terms as string[])?.length)
            return this.deny(name, 'Search needs terms or a region.');
        if (region && this.priorSameQuery && this.prior.some(p => sameRegion(p.region, region) && (p.status === 'discarded' || (p.intent_fit !== null && (p.intent_fit >= 0.8 || p.intent_fit < 0.55)))))
            return this.deny(name, 'This ring was already accepted or rejected for the same question. Explore a neighbor or change its bounds.');
        const refining = !narrow && this.judgments.some(j => j.eligible) && !this.awaitingJudge;
        if (refining && this.refinements >= this.limits.refinements)
            return this.deny(name, 'Three refinement attempts have been used. Call complete_answer.');
        this.shapes.add(shape);
        if (refining) this.refinements++;
        if (name === 'sql_query') { this.sqlThisTurn++; this.dimensionSql++; }
        if (name === 'flexible_search') this.dimensionFlexible++;
        this.busy = true;
        let executed: ToolResult;
        try {
            executed = await executor.execute({ id: `call-${this.sequence + 1}`, type: 'function', function: { name, arguments: JSON.stringify({ ...data, bounds: this.bounds, workspace_ids: workspaceIds }) } });
        } finally { this.busy = false; }
        const setId = `set-${this.results.length + 1}`;
        if (!executed.error && executed.result) executed.result.result_set_id = setId;
        this.results.push(executed);
        if (executed.error) {
            this.event(name, 'failed', data, executed.error);
            return { error: executed.error, session: this.modelState() };
        }
        this.recordTokens(Number(executed.result?.analyzer_usage?.total_tokens) || 0);
        this.ingest(name, executed.result);
        // Always let a newly found refinement ring receive its Judge checkpoint.
        if (!this.awaitingJudge && (this.refinements >= this.limits.refinements || this.nonImproving >= this.limits.nonImproving)) this.mustStopSearching = true;
        this.event(name, 'completed', data);
        return { result: executed.result, session: this.modelState() };
    }
    private ingest(name: ActionName, result: ToolResult['result']): void {
        const rings = [
            ...(result.candidate_rings || []).map((r: Region & { support?: number }) => ({ region: r, support: Number(r.support || 0), source: 'sql' })),
            ...(name === 'flexible_search' && result.region ? [] : result.seed_islands || []).map((r: { bbox: Region; support_count?: number }) => ({ region: r.bbox, support: Number(r.support_count || 0), source: 'seed_island' }))
        ];
        let newRings = false;
        for (const r of rings) {
            if (!(r.support > 0) || this.probes.some(p => sameRegion(p.region, r.region))) continue;
            this.probes.push({ id: `ring-${this.probes.length + 1}`, ...r, status: 'candidate' });
            newRings = true;
        }
        const coverage = result.projection_coverage;
        for (const cell of coverage?.returned_cell_keys || []) this.coveredCells.add(cell);
        if (!result.region && coverage?.scope_cells) this.coverageScopeCells = coverage.scope_cells;
        if (result.coverage_warning?.requires_expansion_for_broad_scope) this.requiresExpansion = true;
        if (this.coverageScopeCells > 0 && this.coveredCells.size / this.coverageScopeCells >= 0.1) this.requiresExpansion = false;
        if (name === 'flexible_search' && typeof result.intent_fit === 'number') {
            const fit = Number.isFinite(result.intent_fit) ? Math.min(1, Math.max(0, result.intent_fit)) : 0;
            const ids: number[] = [...new Set<number>((result.evidence_ids || []).filter((id: number) => Number.isInteger(id)))];
            const sample = Number(result.sample_count || 0);
            const support = Number(result.scope_count || 0);
            const coherence = String(result.coherence || 'unknown');
            const eligible = Boolean(result.region && !result.fallback && ids.length && sample > 0 && support > 0 && fit >= 0.55 && coherence !== 'unknown' && coherence !== 'low');
            const judgment: Judgment = {
                id: `judge-${this.judgments.length + 1}`, region: result.region || null,
                category: String(result.category || 'Unlabeled sample'), themes: result.themes || [], summary: String(result.summary || ''),
                intent_fit: fit, intent_fit_label: classifyIntentFit(fit), evidence_ids: ids,
                fallback: Boolean(result.fallback), requires_expansion: Boolean(result.coverage_warning?.requires_expansion_for_broad_scope),
                sample_count: sample, support, coherence, eligible
            };
            const duplicateCount = this.judgments.filter(j => j.category === judgment.category || j.category.startsWith(`${judgment.category} (`)).length;
            if (duplicateCount) judgment.category = `${judgment.category} (${duplicateCount + 1})`;
            result.category = judgment.category;
            result.judgment_id = judgment.id;
            const oldIds = new Set(this.judgments.filter(j => j.eligible).flatMap(j => j.evidence_ids));
            const oldThemes = new Set(this.judgments.filter(j => j.eligible).flatMap(j => j.themes.map(normalizeSearchText)));
            const improved = eligible && (ids.some(id => !oldIds.has(id)) || judgment.themes.some(t => !oldThemes.has(normalizeSearchText(t))) || fit > Math.max(0, ...this.judgments.map(j => j.intent_fit)));
            if (this.judgments.some(j => j.eligible)) this.nonImproving = improved ? 0 : this.nonImproving + 1;
            this.judgments.push(judgment);
            if (judgment.region) {
                let probe = this.probes.find(p => sameRegion(p.region, judgment.region!));
                if (!probe) { probe = { id: `ring-${this.probes.length + 1}`, region: judgment.region, support, source: 'judge', status: 'judged' }; this.probes.push(probe); }
                probe.status = 'judged';
            }
            this.awaitingJudge = !judgment.region && newRings;
        } else this.awaitingJudge = newRings;
    }
    private complete(data: ReturnType<typeof actionSchemas.complete_answer.parse>): unknown {
        if (/\{\{[^{}]*\}\}/.test(data.explanation)) return this.deny('complete_answer', 'Category cards are rendered from categories; do not insert card tokens in explanation.');
        const sets = data.result_set_ids.map(id => this.results.find(r => !r.error && r.result?.result_set_id === id));
        if (sets.some(s => !s)) return this.deny('complete_answer', 'Use only successful result_set_ids returned this turn.');
        const structured = data.evidence_kind === 'exact_sql' || data.evidence_kind === 'literal_proxy' || data.evidence_kind === 'row_examples';
        if (structured) {
            if (!sets.length || data.categories.length) return this.deny('complete_answer', 'Structured evidence needs result_set_ids and no topic categories.');
            if (data.evidence_kind === 'exact_sql' && (this.playbook !== 'exact_analytics' || sets.some(s => s!.name !== 'sql_query')))
                return this.deny('complete_answer', 'Exact counts require the exact_analytics SQL path.');
            if (data.evidence_kind === 'literal_proxy' && (this.playbook !== 'semantic_count' || !data.bounded || sets.some(s => s!.name !== 'sql_query')))
                return this.deny('complete_answer', 'Literal/proxy counts require semantic_count SQL and bounded language.');
            if (data.evidence_kind === 'row_examples' && (sets.some(s => !s!.result?.rows?.length) || (this.playbook !== 'row_examples' && (!data.bounded || sets.some(s => s!.name !== 'flexible_search' || !s!.result?.evidence_ids?.length)))))
                return this.deny('complete_answer', 'Row examples need returned rows. Outside row_examples, only directly judged ids may be cited as bounded isolated evidence, never as a cluster.');
        } else {
            const judgments = data.categories.map(category => [...this.judgments].reverse().find(j => j.category === category && j.eligible));
            if (judgments.some(j => !j)) return this.deny('complete_answer', 'Cite only eligible, non-low, non-fallback region judgments with direct evidence.');
            const eligible = judgments as Judgment[];
            if (eligible.some(j => j.intent_fit < 0.8 || j.coherence !== 'coherent') && !data.bounded)
                return this.deny('complete_answer', 'Medium or mixed evidence requires bounded language.');
            if ((this.requiresExpansion || this.mustStopSearching || this.probes.some(p => p.status === 'candidate')) && !data.bounded)
                return this.deny('complete_answer', 'Coverage, unexplored frontier, or stopping limits require a bounded answer.');
            if (!eligible.length && !data.bounded) return this.deny('complete_answer', 'No evidence: mark the answer bounded.');
            this.cited = eligible;
        }
        this.explanation = data.explanation;
        this.bounded = data.bounded;
        this.evidenceKind = data.evidence_kind;
        this.followups = data.suggested_followups;
        this.event('complete_answer', 'completed', data);
        const evidence = structured || this.cited.length > 0;
        this.end(!evidence ? 'no_evidence' : data.bounded ? 'partial_success' : 'success', !evidence ? 'no_accepted_evidence' : structured ? data.evidence_kind : data.bounded ? 'bounded_evidence' : 'accepted_rings');
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
    context(): SearchContext {
        const current = this.probes.map(p => {
            const j = [...this.judgments].reverse().find(j => j.region && sameRegion(j.region, p.region));
            return { region: p.region, status: p.status, support: p.support, intent_fit: j?.intent_fit ?? null, category: j?.category || '' };
        });
        return { scope_key: this.scopeKey, query: this.query, probed_regions: [...this.prior, ...current].slice(-20) };
    }
    modelState() {
        return {
            contract: CONTRACT_VERSION, bounds: this.bounds, playbook: this.playbook, terminal: this.terminal,
            awaiting_judge: this.awaitingJudge, sql_this_turn: this.sqlThisTurn, refinements_used: this.refinements,
            non_improving_searches: this.nonImproving, must_stop_searching: this.mustStopSearching,
            requires_expansion: this.requiresExpansion,
            next_required: this.mustStopSearching || this.actions >= this.limits.actions - 2 ? 'complete_answer' : this.awaitingJudge ? 'flexible_search or transition_ring' : null,
            prior_navigation_only: this.prior, probed_regions: this.probes.slice(-20),
            judgments: this.judgments.map(j => ({ id: j.id, category: j.category, intent_fit: j.intent_fit, intent_fit_label: j.intent_fit_label, region: j.region, eligible: j.eligible, sample_count: j.sample_count, support: j.support }))
        };
    }
    snapshot() {
        return {
            ...this.modelState(), task: { playbook: this.playbook }, must_stop: Boolean(this.terminal), stop_reason: this.terminal?.reason || null,
            candidates: this.judgments.map(j => ({ ...j, recommended_action: !j.eligible ? 'reject' : j.intent_fit >= 0.8 && j.coherence === 'coherent' ? 'accept' : 'bounded', status: !j.eligible ? 'rejected' : j.intent_fit >= 0.8 && j.coherence === 'coherent' ? 'accepted' : 'frontier' })),
            frontier: this.probes.filter(p => p.status === 'candidate'), selected_ids: this.cited.map(j => j.id),
            inspected_region_count: this.judgments.filter(j => j.region).length,
            accepted_region_count: this.judgments.filter(j => j.eligible && j.intent_fit >= 0.8 && j.coherence === 'coherent').length,
            relevant_themes: [...new Set(this.judgments.filter(j => j.eligible).flatMap(j => j.themes))],
            remaining: { toolCalls: Math.max(0, this.limits.actions - this.actions), modelTokens: Math.max(0, this.limits.tokens - this.tokens) },
            trajectory: [...this.events], elapsed_ms: this.now() - this.started
        };
    }
    answer(): string {
        if (!this.terminal) throw new Error('Cannot answer before terminal state');
        const lines = [this.explanation || 'The search could not finish. Try narrowing the question.', ...this.cited.map(j => `{{${j.category}}}`)];
        if (this.bounded) lines.push(this.evidenceKind === 'literal_proxy' ? 'Scope: literal/proxy matches are not a semantic census.' : 'Scope: this answer is limited to the returned evidence; unexplored areas may differ.');
        if (this.cited.some(j => j.sample_count < 100)) lines.push('Samples below 100 reviews may be unrepresentative.');
        return lines.join('\n\n');
    }
    suggestedFollowups() { return this.followups; }
    presentation(): ToolResult[] {
        if (!this.terminal) throw new Error('Presentation requires terminal state');
        return this.cited.map(j => ({ name: 'save_selection', call_id: `presentation-${j.id}`, result: { saved: true, label: j.category, record_ids: j.evidence_ids, categories: [j.category], judgment_id: j.id, controller_generated: true } }));
    }
}
function regionKey(region: Region): string { return [region.min_x, region.max_x, region.min_y, region.max_y].map(v => v.toFixed(6)).join(','); }
function searchShape(name: string, data: Record<string, unknown>): string {
    if (name === 'sql_query') return `sql:${String(data.sql).replace(/\s+/g, ' ').trim()}:${data.workspace_set_id || '-'}`;
    const terms = [String(data.query || ''), ...((data.terms as string[]) || [])].map(normalizeSearchText).filter(Boolean).sort();
    return `${name}:${data.region ? regionKey(data.region as Region) : '-'}:${[...new Set(terms)].join('|')}:${data.match_mode || 'OR'}:${data.workspace_set_id || '-'}`;
}
function sameRegion(a: Region, b: Region): boolean { return regionKey(a) === regionKey(b); }
export type SearchPolicySnapshot = ReturnType<SearchSession['snapshot']>;
