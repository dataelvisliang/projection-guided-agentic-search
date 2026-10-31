import { useState, useCallback, useRef } from 'react';
import type { Coordinator } from '@uwdata/mosaic-core';

import type { SearchPolicySnapshot } from '../agent/searchSession';
import type { ToolResult } from '../tools/toolExecutor';

export interface Message {
    role: 'user' | 'assistant' | 'tool';
    content: string;
    toolResults?: ToolResult[];
}

export interface AgentState {
    messages: Message[];
    isLoading: boolean;
    isExecutingTools: boolean;
    currentStep: string;
    error: string | null;
    toolsExecuted: string[];
    highlightIds: number[] | null;
    savedCategories: Map<string, any[]>;
    inspectedRegionsCache: any[];
    searchPolicy: SearchPolicySnapshot | null;
}

const INITIAL_MESSAGE: Message = {
    role: 'assistant',
    content: `Hello! I'm your AI Sommelier and Wine Data Analyst.

I search the wine map by region: I locate a topic on the map, check the reviews inside that area, and answer from the areas that actually match.

Try asking: "Find me good value reds under $20" or "What are the common flavors in Tuscan wines?"`
};

function selectedReviewsContext(selectedPoints: any[], userMessage: string): string {
    const totalSelected = (selectedPoints as any).totalCount || selectedPoints.length;
    const maxContextChars = 100_000;
    const reviews: string[] = [];
    let totalChars = 0;
    for (let index = 0; index < selectedPoints.length; index++) {
        const point = selectedPoints[index];
        const text = `[Review ${index + 1}] Points: ${point.fields?.points ?? point.fields?.Rating ?? 'N/A'} | Title: ${point.fields?.title ?? 'Unknown Wine'}\n${point.fields?.description ?? point.text ?? 'No description'}`;
        if (totalChars + text.length > maxContextChars) break;
        reviews.push(text);
        totalChars += text.length;
    }
    const scores = selectedPoints.slice(0, reviews.length)
        .map((point: any) => point.fields?.points ?? point.fields?.Rating)
        .filter((score: unknown): score is number => typeof score === 'number');
    const averageScore = scores.length ? (scores.reduce((sum, score) => sum + score, 0) / scores.length).toFixed(1) : 'N/A';
    return `IMPORTANT: The user selected ${totalSelected} reviews on the visualization. Answer about this subset unless they explicitly ask to compare it with the full map.
Selection sample: ${reviews.length}/${totalSelected}; average score: ${averageScore}.

Selected reviews:
${reviews.join('\n\n')}

User question: ${userMessage}`;
}

function extractHighlightIds(toolResults: ToolResult[]): number[] {
    const ids = new Set<number>();
    for (const result of toolResults) {
        for (const review of result.result?.reviews || result.result?.rows || []) if (typeof review.id === 'number') ids.add(review.id);
        for (const id of result.result?.evidence_ids || result.result?.highlight_ids || []) if (typeof id === 'number') ids.add(id);
        for (const region of result.result?.regions || []) {
            for (const review of region.reviews || []) if (typeof review.id === 'number') ids.add(review.id);
        }
    }
    return [...ids];
}

/**
 * The browser owns visual state only. The Agents SDK runtime owns model turns,
 * tool execution, policy enforcement, and the reproducible search trajectory.
 */
