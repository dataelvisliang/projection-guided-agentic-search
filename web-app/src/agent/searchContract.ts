import { z } from 'zod';

export const CONTRACT_VERSION = 'topic-ring-probe-v1';

const reason = z.string().trim().min(1).max(400);
export const regionSchema = z.object({
    min_x: z.number().finite(),
    max_x: z.number().finite(),
    min_y: z.number().finite(),
    max_y: z.number().finite()
}).strict().superRefine((region, ctx) => {
    if (region.min_x > region.max_x || region.min_y > region.max_y)
        ctx.addIssue({ code: 'custom', message: 'Region minimum exceeds maximum' });
});

export const PLAYBOOK_IDS = [
    'topic_exploration',
    'region_tile_discovery',
    'facet_use_case_discovery',
    'semantic_count',
    'exact_analytics',
    'dimension_signal_scan',
    'row_examples'
] as const;
export type PlaybookId = typeof PLAYBOOK_IDS[number];

export const PLAYBOOKS: Record<PlaybookId, { title: string; intentFit: string; text: string }> = {
    topic_exploration: {
        title: 'Topic exploration',
        intentFit: 'What themes or topics are in this map, a selection, or an ambiguous question.',
        text: `Procedure: For a focused question, call flexible_search directly. For an ambiguous question, run 2-4 separate interpretations, never one giant OR. For a broad, selected, or mixed landscape, seed rings with a normalized SQL density grid (48x48, then 96x96 for the densest cluster). Group sparse keyword hits into islands and give each major island its own region-constrained flexible_search. Split a mixed cell once with a finer grid (128, 160, 192, or 256) before judging it. Stop when accepted rings have non-low intent_fit, distinct themes, and coverage that fits the question.`
    },
    region_tile_discovery: {
        title: 'Region tile discovery',
        intentFit: 'The user gave a map selection or coordinates and wants the topics inside them.',
        text: `Procedure: Seed from the given bounds. If the region is large or mixed, subgrid it. Run region-constrained flexible_search on each dense subregion. Stop when each dense subregion has its own category.`
    },
    facet_use_case_discovery: {
        title: 'Facet discovery',
        intentFit: 'A cross-cutting facet (a property that scatters across many topics) rather than one dense topic.',
        text: `Procedure: Call flexible_search first with the facet plus 2-4 anchor families. Do not start from the densest clusters. Facet hits may become seed rings; the facet stays the validation anchor. Group by the job or facet, not by whichever topic is locally dense. Stop when the facet groups are coherent.`
    },
    semantic_count: {
        title: 'Semantic count',
        intentFit: 'How many reviews match a meaning, not an exact structured field.',
        text: `Procedure: The first search batch is flexible_search or map_search only. SQL is forbidden until a literal or proxy condition has been defined from the observed wording. Then measure that condition with SQL and label it as a literal or proxy count. Phrase the result as candidate matches, sampled rows, and relevant rows. A semantic count is a lower bound.`
    },
    exact_analytics: {
        title: 'Exact analytics',
        intentFit: 'A structured count or breakdown on country, variety, price, or points.',
        text: `Procedure: Use one guarded SQL statement. Do not use description ILIKE as a semantic search. ILIKE is allowed only when the user asked for an explicit literal string. This path does not require Ring Probe.`
    },
    dimension_signal_scan: {
        title: 'Dimension signal scan',
        intentFit: 'Which structured dimension best separates a topic.',
        text: `Procedure: SQL finds candidate dimensions. flexible_search checks purity of the promising slice. Code budget: 4 sql_query calls and 2 flexible_search calls, then stop_condition_met.`
    },
    row_examples: {
        title: 'Row examples',
        intentFit: 'Show specific review rows, not a topic landscape.',
        text: `Procedure: Look up rows directly with SQL or map_search. Do not expand neighbors into a cluster or call the result a topic.`
    }
};

