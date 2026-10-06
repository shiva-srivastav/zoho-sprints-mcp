#!/usr/bin/env node
/**
 * Zoho Sprints MCP server (stdio).
 *
 * Endpoint paths and response shapes here were verified against the live
 * .in API rather than taken from documentation. Two behaviours are easy to get
 * wrong and are load-bearing:
 *
 *  - Item creation takes NO `action` query param. Sending action=create 404s.
 *  - The backlog is a container of sprintInfo.type 5, addressed through the
 *    same /sprints/{id}/item/ path as a real sprint. There is no project-level
 *    create path.
 *
 * Never write to stdout: the stdio transport owns it. Diagnostics go to stderr.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { clientFromEnv, decodeColumnar, ZohoSprintsError } from './zoho.js';
import { loadEnv } from './env.js';

// Credentials live in a gitignored .env (or $ZOHO_ENV_FILE) so they stay out of
// every MCP client's config file. Real environment variables still win.
try {
  loadEnv();
} catch (err) {
  console.error('[zoho-sprints-mcp] could not parse env file: ' + err.message);
}

const zoho = clientFromEnv();

const server = new McpServer(
  { name: 'zoho-sprints', version: '1.0.0' },
  {
    instructions:
      'Create and inspect Zoho Sprints work items. Team, project, item type and priority all ' +
      'default to the configured values, so creating a backlog item needs only a name. ' +
      'Pass sprint_id to file the item into a specific sprint instead of the backlog. ' +
      'Use list_sprints and list_item_meta to discover IDs for other projects.',
  },
);

/* ------------------------------ helpers ------------------------------ */

function ok(payload) {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
}

function fail(err) {
  const detail =
    err instanceof ZohoSprintsError
      ? { error: err.message, status: err.status, zoho: err.body }
      : { error: String(err?.message ?? err) };
  return { isError: true, content: [{ type: 'text', text: JSON.stringify(detail, null, 2) }] };
}

/** Wraps a handler so Zoho and network failures return tool errors, not crashes. */
function handler(fn) {
  return async (args) => {
    try {
      return ok(await fn(args ?? {}));
    } catch (err) {
      return fail(err);
    }
  };
}

function need(value, fallback, name, envName) {
  const resolved = value ?? fallback;
  if (!resolved) {
    throw new ZohoSprintsError(
      name + ' is required and no default is configured. Pass it explicitly, or set ' +
        envName + ' in .env.',
    );
  }
  return resolved;
}

function projectBase(teamId, projectId) {
  return 'team/' + teamId + '/projects/' + projectId;
}

function ids({ team_id, project_id }) {
  return {
    teamId: need(team_id, zoho.cfg.teamId, 'team_id', 'ZOHO_TEAM_ID'),
    projectId: need(project_id, zoho.cfg.projectId, 'project_id', 'ZOHO_PROJECT_ID'),
  };
}

/**
 * Resolves the backlog container. Sprint listings omit it, so when it is not
 * configured we fall back to scanning items for a container of type 5.
 * Cached per project since it never changes.
 */
const backlogCache = new Map();
async function resolveBacklogId(teamId, projectId) {
  if (projectId === zoho.cfg.projectId && process.env.ZOHO_BACKLOG_ID) {
    return process.env.ZOHO_BACKLOG_ID;
  }
  if (backlogCache.has(projectId)) return backlogCache.get(projectId);

  const data = await zoho.request({
    path: projectBase(teamId, projectId) + '/items/',
    query: { action: 'data', index: 1, range: 100 },
  });
  const items = decodeColumnar(data, 'itemJObj', 'item_prop') ?? [];
  const backlog = items.find((i) => i.sprintInfo?.type === 5)?.sprintInfo?.id;
  if (!backlog) {
    throw new ZohoSprintsError(
      'Could not determine the backlog container for this project. Pass sprint_id ' +
        'explicitly, or set ZOHO_BACKLOG_ID in .env.',
    );
  }
  backlogCache.set(projectId, backlog);
  return backlog;
}

/* ------------------------------- tools ------------------------------- */

