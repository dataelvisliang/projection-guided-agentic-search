/** Topic-mode lexical retrieval. Matching rules are shared by JS and SQL. */

export const MAP_SEARCH_DEFAULT_LIMIT = 50;
export const MAP_SEARCH_MAX_LIMIT = 100;
export const MAP_SEARCH_MAX_TERMS = 12;
export const MAP_SEARCH_MIN_TOKEN_LENGTH = 3;
export const MAP_SEARCH_RECALL_PASS_LIMIT = 180;
export const MAP_SEARCH_RECALL_POOL_LIMIT = 360;
export const MAP_SEARCH_RECALL_RRF_K = 60;
export const CLUSTER_GRID_SIZE = 48;
export const MAP_SEARCH_CLUSTER_CANDIDATE_LIMIT = 48;
export const MAP_SEARCH_CLUSTER_LIMIT = 8;
export const MAP_SEARCH_ISLAND_MIN_SEPARATION = 2;
export const MAP_SEARCH_PROJECTION_RADIUS = 0.045;
export const MAP_SEARCH_PROJECTION_RADIUS_CAP = 0.2;
export const MAP_SEARCH_STRATIFIED_PER_CELL = 6;
export const COVERAGE_MIN_SCOPE_CELLS = 100;
export const COVERAGE_HIGH_WARNING_RATIO = 0.03;
export const COVERAGE_MEDIUM_WARNING_RATIO = 0.1;
export const ANALYZER_SPREAD_WARNING_RATIO = 0.5;
export const ANALYZER_MAX_ROWS = 50;
export const ANALYZER_PROJECTION_CONTEXT_SHARE = 0.25;
export const ANALYZER_NEIGHBOR_RESERVE_CAP = 13;

const STOPWORDS = new Set(['a', 'an', 'the', 'and', 'or', 'of', 'to', 'in', 'for', 'on', 'with', 'from', 'by', 'at', 'as', 'is', 'are', 'be', 'this', 'that', 'it', 'into', 'over', 'than']);

export interface Bounds { min_x: number; max_x: number; min_y: number; max_y: number }
export interface Region { min_x: number; max_x: number; min_y: number; max_y: number }
export interface SearchPlan {
    directPhrases: string[];
    directTokens: string[];
    expandedTerms: string[];
    warnings: string[];
}

