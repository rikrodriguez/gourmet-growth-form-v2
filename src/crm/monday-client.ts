import type { MondayBoardPreflight, MondayClient, MondayColumnValues, MondayItem } from './contracts';
import { EXPECTED_COLUMNS, MONDAY_COLUMNS } from './monday-mapping';

export class MondayApiError extends Error {
  constructor(
    readonly code: string,
    readonly retryable: boolean,
    readonly retryAfterMs: number | null = null,
    readonly ambiguous = false,
  ) {
    super(code);
    this.name = 'MondayApiError';
  }
}

type MondayClientConfig = {
  token: string;
  boardId: string;
  groupId: string;
  apiVersion?: string;
  timeoutMs?: number;
  request?: typeof fetch;
};

type GraphqlResponse<T> = { data?: T; errors?: Array<{ extensions?: { code?: string } }> };

function retryAfterMs(response: Response): number | null {
  const raw = response.headers.get('retry-after');
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, Math.round(seconds * 1000));
  const at = Date.parse(raw);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : null;
}

function validateItem(item: unknown): MondayItem {
  if (!item || typeof item !== 'object') throw new MondayApiError('invalid_monday_item', false);
  const value = item as Record<string, unknown>;
  if (typeof value.id !== 'string' || !/^\d+$/.test(value.id) || typeof value.name !== 'string' || typeof value.url !== 'string') {
    throw new MondayApiError('invalid_monday_item', false);
  }
  const url = new URL(value.url);
  if (url.protocol !== 'https:' || !url.hostname.endsWith('.monday.com') || !/^\/boards\/\d+\/pulses\/\d+$/.test(url.pathname)) {
    throw new MondayApiError('invalid_monday_item_url', false);
  }
  return { id: value.id, name: value.name, url: url.toString().replace(/\/$/, '') };
}

export function createMondayClient(config: MondayClientConfig): MondayClient {
  if (!config.token) throw new Error('MONDAY_API_TOKEN is required.');
  if (!/^\d+$/.test(config.boardId)) throw new Error('MONDAY_BOARD_ID is invalid.');
  if (!/^[A-Za-z0-9_]+$/.test(config.groupId)) throw new Error('MONDAY_GROUP_ID is invalid.');
  const request = config.request ?? fetch;
  const timeoutMs = config.timeoutMs ?? 10_000;

  async function graphql<T>(query: string, variables: Record<string, unknown>, idempotencyKey?: string): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await request('https://api.monday.com/v2', {
        method: 'POST',
        headers: {
          authorization: config.token,
          'content-type': 'application/json',
          'api-version': config.apiVersion ?? '2025-07',
          ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
        },
        body: JSON.stringify({ query, variables }),
        signal: controller.signal,
      });
    } catch (error) {
      const timeout = error instanceof Error && error.name === 'AbortError';
      throw new MondayApiError(timeout ? 'network_timeout' : 'network_error', true, null, Boolean(idempotencyKey));
    } finally {
      clearTimeout(timer);
    }
    if (response.status === 401 || response.status === 403) throw new MondayApiError('monday_auth_failed', false);
    if (response.status === 429) throw new MondayApiError('monday_rate_limited', true, retryAfterMs(response));
    if (response.status >= 500) throw new MondayApiError('monday_server_error', true, retryAfterMs(response), Boolean(idempotencyKey));
    if (!response.ok) throw new MondayApiError('monday_http_error', false);
    let body: GraphqlResponse<T>;
    try {
      body = await response.json() as GraphqlResponse<T>;
    } catch {
      throw new MondayApiError('monday_invalid_json', true, null, Boolean(idempotencyKey));
    }
    if (body.errors?.length) {
      const code = body.errors[0]?.extensions?.code ?? 'monday_graphql_error';
      const retryable = ['ComplexityException', 'DAILY_LIMIT_EXCEEDED', 'INTERNAL_SERVER_ERROR'].includes(code);
      throw new MondayApiError(retryable ? 'monday_graphql_transient' : 'monday_graphql_permanent', retryable);
    }
    if (!body.data) throw new MondayApiError('monday_missing_data', true, null, Boolean(idempotencyKey));
    return body.data;
  }

  return {
    async preflight() {
      const data = await graphql<{ boards: Array<{ id: string; name: string; groups: Array<{ id: string; title: string }>; columns: Array<{ id: string; title: string; type: string; settings_str: string }> }> }>(
        `query BoardPreflight($boardIds: [ID!]) { boards(ids: $boardIds) { id name groups { id title } columns { id title type settings_str } } }`,
        { boardIds: [config.boardId] },
      );
      const board = data.boards[0];
      if (!board || board.id !== config.boardId || board.name !== 'Lead Management') throw new MondayApiError('board_mismatch', false);
      const group = board.groups.find((candidate) => candidate.id === config.groupId);
      if (!group) throw new MondayApiError('group_missing', false);
      for (const [id, expected] of Object.entries(EXPECTED_COLUMNS)) {
        const column = board.columns.find((candidate) => candidate.id === id);
        if (!column || column.title !== expected.title || column.type !== expected.type) {
          throw new MondayApiError(`column_mismatch_${id}`, false);
        }
      }
      const status = board.columns.find((column) => column.id === MONDAY_COLUMNS.status)!;
      let labels: Record<string, string> = {};
      try { labels = JSON.parse(status.settings_str).labels ?? {}; } catch { throw new MondayApiError('status_settings_invalid', false); }
      if (!Object.values(labels).includes('New')) throw new MondayApiError('status_new_missing', false);
      return { boardId: board.id, boardName: board.name, groupId: group.id, groupName: group.title } satisfies MondayBoardPreflight;
    },

    async createLead(name, columns, idempotencyKey) {
      const data = await graphql<{ create_item: unknown }>(
        `mutation CreateLead($boardId: ID!, $groupId: String!, $name: String!, $columns: JSON!) { create_item(board_id: $boardId, group_id: $groupId, item_name: $name, column_values: $columns) { id name url } }`,
        { boardId: config.boardId, groupId: config.groupId, name, columns: JSON.stringify(columns) },
        idempotencyKey,
      );
      return validateItem(data.create_item);
    },

    async updateLead(itemId, columns, idempotencyKey) {
      const data = await graphql<{ change_multiple_column_values: unknown }>(
        `mutation UpdateLead($boardId: ID!, $itemId: ID!, $columns: JSON!) { change_multiple_column_values(board_id: $boardId, item_id: $itemId, column_values: $columns) { id name url } }`,
        { boardId: config.boardId, itemId, columns: JSON.stringify(columns) },
        idempotencyKey,
      );
      return validateItem(data.change_multiple_column_values);
    },

    async getItem(itemId) {
      const data = await graphql<{ items: unknown[] }>(
        `query GetItem($ids: [ID!]) { items(ids: $ids, exclude_nonactive: true) { id name url } }`,
        { ids: [itemId] },
      );
      return data.items[0] ? validateItem(data.items[0]) : null;
    },

    async archiveItem(itemId, idempotencyKey) {
      await graphql<{ archive_item: { id: string } }>(
        `mutation ArchiveItem($itemId: ID!) { archive_item(item_id: $itemId) { id } }`,
        { itemId }, idempotencyKey,
      );
    },
  };
}
