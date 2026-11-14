// Minimal GraphQL executor for the exact documents gh and github-mcp-server send:
// viewer/repository/node/__type queries, issue/PR connections, and the five mutations.
// A small recursive-descent parser + a resolver over the shared store.
import { store, nextSeq, stampFor, gid, parseGid, DEFAULT_BRANCH, type Issue, type Pull, type Repo } from './store.ts';
import { VIEWER } from './scenario.ts';

// ------------------------------------------------------------------ parser
type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Record<string, ValueNode> };

interface FieldNode {
  kind: 'field';
  alias: string | null;
  name: string;
  args: Record<string, ValueNode>;
  selections: SelectionNode[];
}
interface FragmentSpreadNode {
  kind: 'spread';
  name: string;
}
interface InlineFragmentNode {
  kind: 'inline';
  typeCondition: string | null;
  selections: SelectionNode[];
}
type SelectionNode = FieldNode | FragmentSpreadNode | InlineFragmentNode;

interface OperationNode {
  kind: 'operation';
  operation: 'query' | 'mutation';
  name: string | null;
  variableDefs: Record<string, ValueNode | null>; // name -> default value node
  selections: SelectionNode[];
}
interface FragmentNode {
  kind: 'fragment';
  name: string;
  typeCondition: string;
  selections: SelectionNode[];
}
type DefinitionNode = OperationNode | FragmentNode;