const terms = z.array(z.string().trim().min(1).max(90)).max(12);
export const actionSchemas = {
    load_workflow_playbook: z.object({ playbook_id: z.enum(PLAYBOOK_IDS) }).strict(),
    report_progress: z.object({ message: z.string().trim().min(1).max(400) }).strict(),
    sql_query: z.object({ sql: z.string().trim().min(1).max(8000), purpose: reason }).strict(),
    map_search: z.object({
        query: z.string().trim().max(500).default(''),
        terms: terms.default([]),
        region: regionSchema.optional(),
        limit: z.number().int().min(1).max(100).optional(),
        match_mode: z.enum(['AND', 'OR']).default('OR'),
        reason
    }).strict(),
    flexible_search: z.object({
        prompt: z.string().trim().min(1).max(2000),
        query: z.string().trim().max(500).default(''),
        terms: terms.default([]),
        region: regionSchema.optional(),
        match_mode: z.enum(['AND', 'OR']).default('OR'),
        reason
    }).strict(),
    complete_answer: z.object({
        ready_to_answer: z.literal(true),
        suggested_followups: z.array(z.object({
            kind: z.enum(['compare', 'breakdown', 'investigate', 'validate']),
            text: z.string().trim().min(1).max(240)
        }).strict()).max(3),
        categories: z.array(z.string().trim().min(1).max(80)).max(8),
        bounded: z.boolean(),
        explanation: z.string().trim().min(1).max(1200)
    }).strict()
};
export type ActionName = keyof typeof actionSchemas;

export function jsonSchemaFor(name: ActionName) {
    return JSON.parse(JSON.stringify(z.toJSONSchema(actionSchemas[name])));
}

export const descriptions: Record<ActionName, string> = {
    load_workflow_playbook: 'Load exactly one Topic workflow before any search or SQL. Call this first.',
    report_progress: 'At most two business-language sentences about what you are looking for. No tool names, SQL, or ids.',
    sql_query: 'One SELECT or WITH over reviews. Use it to find or refine ring bounds with the injected projection bounds. Not a semantic keyword engine.',
    map_search: 'Lexical seed search over review descriptions. Returns ranked or recall rows and seed-island rings. Keywords only locate rings; they do not decide the answer.',
    flexible_search: 'Region-constrained judge. Runs recall map_search, then the Analyzer, and returns category, themes, and intent_fit. This is the checkpoint that can accept a ring.',
    complete_answer: 'Finish the turn. Cite only categories returned by flexible_search. Set bounded when the best cited ring is medium fit or coverage is thin.'
};

export const LIMITS = Object.freeze({
    actions: 35,
    sqlPerTurnBeforeJudge: 2,
    refinements: 3,
    nonImproving: 2,
    dimensionSql: 4,
    dimensionFlexible: 2,
    tokens: 80000,
    elapsedMs: 120000
});

const playbookToc = PLAYBOOK_IDS.map(id => `- ${id}: ${PLAYBOOKS[id].intentFit}`).join('\n');

export const AGENT_INSTRUCTIONS = `Never reveal tool names, playbooks, Ring Probe, SQL, table or column names, or tile mechanics to the user.
You search a 2-D map of wine reviews. There is no vector index. Nearby points are a hypothesis, not evidence. A ring is a bounded rectangle {min_x, max_x, min_y, max_y}. The ring, not the row, is the unit of evidence. The reviews table is the Topic table: one point is one review, the id column is __row_index__, and the only default search text is description. There is no turn filter and no conversation id. Country, variety, price, and points are structured fields for exact SQL, not semantic search columns.
Topic Ring Probe, in order:
1. Hypothesis. Infer the topic or facet from intent, not from matching words. For an ambiguous request, search 2-4 interpretations separately. Never one giant OR.
2. Seed ring. Create rings from a SQL density grid, a map selection, or keyword hits grouped into islands. Keywords never decide the workflow, the next step, or the answer.
3. Judge ring. Inspect support, density, description snippets, and coverage.
4. Transition. accept: immediately run region-constrained flexible_search. mixed: split or shift the ring once, then judge. weak: probe a neighbor or sibling ring. off-intent: discard it or change the hypothesis.
5. Synthesize only from accepted rings with adequate support and intent_fit. Never from scattered points, raw keyword hits, or visual proximity.
Grid ladder, always using the injected bounds: FLOOR((projection_x - min_x) / range_x * N). 48 for a broad start, 96 for the densest cluster, then 128, 160, 192, or 256 inside a mixed cell. Never bin with projection_x / N or projection_x * N.
Controls the session enforces: load one playbook first. Before the first flexible_search, at most two SQL queries in one assistant turn. After a viable ring exists, the next data tool must be region-constrained flexible_search. Do not repeat a search shape. After the first judged evidence, at most 3 refinements or 2 non-improving searches, then answer with a caveat. intent_fit high is at least 0.8, medium is 0.55 to 0.79, and low is below 0.55. Never answer from a low ring. A medium ring needs bounded language.
Answer shape: lead with the insight, then one {{Category}} token per line using only names flexible_search returned. Do not narrate the search.
Playbooks:
${playbookToc}`;
