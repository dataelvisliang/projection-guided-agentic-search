import type { VercelRequest, VercelResponse } from '@vercel/node';

import { runProjectionAgent } from './agentRuntime';
import { contextSchema } from '../src/agent/searchContract';

interface AgentMessage {
    role: string;
    content: string;
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : 'Internal server error';
}

function requestOrigin(req: VercelRequest): string {
    const proto = String(req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim();
    const host = String(req.headers['x-forwarded-host'] || req.headers.host || 'localhost:5173').split(',')[0].trim();
    return `${proto}://${host}`;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const { messages, context } = (req.body || {}) as { messages?: AgentMessage[]; context?: unknown };
    if (!Array.isArray(messages) || messages.some(message => !message || typeof message.role !== 'string' || typeof message.content !== 'string')) {
        return res.status(400).json({ error: 'Invalid request: messages array required' });
    }
    const parsedContext = contextSchema.safeParse(context || {});
    if (!parsedContext.success) return res.status(400).json({ error: 'Invalid search context or selection ids' });

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120_000);
    req.on('aborted', () => controller.abort());

    try {
        const result = await runProjectionAgent({
            messages,
            context: parsedContext.data,
            origin: requestOrigin(req),
            signal: controller.signal
        });
        return res.status(200).json({
            type: 'runtime_response',
            content: result.content,
            tool_results: result.toolResults,
            tool_sequence: result.toolSequence,
            search_policy: result.searchPolicy,
            controller_terminal: result.terminal,
            usage: result.usage,
            search_context: result.context,
            suggested_followups: result.suggestedFollowups
        });
    } catch (error: unknown) {
        if (error instanceof Error && error.name === 'AbortError') {
            return res.status(499).json({ error: 'Client closed request' });
        }
        return res.status(500).json({ error: errorMessage(error) });
    } finally {
        clearTimeout(timeout);
    }
}
