/* DuckDB rows and LLM tool payloads are runtime-shaped at this browser boundary. */
/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Coordinator } from '@uwdata/mosaic-core';
import {
    ANALYZER_MAX_ROWS, ANALYZER_NEIGHBOR_RESERVE_CAP, ANALYZER_PROJECTION_CONTEXT_SHARE,
    MAP_SEARCH_DEFAULT_LIMIT, MAP_SEARCH_MAX_LIMIT, MAP_SEARCH_PROJECTION_RADIUS, MAP_SEARCH_PROJECTION_RADIUS_CAP,
    MAP_SEARCH_RECALL_PASS_LIMIT, MAP_SEARCH_STRATIFIED_PER_CELL, buildMapSearchPlan, classifyIntentFit,
    evaluateCoverageWarning, fuseRanks, gridIndex, lexicalScore, likePattern, neighborEligible,
    normalizedColumnSql, prepareTopicSql, selectDiversifiedRows, selectSpreadIslands, validateTopicSql
} from './mapSearch';
import type { Bounds, Region, SearchPlan } from './mapSearch';

export interface ToolCall {
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
}

export interface ToolResult {
    name: string;
    call_id: string;
    result: any;
    error?: string;
}

const COLUMNS = '__row_index__, description, title, points, price, variety, country, projection_x, projection_y';
const finite = (value: unknown, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;

function normalizeValue(value: any): any {
    if (typeof value === 'bigint') return Number(value);
    if (Array.isArray(value)) return value.map(normalizeValue);
    if (ArrayBuffer.isView(value)) return Array.from(value as unknown as ArrayLike<unknown>, normalizeValue);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalizeValue(item)]));
    return value;
}

export interface QueryCoordinator { query(sql: string): Promise<{ toArray(): any[] }>; }

export interface ToolExecutorOptions {
    analyzerUrl?: string;
    signal?: AbortSignal;
}

export class ToolExecutor {
    private coordinator: QueryCoordinator;
    private analyzerUrl: string;
    private signal?: AbortSignal;

    constructor(coordinator: Pick<Coordinator, 'query'> | QueryCoordinator, options: ToolExecutorOptions = {}) {
        this.coordinator = coordinator;
        this.analyzerUrl = options.analyzerUrl || '/api/analyzer';
        this.signal = options.signal;
    }

    async execute(toolCall: ToolCall): Promise<ToolResult> {
        const { name, arguments: rawArguments } = toolCall.function;
        let args: any;
        try { args = JSON.parse(rawArguments || '{}'); }
        catch { return { name, call_id: toolCall.id, result: null, error: `Invalid JSON arguments: ${rawArguments}` }; }
        try {
            switch (name) {
                case 'sql_query': return await this.sqlQuery(toolCall.id, args);
                case 'map_search': return await this.mapSearch(toolCall.id, args);
                case 'flexible_search': return await this.flexibleSearch(toolCall.id, args);
                default: return { name, call_id: toolCall.id, result: null, error: `Unknown tool: ${name}` };
            }
        } catch (error) {
            return { name, call_id: toolCall.id, result: null, error: error instanceof Error ? error.message : 'Tool execution failed' };
        }
    }

    private async query(sql: string): Promise<any[]> {
        this.signal?.throwIfAborted();
        return (await this.coordinator.query(sql)).toArray().map(normalizeValue);
    }

    private async sqlQuery(callId: string, args: { sql?: string }): Promise<ToolResult> {
        const problem = validateTopicSql(String(args.sql || ''));
        if (problem) return { name: 'sql_query', call_id: callId, result: null, error: problem };
        const rows = await this.query(prepareTopicSql(String(args.sql)));
        const candidate_rings = rows.filter(row => [row.min_x, row.max_x, row.min_y, row.max_y].every((value: unknown) => Number.isFinite(Number(value)))).map(row => ({
            min_x: Number(row.min_x), max_x: Number(row.max_x), min_y: Number(row.min_y), max_y: Number(row.max_y),
            support: Number(row.cnt ?? row.count ?? row.density ?? 0)
        }));
        return { name: 'sql_query', call_id: callId, result: { rows, candidate_rings, row_count: rows.length } };
    }

