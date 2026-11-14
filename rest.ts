// GitHub REST v3 surface: repositories, branches, commits, contents, labels, issues,
// pull requests and merges. All state lives in the shared store (store.ts).
import type { IncomingMessage, ServerResponse } from 'node:http';
import { store, nextSeq, stampFor, gid, DEFAULT_BRANCH, type Issue, type Pull, type Repo } from './store.ts';
import { ZERO_OID, parseCommit } from './gitproto.ts';
import { VIEWER } from './scenario.ts';
import { doMerge } from './graphql.ts';

export interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  query: URLSearchParams;
  body: unknown;
  segments: string[];
}

function requestId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function sendJson(ctx: Ctx, status: number, data: unknown, extraHeaders: Record<string, string> = {}): void {
  const text = status === 204 ? '' : `${JSON.stringify(data)}\n`;
  ctx.res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': requestId(),
    'x-oauth-scopes': 'repo, read:org',
    ...extraHeaders,
  });
  ctx.res.end(text);
}

export function sendError(ctx: Ctx, status: number, message: string): void {
  sendJson(ctx, status, { message });
}

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: gid('Repository', repo.id),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: repo.owner === VIEWER.login ? VIEWER.id : 1001, type: 'User' },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    has_issues: true,
    has_projects: false,
    has_wiki: false,
    created_at: stampFor(repo.seq),
    updated_at: stampFor(repo.seq),
    pushed_at: stampFor(repo.seq),
    html_url: `https://github.com/${repo.owner}/${repo.name}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
  };
}

function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: gid('Issue', repo.id, issue.number),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => ({ name, color: repo.labels.get(name)?.color ?? 'ededed' })),
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.createdAt,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

function pullJson(repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: pull.id,
    node_id: gid('PullRequest', repo.id, pull.number),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    head: { ref: pull.headRef, sha: pull.headSha, label: `${repo.owner}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: pull.baseSha, label: `${repo.owner}:${pull.baseRef}` },
    merged: pull.merged,
    mergeable: true,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    created_at: pull.createdAt,
    updated_at: pull.createdAt,
    html_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
  };
}

function asObject(body: unknown): Record<string, unknown> {
  return body !== null && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** The repo at /repos/{owner}/{name}, enforcing the owner rule (other owner -> 404). */
function loadRepo(ctx: Ctx, owner: string, name: string): Repo | null {
  if (owner !== store.viewerLogin) return null;
  return store.getRepo(owner, name) ?? null;
}

function commitHistory(repo: Repo, tip: string): Array<{ sha: string; message: string }> {
  const out: Array<{ sha: string; message: string }> = [];
  const seen = new Set<string>();
  const queue = [tip];
  while (queue.length) {
    const oid = queue.shift()!;
    if (oid === ZERO_OID || seen.has(oid)) continue;
    seen.add(oid);
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    const commit = parseCommit(object.data);
    out.push({ sha: oid, message: commit.message });
    for (const parent of commit.parents) queue.push(parent);
  }
  return out;
}

function lineCounts(oldText: string, newText: string): { additions: number; deletions: number } {
  const oldLines = oldText === '' ? [] : oldText.split('\n');
  const newLines = newText === '' ? [] : newText.split('\n');
  const oldCount = new Map<string, number>();
  for (const line of oldLines) oldCount.set(line, (oldCount.get(line) ?? 0) + 1);
  let common = 0;
  for (const line of newLines) {
    const left = oldCount.get(line) ?? 0;
    if (left > 0) {
      oldCount.set(line, left - 1);
      common += 1;
    }
  }
  return { additions: newLines.length - common, deletions: oldLines.length - common };
}

function diffFiles(
  repo: Repo,
  baseTip: string,
  headTip: string,
): Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }> {
  const baseFiles = baseTip && baseTip !== ZERO_OID ? store.branchFiles(repo, branchOfTip(repo, baseTip)) : new Map();
  const headFiles = headTip && headTip !== ZERO_OID ? store.branchFiles(repo, branchOfTip(repo, headTip)) : new Map();
  void baseFiles;
  void headFiles;
  // Direct tree diff instead: walk both trees.
  const baseTree = treeOfTip(repo, baseTip);
  const headTree = treeOfTip(repo, headTip);
  const paths = new Set([...baseTree.keys(), ...headTree.keys()]);
  const out: Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }> = [];
  for (const path of [...paths].sort()) {
    const base = baseTree.get(path);
    const head = headTree.get(path);
    if (!base && head) {
      const text = repo.objects.get(head.oid)?.data.toString('utf8') ?? '';
      const lines = text === '' ? 0 : text.split('\n').length;
      out.push({ filename: path, status: 'added', additions: lines, deletions: 0, changes: lines });
    } else if (base && !head) {
      const text = repo.objects.get(base.oid)?.data.toString('utf8') ?? '';
      const lines = text === '' ? 0 : text.split('\n').length;
      out.push({ filename: path, status: 'removed', additions: 0, deletions: lines, changes: lines });
    } else if (base && head && base.oid !== head.oid) {
      const oldText = repo.objects.get(base.oid)?.data.toString('utf8') ?? '';
      const newText = repo.objects.get(head.oid)?.data.toString('utf8') ?? '';
      const { additions, deletions } = lineCounts(oldText, newText);
      out.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions });
    }
  }
  return out;
}