export function useAgentChat(_coordinator: Coordinator | null) {
    const [state, setState] = useState<AgentState>({
        messages: [INITIAL_MESSAGE],
        isLoading: false,
        isExecutingTools: false,
        currentStep: '',
        error: null,
        toolsExecuted: [],
        highlightIds: null,
        savedCategories: new Map(),
        inspectedRegionsCache: [],
        searchPolicy: null
    });
    const abortControllerRef = useRef<AbortController | null>(null);
    const inspectedRegionsCacheRef = useRef<any[]>([]);

    const applyRuntimeEffects = useCallback((toolResults: ToolResult[]) => {
        for (const result of toolResults) {
            if (result.name === 'flexible_search' && result.result?.category) {
                inspectedRegionsCacheRef.current.push({
                    ...result.result,
                    review_ids: result.result.evidence_ids || [],
                    reviews: (result.result.rows || []).map((row: { id: number; excerpt?: string }) => ({ id: row.id, text: row.excerpt })),
                    intent_match: result.result.intent_fit
                });
            }
            if (result.name === 'filter_records' && Array.isArray(result.result?.reviews)) {
                const reviews = result.result.reviews;
                inspectedRegionsCacheRef.current.push({
                    category: 'Structured search', themes: [], review_ids: reviews.map((review: any) => review.id), reviews
                });
            }
        }

        for (const result of toolResults) {
            if (result.name !== 'save_selection' || !result.result?.saved) continue;
            const { record_ids: recordIds, label } = result.result;
            const matchedRegions = inspectedRegionsCacheRef.current.filter(region =>
                recordIds.some((id: number) => region.review_ids?.includes(id))
            );
            const matchedReviews = matchedRegions.flatMap(region =>
                (region.reviews || []).filter((review: any) => recordIds.includes(review.id))
            );
            const uniqueReviews = [...new Map(matchedReviews.map(review => [review.id, review])).values()];
            if (!matchedRegions.length) continue;
            const average = (key: string) => {
                const values = matchedRegions.map(region => Number(region[key])).filter(Number.isFinite);
                return values.length ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length * 1000) / 1000 : null;
            };
            const category = {
                category: label,
                analyzer_category: matchedRegions.map(region => region.category).filter(Boolean).join(' + '),
                themes: [...new Set(matchedRegions.flatMap(region => region.themes || []))],
                quotes: [...new Set(matchedRegions.flatMap(region => region.quotes || []))],
                intent: matchedRegions[0].intent,
                purity: average('purity'),
                intent_match: average('intent_match'),
                review_ids: uniqueReviews.map(review => review.id),
                reviews: uniqueReviews,
                regions: matchedRegions.map(region => ({
                    id: region.id, center_x: region.center_x, center_y: region.center_y, radius: region.radius,
                    purity: region.purity, intent_match: region.intent_match
                })),
                count: uniqueReviews.length
            };
            setState(previous => ({
                ...previous,
                savedCategories: new Map(previous.savedCategories).set(label, [category])
            }));
        }
        const highlightIds = extractHighlightIds(toolResults);
        if (highlightIds.length) setState(previous => ({ ...previous, highlightIds }));
    }, []);

    const sendMessage = useCallback(async (userMessage: string, selectedPoints?: any[], _selectionPredicate?: string | null) => {
        if (!userMessage.trim() || state.isLoading) return;
        const userMessageForAgent = selectedPoints?.length ? selectedReviewsContext(selectedPoints, userMessage) : userMessage;
        const userMsg: Message = { role: 'user', content: userMessage };
        setState(previous => ({
            ...previous,
            messages: [...previous.messages, userMsg],
            isLoading: true,
            error: null,
            currentStep: 'Searching the projection…',
            toolsExecuted: []
        }));

        abortControllerRef.current = new AbortController();
        try {
            const messages = state.messages
                .filter(message => message.role === 'user' || message.role === 'assistant')
                .map(message => ({ role: message.role, content: message.content }));
            messages.push({ role: 'user', content: userMessageForAgent });
            const response = await fetch('/api/agent', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ messages }),
                signal: abortControllerRef.current.signal
            });
            const data = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(data.error || `Request failed: ${response.status}`);
            if (data.type !== 'runtime_response') throw new Error('Agent runtime returned an unsupported response');

            const toolResults = Array.isArray(data.tool_results) ? data.tool_results as ToolResult[] : [];
            applyRuntimeEffects(toolResults);
            const assistantMsg: Message = {
                role: 'assistant',
                content: data.content || 'I could not generate a response.',
                toolResults
            };
            setState(previous => ({
                ...previous,
                messages: [...previous.messages, assistantMsg],
                isLoading: false,
                isExecutingTools: false,
                currentStep: '',
                toolsExecuted: Array.isArray(data.tool_sequence) ? data.tool_sequence : [],
                searchPolicy: data.search_policy || null
            }));
        } catch (error) {
            const cancelled = error instanceof Error && error.name === 'AbortError';
            const message = cancelled ? 'Request cancelled.' : error instanceof Error ? error.message : 'An unexpected error occurred';
            setState(previous => ({
                ...previous,
                isLoading: false,
                isExecutingTools: false,
                currentStep: '',
                error: cancelled ? null : message,
                messages: [...previous.messages, { role: 'assistant', content: cancelled ? message : `I encountered an error: ${message}\n\nPlease try again or rephrase your question.` }]
            }));
        } finally {
            abortControllerRef.current = null;
        }
    }, [applyRuntimeEffects, state.isLoading, state.messages]);

    const clearChat = useCallback(() => {
        setState({
            messages: [INITIAL_MESSAGE], isLoading: false, isExecutingTools: false, currentStep: '', error: null,
            toolsExecuted: [], highlightIds: null, savedCategories: new Map(), inspectedRegionsCache: [], searchPolicy: null
        });
        inspectedRegionsCacheRef.current = [];
    }, []);

    const clearHighlight = useCallback(() => setState(previous => ({ ...previous, highlightIds: null })), []);
    const stopGeneration = useCallback(() => abortControllerRef.current?.abort(), []);

    return { ...state, sendMessage, clearChat, clearHighlight, stopGeneration };
}
