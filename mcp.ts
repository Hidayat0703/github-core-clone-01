// Model Context Protocol over streamable HTTP (JSON-RPC 2.0): initialize/discover,
// tools/list and tools/call for the six forge tools. Shares the store with REST/GraphQL.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { store, nextSeq, stampFor, type Issue, type Pull } from './store.ts';
import { doMerge } from './graphql.ts';
import { VIEWER } from './scenario.ts';

const SERVER_INFO = { name: 'github-forge', version: '1.0.0' };
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDef {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, unknown>; required: string[] };
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Repository name' },
        description: { type: 'string', description: 'Repository description' },
        private: { type: 'boolean', description: 'Whether the repository is private' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        full_name: { type: 'string', description: 'owner/repo' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        full_name: { type: 'string', description: 'owner/repo' },
        title: { type: 'string', description: 'Issue title' },
        body: { type: 'string', description: 'Issue body' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        full_name: { type: 'string', description: 'owner/repo' },
        state: { type: 'string', description: 'Issue state: open, closed, or all' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        full_name: { type: 'string', description: 'owner/repo' },
        title: { type: 'string', description: 'Pull request title' },
        body: { type: 'string', description: 'Pull request body' },
        head: { type: 'string', description: 'Head branch name' },
        base: { type: 'string', description: 'Base branch name' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        full_name: { type: 'string', description: 'owner/repo' },
        pull_number: { type: 'integer', description: 'Pull request number' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJsonRpc(res: ServerResponse, status: number, payload: unknown): void {
  const text = `${JSON.stringify(payload)}\n`;
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

function splitFullName(args: Record<string, unknown>): { owner: string; repo: string } {
  let owner = typeof args.owner === 'string' ? args.owner : '';
  let repo = typeof args.repo === 'string' ? args.repo : '';
  if ((!owner || !repo) && typeof args.full_name === 'string') {
    const parts = (args.full_name as string).split('/');
    if (parts.length === 2) {
      owner = owner || parts[0];
      repo = repo || parts[1];
    }
  }
  return { owner, repo };
}

function toolResult(data: unknown): Record<string, unknown> {
  const text = typeof data === 'string' ? data : JSON.stringify(data);
  return { content: [{ type: 'text', text }], structuredContent: data };
}

function toolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function callTool(name: string, args: Record<string, unknown>): Record<string, unknown> {
  const normalized = name.toLowerCase().replace(/[^a-z0-9]/g, '');
  const match = (canonical: string): boolean =>
    normalized === canonical || normalized.endsWith(canonical);
  if (match('createrepo') || match('createrepository')) {
    const repoName = typeof args.name === 'string' ? args.name : '';
    if (!repoName) return toolError('missing required argument: name');
    if (store.getRepo(store.viewerLogin, repoName)) return toolError(`repository ${repoName} already exists`);
    const repo = store.createRepo(
      store.viewerLogin,
      repoName,
      typeof args.description === 'string' ? args.description : '',
      args.private === true,
    );
    return toolResult({
      id: repo.id,
      name: repo.name,
      full_name: `${repo.owner}/${repo.name}`,
      owner: repo.owner,
      private: repo.private,
      description: repo.description,
      default_branch: repo.defaultBranch,
    });
  }
  if (match('getrepo') || match('getrepository')) {
    const { owner, repo: repoName } = splitFullName(args);
    const repo = owner && repoName ? store.getRepo(owner, repoName) : undefined;
    if (!repo) return toolError('repository not found');
    return toolResult({
      id: repo.id,
      name: repo.name,
      full_name: `${repo.owner}/${repo.name}`,
      owner: repo.owner,
      private: repo.private,
      description: repo.description,
      default_branch: repo.defaultBranch,
    });
  }
  if (match('createissue')) {
    const { owner, repo: repoName } = splitFullName(args);
    const title = typeof args.title === 'string' ? args.title : '';
    if (!owner || !repoName || !title) return toolError('missing required argument: owner, repo, or title');
    const repo = store.getRepo(owner, repoName);
    if (!repo) return toolError('repository not found');
    const seq = nextSeq();
    const issue: Issue = {
      id: store.nextId(),
      number: repo.nextNumber++,
      title,
      body: typeof args.body === 'string' ? args.body : '',
      state: 'open',
      labels: [],
      comments: [],
      seq,
      createdAt: stampFor(seq),
    };
    repo.issues.push(issue);
    return toolResult({
      id: issue.id,
      number: issue.number,
      title: issue.title,
      body: issue.body,
      state: 'open',
      full_name: `${repo.owner}/${repo.name}`,
    });
  }
  if (match('listissues')) {
    const { owner, repo: repoName } = splitFullName(args);
    if (!owner || !repoName) return toolError('missing required argument: owner or repo');
    const repo = store.getRepo(owner, repoName);
    if (!repo) return toolError('repository not found');
    const state = typeof args.state === 'string' ? args.state : 'open';
    const list = repo.issues.filter((i) => (state === 'all' ? true : i.state === state));
    return toolResult({
      issues: list.map((i) => ({ id: i.id, number: i.number, title: i.title, body: i.body, state: i.state })),
    });
  }
  if (match('createpullrequest') || match('createpr')) {
    const { owner, repo: repoName } = splitFullName(args);
    const title = typeof args.title === 'string' ? args.title : '';
    const head = typeof args.head === 'string' ? args.head : '';
    const base = typeof args.base === 'string' ? args.base : '';
    if (!owner || !repoName || !title || !head || !base) {
      return toolError('missing required argument: owner, repo, title, head, or base');
    }
    const repo = store.getRepo(owner, repoName);
    if (!repo) return toolError('repository not found');
    const seq = nextSeq();
    const pull: Pull = {
      id: store.nextId(),
      number: repo.nextNumber++,
      title,
      body: typeof args.body === 'string' ? args.body : '',
      state: 'open',
      headRef: head,
      baseRef: base,
      headSha: store.branchTip(repo, head),
      baseSha: store.branchTip(repo, base),
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      seq,
      createdAt: stampFor(seq),
    };
    repo.pulls.push(pull);
    return toolResult({
      id: pull.id,
      number: pull.number,
      title: pull.title,
      state: 'open',
      head: { ref: head, sha: pull.headSha },
      base: { ref: base, sha: pull.baseSha },
      full_name: `${repo.owner}/${repo.name}`,
    });
  }
  if (match('mergepullrequest') || match('mergepr')) {
    const { owner, repo: repoName } = splitFullName(args);
    const pullNumber = Number(args.pull_number ?? args.number);
    if (!owner || !repoName || !pullNumber) return toolError('missing required argument: owner, repo, or pull_number');
    const repo = store.getRepo(owner, repoName);
    const pull = repo?.pulls.find((p) => p.number === pullNumber);
    if (!repo || !pull) return toolError('pull request not found');
    const ok = doMerge(repo, pull);
    if (!ok) return toolError('merge conflict');
    return toolResult({ number: pull.number, merged: true, sha: pull.mergeCommitSha, state: 'closed' });
  }
  return toolError(`unknown tool: ${name}`);
}

export async function handleMcp(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const method = req.method ?? 'POST';
  if (method === 'DELETE') {
    res.writeHead(204);
    res.end();
    return true;
  }
  if (method !== 'POST') return false;
  // Auth: a missing or wrong bearer is 401 before anything else.
  const auth = req.headers.authorization ?? '';
  const expected = store.token;
  const authed = expected === '' ? auth.startsWith('Bearer ') && auth.length > 7 : auth === `Bearer ${expected}`;
  if (!authed) {
    sendJsonRpc(res, 401, { jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Unauthorized' } });
    return true;
  }
  const raw = await readBody(req);
  let request: Record<string, unknown>;
  try {
    request = JSON.parse(raw.toString('utf8')) as Record<string, unknown>;
  } catch {
    sendJsonRpc(res, 400, { jsonrpc: '2.0', id: 424242, error: { code: -32700, message: 'Parse error' } });
    return true;
  }
  if (request === null || typeof request !== 'object' || Array.isArray(request)) {
    sendJsonRpc(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return true;
  }
  const id = 'id' in request ? request.id : undefined;
  const rpcMethod = typeof request.method === 'string' ? request.method : '';
  // Notifications carry no id: acknowledge with 202 and no body.
  if (id === undefined) {
    res.writeHead(202);
    res.end();
    return true;
  }
  const params = (request.params ?? {}) as Record<string, unknown>;
  const respond = (result: unknown): void => {
    sendJsonRpc(res, 200, { jsonrpc: '2.0', id, result });
  };
  const respondError = (code: number, message: string): void => {
    sendJsonRpc(res, 200, { jsonrpc: '2.0', id, error: { code, message } });
  };
  if (rpcMethod === 'server/discover') {
    respond({ supportedVersions: SUPPORTED_VERSIONS, capabilities: { tools: {} }, serverInfo: SERVER_INFO });
    return true;
  }
  if (rpcMethod === 'initialize') {
    const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
    const negotiated = SUPPORTED_VERSIONS.includes(offered) ? offered : '2026-07-28';
    respond({ protocolVersion: negotiated, capabilities: { tools: {} }, serverInfo: SERVER_INFO });
    return true;
  }
  if (rpcMethod === 'ping') {
    respond({});
    return true;
  }
  if (rpcMethod === 'tools/list') {
    respond({ tools: TOOLS });
    return true;
  }
  if (rpcMethod === 'tools/call') {
    const toolName = typeof params.name === 'string' ? params.name : '';
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    const known = TOOLS.some((t) => {
      const n = t.name.replace(/[^a-z0-9]/g, '');
      const given = toolName.toLowerCase().replace(/[^a-z0-9]/g, '');
      return given === n || given.endsWith(n);
    });
    if (!known) {
      respondError(-32601, `Method not found: ${toolName}`);
      return true;
    }
    respond(callTool(toolName, args));
    return true;
  }
  respondError(-32601, `Method not found: ${rpcMethod}`);
  return true;
}