    private async mapSearch(callId: string, args: any): Promise<ToolResult> {
        const found = await this.retrieve(args);
        return { name: 'map_search', call_id: callId, result: found };
    }

    private async flexibleSearch(callId: string, args: any): Promise<ToolResult> {
        const retrieval = await this.retrieve({ ...args, search_strategy: 'recall', expand_clusters: true, max_expanded: 25, limit: MAP_SEARCH_DEFAULT_LIMIT });
        const region = args.region as Region | undefined;
        if (!retrieval.rows.length) {
            return { name: 'flexible_search', call_id: callId, result: {
                ...retrieval, category: 'No Results', themes: [], summary: 'The ring contained no lexical or stratified rows.',
                intent_fit: 0, intent_fit_label: 'low', off_intent_signals: [], refinement_suggestion: 'Broaden the ring or change the hypothesis.',
                representative_evidence_ids: [], evidence_ids: [], metadata_insights: {}, region: region || null, fallback: false
            } };
        }
        const plan = buildMapSearchPlan(String(args.query || ''), args.terms || []);
        const direct = retrieval.rows.filter(row => row.match_type !== 'cluster_neighbor');
        const eligibleNeighbors = retrieval.expanded_rows.filter(row => neighborEligible(String(row.description || ''), plan));
        const reserve = Math.min(ANALYZER_NEIGHBOR_RESERVE_CAP, Math.ceil(ANALYZER_MAX_ROWS * ANALYZER_PROJECTION_CONTEXT_SHARE));
        const neighborCount = Math.min(reserve, eligibleNeighbors.length);
        const chosen = [...direct.slice(0, ANALYZER_MAX_ROWS - neighborCount), ...eligibleNeighbors.slice(0, neighborCount)];
        const analyzerRows = chosen.map(row => ({
            id: row.id, points: row.points, price: row.price, country: row.country, variety: row.variety, title: row.title,
            evidence_type: row.match_type === 'cluster_neighbor' ? 'projection_neighbor_context' : plan.directPhrases.length ? 'direct_lexical_match' : 'scope_sample',
            text: String(row.description || '').slice(0, 3500)
        }));
        const analysis = await this.analyze(args.prompt || args.query || 'Topic sample', analyzerRows, region);
        const directIds = new Set(direct.slice(0, ANALYZER_MAX_ROWS - neighborCount).map(row => row.id));
        const evidence_ids = analysis.representative_evidence_ids.filter((id: number) => directIds.has(id));
        const diagnostics = await this.coverage(boundsOf(args.bounds), region, plan.directPhrases.length ? plan : null, chosen, args.match_mode === 'AND' ? 'AND' : 'OR');
        return { name: 'flexible_search', call_id: callId, result: {
            ...retrieval, ...analysis, ...diagnostics, sample_count: chosen.length,
            evidence_ids, highlight_ids: evidence_ids, region: region || null,
            rows: chosen.map(row => ({ id: row.id, excerpt: String(row.description || '').slice(0, 300) }))
        } };
    }

    private async retrieve(args: any) {
        const bounds = boundsOf(args.bounds);
        const plan = buildMapSearchPlan(String(args.query || ''), Array.isArray(args.terms) ? args.terms : []);
        const limit = Math.floor(Math.min(MAP_SEARCH_MAX_LIMIT, Math.max(1, finite(args.limit, MAP_SEARCH_DEFAULT_LIMIT))));
        const region = args.region as Region | undefined;
        const hasTerms = plan.directPhrases.length + plan.directTokens.length + plan.expandedTerms.length > 0;
        const strategy = args.search_strategy || (hasTerms ? 'ranked' : 'recall');
        const matchMode = args.match_mode === 'AND' ? 'AND' : 'OR';
        let rows: ReviewRow[] = [];
        let method = 'ranked';
        let recall_passes: string[] = [];
        if (!hasTerms) {
            method = 'scope_stratified_grid_v1';
            rows = await this.stratified(bounds, region, limit);
        } else if (strategy === 'recall') {
            method = 'multi_pass_rrf_grid_v1';
            const fused = await this.recall(plan, region, args.match_mode === 'AND' ? 'AND' : 'OR');
            recall_passes = fused.passes;
            rows = diversify(fused.rows, limit, bounds);
        } else {
            rows = diversify(await this.ranked(plan, region, Math.max(limit, 180), matchMode), limit, bounds);
        }
        const expanded_rows = args.expand_clusters ? await this.expand(rows, region) : [];
        const seed_islands = hasTerms ? await this.islands(plan, bounds, region, args.match_mode === 'AND' ? 'AND' : 'OR') : [];
        const diagnostics = await this.coverage(bounds, region, hasTerms ? plan : null, rows, matchMode);
        const matchRows = await this.countMatches(plan, region, hasTerms, matchMode);
        const scopeRows = await this.query(`SELECT COUNT(*) AS scope_count FROM reviews WHERE ${scopeSql(region)}`);
        return {
            method, warnings: plan.warnings, recall_passes, rows, expanded_rows, seed_islands, ...diagnostics,
            scope_count: Number(scopeRows[0]?.scope_count || 0), sample_count: rows.length,
            lexical_match_count: matchRows, region: region || null,
            region_contract: {
                region_role: 'candidate_navigation_region', region_coherence_status: 'unvalidated',
                semantic_cluster_status: 'unconfirmed', direct_evidence_disposition: 'region_rejection_does_not_decide_row_relevance'
            }
        };
    }