export function normalizeSearchText(value: string): string {
    return value.toLowerCase()
        .replaceAll('&', ' and ')
        .replace(/['‘’ʼ]/g, '')
        .replace(/[^a-z0-9()]+/g, ' ')
        .trim();
}

/** Same chain as normalizeSearchText, for a SQL expression that yields the column text. */
export function normalizedColumnSql(columnExpression: string): string {
    return `trim(regexp_replace(replace(replace(replace(replace(replace(lower(${columnExpression}), '&', ' and '), '''', ''), '’', ''), '‘', ''), 'ʼ', ''), '[^a-z0-9()]+', ' ', 'g'))`;
}

export function sqlQuote(value: string): string {
    return `'${value.replaceAll("'", "''")}'`;
}

export function likePattern(term: string): string {
    return sqlQuote(`%${term}%`);
}

export function buildMapSearchPlan(query: string, terms: string[] = []): SearchPlan {
    const raw = [query, ...terms].map(term => term.slice(0, 90)).filter(term => term.trim());
    const directPhrases = unique(raw.map(normalizeSearchText).filter(term => term.length >= MAP_SEARCH_MIN_TOKEN_LENGTH));
    const directTokens = unique(directPhrases.flatMap(phrase => phrase.split(' ')).filter(token => token.length >= MAP_SEARCH_MIN_TOKEN_LENGTH && !STOPWORDS.has(token)));
    const expandedTerms = unique(directTokens.flatMap(morphologyVariants));
    const ordered = unique([...directPhrases, ...directTokens, ...expandedTerms]);
    const warnings = ordered.length > MAP_SEARCH_MAX_TERMS ? ['term_cap'] : [];
    const kept = new Set(ordered.slice(0, MAP_SEARCH_MAX_TERMS));
    return {
        directPhrases: directPhrases.filter(term => kept.has(term)),
        directTokens: directTokens.filter(term => kept.has(term)),
        expandedTerms: expandedTerms.filter(term => kept.has(term) && !directPhrases.includes(term) && !directTokens.includes(term)),
        warnings
    };
}

function morphologyVariants(token: string): string[] {
    if (token.length <= 4 || token.endsWith('ss')) return [];
    return [token.endsWith('s') ? token.slice(0, -1) : `${token}s`];
}

function unique(values: string[]): string[] {
    return [...new Set(values.filter(Boolean))];
}

export function validateTopicSql(sql: string): string | null {
    const stripped = stripLeadingComments(sql).trim().replace(/;\s*$/, '');
    if (!/^(select|with)\b/i.test(stripped)) return 'SQL must start with SELECT or WITH';
    if (splitStatements(stripped).length !== 1) return 'Exactly one SQL statement is allowed';
    const outside = stripStringsAndComments(stripped);
    if (/\b(drop|delete|insert|update|alter|create|truncate|exec|execute)\b/i.test(outside)) return 'SQL contains a forbidden statement';
    if (!/\breviews\b/i.test(outside)) return 'SQL must read the reviews table';
    if (/projection_[xy]\s*\*/i.test(outside)) return 'Bin with the injected projection bounds, never projection_x * N';
    if (/floor\s*\(\s*projection_[xy]\s*\//i.test(outside)) return 'Bin with FLOOR((projection_x - min_x) / range_x * N), not projection_x / N';
    return null;
}

export function prepareTopicSql(sql: string): string {
    let statement = stripLeadingComments(sql).trim().replace(/;\s*$/, '');
    if (!aggregateOrStar(statement) && !/\b__row_index__\b/i.test(statement))
        statement = statement.replace(/^\s*select\s+/i, 'SELECT __row_index__, ');
    return `SELECT * FROM (${statement}) AS topic_sql LIMIT 1000`;
}

function aggregateOrStar(sql: string): boolean {
    const outside = stripStringsAndComments(sql);
    return /\b(group\s+by|distinct|count\s*\(|avg\s*\(|sum\s*\(|min\s*\(|max\s*\(|date_trunc\s*\(|floor\s*\()\b/i.test(outside) || /\bselect\s+\*/i.test(outside);
}

function stripLeadingComments(sql: string): string {
    let rest = sql.trim();
    for (;;) {
        if (rest.startsWith('--')) {
            const newline = rest.indexOf('\n');
            rest = (newline < 0 ? '' : rest.slice(newline + 1)).trim();
        } else if (rest.startsWith('/*')) {
            const end = rest.indexOf('*/');
            if (end < 0) return rest;
            rest = rest.slice(end + 2).trim();
        } else break;
    }
    return rest;
}

function splitStatements(sql: string): string[] {
    return stripStringsAndComments(sql).split(';').map(part => part.trim()).filter(Boolean);
}

function stripStringsAndComments(sql: string): string {
    let output = '';
    for (let i = 0; i < sql.length; i++) {
        const pair = sql.slice(i, i + 2);
        if (pair === '--') { const end = sql.indexOf('\n', i); i = end < 0 ? sql.length : end; continue; }
        if (pair === '/*') { const end = sql.indexOf('*/', i + 2); i = end < 0 ? sql.length : end + 1; continue; }
        if (sql[i] === "'") { const end = sql.indexOf("'", i + 1); i = end < 0 ? sql.length : end; output += ' '; continue; }
        output += sql[i];
    }
    return output;
}

export function fuseRanks(passes: Array<{ name: string; ids: string[] }>, k = MAP_SEARCH_RECALL_RRF_K, pool = MAP_SEARCH_RECALL_POOL_LIMIT) {
    const scores = new Map<string, { score: number; passes: string[] }>();
    for (const pass of passes) {
        pass.ids.forEach((id, index) => {
            const row = scores.get(id) || { score: 0, passes: [] };
            row.score += 1 / (k + index + 1);
            row.passes.push(pass.name);
            scores.set(id, row);
        });
    }
    return [...scores.entries()]
        .sort((a, b) => b[1].score - a[1].score || a[0].localeCompare(b[0]))
        .slice(0, pool)
        .map(([id, row]) => ({ id, score: row.score, recall_passes: row.passes, recall_pass_count: row.passes.length }));
}

export interface GridCell { gx: number; gy: number; support: number }

export function selectSpreadIslands<T extends GridCell>(cells: T[], limit = MAP_SEARCH_CLUSTER_LIMIT, minSeparation = MAP_SEARCH_ISLAND_MIN_SEPARATION): T[] {
    const candidates = [...cells].sort((a, b) => b.support - a.support || a.gx - b.gx || a.gy - b.gy).slice(0, MAP_SEARCH_CLUSTER_CANDIDATE_LIMIT);
    const picked: T[] = [];
    const apart = (cell: T) => picked.every(existing => Math.max(Math.abs(existing.gx - cell.gx), Math.abs(existing.gy - cell.gy)) >= minSeparation);
    for (const cell of candidates) {
        if (!apart(cell)) continue;
        picked.push(cell);
        if (picked.length === limit) return picked;
    }
    for (const cell of candidates) {
        if (picked.includes(cell)) continue;
        picked.push(cell);
        if (picked.length === limit) break;
    }
    return picked;
}

export function selectDiversifiedRows<T extends { id: string; gx: number; gy: number; lexical_score: number }>(rows: T[], limit: number): T[] {
    const sorted = [...rows].sort((a, b) => b.lexical_score - a.lexical_score || a.id.localeCompare(b.id));
    const strongQuota = Math.min(limit, Math.max(6, Math.floor(limit * 0.4)));
    const chosen: T[] = [];
    const used = new Set<string>();
    for (const row of sorted) {
        if (chosen.length >= strongQuota) break;
        chosen.push(row);
        used.add(row.id);
    }
    const buckets = new Map<string, T[]>();
    for (const row of sorted) {
        if (used.has(row.id)) continue;
        const key = `${row.gx}:${row.gy}`;
        buckets.set(key, [...(buckets.get(key) || []), row]);
    }
    const keys = [...buckets.keys()];
    let progressed = true;
    while (chosen.length < limit && progressed) {
        progressed = false;
        for (const key of keys) {
            const next = buckets.get(key)?.shift();
            if (!next) continue;
            chosen.push(next);
            progressed = true;
            if (chosen.length >= limit) break;
        }
    }
    return chosen;
}

export function lexicalScore(text: string, plan: SearchPlan) {
    const normalized = normalizeSearchText(text);
    const phrases = plan.directPhrases.filter(term => normalized.includes(term));
    const tokens = plan.directTokens.filter(term => normalized.includes(term));
    const variants = plan.expandedTerms.filter(term => normalized.includes(term));
    return {
        lexical_score: phrases.length * 10 + tokens.length * 2 + variants.length,
        matched_term_count: new Set([...phrases, ...tokens]).size,
        phrase_score: phrases.length,
        phrase_hit: phrases.length > 0,
        term_hits: tokens.length
    };
}

export function neighborEligible(text: string, plan: SearchPlan): boolean {
    const score = lexicalScore(text, plan);
    return score.phrase_hit || score.term_hits >= 2;
}

export function evaluateCoverageWarning(scopeCells: number, directMatchCells: number, analyzedCells: number, analyzedRows: number) {
    if (scopeCells <= COVERAGE_MIN_SCOPE_CELLS) return null;
    const ratio = directMatchCells / scopeCells;
    const spreadDenom = Math.min(analyzedRows, directMatchCells);
    const clustered = spreadDenom > 0 && analyzedCells / spreadDenom < ANALYZER_SPREAD_WARNING_RATIO;
    if (ratio < COVERAGE_HIGH_WARNING_RATIO) return { level: 'high' as const, code: 'very_low_projection_coverage', requires_expansion_for_broad_scope: true, direct_match_grid_coverage: ratio, analyzer_context_clustered: clustered };
    if (ratio < COVERAGE_MEDIUM_WARNING_RATIO) return { level: 'medium' as const, code: 'low_projection_coverage', requires_expansion_for_broad_scope: true, direct_match_grid_coverage: ratio, analyzer_context_clustered: clustered };
    if (clustered) return { level: null, code: 'analyzer_context_clustered', requires_expansion_for_broad_scope: false, direct_match_grid_coverage: ratio, analyzer_context_clustered: true };
    return null;
}

export function gridIndex(value: number, min: number, range: number, size = CLUSTER_GRID_SIZE): number {
    if (!(range > 0)) return 0;
    return Math.max(0, Math.min(size - 1, Math.floor((value - min) / range * size)));
}

export function classifyIntentFit(value: number): 'high' | 'medium' | 'low' {
    if (value >= 0.8) return 'high';
    if (value >= 0.55) return 'medium';
    return 'low';
}

export function clampIntentFit(value: unknown): number {
    const number = Number(value);
    if (!Number.isFinite(number)) return 0.75;
    return Math.min(1, Math.max(0, number));
}
