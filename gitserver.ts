// Git smart HTTP: info/refs (v0 + v2), upload-pack (v2 ls-refs/fetch, v0 fetch),
// receive-pack v0 with report-status. Plain packs only (no deltas) — the client accepts them.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { store, type Repo } from './store.ts';
import {
  ZERO_OID,
  collectReachable,
  decodePktLines,
  hashObject,
  isAncestor,
  isObjectId,
  parseCommit,
  parseTag,
  parseTree,
  pktLine,
  pktLines,
  readPack,
  sidebandPack,
  writePack,
  type GitObject,
  type Packet,
} from './gitproto.ts';

const AGENT = 'github-forge/1.0';
const UPLOAD_V0_CAPS = `side-band-64k thin-pack ofs-delta multi_ack_detailed shallow symref=HEAD:refs/heads/main agent=${AGENT}`;
const RECEIVE_CAPS = `report-status report-status-v2 side-band-64k delete-refs ofs-delta agent=${AGENT}`;

function send(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length });
  res.end(body);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

interface RefLine {
  oid: string;
  name: string;
  peeled?: string;
  symrefTarget?: string;
  unborn?: boolean;
}

/** All refs of a repo, HEAD first, then heads, then tags (with peeled targets). */
function listRefs(repo: Repo): RefLine[] {
  const out: RefLine[] = [];
  const mainTip = repo.refs.get('refs/heads/main') ?? ZERO_OID;
  if (repo.refs.size === 0) {
    out.push({ oid: ZERO_OID, name: 'HEAD', symrefTarget: 'refs/heads/main', unborn: true });
    return out;
  }
  out.push({ oid: mainTip, name: 'HEAD', symrefTarget: 'refs/heads/main' });
  const heads = [...repo.refs.keys()].filter((r) => r.startsWith('refs/heads/')).sort();
  const tags = [...repo.refs.keys()].filter((r) => r.startsWith('refs/tags/')).sort();
  for (const ref of heads) out.push({ oid: repo.refs.get(ref)!, name: ref });
  for (const ref of tags) {
    const oid = repo.refs.get(ref)!;
    const entry: RefLine = { oid, name: ref };
    const object = repo.objects.get(oid);
    if (object?.type === 'tag') entry.peeled = parseTag(object.data).object;
    out.push(entry);
  }
  return out;
}

function v0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps = service === 'git-upload-pack' ? UPLOAD_V0_CAPS : RECEIVE_CAPS;
  const refs = listRefs(repo);
  const items: Array<string | 'flush'> = [`# service=${service}\n`, 'flush'];
  if (repo.refs.size === 0) {
    items.push(`${ZERO_OID} capabilities^{}\0${caps}\n`);
    items.push(`${ZERO_OID} HEAD\n`);
  } else {
    refs.forEach((ref, index) => {
      if (index === 0) items.push(`${ref.oid} ${ref.name}\0${caps}\n`);
      else items.push(`${ref.oid} ${ref.name}\n`);
      if (ref.peeled) items.push(`${ref.peeled} ${ref.name}^{}\n`);
    });
  }
  items.push('flush');
  return pktLines(items as Array<string | Buffer | 'flush'>);
}

function v2Advertisement(): Buffer {
  return pktLines([
    '# service=git-upload-pack\n',
    'version 2\n',
    'ls-refs=unborn\n',
    'fetch=shallow filter\n',
    'object-format=sha1\n',
    `agent=${AGENT}\n`,
    'flush',
  ]);
}

/** Reachable objects from `tips`, stopping parent traversal at shallow boundary commits. */
function reachableTruncated(repo: Repo, tips: Iterable<string>, boundaries: ReadonlySet<string>): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const tip of tips) if (isObjectId(tip) && tip !== ZERO_OID) queue.push(tip);
  while (queue.length) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (!object) continue;
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      queue.push(commit.tree);
      if (!boundaries.has(oid)) for (const parent of commit.parents) queue.push(parent);
    } else if (object.type === 'tag') {
      queue.push(parseTag(object.data).object);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode !== '160000') queue.push(entry.oid);
      }
    }
  }
  return seen;
}

interface FetchPlan {
  objects: GitObject[];
  shallow: string[];
  unshallow: string[];
}