    private async ranked(plan: SearchPlan, region: Region | undefined, limit: number, matchMode: 'AND' | 'OR'): Promise<ReviewRow[]> {
        const score = scoreSql(plan);
        const rows = await this.query(`
            SELECT ${COLUMNS}, ${score.lexical} AS lexical_score, ${score.matched} AS matched_term_count, ${score.phrases} AS phrase_score
            FROM reviews
            WHERE ${scopeSql(region)} AND (${matchSql(plan, matchMode)})
            ORDER BY lexical_score DESC, matched_term_count DESC, phrase_score DESC, __row_index__ ASC
            LIMIT ${limit}
        `);
        return rows.map(row => toReview(row, 'direct'));
    }

    private async recall(plan: SearchPlan, region: Region | undefined, matchMode: 'AND' | 'OR') {
        const passes: Array<{ name: string; ids: string[] }> = [];
        const phraseWhere = plan.directPhrases.length ? plan.directPhrases.map(term => like(term)).join(matchMode === 'AND' ? ' AND ' : ' OR ') : '';
        if (phraseWhere) passes.push({ name: 'phrase', ids: await this.passIds(region, phraseWhere) });
        if (plan.directTokens.length > 1) passes.push({ name: 'all_tokens', ids: await this.passIds(region, plan.directTokens.map(term => like(term)).join(' AND ')) });
        if (plan.directTokens.length) passes.push({ name: 'any_token', ids: await this.passIds(region, plan.directTokens.map(term => like(term)).join(' OR ')) });
        if (plan.expandedTerms.length) passes.push({ name: 'morphology', ids: await this.passIds(region, plan.expandedTerms.map(term => like(term)).join(' OR ')) });
        const fused = fuseRanks(passes);
        if (!fused.length) return { rows: [] as ReviewRow[], passes: passes.map(pass => pass.name) };
        const ids = fused.map(row => Number(row.id)).filter(Number.isInteger);
        const fetched = await this.query(`SELECT ${COLUMNS} FROM reviews WHERE ${scopeSql(region)} AND (${matchSql(plan, matchMode)}) AND __row_index__ IN (${ids.join(',')})`);
        const byId = new Map(fetched.map(row => [Number(row.__row_index__), row]));
        const rows = fused.flatMap(item => {
            const row = byId.get(Number(item.id));
            if (!row) return [];
            const scored = lexicalScore(String(row.description || ''), plan);
            return [toReview({ ...row, ...scored, recall_pass_count: item.recall_pass_count, recall_passes: item.recall_passes }, 'direct')];
        });
        return { rows, passes: passes.map(pass => pass.name) };
    }

    private async passIds(region: Region | undefined, where: string): Promise<string[]> {
        const rows = await this.query(`
            SELECT __row_index__ AS id FROM reviews
            WHERE ${scopeSql(region)} AND (${where})
            ORDER BY __row_index__ ASC
            LIMIT ${MAP_SEARCH_RECALL_PASS_LIMIT}
        `);
        return rows.map(row => String(row.id));
    }