interface Token {
  kind: 'name' | 'int' | 'float' | 'string' | 'punct' | 'spread';
  value: string;
}

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < input.length && input[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && input.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'spread', value: '...' });
      i += 3;
      continue;
    }
    if ('!$():=@[]{}.|'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < input.length && input[j] !== '"') {
        if (input[j] === '\\' && j + 1 < input.length) {
          const esc = input[j + 1];
          if (esc === 'n') out += '\n';
          else if (esc === 't') out += '\t';
          else if (esc === 'r') out += '\r';
          else if (esc === '"') out += '"';
          else if (esc === '\\') out += '\\';
          else if (esc === '/') out += '/';
          else if (esc === 'u') {
            out += String.fromCharCode(Number.parseInt(input.slice(j + 2, j + 6), 16));
            j += 4;
          } else out += esc;
          j += 2;
        } else {
          out += input[j];
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      if (input[j] === '-') j += 1;
      while (j < input.length && /[0-9]/.test(input[j])) j += 1;
      let isFloat = false;
      if (input[j] === '.' && /[0-9]/.test(input[j + 1] ?? '')) {
        isFloat = true;
        j += 1;
        while (j < input.length && /[0-9]/.test(input[j])) j += 1;
      }
      if (input[j] === 'e' || input[j] === 'E') {
        isFloat = true;
        j += 1;
        if (input[j] === '+' || input[j] === '-') j += 1;
        while (j < input.length && /[0-9]/.test(input[j])) j += 1;
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value: input.slice(i, j) });
      i = j;
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      let j = i;
      while (j < input.length && /[_A-Za-z0-9]/.test(input[j])) j += 1;
      tokens.push({ kind: 'name', value: input.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} in query`);
  }
  return tokens;
}

class Parser {
  private pos = 0;
  private tokens: Token[];
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }
  peek(): Token | undefined {
    return this.tokens[this.pos];
  }
  next(): Token {
    const token = this.tokens[this.pos++];
    if (!token) throw new Error('unexpected end of query');
    return token;
  }
  expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected ${value}, got ${token.value}`);
  }
  expectName(value?: string): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error(`expected name, got ${token.value}`);
    if (value && token.value !== value) throw new Error(`expected ${value}, got ${token.value}`);
    return token.value;
  }
  skipDirectives(): void {
    while (this.peek()?.kind === 'punct' && this.peek()?.value === '@') {
      this.next();
      this.expectName();
      if (this.peek()?.value === '(') this.parseArguments();
    }
  }
  parseDocument(): DefinitionNode[] {
    const defs: DefinitionNode[] = [];
    while (this.pos < this.tokens.length) defs.push(this.parseDefinition());
    return defs;
  }
  parseDefinition(): DefinitionNode {
    const token = this.peek();
    if (token?.kind === 'name' && token.value === 'fragment') {
      this.next();
      const name = this.expectName();
      this.expectName('on');
      const typeCondition = this.expectName();
      this.skipDirectives();
      return { kind: 'fragment', name, typeCondition, selections: this.parseSelectionSet() };
    }
    let operation: 'query' | 'mutation' = 'query';
    let name: string | null = null;
    if (token?.kind === 'name' && (token.value === 'query' || token.value === 'mutation')) {
      operation = token.value as 'query' | 'mutation';
      this.next();
      if (this.peek()?.kind === 'name') name = this.next().value;
    }
    const variableDefs: Record<string, ValueNode | null> = {};
    if (this.peek()?.value === '(') {
      this.next();
      while (this.peek()?.value !== ')') {
        this.expectPunct('$');
        const varName = this.expectName();
        this.expectPunct(':');
        // type: Name, [Name], Name!, [Name!]! — skip tokens until ',' ')' or '='
        let depth = 0;
        while (this.pos < this.tokens.length) {
          const t = this.peek()!;
          if (t.value === '[') depth += 1;
          if (t.value === ']') depth -= 1;
          if (depth === 0 && (t.value === ',' || t.value === ')' || t.value === '=')) break;
          this.next();
        }
        let def: ValueNode | null = null;
        if (this.peek()?.value === '=') {
          this.next();
          def = this.parseValue();
        }
        variableDefs[varName] = def;
        if (this.peek()?.value === ',') this.next();
      }
      this.expectPunct(')');
    }
    this.skipDirectives();
    return { kind: 'operation', operation, name, variableDefs, selections: this.parseSelectionSet() };
  }
  parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (this.peek()?.value !== '}') {
      selections.push(this.parseSelection());
    }
    this.expectPunct('}');
    return selections;
  }
  parseSelection(): SelectionNode {
    const token = this.peek();
    if (token?.kind === 'spread') {
      this.next();
      const next = this.peek();
      if (next?.kind === 'name' && next.value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        this.skipDirectives();
        return { kind: 'inline', typeCondition, selections: this.parseSelectionSet() };
      }
      if (next?.kind === 'name') {
        const name = this.next().value;
        this.skipDirectives();
        return { kind: 'spread', name };
      }
      this.skipDirectives();
      return { kind: 'inline', typeCondition: null, selections: this.parseSelectionSet() };
    }
    const first = this.expectName();
    let alias: string | null = null;
    let name = first;
    if (this.peek()?.value === ':') {
      this.next();
      alias = first;
      name = this.expectName();
    }
    const args = this.peek()?.value === '(' ? this.parseArguments() : {};
    this.skipDirectives();
    const selections = this.peek()?.value === '{' ? this.parseSelectionSet() : [];
    return { kind: 'field', alias, name, args, selections };
  }
  parseArguments(): Record<string, ValueNode> {
    const args: Record<string, ValueNode> = {};
    this.expectPunct('(');
    while (this.peek()?.value !== ')') {
      const name = this.expectName();
      this.expectPunct(':');
      args[name] = this.parseValue();
      if (this.peek()?.value === ',') this.next();
    }
    this.expectPunct(')');
    return args;
  }
  parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') {
      return { kind: 'variable', name: this.expectName() };
    }
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'int') return { kind: 'int', value: Number.parseInt(token.value, 10) };
    if (token.kind === 'float') return { kind: 'float', value: Number.parseFloat(token.value) };
    if (token.kind === 'punct' && token.value === '[') {
      const values: ValueNode[] = [];
      while (this.peek()?.value !== ']') {
        values.push(this.parseValue());
        if (this.peek()?.value === ',') this.next();
      }
      this.expectPunct(']');
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Record<string, ValueNode> = {};
      while (this.peek()?.value !== '}') {
        const name = this.expectName();
        this.expectPunct(':');
        fields[name] = this.parseValue();
        if (this.peek()?.value === ',') this.next();
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error(`unexpected value token ${token.value}`);
  }
}