/** Compute the pack for a fetch: wants minus haves, honouring depth and shallow boundaries. */
function planFetch(
  repo: Repo,
  wants: string[],
  haves: string[],
  depth: number | null,
  shallowBoundaries: string[],
): FetchPlan {
  const boundarySet = new Set(shallowBoundaries);
  const haveClosure = reachableTruncated(repo, haves, boundarySet);
  // Commit set: BFS from wants, limited by depth (depth counts commits: 1 = tips only).
  const wantedCommits: Array<{ oid: string; dist: number }> = [];
  const seenCommit = new Set<string>();
  const queue: Array<{ oid: string; dist: number }> = wants
    .filter((w) => isObjectId(w) && w !== ZERO_OID)
    .map((w) => ({ oid: w, dist: 0 }));
  const shallowOut: string[] = [];
  while (queue.length) {
    const { oid, dist } = queue.shift()!;
    if (seenCommit.has(oid)) continue;
    seenCommit.add(oid);
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    if (depth !== null && dist >= depth) continue;
    wantedCommits.push({ oid, dist });
    const commit = parseCommit(object.data);
    for (const parent of commit.parents) queue.push({ oid: parent, dist: dist + 1 });
    if (depth !== null && dist === depth - 1 && commit.parents.length > 0) shallowOut.push(oid);
  }
  // Closure of wanted commits (trees/blobs fully, parents only if included above).
  const wanted = new Set<string>();
  for (const { oid } of wantedCommits) {
    const object = repo.objects.get(oid);
    if (!object) continue;
    wanted.add(oid);
    const commit = parseCommit(object.data);
    const treeClosure = collectReachable([commit.tree], (id) => repo.objects.get(id));
    for (const id of treeClosure) wanted.add(id);
  }
  // If no depth limit, also include full ancestry of wanted commits.
  if (depth === null) {
    const full = collectReachable(wants, (id) => repo.objects.get(id));
    for (const id of full) wanted.add(id);
  }
  const unshallow: string[] = [];
  for (const boundary of shallowBoundaries) {
    if (seenCommit.has(boundary) && !shallowOut.includes(boundary)) {
      // boundary commit's parents are now included -> no longer shallow
      const object = repo.objects.get(boundary);
      if (object?.type === 'commit') {
        const parents = parseCommit(object.data).parents;
        if (parents.every((p) => seenCommit.has(p))) unshallow.push(boundary);
      }
    }
  }
  const objects: GitObject[] = [];
  for (const oid of wanted) {
    if (haveClosure.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (object) objects.push(object);
  }
  return { objects, shallow: shallowOut, unshallow };
}

function v2FetchResponse(repo: Repo, lines: string[]): Buffer {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | null = null;
  for (const line of lines) {
    const text = line.replace(/\n$/, '');
    if (text.startsWith('want ')) wants.push(text.slice(5).trim());
    else if (text.startsWith('have ')) haves.push(text.slice(5).trim());
    else if (text.startsWith('shallow ')) shallow.push(text.slice(8).trim());
    else if (text.startsWith('deepen ')) depth = Number.parseInt(text.slice(7).trim(), 10);
  }
  const plan = planFetch(repo, wants, haves, depth, shallow);
  const pack = plan.objects.length ? writePack(plan.objects) : writePack([]);
  const parts: Buffer[] = [];
  parts.push(pktLine('acknowledgments\n'));
  if (haves.length && haves.every((h) => repo.objects.has(h))) {
    parts.push(pktLine(`ACK ${haves[0]}\n`));
    parts.push(pktLine('ready\n'));
  } else {
    parts.push(pktLine('NAK\n'));
  }
  parts.push(pktLines(['flush']));
  if (depth !== null || shallow.length) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(pktLines(['flush']));
  }
  parts.push(pktLine('packfile\n'));
  parts.push(sidebandPack(pack));
  parts.push(pktLines(['flush']));
  return Buffer.concat(parts);
}

function v0FetchResponse(repo: Repo, lines: string[]): Buffer {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | null = null;
  for (const line of lines) {
    const text = line.replace(/\n$/, '');
    if (text.startsWith('want ')) wants.push(text.slice(5).split(' ')[0]);
    else if (text.startsWith('have ')) haves.push(text.slice(5).trim());
    else if (text.startsWith('shallow ')) shallow.push(text.slice(8).trim());
    else if (text.startsWith('deepen ')) depth = Number.parseInt(text.slice(7).trim(), 10);
  }
  const plan = planFetch(repo, wants, haves, depth, shallow);
  const pack = plan.objects.length ? writePack(plan.objects) : writePack([]);
  const parts: Buffer[] = [];
  parts.push(pktLine('NAK\n'));
  for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  parts.push(sidebandPack(pack));
  return Buffer.concat(parts);
}