    private async stratified(bounds: Bounds, region: Region | undefined, limit: number): Promise<ReviewRow[]> {
        const { rangeX, rangeY } = ranges(bounds);
        const rows = await this.query(`
            SELECT * FROM (
                SELECT ${COLUMNS}, ROW_NUMBER() OVER (
                    PARTITION BY FLOOR((projection_x - ${bounds.min_x}) / ${rangeX} * 48), FLOOR((projection_y - ${bounds.min_y}) / ${rangeY} * 48)
                    ORDER BY hash(__row_index__), __row_index__
                ) AS rn
                FROM reviews WHERE ${scopeSql(region)}
            ) sampled WHERE rn <= ${MAP_SEARCH_STRATIFIED_PER_CELL}
            ORDER BY rn, hash(FLOOR((projection_x - ${bounds.min_x}) / ${rangeX} * 48), FLOOR((projection_y - ${bounds.min_y}) / ${rangeY} * 48)), __row_index__
            LIMIT 360
        `);
        return diversify(rows.map(row => toReview({ ...row, lexical_score: 0 }, 'direct')), limit, bounds);
    }

    private async islands(plan: SearchPlan, bounds: Bounds, region: Region | undefined, matchMode: 'AND' | 'OR') {
        const { rangeX, rangeY } = ranges(bounds);
        const rows = await this.query(`
            SELECT gx, gy, COUNT(*) AS support, MIN(projection_x) AS min_x, MAX(projection_x) AS max_x,
                   MIN(projection_y) AS min_y, MAX(projection_y) AS max_y, MIN(__row_index__) AS sample_id
            FROM (
                SELECT __row_index__, projection_x, projection_y,
                       FLOOR((projection_x - ${bounds.min_x}) / ${rangeX} * 48) AS gx,
                       FLOOR((projection_y - ${bounds.min_y}) / ${rangeY} * 48) AS gy
                FROM reviews WHERE ${scopeSql(region)} AND (${matchSql(plan, matchMode)})
            ) matches
            GROUP BY gx, gy
            ORDER BY support DESC, gx, gy
            LIMIT 48
        `);
        return selectSpreadIslands(rows.map(row => ({
            gx: Number(row.gx), gy: Number(row.gy), support: Number(row.support),
            bbox: { min_x: Number(row.min_x), max_x: Number(row.max_x), min_y: Number(row.min_y), max_y: Number(row.max_y) },
            support_count: Number(row.support), sample_ids: [Number(row.sample_id)],
            region_role: 'candidate_navigation_region', region_coherence_status: 'unvalidated',
            semantic_cluster_status: 'unconfirmed', direct_evidence_disposition: 'region_rejection_does_not_decide_row_relevance'
        }))).map(cell => ({
            bbox: cell.bbox, support_count: cell.support_count, sample_ids: cell.sample_ids,
            region_role: cell.region_role, region_coherence_status: cell.region_coherence_status,
            semantic_cluster_status: cell.semantic_cluster_status, direct_evidence_disposition: cell.direct_evidence_disposition
        }));
    }

    private async expand(seeds: ReviewRow[], region?: Region): Promise<ReviewRow[]> {
        const anchors = seeds.filter(row => Number.isFinite(row.projection_x)).slice(0, 12);
        if (!anchors.length) return [];
        const radius = Math.min(MAP_SEARCH_PROJECTION_RADIUS, MAP_SEARCH_PROJECTION_RADIUS_CAP);
        const ids = [...new Set(seeds.map(row => row.id))].join(',');
        const near = anchors.map(row => `(projection_x - ${row.projection_x}) * (projection_x - ${row.projection_x}) + (projection_y - ${row.projection_y}) * (projection_y - ${row.projection_y}) <= ${radius * radius}`).join(' OR ');
        const distanceSql = `LEAST(${anchors.map(row => `(projection_x - ${row.projection_x}) * (projection_x - ${row.projection_x}) + (projection_y - ${row.projection_y}) * (projection_y - ${row.projection_y})`).join(',')})`;
        const rows = await this.query(`
            SELECT ${COLUMNS}, ${distanceSql} AS projection_distance FROM reviews
            WHERE ${scopeSql(region)} AND __row_index__ NOT IN (${ids || 'NULL'}) AND (${near})
            ORDER BY projection_distance ASC, __row_index__ ASC
            LIMIT 25
        `);
        return rows.map(row => {
            const distance = Math.min(...anchors.map(seed => Math.hypot(Number(row.projection_x) - seed.projection_x, Number(row.projection_y) - seed.projection_y)));
            return { ...toReview(row, 'cluster_neighbor'), distance };
        }).sort((a, b) => a.distance - b.distance).slice(0, 25);
    }

