import { createHash } from 'node:crypto';
import { ToolExecutor } from '../src/tools/toolExecutor';
import type { QueryCoordinator, ToolCall, ToolExecutorOptions } from '../src/tools/toolExecutor';

/** Each request has an immutable relation; concurrent requests never mutate a shared view. */
export function scopeCoordinator(base: QueryCoordinator, selectedIds?: number[]) {
    const ids = selectedIds === undefined ? undefined : [...new Set(selectedIds)].sort((a, b) => a - b);
    if (ids?.some(id => !Number.isSafeInteger(id) || id < 0)) throw new Error('Invalid selection ids');
    const scopeKey = ids === undefined ? 'full-map' : createHash('sha256').update(JSON.stringify(ids)).digest('hex');
    const coordinator: QueryCoordinator = ids === undefined ? base : {
        query(sql) {
            const where = ids.length ? `__row_index__ IN (${ids.join(',')})` : 'FALSE';
            return base.query(`WITH reviews AS (SELECT * FROM main.reviews WHERE ${where}) SELECT * FROM (${sql}) AS scoped_query`);
        }
    };
    return { coordinator, scopeKey, selectedCount: ids?.length ?? null };
}

/** Workspace sets can narrow the request selection, but cannot widen it. */
export function createScopedExecutor(base: QueryCoordinator, selectedIds: number[] | undefined, options: ToolExecutorOptions = {}) {
    return {
        async execute(call: ToolCall) {
            const args = JSON.parse(call.function.arguments);
            let ids = selectedIds;
            if (Array.isArray(args.workspace_ids)) {
                const workspace = new Set<number>(args.workspace_ids);
                ids = selectedIds === undefined ? [...workspace] : selectedIds.filter(id => workspace.has(id));
            }
            return new ToolExecutor(scopeCoordinator(base, ids).coordinator, options).execute(call);
        }
    };
}