function v2LsRefsResponse(repo: Repo, lines: string[]): Buffer {
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const line of lines) {
    const text = line.replace(/\n$/, '');
    if (text === 'peel') peel = true;
    else if (text === 'symrefs') symrefs = true;
    else if (text === 'unborn') unborn = true;
    else if (text.startsWith('ref-prefix ')) prefixes.push(text.slice(11));
  }
  const refs = listRefs(repo);
  const out: string[] = [];
  for (const ref of refs) {
    if (prefixes.length && !prefixes.some((p) => ref.name.startsWith(p))) continue;
    if (ref.unborn) {
      if (!unborn) continue;
      out.push(`unborn ${ref.name}${ref.symrefTarget ? ` symref-target:${ref.symrefTarget}` : ''}\n`);
      continue;
    }
    let line = `${ref.oid} ${ref.name}`;
    if (symrefs && ref.symrefTarget) line += ` symref-target:${ref.symrefTarget}`;
    if (peel && ref.peeled) line += ` peeled:${ref.peeled}`;
    out.push(`${line}\n`);
  }
  out.push('flush');
  return pktLines(out as Array<string | 'flush'>);
}

export async function handleGit(
  req: IncomingMessage,
  res: ServerResponse,
  owner: string,
  repoName: string,
  sub: string,
  query: URLSearchParams,
): Promise<boolean> {
  const repo = store.getRepo(owner, repoName);
  const method = req.method ?? 'GET';
  // info/refs
  if (method === 'GET' && sub === '/info/refs') {
    const service = query.get('service');
    if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
      send(res, 404, 'application/json', Buffer.from(JSON.stringify({ message: 'Not Found' })));
      return true;
    }
    if (!repo) {
      send(res, 404, 'application/json', Buffer.from(JSON.stringify({ message: 'Not Found' })));
      return true;
    }
    const wantsV2 = service === 'git-upload-pack' && (req.headers['git-protocol'] ?? '') === 'version=2';
    const body = wantsV2 ? v2Advertisement() : v0Advertisement(repo, service);
    const type = `application/x-${service}-advertisement`;
    send(res, 200, type, body);
    return true;
  }
  if (method === 'POST' && (sub === '/git-upload-pack' || sub === '/git-receive-pack')) {
    if (!repo) {
      send(res, 404, 'application/json', Buffer.from(JSON.stringify({ message: 'Not Found' })));
      return true;
    }
    const body = await readBody(req);
    if (sub === '/git-upload-pack') {
      let packets: Packet[];
      try {
        packets = decodePktLines(body);
      } catch {
        send(res, 400, 'application/json', Buffer.from(JSON.stringify({ message: 'malformed pkt-line' })));
        return true;
      }
      const lines = packets.filter((p) => p.kind === 'data').map((p) => (p as { payload: Buffer }).payload.toString('utf8'));
      const isV2 = (req.headers['git-protocol'] ?? '') === 'version=2';
      try {
        const out = isV2
          ? lines[0]?.startsWith('command=ls-refs')
            ? v2LsRefsResponse(repo, lines)
            : v2FetchResponse(repo, lines)
          : v0FetchResponse(repo, lines);
        send(res, 200, 'application/x-git-upload-pack-result', out);
      } catch (err) {
        send(res, 400, 'application/json', Buffer.from(JSON.stringify({ message: String((err as Error).message) })));
      }
      return true;
    }
    // receive-pack
    return handleReceivePack(req, res, repo, body);
  }
  return false;
}