    private async coverage(bounds: Bounds, region: Region | undefined, plan: SearchPlan | null, rows: ReviewRow[], mode: 'AND' | 'OR') {
        const scopeCells = await this.cellCount(bounds, region, null);
        const directCells = plan ? await this.cellCount(bounds, region, plan, mode) : scopeCells;
        const keys = [...new Set(rows.map(row => `${gridIndex(row.projection_x, bounds.min_x, bounds.max_x - bounds.min_x)}:${gridIndex(row.projection_y, bounds.min_y, bounds.max_y - bounds.min_y)}`))];
        return {
            coverage_warning: evaluateCoverageWarning(scopeCells, directCells, keys.length, rows.length),
            projection_coverage: { scope_cells: scopeCells, direct_match_cells: directCells, analyzed_cells: keys.length, analyzed_rows: rows.length, returned_cell_keys: keys }
        };
    }

    private async cellCount(bounds: Bounds, region: Region | undefined, plan: SearchPlan | null, mode: 'AND' | 'OR' = 'OR'): Promise<number> {
        const { rangeX, rangeY } = ranges(bounds);
        const match = plan ? ` AND (${matchSql(plan, mode)})` : '';
        const rows = await this.query(`
            SELECT COUNT(*) AS cells FROM (
                SELECT 1 FROM reviews
                WHERE ${scopeSql(region)}${match}
                GROUP BY FLOOR((projection_x - ${bounds.min_x}) / ${rangeX} * 48), FLOOR((projection_y - ${bounds.min_y}) / ${rangeY} * 48)
            ) cells
        `);
        return Number(rows[0]?.cells || 0);
    }

    private async countMatches(plan: SearchPlan, region: Region | undefined, hasTerms: boolean, mode: 'AND' | 'OR'): Promise<number> {
        if (!hasTerms) return 0;
        const rows = await this.query(`SELECT COUNT(*) AS matches FROM reviews WHERE ${scopeSql(region)} AND (${matchSql(plan, mode)})`);
        return Number(rows[0]?.matches || 0);
    }

    private async analyze(prompt: string, reviews: any[], region?: Region) {
        let failure: unknown;
        for (let attempt = 0; attempt < 2; attempt++) {
            if (attempt) await new Promise(resolve => setTimeout(resolve, 1000));
            try {
                const timeout = AbortSignal.timeout(30000);
                const signal = this.signal ? AbortSignal.any([this.signal, timeout]) : timeout;
                const response = await fetch(this.analyzerUrl, {
                    method: 'POST', signal, headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ prompt, region, reviews })
                });
                if (!response.ok) throw new Error(`Analyzer API returned ${response.status}`);
                const body = await response.json();
                const intent_fit = Number.isFinite(Number(body.intent_fit)) ? Math.min(1, Math.max(0, Number(body.intent_fit))) : 0.5;
                return {
                    category: String(body.category || 'Unlabeled sample'),
                    themes: Array.isArray(body.themes) ? body.themes.map(String).slice(0, 5) : [],
                    summary: String(body.summary || ''),
                    intent_fit, intent_fit_label: classifyIntentFit(intent_fit),
                    off_intent_signals: Array.isArray(body.off_intent_signals) ? body.off_intent_signals.map(String) : [],
                    refinement_suggestion: String(body.refinement_suggestion || ''),
                    representative_evidence_ids: Array.isArray(body.representative_evidence_ids) ? body.representative_evidence_ids : [],
                    metadata_insights: body.metadata_insights && typeof body.metadata_insights === 'object' ? body.metadata_insights : {},
                    fallback: Boolean(body.fallback),
                    coherence: ['coherent', 'mixed', 'low'].includes(body.coherence) ? body.coherence : 'unknown',
                    analyzer_usage: body.analyzer_usage
                };
            } catch (error) { failure = error; }
        }
        const text = reviews.map(review => String(review.text || '')).join(' ');
        const themes = topWords(text, 5);
        return {
            category: themes.slice(0, 3).join(' ') || 'Unlabeled sample', themes, summary: 'Analyzer fallback from sampled wording.',
            intent_fit: 0.5, intent_fit_label: 'low' as const, off_intent_signals: [], refinement_suggestion: 'Retry the judge.',
            representative_evidence_ids: [], metadata_insights: {}, fallback: true, coherence: 'unknown',
            analyzer_status: failure instanceof Error ? failure.message : 'analyzer_failed'
        };
    }
}