function branchOfTip(repo: Repo, tip: string): string {
  for (const [ref, oid] of repo.refs) if (oid === tip && ref.startsWith('refs/heads/')) return ref.slice(11);
  return DEFAULT_BRANCH;
}

function treeOfTip(repo: Repo, tip: string): Map<string, { oid: string; mode: string }> {
  if (!tip || tip === ZERO_OID) return new Map();
  const object = repo.objects.get(tip);
  if (!object || object.type !== 'commit') return new Map();
  return store.treeFiles(repo, parseCommit(object.data).tree);
}

export function handleRest(ctx: Ctx): boolean {
  const s = ctx.segments; // after /api/v3
  const method = ctx.req.method ?? 'GET';
  const q = ctx.query;

  // Root + meta + user
  if (s.length === 0 && method === 'GET') {
    sendJson(ctx, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' });
    return true;
  }
  if (s.length === 1 && s[0] === 'meta' && method === 'GET') {
    sendJson(ctx, 200, { installed_version: '1.0.0', verifiable_password_authentication: true });
    return true;
  }
  if (s.length === 1 && s[0] === 'user' && method === 'GET') {
    sendJson(ctx, 200, { login: VIEWER.login, id: VIEWER.id, name: VIEWER.name, email: VIEWER.email, type: 'User' });
    return true;
  }
  // GET /user/repos + POST /user/repos
  if (s.length === 2 && s[0] === 'user' && s[1] === 'repos') {
    if (method === 'GET') {
      const all = store.listRepos(store.viewerLogin);
      const perPage = Math.max(1, Number.parseInt(q.get('per_page') ?? '30', 10) || 30);
      const page = Math.max(1, Number.parseInt(q.get('page') ?? '1', 10) || 1);
      const slice = all.slice((page - 1) * perPage, page * perPage);
      const headers: Record<string, string> = {};
      if (page * perPage < all.length) {
        const host = ctx.req.headers.host ?? '127.0.0.1';
        headers.link = `<http://${host}/api/v3/user/repos?per_page=${perPage}&page=${page + 1}>; rel="next"`;
      }
      sendJson(ctx, 200, slice.map(repoJson), headers);
      return true;
    }
    if (method === 'POST') {
      const body = asObject(ctx.body);
      const name = str(body.name);
      if (!name || name.length > 100) {
        sendError(ctx, 422, 'Repository name is invalid');
        return true;
      }
      if (store.getRepo(store.viewerLogin, name)) {
        sendError(ctx, 422, 'Repository already exists');
        return true;
      }
      const repo = store.createRepo(store.viewerLogin, name, str(body.description), body.private === true);
      sendJson(ctx, 201, repoJson(repo));
      return true;
    }
    return false;
  }

  // /repos/{owner}/{name}/...
  if (s.length >= 3 && s[0] === 'repos') {
    const owner = decodeURIComponent(s[1]);
    const name = decodeURIComponent(s[2]);
    const rest = s.slice(3);
    const repo = loadRepo(ctx, owner, name);
    if (rest.length === 0) {
      if (method === 'GET') {
        if (!repo) return sendError(ctx, 404, 'Not Found'), true;
        sendJson(ctx, 200, repoJson(repo));
        return true;
      }
      if (method === 'PATCH') {
        if (!repo) return sendError(ctx, 404, 'Not Found'), true;
        const body = asObject(ctx.body);
        if (typeof body.description === 'string') repo.description = body.description;
        sendJson(ctx, 200, repoJson(repo));
        return true;
      }
      if (method === 'DELETE') {
        if (!repo) return sendError(ctx, 404, 'Not Found'), true;
        store.deleteRepo(owner, name);
        sendJson(ctx, 204, null);
        return true;
      }
      return false;
    }
    if (!repo) return sendError(ctx, 404, 'Not Found'), true;
    return handleRepoSub(ctx, repo, rest, method);
  }
  return false;
}

function handleRepoSub(ctx: Ctx, repo: Repo, rest: string[], method: string): boolean {
  const q = ctx.query;
  const head = rest[0];

  if (head === 'branches' && rest.length === 1 && method === 'GET') {
    const out = [...repo.refs.keys()]
      .filter((r) => r.startsWith('refs/heads/'))
      .sort()
      .map((r) => ({ name: r.slice(11), commit: { sha: repo.refs.get(r)! } }));
    sendJson(ctx, 200, out);
    return true;
  }
  if (head === 'commits' && rest.length === 1 && method === 'GET') {
    const branch = q.get('sha') ?? repo.defaultBranch;
    const tip = store.branchTip(repo, branch);
    sendJson(ctx, 200, commitHistory(repo, tip).map((c) => ({ sha: c.sha, commit: { message: c.message } })));
    return true;
  }
  if (head === 'git' && rest[1] === 'refs' && method === 'POST') {
    const body = asObject(ctx.body);
    const ref = str(body.ref);
    const sha = str(body.sha);
    if (!ref.startsWith('refs/') || !/^[0-9a-f]{40}$/i.test(sha)) {
      sendError(ctx, 422, 'Invalid ref or sha');
      return true;
    }
    repo.refs.set(ref, sha.toLowerCase());
    sendJson(ctx, 201, { ref, object: { sha: sha.toLowerCase(), type: 'commit' } });
    return true;
  }
  if (head === 'git' && rest[1] === 'refs' && method === 'GET') {
    const ref = `refs/${rest.slice(2).join('/')}`;
    const oid = repo.refs.get(ref);
    if (!oid) return sendError(ctx, 404, 'Not Found'), true;
    sendJson(ctx, 200, { ref, object: { sha: oid, type: 'commit' } });
    return true;
  }
  if (head === 'contents') {
    return handleContents(ctx, repo, rest.slice(1), method);
  }
  if (head === 'labels') {
    if (method === 'POST' && rest.length === 1) {
      const body = asObject(ctx.body);
      const name = str(body.name);
      if (!name) return sendError(ctx, 422, 'Label name is required'), true;
      repo.labels.set(name, { name, color: str(body.color) || 'ededed' });
      sendJson(ctx, 201, { name, color: repo.labels.get(name)!.color });
      return true;
    }
    if (method === 'GET' && rest.length === 1) {
      sendJson(ctx, 200, [...repo.labels.values()]);
      return true;
    }
    return false;
  }
  if (head === 'issues') {
    return handleIssues(ctx, repo, rest.slice(1), method);
  }
  if (head === 'pulls') {
    return handlePulls(ctx, repo, rest.slice(1), method);
  }
  return false;
}

function handleContents(ctx: Ctx, repo: Repo, pathParts: string[], method: string): boolean {
  const q = ctx.query;
  const path = pathParts.map((p) => decodeURIComponent(p)).join('/');
  const branch = q.get('ref') ?? repo.defaultBranch;
  if (method === 'GET') {
    const files = store.branchFiles(repo, branch);
    const exact = files.get(path);
    if (exact) {
      const blob = repo.objects.get(exact.oid);
      const bytes = blob?.data ?? Buffer.alloc(0);
      sendJson(ctx, 200, {
        type: 'file',
        encoding: 'base64',
        size: bytes.length,
        name: path.split('/').pop() ?? path,
        path,
        content: bytes.toString('base64'),
        sha: exact.oid,
      });
      return true;
    }
    // directory?
    const prefix = path === '' ? '' : `${path}/`;
    const entries: Array<Record<string, unknown>> = [];
    const seenDirs = new Set<string>();
    for (const [filePath, file] of files) {
      if (prefix && !filePath.startsWith(prefix)) continue;
      const rest = prefix ? filePath.slice(prefix.length) : filePath;
      const slash = rest.indexOf('/');
      if (slash < 0) {
        entries.push({ type: 'file', name: rest, path: filePath, sha: file.oid });
      } else {
        const dir = rest.slice(0, slash);
        if (!seenDirs.has(dir)) {
          seenDirs.add(dir);
          entries.push({ type: 'dir', name: dir, path: prefix + dir, sha: file.oid });
        }
      }
    }
    if (!entries.length) return sendError(ctx, 404, 'Not Found'), true;
    entries.sort((a, b) => String(a.name).localeCompare(String(b.name)));
    sendJson(ctx, 200, entries);
    return true;
  }
  if (method === 'PUT') {
    const body = asObject(ctx.body);
    const contentB64 = str(body.content);
    const message = str(body.message) || `Update ${path}`;
    const useBranch = typeof body.branch === 'string' ? (body.branch as string) : branch;
    const files = store.branchFiles(repo, useBranch);
    const existing = files.get(path);
    const sha = typeof body.sha === 'string' ? (body.sha as string) : undefined;
    if (existing && sha && sha.toLowerCase() !== existing.oid) {
      sendError(ctx, 409, 'sha does not match the current file');
      return true;
    }
    let bytes: Buffer;
    try {
      bytes = Buffer.from(contentB64, 'base64');
    } catch {
      sendError(ctx, 400, 'content is not valid base64');
      return true;
    }
    const blobOid = store.putObject(repo, 'blob', bytes);
    files.set(path, { oid: blobOid, mode: '100644' });
    const isNew = !existing;
    const commitSha = store.commitFiles(repo, useBranch, message, files);
    sendJson(ctx, isNew ? 201 : 200, {
      content: { name: path.split('/').pop() ?? path, path, sha: blobOid, size: bytes.length, encoding: 'base64', type: 'file' },
      commit: { sha: commitSha },
    });
    return true;
  }
  if (method === 'DELETE') {
    const files = store.branchFiles(repo, branch);
    if (!files.has(path)) return sendError(ctx, 404, 'Not Found'), true;
    files.delete(path);
    const message = str(asObject(ctx.body).message) || `Delete ${path}`;
    const commitSha = store.commitFiles(repo, branch, message, files);
    sendJson(ctx, 200, { commit: { sha: commitSha } });
    return true;
  }
  return false;
}

function handleIssues(ctx: Ctx, repo: Repo, rest: string[], method: string): boolean {
  const q = ctx.query;
  if (rest.length === 0) {
    if (method === 'POST') {
      const body = asObject(ctx.body);
      const title = str(body.title);
      const labels = Array.isArray(body.labels) ? (body.labels as unknown[]).map(String) : [];
      for (const label of labels) {
        if (!repo.labels.has(label)) return sendError(ctx, 422, `Label ${label} does not exist`), true;
      }
      const seq = nextSeq();
      const issue: Issue = {
        id: store.nextId(),
        number: repo.nextNumber++,
        title,
        body: str(body.body),
        state: 'open',
        labels,
        comments: [],
        seq,
        createdAt: stampFor(seq),
      };
      repo.issues.push(issue);
      sendJson(ctx, 201, issueJson(repo, issue));
      return true;
    }
    if (method === 'GET') {
      const state = q.get('state') ?? 'open';
      const sort = q.get('sort') ?? 'created';
      const direction = q.get('direction') ?? 'desc';
      let list = repo.issues.filter((i) => (state === 'all' ? true : i.state === state));
      if (sort === 'created') {
        list = [...list].sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
      }
      const perPage = Number.parseInt(q.get('per_page') ?? '30', 10) || 30;
      sendJson(ctx, 200, list.slice(0, perPage).map((i) => issueJson(repo, i)));
      return true;
    }
    return false;
  }
  const number = Number.parseInt(rest[0], 10);
  const issue = repo.issues.find((i) => i.number === number);
  if (rest.length === 1) {
    if (method === 'GET') {
      if (!issue) return sendError(ctx, 404, 'Not Found'), true;
      sendJson(ctx, 200, issueJson(repo, issue));
      return true;
    }
    if (method === 'PATCH') {
      if (!issue) return sendError(ctx, 404, 'Not Found'), true;
      const body = asObject(ctx.body);
      if (body.state === 'open' || body.state === 'closed') issue.state = body.state;
      if (typeof body.title === 'string') issue.title = body.title;
      if (typeof body.body === 'string') issue.body = body.body;
      sendJson(ctx, 200, issueJson(repo, issue));
      return true;
    }
    return false;
  }
  if (rest.length === 2 && rest[1] === 'comments') {
    if (!issue) return sendError(ctx, 404, 'Not Found'), true;
    if (method === 'POST') {
      const body = asObject(ctx.body);
      const comment = { id: repo.nextCommentId++, body: str(body.body) };
      issue.comments.push(comment);
      sendJson(ctx, 201, { id: comment.id, body: comment.body });
      return true;
    }
    if (method === 'GET') {
      sendJson(ctx, 200, issue.comments.map((c) => ({ id: c.id, body: c.body })));
      return true;
    }
    return false;
  }
  return false;
}

function handlePulls(ctx: Ctx, repo: Repo, rest: string[], method: string): boolean {
  const q = ctx.query;
  if (rest.length === 0) {
    if (method === 'POST') {
      const body = asObject(ctx.body);
      const headRef = str(body.head);
      const baseRef = str(body.base) || repo.defaultBranch;
      const headSha = store.branchTip(repo, headRef);
      const baseSha = store.branchTip(repo, baseRef);
      const seq = nextSeq();
      const pull: Pull = {
        id: store.nextId(),
        number: repo.nextNumber++,
        title: str(body.title),
        body: str(body.body),
        state: 'open',
        headRef,
        baseRef,
        headSha,
        baseSha,
        merged: false,
        mergedAt: null,
        mergeCommitSha: null,
        seq,
        createdAt: stampFor(seq),
      };
      repo.pulls.push(pull);
      sendJson(ctx, 201, pullJson(repo, pull));
      return true;
    }
    if (method === 'GET') {
      const state = q.get('state') ?? 'open';
      const list = repo.pulls.filter((p) => (state === 'all' ? true : p.state === state));
      sendJson(ctx, 200, list.map((p) => pullJson(repo, p)));
      return true;
    }
    return false;
  }
  const number = Number.parseInt(rest[0], 10);
  const pull = repo.pulls.find((p) => p.number === number);
  if (rest.length === 1) {
    if (method === 'GET') {
      if (!pull) return sendError(ctx, 404, 'Not Found'), true;
      sendJson(ctx, 200, pullJson(repo, pull));
      return true;
    }
    return false;
  }
  if (rest.length === 2 && rest[1] === 'files' && method === 'GET') {
    if (!pull) return sendError(ctx, 404, 'Not Found'), true;
    sendJson(ctx, 200, diffFiles(repo, pull.baseSha, pull.headSha));
    return true;
  }
  if (rest.length === 2 && rest[1] === 'merge' && method === 'PUT') {
    if (!pull) return sendError(ctx, 404, 'Not Found'), true;
    if (pull.merged && pull.mergeCommitSha) {
      sendJson(ctx, 200, { merged: true, sha: pull.mergeCommitSha, message: 'Already merged' });
      return true;
    }
    const ok = doMerge(repo, pull);
    if (!ok) return sendError(ctx, 405, 'Merge conflict'), true;
    sendJson(ctx, 200, { merged: true, sha: pull.mergeCommitSha!, message: `Pull request #${pull.number} merged` });
    return true;
  }
  return false;
}