async function handleReceivePack(
  _req: IncomingMessage,
  res: ServerResponse,
  repo: Repo,
  body: Buffer,
): Promise<boolean> {
  const reportLines: string[] = [];
  let unpackOk = true;
  let unpackDetail = 'ok';
  try {
    // Split pkt-line command section from the trailing pack bytes.
    let offset = 0;
    const commands: Array<{ oldOid: string; newOid: string; ref: string }> = [];
    let caps = '';
    while (offset + 4 <= body.length) {
      const header = body.subarray(offset, offset + 4).toString('ascii');
      if (!/^[0-9a-fA-F]{4}$/.test(header)) throw new Error('malformed pkt-line in push');
      const length = Number.parseInt(header, 16);
      if (length === 0) {
        offset += 4;
        break;
      }
      const payload = body.subarray(offset + 4, offset + length).toString('utf8');
      offset += length;
      const line = payload.replace(/\n$/, '');
      const nul = line.indexOf('\0');
      const cmdText = nul >= 0 ? line.slice(0, nul) : line;
      if (nul >= 0 && commands.length === 0) caps = line.slice(nul + 1);
      const parts = cmdText.split(' ');
      if (parts.length !== 3) throw new Error('bad push command');
      commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts[2] });
    }
    const packBytes = body.subarray(offset);
    const sideband = caps.includes('side-band-64k');
    // Unpack the pack (present unless delete-only).
    const updatesRef = commands.some((c) => c.newOid !== ZERO_OID);
    let newObjects = new Map<string, GitObject>();
    if (updatesRef || packBytes.length > 0) {
      if (packBytes.length === 0) throw new Error('missing pack');
      const read = readPack(packBytes, { resolveBase: (oid) => repo.objects.get(oid) });
      newObjects = read.objects;
    }
    // Validate each command, then apply the accepted ones.
    const results: Array<{ ref: string; ok: boolean; reason: string }> = [];
    const staged = new Map<string, string>();
    for (const cmd of commands) {
      const current = repo.refs.get(cmd.ref) ?? ZERO_OID;
      if (cmd.newOid === ZERO_OID) {
        // delete
        if (current === ZERO_OID || current !== cmd.oldOid) {
          results.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' });
        } else {
          staged.set(cmd.ref, ZERO_OID);
          results.push({ ref: cmd.ref, ok: true, reason: '' });
        }
        continue;
      }
      if (!isObjectId(cmd.newOid)) {
        results.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' });
        continue;
      }
      const hasNew = newObjects.has(cmd.newOid) || repo.objects.has(cmd.newOid);
      if (!hasNew) {
        results.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' });
        continue;
      }
      if (current === ZERO_OID) {
        // create
        if (cmd.oldOid !== ZERO_OID) {
          results.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' });
        } else {
          staged.set(cmd.ref, cmd.newOid);
          results.push({ ref: cmd.ref, ok: true, reason: '' });
        }
      } else if (cmd.oldOid !== current) {
        results.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' });
      } else if (!isAncestor(current, cmd.newOid, (oid) => newObjects.get(oid) ?? repo.objects.get(oid))) {
        results.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' });
      } else {
        staged.set(cmd.ref, cmd.newOid);
        results.push({ ref: cmd.ref, ok: true, reason: '' });
      }
    }
    // Store objects, then apply ref updates.
    for (const [oid, object] of newObjects) {
      if (!repo.objects.has(oid)) repo.objects.set(oid, object);
    }
    for (const [ref, oid] of staged) {
      if (oid === ZERO_OID) repo.refs.delete(ref);
      else repo.refs.set(ref, oid);
    }
    reportLines.push(`unpack ${unpackDetail}\n`);
    for (const result of results) {
      if (result.ok) reportLines.push(`ok ${result.ref}\n`);
      else reportLines.push(`ng ${result.ref} ${result.reason}\n`);
    }
    const report = pktLines(reportLines as Array<string | 'flush'>);
    // Wrap in sideband band 1 when negotiated.
    let out: Buffer;
    if (sideband) {
      const parts: Buffer[] = [];
      const CHUNK = 65515;
      for (let off = 0; off < report.length; off += CHUNK) {
        const chunk = report.subarray(off, Math.min(off + CHUNK, report.length));
        parts.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
      }
      out = Buffer.concat(parts);
    } else {
      out = report;
    }
    send(res, 200, 'application/x-git-receive-pack-result', out);
    return true;
  } catch (err) {
    unpackOk = false;
    unpackDetail = String((err as Error).message).slice(0, 120) || 'unpack error';
    void unpackOk;
    const report = pktLines([`unpack ${unpackDetail}\n`, 'flush']);
    send(res, 200, 'application/x-git-receive-pack-result', report);
    return true;
  }
}
