import { useState, useCallback, useRef } from 'react';
import type { Coordinator } from '@uwdata/mosaic-core';

import type { SearchPolicySnapshot } from '../agent/searchSession';
import type { SearchContext } from '../agent/searchContract';
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

export function extractHighlightIds(toolResults: ToolResult[]): number[] {
    const ids = new Set<number>();
    for (const result of toolResults) {
        if (result.error) continue;
        const values = result.name === 'flexible_search'
            ? result.result?.evidence_ids || []
            : result.name === 'save_selection' ? result.result?.record_ids || []
            : (result.result?.rows || []).filter((row: { match_type?: string }) => row.match_type !== 'cluster_neighbor').map((row: { id?: number; __row_index__?: number }) => row.id ?? row.__row_index__);
        for (const id of values) if (Number.isSafeInteger(id)) ids.add(id);
    }
    return [...ids];
}

/**
 * The browser owns visual state only. The Agents SDK runtime owns model turns,
 * tool execution, policy enforcement, and the reproducible search trajectory.
 */
export function useAgentChat(coordinator: Coordinator | null) {
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
    const contextRef = useRef<SearchContext>({ probed_regions: [] });

    const applyRuntimeEffects = useCallback((toolResults: ToolResult[]) => {
        inspectedRegionsCacheRef.current = [];
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
                region.judgment_id === result.result.judgment_id && region.category === label
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
        setState(previous => ({ ...previous, highlightIds: highlightIds.length ? highlightIds : null }));
    }, []);

    const sendMessage = useCallback(async (userMessage: string, selectedPoints?: any[], _selectionPredicate?: string | null) => {
        if (!userMessage.trim() || state.isLoading) return;

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
            let selectionIds: number[] | undefined;
            if (_selectionPredicate) {
                if (!coordinator) throw new Error('The selected map is not ready.');
                const rows = (await coordinator.query(`SELECT __row_index__ AS id FROM reviews WHERE ${_selectionPredicate}`)).toArray();
                selectionIds = rows.map(row => Number(row.id));
            } else if (selectedPoints?.length) {
                const total = Number((selectedPoints as any).totalCount || selectedPoints.length);
                if (total > selectedPoints.length) throw new Error('The full selection is unavailable. Select the region again.');
                selectionIds = selectedPoints.map(point => Number(point.identifier));
            }
            const context = { ...contextRef.current, selection_ids: selectionIds };
            const messages = state.messages
                .filter(message => message.role === 'user' || message.role === 'assistant')
                .map(message => ({ role: message.role, content: message.content }));
            messages.push({ role: 'user', content: userMessage });
            const response = await fetch('/api/agent', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ messages, context }),
                signal: abortControllerRef.current.signal
            });
            const data = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(data.error || `Request failed: ${response.status}`);
            if (data.type !== 'runtime_response') throw new Error('Agent runtime returned an unsupported response');

            const toolResults = Array.isArray(data.tool_results) ? data.tool_results as ToolResult[] : [];
            if (data.search_context) contextRef.current = data.search_context;
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
    }, [applyRuntimeEffects, state.isLoading, state.messages, coordinator]);

    const clearChat = useCallback(() => {
        setState({
            messages: [INITIAL_MESSAGE], isLoading: false, isExecutingTools: false, currentStep: '', error: null,
            toolsExecuted: [], highlightIds: null, savedCategories: new Map(), inspectedRegionsCache: [], searchPolicy: null
        });
        inspectedRegionsCacheRef.current = [];
        contextRef.current = { probed_regions: [] };
    }, []);

    const clearHighlight = useCallback(() => setState(previous => ({ ...previous, highlightIds: null })), []);
    const stopGeneration = useCallback(() => abortControllerRef.current?.abort(), []);

    return { ...state, sendMessage, clearChat, clearHighlight, stopGeneration };
}