interface ReviewRow {
    id: number; description: string; title: string; points: number; price: number; variety: string; country: string;
    projection_x: number; projection_y: number; lexical_score: number; match_type: 'direct' | 'cluster_neighbor';
    distance?: number; recall_passes?: string[];
}

function toReview(row: any, matchType: ReviewRow['match_type']): ReviewRow {
    return {
        id: Number(row.__row_index__), description: String(row.description || ''), title: String(row.title || ''),
        points: Number(row.points), price: Number(row.price), variety: String(row.variety || ''), country: String(row.country || ''),
        projection_x: Number(row.projection_x), projection_y: Number(row.projection_y),
        lexical_score: Number(row.lexical_score || 0), match_type: matchType, recall_passes: row.recall_passes
    };
}

function diversify(rows: ReviewRow[], limit: number, bounds: Bounds): ReviewRow[] {
    const { rangeX, rangeY } = ranges(bounds);
    return selectDiversifiedRows(rows.map(row => ({
        ...row, gx: gridIndex(row.projection_x, bounds.min_x, rangeX), gy: gridIndex(row.projection_y, bounds.min_y, rangeY)
    })), limit);
}

function boundsOf(value: any): Bounds {
    const bounds = {
        min_x: finite(value?.min_x), max_x: finite(value?.max_x, 1),
        min_y: finite(value?.min_y), max_y: finite(value?.max_y, 1)
    };
    if (bounds.max_x <= bounds.min_x) bounds.max_x = bounds.min_x + 1;
    if (bounds.max_y <= bounds.min_y) bounds.max_y = bounds.min_y + 1;
    return bounds;
}

function ranges(bounds: Bounds) {
    return { rangeX: Math.max(bounds.max_x - bounds.min_x, 1e-9), rangeY: Math.max(bounds.max_y - bounds.min_y, 1e-9) };
}

function scopeSql(region?: Region): string {
    if (!region) return 'TRUE';
    return `projection_x BETWEEN ${region.min_x} AND ${region.max_x} AND projection_y BETWEEN ${region.min_y} AND ${region.max_y}`;
}

function like(term: string): string {
    return `${normalizedColumnSql('description')} LIKE ${likePattern(term)}`;
}

function matchSql(plan: SearchPlan, mode: 'AND' | 'OR'): string {
    if (mode === 'AND') return plan.directPhrases.map(like).join(' AND ') || 'TRUE';
    const phrases = plan.directPhrases.map(like);
    const tokens = plan.directTokens.map(like);
    const variants = plan.expandedTerms.map(like);
    const parts = [...phrases, ...tokens, ...variants];
    return parts.length ? parts.join(' OR ') : 'TRUE';
}

function scoreSql(plan: SearchPlan) {
    const sum = (terms: string[], weight: number) => terms.length ? terms.map(term => `CASE WHEN ${like(term)} THEN ${weight} ELSE 0 END`).join(' + ') : '0';
    const hits = (terms: string[]) => terms.length ? terms.map(term => `CASE WHEN ${like(term)} THEN 1 ELSE 0 END`).join(' + ') : '0';
    return {
        lexical: `(${sum(plan.directPhrases, 10)}) + (${sum(plan.directTokens, 2)}) + (${sum(plan.expandedTerms, 1)})`,
        matched: `(${hits(plan.directPhrases)}) + (${hits(plan.directTokens)})`,
        phrases: `(${sum(plan.directPhrases, 1)})`
    };
}

function topWords(text: string, count: number): string[] {
    const counts = new Map<string, number>();
    for (const word of text.toLowerCase().match(/[a-z]{4,}/g) || []) counts.set(word, (counts.get(word) || 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, count).map(([word]) => word);
}
