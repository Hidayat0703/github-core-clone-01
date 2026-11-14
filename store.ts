// One in-memory store shared by the git, REST, GraphQL and MCP surfaces. Ids are stable
// across reads; issue/PR numbers are per-repo starting at 1 (one shared counter, as GitHub).
import {
  ZERO_OID,
  buildCommit,
  buildTree,
  collectReachable,
  hashObject,
  isAncestor,
  parseCommit,
  parseTree,
  type GitObject,
  type GitObjectType,
  type TreeEntry,
} from './gitproto.ts';
import { VIEWER } from './scenario.ts';

export interface Label {
  name: string;
  color: string;
}
export interface IssueComment {
  id: number;
  body: string;
}
export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: IssueComment[];
  seq: number;
  createdAt: string;
}
export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  seq: number;
  createdAt: string;
}
export interface Repo {
  id: number;
  name: string;
  owner: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  refs: Map<string, string>;
  objects: Map<string, GitObject>;
  issues: Issue[];
  pulls: Pull[];
  labels: Map<string, Label>;
  nextNumber: number;
  nextCommentId: number;
  seq: number;
}

export const DEFAULT_BRANCH = 'main';
const EPOCH_MS = 1735689600000; // 2025-01-01T00:00:00Z
let globalSeq = 0;
let nextRepoId = 5000;
let nextObjectId = 10000;

export function nextSeq(): number {
  globalSeq += 1;
  return globalSeq;
}
export function stampFor(seq: number): string {
  return new Date(EPOCH_MS + seq * 1000).toISOString();
}

export function gid(kind: string, ...parts: Array<string | number>): string {
  return Buffer.from(`${kind}:${parts.join(':')}`, 'utf8').toString('base64url');
}
export function parseGid(id: string): { kind: string; parts: string[] } | null {
  try {
    const decoded = Buffer.from(id, 'base64url').toString('utf8');
    const [kind, ...parts] = decoded.split(':');
    if (!kind || parts.length === 0) return null;
    return { kind, parts };
  } catch {
    return null;
  }
}

class Store {
  repos = new Map<string, Repo>();
  token = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  viewerLogin = VIEWER.login;
  viewerId = VIEWER.id;