server.registerTool(
  'list_projects',
  {
    title: 'List projects',
    description:
      'Lists projects in the workspace with their system IDs. projNo is the short number ' +
      'shown in the UI URL (P27 means projNo 27); the ID is the long numeric value.',
    inputSchema: {
      team_id: z.string().optional().describe('Defaults to ZOHO_TEAM_ID.'),
      index: z.number().int().min(1).default(1),
      range: z.number().int().min(1).max(100).default(50),
    },
    annotations: { readOnlyHint: true },
  },
  handler(async ({ team_id, index = 1, range = 50 }) => {
    const teamId = need(team_id, zoho.cfg.teamId, 'team_id', 'ZOHO_TEAM_ID');
    const data = await zoho.request({
      path: 'team/' + teamId + '/projects/',
      query: { action: 'data', index, range },
    });
    const rows = decodeColumnar(data, 'projectJObj', 'project_prop');
    if (!rows) return { raw: data };
    return {
      projects: rows.map((p) => ({
        projectId: p.id,
        name: p.projName,
        projNo: p.projNo,
        status: p.status,
        owner: p.owner,
      })),
    };
  }),
);

server.registerTool(
  'list_sprints',
  {
    title: 'List sprints',
    description:
      'Lists the active sprints of a project, plus the backlog container. Pass one of these ' +
      'IDs as sprint_id when creating an item.',
    inputSchema: {
      team_id: z.string().optional(),
      project_id: z.string().optional(),
      index: z.number().int().min(1).default(1),
      range: z.number().int().min(1).max(100).default(50),
    },
    annotations: { readOnlyHint: true },
  },
  handler(async (args) => {
    const { teamId, projectId } = ids(args);
    const { index = 1, range = 50 } = args;
    const data = await zoho.request({
      path: projectBase(teamId, projectId) + '/sprints/',
      query: { action: 'data', index, range },
    });
    const rows = decodeColumnar(data, 'sprintJObj', 'sprint_prop') ?? [];

    let backlogId = null;
    try {
      backlogId = await resolveBacklogId(teamId, projectId);
    } catch {
      // Backlog discovery is best effort; sprint data is still useful without it.
    }

    return {
      backlogId,
      sprints: rows.map((s) => ({
        sprintId: s.id,
        name: s.sprintName,
        sprintNo: s.sprintNo,
        startDate: s.startDate,
        endDate: s.endDate,
        duration: s.duration,
      })),
    };
  }),
);

server.registerTool(
  'list_item_meta',
  {
    title: 'List item types, priorities and statuses',
    description:
      'Resolves the project-scoped IDs used when creating or updating items: item type IDs ' +
      '(Task/Story/Bug and custom types), priority IDs, and workflow status IDs.',
    inputSchema: {
      team_id: z.string().optional(),
      project_id: z.string().optional(),
    },
    annotations: { readOnlyHint: true },
  },
  handler(async (args) => {
    const { teamId, projectId } = ids(args);
    const base = projectBase(teamId, projectId);

    // Each lookup is independent, so report per-endpoint failures rather than
    // losing the whole response to one bad path.
    const settle = async (label, p, decode) => {
      try {
        const data = await zoho.request({ path: p, query: { action: 'data' } });
        return [label, decode(data) ?? { raw: data }];
      } catch (err) {
        return [label, { error: err.message, status: err.status, zoho: err.body }];
      }
    };

    const results = await Promise.all([
      settle('itemTypes', base + '/itemtype/', (d) =>
        decodeColumnar(d, 'projItemTypeJObj', 'projItemType_prop')?.map((t) => ({
          itemTypeId: t.id,
          name: t.itemTypeName,
          baseType: t.baseType,
          isDefault: t.isDefault,
        })),
      ),
      settle('priorities', base + '/priority/', (d) =>
        decodeColumnar(d, 'projPriorityJObj', 'projPriority_prop')?.map((p) => ({
          priorityId: p.id,
          name: p.priorityName,
          colorCode: p.colorCode,
          sequence: p.sequence,
        })),
      ),
      settle('statuses', base + '/itemstatus/', (d) =>
        decodeColumnar(d, 'statusJObj', 'status_prop')?.map((s) => ({
          statusId: s.id,
          name: s.statusDescription,
          type: s.statusType,
          isDefault: s.isDefault,
        })),
      ),
    ]);
    return Object.fromEntries(results);
  }),
);

