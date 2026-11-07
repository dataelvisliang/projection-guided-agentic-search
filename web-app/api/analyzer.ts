import type { VercelRequest, VercelResponse } from '@vercel/node';
import { classifyIntentFit, clampIntentFit } from '../src/tools/mapSearch';

const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';

const ANALYZER_JSON_SCHEMA = {
    name: 'topic_ring_analysis',
    strict: true,
    schema: {
        type: 'object', additionalProperties: false,
        required: ['category', 'themes', 'summary', 'intent_fit', 'intent_fit_label', 'off_intent_signals', 'refinement_suggestion', 'representative_evidence_ids', 'metadata_insights', 'coherence'],
        properties: {
            category: { type: 'string' },
            themes: { type: 'array', items: { type: 'string' }, maxItems: 5 },
            summary: { type: 'string' },
            intent_fit: { type: 'number', minimum: 0, maximum: 1 },
            intent_fit_label: { type: 'string', enum: ['high', 'medium', 'low'] },
            coherence: { type: 'string', enum: ['coherent', 'mixed', 'low'] },
            off_intent_signals: { type: 'array', items: { type: 'string' } },
            refinement_suggestion: { type: 'string' },
            representative_evidence_ids: { type: 'array', items: { type: 'integer' } },
            metadata_insights: { type: 'object', additionalProperties: true }
        }
    }
} as const;

const ANALYZER_SYSTEM_PROMPT = `You judge one map ring of wine reviews against the user's topic.
Return only JSON with category (2-4 words), themes (2-5), summary (1-2 sentences, no prevalence claims beyond this sample), intent_fit from 0 to 1, intent_fit_label (high at least 0.8, medium from 0.55, otherwise low), off_intent_signals, refinement_suggestion, representative_evidence_ids chosen only from the supplied ids, and metadata_insights.
Score the supplied review text only. Coordinates and density are not evidence. Return coherence as coherent, mixed, or low based on consistency of the sampled content. Coherence and relevance are separate: a coherent region can be off intent. A mixed ring gets a lower intent_fit rather than a blended category that hides the mix. representative_evidence_ids must include only directly relevant direct_lexical_match or scope_sample ids; projection_neighbor_context ids are context only. If no direct sample supports the intent, return an empty id list and low fit.`;

export function intentFitLabel(value: number): 'high' | 'medium' | 'low' {
    return classifyIntentFit(clampIntentFit(value));
}

function parseAnalysis(content: string, allowedIds: Set<number>) {
    try {
        const jsonMatch = content.match(/```json\n([\s\S]+?)\n```/) || content.match(/\{[\s\S]+\}/);
        const parsed = JSON.parse(jsonMatch ? (jsonMatch[1] || jsonMatch[0]) : content);
        if (!parsed || typeof parsed.category !== 'string' || !parsed.category.trim() || typeof parsed.intent_fit !== 'number' || !Number.isFinite(parsed.intent_fit)) return null;
        const intent_fit = clampIntentFit(parsed.intent_fit);
        const ids = Array.isArray(parsed.representative_evidence_ids) ? parsed.representative_evidence_ids.map(Number).filter((id: number) => allowedIds.has(id)) : [];
        return {
            category: parsed.category.trim(),
            themes: Array.isArray(parsed.themes) ? parsed.themes.map(String).slice(0, 5) : [],
            summary: String(parsed.summary || ''),
            intent_fit,
            intent_fit_label: classifyIntentFit(intent_fit),
            off_intent_signals: Array.isArray(parsed.off_intent_signals) ? parsed.off_intent_signals.map(String) : [],
            refinement_suggestion: String(parsed.refinement_suggestion || ''),
            representative_evidence_ids: ids,
            metadata_insights: parsed.metadata_insights && typeof parsed.metadata_insights === 'object' ? parsed.metadata_insights : {},
            fallback: false,
            coherence: ['coherent', 'mixed', 'low'].includes(parsed.coherence) ? parsed.coherence : 'unknown'
        };
    } catch { return null; }
}