  key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }
  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.key(owner, name));
  }
  createRepo(owner: string, name: string, description: string, isPrivate: boolean): Repo {
    const repo: Repo = {
      id: nextRepoId++,
      name,
      owner,
      description,
      private: isPrivate,
      defaultBranch: DEFAULT_BRANCH,
      refs: new Map(),
      objects: new Map(),
      issues: [],
      pulls: [],
      labels: new Map(),
      nextNumber: 1,
      nextCommentId: 1,
      seq: nextSeq(),
    };
    this.repos.set(this.key(owner, name), repo);
    return repo;
  }
  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.key(owner, name));
  }
  listRepos(owner: string): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) if (repo.owner === owner) out.push(repo);
    out.sort((a, b) => a.seq - b.seq);
    return out;
  }

  // ---- git objects -------------------------------------------------------
  putObject(repo: Repo, type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }
  getObject(repo: Repo, oid: string): GitObject | undefined {
    return repo.objects.get(oid);
  }
  lookup(repo: Repo): (oid: string) => GitObject | undefined {
    return (oid) => repo.objects.get(oid);
  }

  // ---- trees / files -----------------------------------------------------
  /** Flat path -> {oid, mode} for the tree at `treeOid`. */
  treeFiles(repo: Repo, treeOid: string): Map<string, { oid: string; mode: string }> {
    const out = new Map<string, { oid: string; mode: string }>();
    const walk = (oid: string, prefix: string): void => {
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'tree') return;
      for (const entry of parseTree(object.data)) {
        const path = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.mode === '40000') walk(entry.oid, path);
        else out.set(path, { oid: entry.oid, mode: entry.mode });
      }
    };
    walk(treeOid, '');
    return out;
  }

  /** Build (and store) a tree object from a flat file map; returns the tree oid. */
  filesTree(repo: Repo, files: Map<string, { oid: string; mode: string }>): string {
    // group by directory
    const buildDir = (prefix: string): string => {
      const entries: TreeEntry[] = [];
      const dirs = new Set<string>();
      for (const [path, file] of files) {
        if (prefix && !path.startsWith(`${prefix}/`)) continue;
        const rest = prefix ? path.slice(prefix.length + 1) : path;
        const slash = rest.indexOf('/');
        if (slash < 0) entries.push({ mode: file.mode, name: rest, oid: file.oid });
        else dirs.add(rest.slice(0, slash));
      }
      for (const dir of dirs) {
        const sub = prefix ? `${prefix}/${dir}` : dir;
        entries.push({ mode: '40000', name: dir, oid: buildDir(sub) });
      }
      return this.putObject(repo, 'tree', buildTree(entries));
    };
    return buildDir('');
  }

  /** Create a commit on `branch` from a file map; returns the commit oid. */
  commitFiles(
    repo: Repo,
    branch: string,
    message: string,
    files: Map<string, { oid: string; mode: string }>,
    author?: string,
  ): string {
    const treeOid = this.filesTree(repo, files);
    const ref = `refs/heads/${branch}`;
    const parent = repo.refs.get(ref);
    const identity = author ?? `${VIEWER.name} <${VIEWER.email}>`;
    const commit = buildCommit({
      tree: treeOid,
      parents: parent && parent !== ZERO_OID ? [parent] : [],
      message,
      author: identity,
      committer: identity,
    });
    const oid = this.putObject(repo, 'commit', commit);
    repo.refs.set(ref, oid);
    return oid;
  }

  branchFiles(repo: Repo, branch: string): Map<string, { oid: string; mode: string }> {
    const tip = repo.refs.get(`refs/heads/${branch}`);
    if (!tip || tip === ZERO_OID) return new Map();
    const object = repo.objects.get(tip);
    if (!object || object.type !== 'commit') return new Map();
    return this.treeFiles(repo, parseCommit(object.data).tree);
  }

  branchTip(repo: Repo, branch: string): string {
    return repo.refs.get(`refs/heads/${branch}`) ?? ZERO_OID;
  }

  reachable(repo: Repo, tips: Iterable<string>): Set<string> {
    return collectReachable(tips, this.lookup(repo));
  }

  isAncestorOf(repo: Repo, ancestor: string, tip: string): boolean {
    return isAncestor(ancestor, tip, this.lookup(repo));
  }

  /** Merge-base of two commits (nearest common ancestor, BFS by depth). */
  mergeBase(repo: Repo, a: string, b: string): string | null {
    if (a === ZERO_OID || b === ZERO_OID) return null;
    const depthA = new Map<string, number>();
    const queueA: Array<[string, number]> = [[a, 0]];
    while (queueA.length) {
      const [oid, depth] = queueA.shift()!;
      if (depthA.has(oid)) continue;
      depthA.set(oid, depth);
      const object = repo.objects.get(oid);
      if (object?.type === 'commit') {
        for (const parent of parseCommit(object.data).parents) queueA.push([parent, depth + 1]);
      }
    }
    const queueB: Array<[string, number]> = [[b, 0]];
    const seenB = new Set<string>();
    let best: string | null = null;
    let bestDepth = Infinity;
    while (queueB.length) {
      const [oid, depth] = queueB.shift()!;
      if (seenB.has(oid)) continue;
      seenB.add(oid);
      if (depthA.has(oid)) {
        const total = (depthA.get(oid) ?? 0) + depth;
        if (total < bestDepth) {
          bestDepth = total;
          best = oid;
        }
      }
      const object = repo.objects.get(oid);
      if (object?.type === 'commit') {
        for (const parent of parseCommit(object.data).parents) queueB.push([parent, depth + 1]);
      }
    }
    return best;
  }

  nextId(): number {
    nextObjectId += 1;
    return nextObjectId;
  }
}

export const store = new Store();