export function parseQuery(query: string): DefinitionNode[] {
  return new Parser(tokenize(query)).parseDocument();
}

// ------------------------------------------------------------------ values
type JsonValue = string | number | boolean | null | Record<string, unknown> | unknown[];

function evalValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name] ?? null;
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.values.map((v) => evalValue(v, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(node.fields)) out[k] = evalValue(v, variables);
      return out;
    }
  }
}

function evalArgs(args: Record<string, ValueNode>, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) out[k] = evalValue(v, variables);
  return out;
}

// ------------------------------------------------------------------ schema
const TYPE_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', '__type'],
  User: ['login', 'id', 'name'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest'],
  Issue: ['id', 'number', 'title', 'state', 'body'],
  IssueConnection: ['nodes', 'pageInfo', 'totalCount'],
  PageInfo: ['hasNextPage', 'endCursor', 'hasPreviousPage', 'startCursor'],
  PullRequest: ['id', 'number', 'title', 'state', 'merged', 'headRefName', 'baseRefName', 'mergeable', 'files'],
  PullRequestConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestChangedFile: ['path'],
  PullRequestChangedFileConnection: ['nodes'],
  IssueComment: ['id', 'body'],
  BranchRef: ['name'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
};
const SEARCH_TYPE_VALUES = ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT'];

// ------------------------------------------------------------------ model wrappers
type GqlValue =
  | { __type: 'User'; login: string }
  | { __type: 'Repository'; repo: Repo }
  | { __type: 'Issue'; repo: Repo; issue: Issue }
  | { __type: 'PullRequest'; repo: Repo; pull: Pull }
  | { __type: 'IssueComment'; repo: Repo; issue: Issue; id: number; body: string }
  | { __type: 'BranchRef'; name: string }
  | { __type: 'IssueConnection'; repo: Repo; nodes: Array<{ __type: 'Issue'; repo: Repo; issue: Issue }>; pageInfo: { __type: 'PageInfo'; hasNextPage: boolean; endCursor: string | null } }
  | { __type: 'PullRequestConnection'; nodes: Array<{ __type: 'PullRequest'; repo: Repo; pull: Pull }> }
  | { __type: 'PullRequestChangedFileConnection'; nodes: Array<{ __type: 'PullRequestChangedFile'; path: string }> }
  | { __type: 'PullRequestChangedFile'; path: string }
  | { __type: 'TypeInfo'; name: string }
  | { __type: 'TypeField'; name: string }
  | { __type: 'EnumValue'; name: string }
  | { __type: 'PageInfo'; hasNextPage: boolean; endCursor: string | null }
  | { __type: 'CreateIssuePayload'; issue: GqlValue | null }
  | { __type: 'CloseIssuePayload'; issue: GqlValue | null }
  | { __type: 'CreatePullRequestPayload'; pullRequest: GqlValue | null }
  | { __type: 'MergePullRequestPayload'; pullRequest: GqlValue | null }
  | { __type: 'AddCommentPayload'; commentEdge: GqlValue | null }
  | { __type: 'CommentEdge'; node: GqlValue | null }
  | Record<string, unknown>;

function stateOf(issue: Issue): string {
  return issue.state === 'open' ? 'OPEN' : 'CLOSED';
}
function prStateOf(pull: Pull): string {
  if (pull.merged) return 'MERGED';
  return pull.state === 'open' ? 'OPEN' : 'CLOSED';
}

function findRepoById(id: number): Repo | undefined {
  for (const repo of store.repos.values()) if (repo.id === id) return repo;
  return undefined;
}

function issuesConnection(repo: Repo, args: Record<string, unknown>): { __type: 'IssueConnection'; repo: Repo; nodes: Array<{ __type: 'Issue'; repo: Repo; issue: Issue }>; pageInfo: { __type: 'PageInfo'; hasNextPage: boolean; endCursor: string | null } } {
  let list = [...repo.issues];
  const states = Array.isArray(args.states) ? (args.states as string[]) : null;
  if (states) list = list.filter((i) => states.includes(stateOf(i)));
  const orderBy = (args.orderBy ?? {}) as Record<string, unknown>;
  const direction = orderBy.direction === 'ASC' ? 1 : -1;
  list.sort((a, b) => (a.seq - b.seq) * direction || (a.number - b.number) * direction);
  const first = typeof args.first === 'number' ? args.first : 10;
  let start = 0;
  if (typeof args.after === 'string' && args.after) {
    try {
      const decoded = Buffer.from(args.after, 'base64').toString('utf8');
      const afterNum = Number.parseInt(decoded.slice(2), 10);
      const index = list.findIndex((i) => i.number === afterNum);
      if (index >= 0) start = index + 1;
    } catch {
      start = 0;
    }
  }
  const page = list.slice(start, start + first);
  const hasNextPage = start + page.length < list.length;
  const endCursor = page.length ? Buffer.from(`n:${page[page.length - 1].number}`).toString('base64') : null;
  return {
    __type: 'IssueConnection',
    repo,
    nodes: page.map((issue) => ({ __type: 'Issue' as const, repo, issue })),
    pageInfo: { __type: 'PageInfo' as const, hasNextPage, endCursor },
  };
}

// ------------------------------------------------------------------ executor
export interface GqlResult {
  data?: Record<string, unknown> | null;
  errors?: Array<{ message: string }>;
}

class Executor {
  errors: Array<{ message: string }> = [];
  fragments = new Map<string, FragmentNode>();

  execute(doc: DefinitionNode[], variables: Record<string, unknown>, operationName?: string | null): GqlResult {
    for (const def of doc) if (def.kind === 'fragment') this.fragments.set(def.name, def);
    const operations = doc.filter((d): d is OperationNode => d.kind === 'operation');
    const operation = operationName
      ? operations.find((o) => o.name === operationName)
      : operations[0];
    if (!operation) return { errors: [{ message: 'no operation found' }] };
    const vars: Record<string, unknown> = {};
    for (const [name, def] of Object.entries(operation.variableDefs)) {
      if (name in variables) vars[name] = variables[name];
      else if (def) vars[name] = evalValue(def, {});
    }
    for (const [k, v] of Object.entries(variables)) if (!(k in vars)) vars[k] = v;
    const rootType = operation.operation === 'mutation' ? 'Mutation' : 'Query';
    const data = this.executeSelections(operation.selections, rootType, { __type: 'Root' } as unknown as GqlValue, vars);
    const result: GqlResult = { data };
    if (this.errors.length) result.errors = this.errors;
    return result;
  }

  private executeSelections(
    selections: SelectionNode[],
    typeName: string,
    value: GqlValue,
    vars: Record<string, unknown>,
  ): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const selection of selections) {
      if (selection.kind === 'spread') {
        const fragment = this.fragments.get(selection.name);
        if (fragment) Object.assign(out, this.executeSelections(fragment.selections, typeName, value, vars));
        continue;
      }
      if (selection.kind === 'inline') {
        if (!selection.typeCondition || selection.typeCondition === typeName || selection.typeCondition === 'Node') {
          Object.assign(out, this.executeSelections(selection.selections, selection.typeCondition ?? typeName, value, vars));
        }
        continue;
      }
      const key = selection.alias ?? selection.name;
      out[key] = this.executeField(selection, typeName, value, vars);
    }
    return out;
  }

  private executeField(field: FieldNode, typeName: string, value: GqlValue, vars: Record<string, unknown>): unknown {
    const args = evalArgs(field.args, vars);
    const resolved = this.resolve(typeName, field.name, value, args);
    if (resolved === undefined) {
      this.errors.push({ message: `Cannot query field "${field.name}" on type "${typeName}".` });
      return null;
    }
    if (field.selections.length === 0) return resolved;
    if (resolved === null) return null;
    if (Array.isArray(resolved)) {
      return resolved.map((item) => this.executeSelections(field.selections, this.typeOf(item), item, vars));
    }
    return this.executeSelections(field.selections, this.typeOf(resolved), resolved, vars);
  }

  private typeOf(value: GqlValue): string {
    if (value !== null && typeof value === 'object' && '__type' in value) return (value as { __type: string }).__type;
    return 'Unknown';
  }

  private resolve(typeName: string, fieldName: string, value: GqlValue, args: Record<string, unknown>): unknown {
    // Root
    if (typeName === 'Query') {
      if (fieldName === 'viewer') return { __type: 'User', login: VIEWER.login } as GqlValue;
      if (fieldName === 'repository') {
        const owner = String(args.owner ?? '');
        const name = String(args.name ?? '');
        if (owner !== store.viewerLogin) return null;
        const repo = store.getRepo(owner, name);
        return repo ? ({ __type: 'Repository', repo } as GqlValue) : null;
      }
      if (fieldName === 'node') {
        const parsed = parseGid(String(args.id ?? ''));
        if (!parsed) return null;
        if (parsed.kind === 'Repository') {
          const repo = findRepoById(Number(parsed.parts[0]));
          return repo ? ({ __type: 'Repository', repo } as GqlValue) : null;
        }
        if (parsed.kind === 'Issue') {
          const repo = findRepoById(Number(parsed.parts[0]));
          const issue = repo?.issues.find((i) => i.number === Number(parsed.parts[1]));
          return repo && issue ? ({ __type: 'Issue', repo, issue } as GqlValue) : null;
        }
        if (parsed.kind === 'PullRequest') {
          const repo = findRepoById(Number(parsed.parts[0]));
          const pull = repo?.pulls.find((p) => p.number === Number(parsed.parts[1]));
          return repo && pull ? ({ __type: 'PullRequest', repo, pull } as GqlValue) : null;
        }
        return null;
      }
      if (fieldName === '__type') {
        const name = String(args.name ?? '');
        if (TYPE_FIELDS[name] || name === 'SearchType' || name === 'IssueState' || name === 'MergeableState' || name === 'PullRequestState' || name === 'PullRequestMergeMethod' || name === 'RepositoryPermission' || name === 'IssueOrderField' || name === 'OrderDirection') {
          return { __type: 'TypeInfo', name } as GqlValue;
        }
        return null;
      }
    }
    if (typeName === 'Mutation') return this.resolveMutation(fieldName, args);
    if (typeName === 'TypeInfo') {
      const info = value as { __type: 'TypeInfo'; name: string };
      if (fieldName === 'name') return info.name;
      if (fieldName === 'fields') return (TYPE_FIELDS[info.name] ?? []).map((n) => ({ __type: 'TypeField', name: n }));
      if (fieldName === 'enumValues') {
        if (info.name === 'SearchType') return SEARCH_TYPE_VALUES.map((n) => ({ __type: 'EnumValue', name: n }));
        return [];
      }
    }
    if (typeName === 'TypeField' || typeName === 'EnumValue') {
      const item = value as { name: string };
      if (fieldName === 'name') return item.name;
    }
    if (typeName === 'CreateIssuePayload' || typeName === 'CloseIssuePayload') {
      const payload = value as { issue: GqlValue | null };
      if (fieldName === 'issue') return payload.issue;
    }
    if (typeName === 'CreatePullRequestPayload' || typeName === 'MergePullRequestPayload') {
      const payload = value as { pullRequest: GqlValue | null };
      if (fieldName === 'pullRequest') return payload.pullRequest;
    }
    if (typeName === 'AddCommentPayload') {
      const payload = value as { commentEdge: GqlValue | null };
      if (fieldName === 'commentEdge') return payload.commentEdge;
    }
    if (typeName === 'CommentEdge') {
      const edge = value as { node: GqlValue | null };
      if (fieldName === 'node') return edge.node;
    }
    if (typeName === 'User') {
      const user = value as { __type: 'User'; login: string };
      if (fieldName === 'login') return user.login;
      if (fieldName === 'id') return gid('User', user.login);
      if (fieldName === 'name') return user.login;
    }
    if (typeName === 'Repository') {
      const wrap = value as { __type: 'Repository'; repo: Repo };
      const repo = wrap.repo;
      switch (fieldName) {
        case 'id': return gid('Repository', repo.id);
        case 'databaseId': return repo.id;
        case 'name': return repo.name;
        case 'nameWithOwner': return `${repo.owner}/${repo.name}`;
        case 'owner': return { __type: 'User', login: repo.owner } as GqlValue;
        case 'defaultBranchRef': return { __type: 'BranchRef', name: repo.defaultBranch } as GqlValue;
        case 'viewerPermission': return 'ADMIN';
        case 'hasIssuesEnabled': return true;
        case 'issue': {
          const issue = repo.issues.find((i) => i.number === Number(args.number));
          return issue ? ({ __type: 'Issue', repo, issue } as GqlValue) : null;
        }
        case 'issues': return issuesConnection(repo, args);
        case 'pullRequests': {
          const first = typeof args.first === 'number' ? args.first : 10;
          const nodes = repo.pulls.slice(0, first).map((pull) => ({ __type: 'PullRequest' as const, repo, pull }));
          return { __type: 'PullRequestConnection', nodes } as GqlValue;
        }
        case 'pullRequest': {
          const pull = repo.pulls.find((p) => p.number === Number(args.number));
          return pull ? ({ __type: 'PullRequest', repo, pull } as GqlValue) : null;
        }
      }
    }
    if (typeName === 'Issue') {
      const wrap = value as { __type: 'Issue'; repo: Repo; issue: Issue };
      switch (fieldName) {
        case 'id': return gid('Issue', wrap.repo.id, wrap.issue.number);
        case 'number': return wrap.issue.number;
        case 'title': return wrap.issue.title;
        case 'state': return stateOf(wrap.issue);
        case 'body': return wrap.issue.body;
      }
    }
    if (typeName === 'IssueConnection') {
      const wrap = value as { __type: 'IssueConnection'; nodes: unknown[]; pageInfo: Record<string, unknown> };
      if (fieldName === 'nodes') return wrap.nodes;
      if (fieldName === 'pageInfo') return wrap.pageInfo;
      if (fieldName === 'totalCount') return wrap.nodes.length;
    }
    if (typeName === 'PageInfo') {
      const info = value as unknown as Record<string, unknown>;
      if (fieldName === 'hasNextPage') return info.hasNextPage ?? false;
      if (fieldName === 'endCursor') return info.endCursor ?? null;
      if (fieldName === 'hasPreviousPage') return false;
      if (fieldName === 'startCursor') return null;
    }
    if (typeName === 'PullRequest') {
      const wrap = value as { __type: 'PullRequest'; repo: Repo; pull: Pull };
      switch (fieldName) {
        case 'id': return gid('PullRequest', wrap.repo.id, wrap.pull.number);
        case 'number': return wrap.pull.number;
        case 'title': return wrap.pull.title;
        case 'state': return prStateOf(wrap.pull);
        case 'merged': return wrap.pull.merged;
        case 'headRefName': return wrap.pull.headRef;
        case 'baseRefName': return wrap.pull.baseRef;
        case 'mergeable': return 'MERGEABLE';
        case 'files': {
          const first = typeof args.first === 'number' ? args.first : 10;
          const { diffFiles } = filesModule;
          const files = diffFiles(wrap.repo, wrap.pull.baseSha, wrap.pull.headSha).slice(0, first);
          return {
            __type: 'PullRequestChangedFileConnection',
            nodes: files.map((f) => ({ __type: 'PullRequestChangedFile', path: f.filename })),
          } as GqlValue;
        }
      }
    }
    if (typeName === 'PullRequestConnection') {
      const wrap = value as { __type: 'PullRequestConnection'; nodes: unknown[] };
      if (fieldName === 'nodes') return wrap.nodes;
      if (fieldName === 'pageInfo') return { __type: 'PageInfo', hasNextPage: false, endCursor: null };
      if (fieldName === 'totalCount') return wrap.nodes.length;
    }
    if (typeName === 'PullRequestChangedFileConnection') {
      const wrap = value as { __type: 'PullRequestChangedFileConnection'; nodes: unknown[] };
      if (fieldName === 'nodes') return wrap.nodes;
    }
    if (typeName === 'PullRequestChangedFile') {
      const wrap = value as { __type: 'PullRequestChangedFile'; path: string };
      if (fieldName === 'path') return wrap.path;
    }
    if (typeName === 'BranchRef') {
      const wrap = value as { __type: 'BranchRef'; name: string };
      if (fieldName === 'name') return wrap.name;
    }
    if (typeName === 'IssueComment') {
      const wrap = value as { __type: 'IssueComment'; id: number; body: string };
      if (fieldName === 'id') return gid('IssueComment', wrap.id);
      if (fieldName === 'body') return wrap.body;
    }
    return undefined;
  }

  private resolveMutation(fieldName: string, args: Record<string, unknown>): unknown {
    const input = (args.input ?? {}) as Record<string, unknown>;
    if (fieldName === 'createIssue') {
      const parsed = parseGid(String(input.repositoryId ?? ''));
      const repo = parsed?.kind === 'Repository' ? findRepoById(Number(parsed.parts[0])) : undefined;
      if (!repo) return { __type: 'CreateIssuePayload', issue: null };
      const seq = nextSeq();
      const issue: Issue = {
        id: store.nextId(),
        number: repo.nextNumber++,
        title: String(input.title ?? ''),
        body: String(input.body ?? ''),
        state: 'open',
        labels: [],
        comments: [],
        seq,
        createdAt: stampFor(seq),
      };
      repo.issues.push(issue);
      return { __type: 'CreateIssuePayload', issue: { __type: 'Issue', repo, issue } };
    }
    if (fieldName === 'closeIssue') {
      const parsed = parseGid(String(input.issueId ?? ''));
      if (parsed?.kind !== 'Issue') return { __type: 'CloseIssuePayload', issue: null };
      const repo = findRepoById(Number(parsed.parts[0]));
      const issue = repo?.issues.find((i) => i.number === Number(parsed.parts[1]));
      if (!issue || !repo) return { __type: 'CloseIssuePayload', issue: null };
      issue.state = 'closed';
      return { __type: 'CloseIssuePayload', issue: { __type: 'Issue', repo, issue } };
    }
    if (fieldName === 'createPullRequest') {
      const parsed = parseGid(String(input.repositoryId ?? ''));
      const repo = parsed?.kind === 'Repository' ? findRepoById(Number(parsed.parts[0])) : undefined;
      if (!repo) return { __type: 'CreatePullRequestPayload', pullRequest: null };
      const headRef = String(input.headRefName ?? '');
      const baseRef = String(input.baseRefName ?? repo.defaultBranch);
      const seq = nextSeq();
      const pull: Pull = {
        id: store.nextId(),
        number: repo.nextNumber++,
        title: String(input.title ?? ''),
        body: String(input.body ?? ''),
        state: 'open',
        headRef,
        baseRef,
        headSha: store.branchTip(repo, headRef),
        baseSha: store.branchTip(repo, baseRef),
        merged: false,
        mergedAt: null,
        mergeCommitSha: null,
        seq,
        createdAt: stampFor(seq),
      };
      repo.pulls.push(pull);
      return { __type: 'CreatePullRequestPayload', pullRequest: { __type: 'PullRequest', repo, pull } };
    }
    if (fieldName === 'mergePullRequest') {
      const parsed = parseGid(String(input.pullRequestId ?? ''));
      if (parsed?.kind !== 'PullRequest') return { __type: 'MergePullRequestPayload', pullRequest: null };
      const repo = findRepoById(Number(parsed.parts[0]));
      const pull = repo?.pulls.find((p) => p.number === Number(parsed.parts[1]));
      if (!repo || !pull) return { __type: 'MergePullRequestPayload', pullRequest: null };
      const merged = doMerge(repo, pull);
      if (!merged) return { __type: 'MergePullRequestPayload', pullRequest: { __type: 'PullRequest', repo, pull } };
      return { __type: 'MergePullRequestPayload', pullRequest: { __type: 'PullRequest', repo, pull } };
    }
    if (fieldName === 'addComment') {
      const parsed = parseGid(String(input.subjectId ?? ''));
      if (parsed?.kind !== 'Issue') return { __type: 'AddCommentPayload', commentEdge: null };
      const repo = findRepoById(Number(parsed.parts[0]));
      const issue = repo?.issues.find((i) => i.number === Number(parsed.parts[1]));
      if (!repo || !issue) return { __type: 'AddCommentPayload', commentEdge: null };
      const comment = { id: repo.nextCommentId++, body: String(input.body ?? '') };
      issue.comments.push(comment);
      return {
        __type: 'AddCommentPayload',
        commentEdge: {
          __type: 'CommentEdge',
          node: { __type: 'IssueComment', repo, issue, id: comment.id, body: comment.body },
        },
      };
    }
    return undefined;
  }
}