function fallbackAnalysis(reviews: Array<{ text?: string }>) {
    const counts = new Map<string, number>();
    for (const word of reviews.map(review => String(review.text || '')).join(' ').toLowerCase().match(/[a-z]{4,}/g) || [])
        counts.set(word, (counts.get(word) || 0) + 1);
    const themes = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([word]) => word);
    return {
        category: themes.slice(0, 3).join(' ') || 'Unlabeled sample',
        themes, summary: 'Analyzer fallback from sampled wording.', intent_fit: 0.5, intent_fit_label: 'low' as const,
        off_intent_signals: [], refinement_suggestion: 'Retry the judge.', representative_evidence_ids: [],
        metadata_insights: {}, fallback: true, coherence: 'unknown'
    };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    const apiKey = process.env.OPENROUTER_API_KEY;
    const model = process.env.OPENROUTER_ANALYZER_MODEL || process.env.OPENROUTER_MODEL || 'anthropic/claude-haiku-5.5';
    if (!apiKey) return res.status(500).json({ error: 'OpenRouter API key not configured' });

    const { region, reviews, prompt, intent } = req.body || {};
    if (!Array.isArray(reviews)) return res.status(400).json({ error: 'Reviews array required.' });
    if (!reviews.length) return res.status(200).json({ category: 'No Results', themes: [], summary: 'No rows were supplied.', intent_fit: 0, intent_fit_label: 'low', off_intent_signals: [], refinement_suggestion: 'Broaden the ring.', representative_evidence_ids: [], metadata_insights: {}, fallback: false });
    const focus = String(prompt || intent || 'Topic sample').slice(0, 2000);
    const allowedIds = new Set<number>(reviews.map((review: { id?: number }) => Number(review.id)).filter(Number.isInteger));
    const body = reviews.map((review: { id?: number; points?: number; price?: number; country?: string; variety?: string; evidence_type?: string; text?: string }, index: number) =>
        `[${index + 1}] id=${review.id} points=${review.points ?? 'unknown'} price=${review.price ?? 'unknown'} country=${review.country ?? 'unknown'} variety=${review.variety ?? 'unknown'} evidence=${review.evidence_type || 'direct_lexical_match'}\n${String(review.text || '').slice(0, 3500)}`
    ).join('\n\n');

    const callModel = async () => {
        const abort = new AbortController();
        const timeout = setTimeout(() => abort.abort(), 30000);
        try {
            const response = await fetch(OPENROUTER_API_URL, {
                method: 'POST', signal: abort.signal,
                headers: {
                    Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json',
                    'HTTP-Referer': req.headers.referer as string || req.headers.origin as string || 'https://localhost',
                    'X-Title': 'Topic Ring Analyzer'
                },
                body: JSON.stringify({
                    model,
                    messages: [
                        { role: 'system', content: ANALYZER_SYSTEM_PROMPT },
                        { role: 'user', content: `FOCUS: ${focus}\n\n${body}` }
                    ],
                    temperature: 0, max_tokens: 900,
                    response_format: { type: 'json_schema', json_schema: ANALYZER_JSON_SCHEMA },
                    reasoning: { enabled: false },
                    plugins: [{ id: 'response-healing' }]
                })
            });
            if (!response.ok) throw new Error(`Analyzer Agent failed: ${response.statusText}`);
            return await response.json();
        } finally { clearTimeout(timeout); }
    };

    let parsed = null;
    const usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
    for (let attempt = 0; attempt < 2 && !parsed; attempt++) {
        if (attempt) await new Promise(resolve => setTimeout(resolve, 1000));
        try {
            const data = await callModel();
            usage.prompt_tokens += Number(data.usage?.prompt_tokens) || 0;
            usage.completion_tokens += Number(data.usage?.completion_tokens) || 0;
            usage.total_tokens += Number(data.usage?.total_tokens) || 0;
            const message = data.choices?.[0]?.message;
            const content = message?.content || (message?.reasoning_details || []).map((detail: { content?: string }) => detail.content).join('\n');
            parsed = parseAnalysis(String(content || ''), allowedIds);
        } catch { parsed = null; }
    }
    const analysis = parsed || fallbackAnalysis(reviews);
    return res.status(200).json({ ...analysis, region: region || null, analyzer_usage: usage });
}