server.registerTool(
  'list_items',
  {
    title: 'List work items',
    description:
      'Lists work items across the project, newest page first. Each result reports the ' +
      'sprint or backlog it sits in.',
    inputSchema: {
      team_id: z.string().optional(),
      project_id: z.string().optional(),
      index: z.number().int().min(1).default(1).describe('1-based page start.'),
      range: z.number().int().min(1).max(100).default(25),
    },
    annotations: { readOnlyHint: true },
  },
  handler(async (args) => {
    const { teamId, projectId } = ids(args);
    const { index = 1, range = 25 } = args;
    const data = await zoho.request({
      path: projectBase(teamId, projectId) + '/items/',
      query: { action: 'data', index, range },
    });
    const rows = decodeColumnar(data, 'itemJObj', 'item_prop');
    if (!rows) return { raw: data };
    return {
      hasMore: Boolean(data?.next),
      items: rows.map((i) => ({
        itemId: i.id,
        itemNo: i.itemNo,
        name: i.itemName,
        container: i.sprintInfo?.name,
        containerType: i.sprintInfo?.type === 5 ? 'backlog' : 'sprint',
        sprintId: i.sprintId,
        statusId: i.statusId,
        ownerId: i.ownerId,
        points: i.points,
      })),
    };
  }),
);

server.registerTool(
  'list_users',
  {
    title: 'List workspace users',
    description:
      'Lists users with the Zoho system IDs that create_item expects for owner_id. ' +
      'Harvested from item listings, because the dedicated /users/ endpoint needs the ' +
      'ZohoSprints.users.READ scope. Only users appearing on items in the scanned pages ' +
      'are reported.',
    inputSchema: {
      team_id: z.string().optional(),
      project_id: z.string().optional(),
      pages: z.number().int().min(1).max(10).default(3).describe('Pages of 100 items to scan.'),
    },
    annotations: { readOnlyHint: true },
  },
  handler(async (args) => {
    const { teamId, projectId } = ids(args);
    const { pages = 3 } = args;
    const names = {};
    const zuids = {};
    let index = 1;

    for (let p = 0; p < pages; p++) {
      const data = await zoho.request({
        path: projectBase(teamId, projectId) + '/items/',
        query: { action: 'data', index, range: 100 },
      });
      Object.assign(names, data?.userDisplayName ?? {});
      Object.assign(zuids, data?.zsuserIdvsZUID ?? {});
      if (!data?.next) break;
      index += 100;
    }

    return {
      users: Object.entries(names)
        .filter(([, name]) => name && name !== 'Unassigned')
        .map(([systemId, name]) => ({
          ownerId: systemId,
          name,
          zuid: zuids[systemId] ?? null,
        })),
    };
  }),
);