// The PR file diff lives in rest.ts; re-export a small local copy here to avoid a cycle.
import { ZERO_OID } from './gitproto.ts';
import { parseCommit } from './gitproto.ts';

function treeOfTip(repo: Repo, tip: string): Map<string, { oid: string; mode: string }> {
  if (!tip || tip === ZERO_OID) return new Map();
  const object = repo.objects.get(tip);
  if (!object || object.type !== 'commit') return new Map();
  return store.treeFiles(repo, parseCommit(object.data).tree);
}

const filesModule = {
  diffFiles(repo: Repo, baseTip: string, headTip: string): Array<{ filename: string }> {
    const baseTree = treeOfTip(repo, baseTip);
    const headTree = treeOfTip(repo, headTip);
    const paths = new Set([...baseTree.keys(), ...headTree.keys()]);
    const out: Array<{ filename: string }> = [];
    for (const path of [...paths].sort()) {
      const b = baseTree.get(path)?.oid;
      const h = headTree.get(path)?.oid;
      if (b !== h) out.push({ filename: path });
    }
    return out;
  },
};

/** Merge a PR (squash onto base). Returns false on conflict. Shared with the REST merge route. */
export function doMerge(repo: Repo, pull: Pull): boolean {
  if (pull.merged && pull.mergeCommitSha) return true;
  const baseTip = store.branchTip(repo, pull.baseRef);
  const headTip = store.branchTip(repo, pull.headRef);
  const base = store.mergeBase(repo, baseTip, headTip);
  const baseFiles = base ? treeOfTip(repo, base) : new Map<string, { oid: string; mode: string }>();
  const baseNow = treeOfTip(repo, baseTip);
  const headFiles = treeOfTip(repo, headTip);
  const paths = new Set([...baseFiles.keys(), ...baseNow.keys(), ...headFiles.keys()]);
  for (const path of paths) {
    const b = baseFiles.get(path)?.oid;
    const now = baseNow.get(path)?.oid;
    const h = headFiles.get(path)?.oid;
    if (b !== now && b !== h && now !== h) return false;
  }
  const merged = new Map(baseNow);
  for (const [path, file] of headFiles) merged.set(path, file);
  for (const path of [...merged.keys()]) {
    if (!headFiles.has(path) && baseFiles.has(path)) merged.delete(path);
  }
  const squashSha = store.commitFiles(repo, pull.baseRef, `Merge pull request #${pull.number} from ${pull.headRef}`, merged);
  pull.merged = true;
  pull.state = 'closed';
  pull.mergedAt = stampFor(nextSeq());
  pull.mergeCommitSha = squashSha;
  return true;
}

export function runGraphQL(body: unknown): GqlResult | GqlResult[] {
  if (Array.isArray(body)) {
    return body.map((item) => runOne(item as Record<string, unknown>));
  }
  return runOne(body as Record<string, unknown>);
}

function runOne(body: Record<string, unknown>): GqlResult {
  const query = typeof body.query === 'string' ? body.query : '';
  const variables = (body.variables ?? {}) as Record<string, unknown>;
  const operationName = typeof body.operationName === 'string' ? body.operationName : null;
  try {
    const doc = parseQuery(query);
    return new Executor().execute(doc, variables, operationName);
  } catch (err) {
    return { errors: [{ message: String((err as Error).message) }] };
  }
}
