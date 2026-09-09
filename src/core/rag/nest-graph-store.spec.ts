import Database from 'better-sqlite3';
import { analyzeNestGraph } from '../tools/ast/nest-graph';
import {
  backfillNestGraph,
  ensureNestGraphSchema,
  findBindingsForModule,
  findBindingsForToken,
  findInjectionsForToken,
  findUnexportedInjections,
  normalizeToken,
  replaceNestGraphForFile,
} from './nest-graph-store';

/** A registry plus the Nest tables, enough to exercise the cascade. */
function store(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE file_registry (
      path TEXT PRIMARY KEY,
      hash TEXT NOT NULL
    );
  `);
  ensureNestGraphSchema(db);
  return db;
}

function register(db: Database.Database, filePath: string): void {
  db.prepare('INSERT OR IGNORE INTO file_registry (path, hash) VALUES (?, ?)').run(filePath, 'h');
}

function index(db: Database.Database, filePath: string, source: string): void {
  register(db, filePath);
  replaceNestGraphForFile(db, filePath, analyzeNestGraph(filePath, source));
}

const HTTP_MODULE = `
  @Module({})
  export class HttpModule {
    static forRoot(options: Options): DynamicModule {
      return {
        module: HttpModule,
        controllers: [HttpController],
        providers: [HttpService, { provide: 'HTTP_OPTIONS', useValue: options }],
        exports: [HttpService],
      };
    }
  }
`;

const HTTP_SERVICE = `
  @Injectable()
  export class HttpService {
    constructor(
      @Inject('HTTP_OPTIONS') private readonly options: Options,
      private readonly clock: Clock,
    ) {}
  }
`;

describe('normalizeToken', () => {
  it('ignores the quoting the source happened to use', () => {
    expect(normalizeToken("'AI_AGENT'")).toBe('AI_AGENT');
    expect(normalizeToken('"AI_AGENT"')).toBe('AI_AGENT');
    expect(normalizeToken('  AI_AGENT  ')).toBe('AI_AGENT');
  });
});

describe('replaceNestGraphForFile', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = store();
  });

  afterEach(() => db.close());

  it('stores what a dynamic module binds', () => {
    index(db, 'src/http/http.module.ts', HTTP_MODULE);

    const bindings = findBindingsForModule(db, 'HttpModule');

    expect(bindings.map((b) => `${b.kind}:${b.token}`)).toEqual([
      'controller:HttpController',
      "export:HttpService",
      "provider:'HTTP_OPTIONS'",
      'provider:HttpService',
    ]);
    expect(bindings.every((b) => b.dynamic)).toBe(true);
  });

  // A re-index must remove what the file stopped declaring; otherwise the graph
  // accumulates providers that no longer exist and reads as authoritative.
  it('removes a binding the file stopped declaring', () => {
    index(db, 'src/users/users.module.ts', `
      @Module({ providers: [UsersService, LegacyService] })
      export class UsersModule {}
    `);
    expect(findBindingsForModule(db, 'UsersModule')).toHaveLength(2);

    index(db, 'src/users/users.module.ts', `
      @Module({ providers: [UsersService] })
      export class UsersModule {}
    `);

    expect(findBindingsForModule(db, 'UsersModule').map((b) => b.token)).toEqual(['UsersService']);
  });

  it('drops the wiring of a file that leaves the registry', () => {
    index(db, 'src/http/http.module.ts', HTTP_MODULE);
    expect(findBindingsForModule(db, 'HttpModule').length).toBeGreaterThan(0);

    db.prepare('DELETE FROM file_registry WHERE path = ?').run('src/http/http.module.ts');

    expect(findBindingsForModule(db, 'HttpModule')).toEqual([]);
  });

  it('writes nothing for a file with no NestJS constructs', () => {
    index(db, 'src/core/rag/math.ts', 'export function cosine() { return 1; }');

    expect(db.prepare('SELECT COUNT(*) c FROM nest_bindings').get()).toEqual({ c: 0 });
    expect(db.prepare('SELECT COUNT(*) c FROM nest_injections').get()).toEqual({ c: 0 });
  });
});

describe('token queries', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = store();
    index(db, 'src/http/http.module.ts', HTTP_MODULE);
    index(db, 'src/http/http.service.ts', HTTP_SERVICE);
  });

  afterEach(() => db.close());

  // The point of the whole feature: a string token belongs to no file, so no
  // import graph can answer where it comes from.
  it('finds the module that provides a string token, which no import graph can', () => {
    const bindings = findBindingsForToken(db, 'HTTP_OPTIONS');

    expect(bindings).toHaveLength(1);
    expect(bindings[0].module).toBe('HttpModule');
    expect(bindings[0].kind).toBe('provider');
    expect(bindings[0].useKind).toBe('value');
  });

  it('matches a token regardless of how either side quoted it', () => {
    expect(findBindingsForToken(db, "'HTTP_OPTIONS'")).toHaveLength(1);
    expect(findInjectionsForToken(db, 'HTTP_OPTIONS')).toHaveLength(1);
  });

  it('answers who injects a token — the what-breaks-if-I-remove-it query', () => {
    const injections = findInjectionsForToken(db, 'HTTP_OPTIONS');

    expect(injections).toEqual([
      {
        filePath: 'src/http/http.service.ts',
        consumer: 'HttpService',
        token: "'HTTP_OPTIONS'",
        explicit: true,
      },
    ]);
  });

  it('returns nothing for a token nobody binds', () => {
    expect(findBindingsForToken(db, 'NOT_A_TOKEN')).toEqual([]);
    expect(findInjectionsForToken(db, 'NOT_A_TOKEN')).toEqual([]);
  });
});

describe('findUnexportedInjections', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = store();
  });

  afterEach(() => db.close());

  it('reports an injected token that no module provides or exports', () => {
    index(db, 'src/http/http.service.ts', HTTP_SERVICE);

    const suspicious = findUnexportedInjections(db).map((i) => i.token);

    // Both are unprovided here: the module file was deliberately not indexed.
    expect(suspicious).toContain("'HTTP_OPTIONS'");
    expect(suspicious).toContain('Clock');
  });

  it('stays quiet once the providing module is indexed too', () => {
    index(db, 'src/http/http.service.ts', HTTP_SERVICE);
    index(db, 'src/http/http.module.ts', HTTP_MODULE);

    const suspicious = findUnexportedInjections(db).map((i) => i.token);

    expect(suspicious).not.toContain("'HTTP_OPTIONS'");
    // `Clock` is still unaccounted for, which is the honest answer.
    expect(suspicious).toEqual(['Clock']);
  });
});

describe('backfillNestGraph', () => {
  let db: Database.Database;
  const files = [
    { relativePath: 'src/http/http.module.ts', absolutePath: '/abs/http.module.ts' },
    { relativePath: 'src/http/http.service.ts', absolutePath: '/abs/http.service.ts' },
  ];
  const sources: Record<string, string> = {
    '/abs/http.module.ts': HTTP_MODULE,
    '/abs/http.service.ts': HTTP_SERVICE,
  };
  const read = (absolutePath: string): string => {
    const source = sources[absolutePath];
    if (source === undefined) throw new Error(`missing ${absolutePath}`);
    return source;
  };

  beforeEach(() => {
    db = store();
    register(db, 'src/http/http.module.ts');
    register(db, 'src/http/http.service.ts');
  });

  afterEach(() => db.close());

  // Without this the feature ships dead: an already-indexed repository
  // re-processes nothing, so the tables would stay empty forever.
  it('populates an index whose files were all committed before the tables existed', () => {
    expect(db.prepare('SELECT COUNT(*) c FROM nest_bindings').get()).toEqual({ c: 0 });

    const analyzed = backfillNestGraph(db, files, analyzeNestGraph, read);

    expect(analyzed).toBe(2);
    expect(findBindingsForToken(db, 'HTTP_OPTIONS')).toHaveLength(1);
    expect(findInjectionsForToken(db, 'HTTP_OPTIONS')).toHaveLength(1);
  });

  it('does nothing on a second run, because the scan matches the registry hash', () => {
    backfillNestGraph(db, files, analyzeNestGraph, read);

    expect(backfillNestGraph(db, files, analyzeNestGraph, read)).toBe(0);
  });

  it('re-reads a file whose registry hash moved', () => {
    backfillNestGraph(db, files, analyzeNestGraph, read);
    db.prepare('UPDATE file_registry SET hash = ? WHERE path = ?').run(
      'changed',
      'src/http/http.module.ts',
    );

    expect(backfillNestGraph(db, files, analyzeNestGraph, read)).toBe(1);
  });

  // A file with no NestJS constructs must still be recorded, or every run
  // re-reads every plain TypeScript file in the repository.
  it('records a file that declares nothing, so it is read once', () => {
    register(db, 'src/core/rag/math.ts');
    const plain = [{ relativePath: 'src/core/rag/math.ts', absolutePath: '/abs/math.ts' }];
    const readPlain = (): string => 'export function cosine() { return 1; }';

    expect(backfillNestGraph(db, plain, analyzeNestGraph, readPlain)).toBe(1);
    expect(backfillNestGraph(db, plain, analyzeNestGraph, readPlain)).toBe(0);
  });

  it('skips a file that vanished rather than failing the run', () => {
    register(db, 'src/gone.ts');
    const missing = [{ relativePath: 'src/gone.ts', absolutePath: '/abs/gone.ts' }];

    expect(() => backfillNestGraph(db, missing, analyzeNestGraph, read)).not.toThrow();
    expect(backfillNestGraph(db, missing, analyzeNestGraph, read)).toBe(0);
  });

  it('ignores a discovered file that the registry does not know', () => {
    const unknown = [{ relativePath: 'src/never-indexed.ts', absolutePath: '/abs/http.module.ts' }];

    expect(backfillNestGraph(db, unknown, analyzeNestGraph, read)).toBe(0);
  });
});