server.registerTool(
  'create_item',
  {
    title: 'Create a Zoho Sprints work item',
    description:
      'Creates a work item. With nothing but a name it creates a Task at the configured ' +
      'default priority in the project backlog. Pass sprint_id to file it into a sprint ' +
      'instead, and item_type_id / priority_id (from list_item_meta) to override the defaults.',
    inputSchema: {
      name: z.string().min(1).max(255).describe('Item title.'),
      team_id: z.string().optional(),
      project_id: z.string().optional(),
      sprint_id: z
        .string()
        .optional()
        .describe('Target sprint. Omit to create the item in the backlog.'),
      item_type_id: z.string().optional().describe('Defaults to ZOHO_DEFAULT_ITEM_TYPE_ID.'),
      priority_id: z.string().optional().describe('Defaults to ZOHO_DEFAULT_PRIORITY_ID.'),
      description: z.string().optional(),
      owner_id: z
        .union([z.string(), z.array(z.string())])
        .optional()
        .describe(
          'Zoho system user ID(s) from list_users to assign the item to. Not the numeric ' +
            'User ID shown in Sprints settings. Defaults to the API account.',
        ),
      story_points: z.number().optional(),
      duration: z.number().optional().describe('Estimated hours.'),
      start_date: z.string().optional().describe('MM/DD/YYYY'),
      end_date: z.string().optional().describe('MM/DD/YYYY'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  },
  handler(async (args) => {
    const { teamId, projectId } = ids(args);
    const itemTypeId = need(
      args.item_type_id,
      process.env.ZOHO_DEFAULT_ITEM_TYPE_ID,
      'item_type_id',
      'ZOHO_DEFAULT_ITEM_TYPE_ID',
    );
    const priorityId = need(
      args.priority_id,
      process.env.ZOHO_DEFAULT_PRIORITY_ID,
      'priority_id',
      'ZOHO_DEFAULT_PRIORITY_ID',
    );
    const container = args.sprint_id ?? (await resolveBacklogId(teamId, projectId));

    // No `action` param here: adding one makes Zoho reject the URL with a 404.
    const data = await zoho.request({
      method: 'POST',
      path: projectBase(teamId, projectId) + '/sprints/' + container + '/item/',
      form: {
        name: args.name,
        projitemtypeid: itemTypeId,
        projpriorityid: priorityId,
        description: args.description,
        // `users` must be a JSON array even for a single assignee; a bare ID
        // is rejected with 400 "Given JSON is invalid".
        users: args.owner_id
          ? JSON.stringify(Array.isArray(args.owner_id) ? args.owner_id : [args.owner_id])
          : undefined,
        point: args.story_points,
        duration: args.duration,
        startdate: args.start_date,
        enddate: args.end_date,
      },
    });

    if (!data?.addedItemId) {
      throw new ZohoSprintsError('Zoho accepted the request but returned no item ID.', {
        body: data,
      });
    }
    return {
      created: true,
      itemId: data.addedItemId,
      itemNo: data.itemNo,
      statusId: data.statusId,
      placement: args.sprint_id ? 'sprint ' + args.sprint_id : 'backlog',
    };
  }),
);

server.registerTool(
  'move_items',
  {
    title: 'Move items to another sprint',
    description:
      'Moves one or more existing items into a different sprint, or into the backlog. ' +
      'Preserves item IDs, numbers and content. from_sprint_id must be the item\'s ' +
      'current container (see list_items).',
    inputSchema: {
      item_ids: z.array(z.string()).min(1).describe('Item system IDs to move.'),
      from_sprint_id: z.string().describe('The items\' current sprint or backlog ID.'),
      to_sprint_id: z
        .string()
        .optional()
        .describe('Destination sprint. Omit to move into the backlog.'),
      team_id: z.string().optional(),
      project_id: z.string().optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  },
  handler(async (args) => {
    const { teamId, projectId } = ids(args);
    const target = args.to_sprint_id ?? (await resolveBacklogId(teamId, projectId));
    const base = projectBase(teamId, projectId);
    const moved = [];
    const failed = [];

    for (const itemId of args.item_ids) {
      try {
        // The destination field is `tosprintid`. `sprintid`, `projsprintid` and
        // `sprintId` are all rejected with "Extra parameter found in URL".
        await zoho.request({
          method: 'POST',
          path: base + '/sprints/' + args.from_sprint_id + '/item/' + itemId + '/',
          form: { tosprintid: target },
        });
        moved.push(itemId);
      } catch (err) {
        failed.push({ itemId, error: err.message, zoho: err.body });
      }
    }
    return { movedTo: target, moved, failed: failed.length ? failed : undefined };
  }),
);

server.registerTool(
  'zoho_request',
  {
    title: 'Raw authenticated Zoho Sprints request',
    description:
      'Escape hatch for endpoints this server does not wrap. Path is relative to /zsapi/, ' +
      'for example team/123/projects/456/items/. Read endpoints generally need ' +
      'action=data plus index and range.',
    inputSchema: {
      path: z.string().describe('Path after /zsapi/, without a leading slash.'),
      method: z.enum(['GET', 'POST', 'PUT', 'DELETE']).default('GET'),
      query: z.record(z.string()).optional(),
      form: z.record(z.string()).optional().describe('Form-encoded body fields.'),
    },
  },
  handler(async ({ path: p, method = 'GET', query, form }) =>
    zoho.request({ method, path: p, query, form }),
  ),
);

/* ------------------------------- start ------------------------------- */

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  const auth = zoho.canRefresh
    ? 'refresh-token'
    : zoho.cfg.accessToken
      ? 'static-token'
      : 'MISSING';
  console.error('[zoho-sprints-mcp] ready (dc=.' + zoho.cfg.tld + ', auth=' + auth + ')');
}

main().catch((err) => {
  console.error('[zoho-sprints-mcp] fatal:', err);
  process.exit(1);
});
