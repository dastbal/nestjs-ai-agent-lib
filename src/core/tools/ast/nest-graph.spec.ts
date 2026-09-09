import * as fs from 'fs';
import * as path from 'path';
import { analyzeNestGraph } from './nest-graph';

describe('analyzeNestGraph — static modules', () => {
  it('reads imports, providers, controllers and exports from the decorator', () => {
    const graph = analyzeNestGraph(
      'src/users/users.module.ts',
      `
      @Module({
        imports: [SharedModule, ConfigModule.forRoot()],
        controllers: [UsersController],
        providers: [UsersService, UsersRepository],
        exports: [UsersService],
      })
      export class UsersModule {}
      `,
    );

    expect(graph.modules).toEqual(['UsersModule']);
    expect(graph.bindings.filter((b) => b.kind === 'import').map((b) => b.token)).toEqual([
      'SharedModule',
      'ConfigModule.forRoot()',
    ]);
    expect(graph.bindings.filter((b) => b.kind === 'provider').map((b) => b.token)).toEqual([
      'UsersService',
      'UsersRepository',
    ]);
    expect(graph.bindings.filter((b) => b.kind === 'controller').map((b) => b.token)).toEqual([
      'UsersController',
    ]);
    expect(graph.bindings.filter((b) => b.kind === 'export').map((b) => b.token)).toEqual([
      'UsersService',
    ]);
    expect(graph.bindings.every((b) => b.dynamic === false)).toBe(true);
  });

  // The token a custom provider registers is frequently a string constant, not
  // a class. Nothing about it appears in the file-import graph, which is the
  // whole reason this extractor exists.
  it('records the token of a custom provider, and how it is satisfied', () => {
    const graph = analyzeNestGraph(
      'src/payments/payments.module.ts',
      `
      @Module({
        providers: [
          PaymentsService,
          { provide: 'PAYMENT_GATEWAY', useClass: StripeGateway },
          { provide: CONFIG, useValue: options },
          { provide: 'CLOCK', useFactory: () => new Clock(), inject: [ConfigService] },
          { provide: LegacyAlias, useExisting: PaymentsService },
        ],
      })
      export class PaymentsModule {}
      `,
    );

    const providers = graph.bindings.filter((b) => b.kind === 'provider');

    expect(providers.map((b) => b.token)).toEqual([
      'PaymentsService',
      "'PAYMENT_GATEWAY'",
      'CONFIG',
      "'CLOCK'",
      'LegacyAlias',
    ]);
    expect(providers.map((b) => b.useKind)).toEqual([
      undefined,
      'class',
      'value',
      'factory',
      'existing',
    ]);
  });

  it('returns empty arrays for a file with no NestJS constructs', () => {
    const graph = analyzeNestGraph('src/core/rag/math.ts', 'export function cosine() { return 1; }');

    expect(graph).toEqual({ modules: [], injectables: [], bindings: [], injections: [] });
  });
});

describe('analyzeNestGraph — dynamic modules', () => {
  // Every configurable NestJS module carries a literally empty decorator and
  // returns its real wiring from a static method. A reader of the decorator
  // alone reports "no providers" for exactly the modules that matter most.
  it('reads the wiring a forRoot returns, not the empty decorator', () => {
    const graph = analyzeNestGraph(
      'src/http/http.module.ts',
      `
      @Module({})
      export class AgentHttpModule {
        public static forRoot(options: Options): DynamicModule {
          return {
            module: AgentHttpModule,
            controllers: [AgentHttpController],
            providers: [AgentHttpService, { provide: HTTP_OPTIONS, useValue: options }],
            exports: [AgentHttpService],
          };
        }
      }
      `,
    );

    expect(graph.modules).toEqual(['AgentHttpModule']);
    expect(graph.bindings).toHaveLength(4);
    expect(graph.bindings.every((b) => b.dynamic)).toBe(true);
    // Grouped by kind, not by the order the object was written.
    expect(graph.bindings.map((b) => `${b.kind}:${b.token}`)).toEqual([
      'provider:AgentHttpService',
      'provider:HTTP_OPTIONS',
      'controller:AgentHttpController',
      'export:AgentHttpService',
    ]);
  });

  it('reads several registration methods on one module', () => {
    const graph = analyzeNestGraph(
      'src/cache/cache.module.ts',
      `
      @Module({})
      export class CacheModule {
        static forRoot(): DynamicModule {
          return { module: CacheModule, providers: [RootCache] };
        }
        static forFeature(): DynamicModule {
          return { module: CacheModule, providers: [FeatureCache] };
        }
      }
      `,
    );

    expect(graph.bindings.map((b) => b.token)).toEqual(['RootCache', 'FeatureCache']);
  });

  // Without the `module` property test, any static factory returning a config
  // object would be read as module wiring.
  it('ignores a static method that returns an object which is not a DynamicModule', () => {
    const graph = analyzeNestGraph(
      'src/config/defaults.ts',
      `
      @Module({})
      export class ConfigModule {
        static defaults() {
          return { providers: ['not-a-module'], exports: ['neither'] };
        }
      }
      `,
    );

    expect(graph.bindings).toEqual([]);
  });

  it('keeps the decorator bindings and the dynamic ones, marked apart', () => {
    const graph = analyzeNestGraph(
      'src/mixed/mixed.module.ts',
      `
      @Module({ providers: [AlwaysThere] })
      export class MixedModule {
        static forRoot(): DynamicModule {
          return { module: MixedModule, providers: [OnlyWhenConfigured] };
        }
      }
      `,
    );

    expect(graph.bindings).toEqual([
      { module: 'MixedModule', kind: 'provider', token: 'AlwaysThere', useKind: undefined, dynamic: false },
      { module: 'MixedModule', kind: 'provider', token: 'OnlyWhenConfigured', useKind: undefined, dynamic: true },
    ]);
  });
});

describe('analyzeNestGraph — injections', () => {
  it('prefers the @Inject token over the declared type, because Nest resolves by token', () => {
    const graph = analyzeNestGraph(
      'src/http/http.service.ts',
      `
      @Injectable()
      export class AgentHttpService {
        public constructor(
          @Inject(HTTP_OPTIONS) private readonly options: HttpOptions,
          @Inject(AI_AGENT) private readonly agent: AgentRuntime,
          private readonly clock: Clock,
        ) {}
      }
      `,
    );

    expect(graph.injectables).toEqual(['AgentHttpService']);
    expect(graph.injections).toEqual([
      { consumer: 'AgentHttpService', token: 'HTTP_OPTIONS', explicit: true },
      { consumer: 'AgentHttpService', token: 'AI_AGENT', explicit: true },
      { consumer: 'AgentHttpService', token: 'Clock', explicit: false },
    ]);
  });

  it('treats a controller as an injectable', () => {
    const graph = analyzeNestGraph(
      'src/http/http.controller.ts',
      `
      @Controller('agent')
      export class AgentHttpController {
        constructor(private readonly service: AgentHttpService) {}
      }
      `,
    );

    expect(graph.injectables).toEqual(['AgentHttpController']);
    expect(graph.injections).toEqual([
      { consumer: 'AgentHttpController', token: 'AgentHttpService', explicit: false },
    ]);
  });

  it('skips an untyped parameter rather than inventing a token', () => {
    const graph = analyzeNestGraph(
      'src/misc/loose.ts',
      `
      @Injectable()
      export class Loose {
        constructor(private readonly anything) {}
      }
      `,
    );

    expect(graph.injections).toEqual([]);
  });
});

describe('analyzeNestGraph — against this repository', () => {
  const read = (relative: string): string =>
    fs.readFileSync(path.resolve(__dirname, '..', '..', '..', '..', relative), 'utf8');

  it('extracts the real wiring of the HTTP module, which the decorator hides', () => {
    const graph = analyzeNestGraph(
      'src/presentation/http/ai-agent-http.module.ts',
      read('src/presentation/http/ai-agent-http.module.ts'),
    );

    expect(graph.modules).toEqual(['AiAgentHttpModule']);
    expect(graph.injectables).toEqual(['AiAgentHttpService', 'AiAgentHttpController']);

    // All of it comes from forRoot; the decorator is `@Module({})`.
    expect(graph.bindings.every((b) => b.dynamic)).toBe(true);
    expect(graph.bindings.map((b) => `${b.kind}:${b.token}`)).toEqual([
      'provider:AiAgentHttpService',
      'provider:AGENT_HTTP_OPTIONS',
      'controller:AiAgentHttpController',
    ]);

    expect(graph.injections).toContainEqual({
      consumer: 'AiAgentHttpService',
      token: 'AGENT_HTTP_OPTIONS',
      explicit: true,
    });
    expect(graph.injections).toContainEqual({
      consumer: 'AiAgentHttpService',
      token: 'AI_AGENT',
      explicit: true,
    });
  });

  it('extracts the root module registration', () => {
    const graph = analyzeNestGraph('src/ai-agent.module.ts', read('src/ai-agent.module.ts'));

    expect(graph.modules).toEqual(['AiAgentModule']);
    expect(graph.bindings.map((b) => `${b.kind}:${b.token}`)).toEqual([
      'provider:InteractionService',
      'provider:AI_AGENT',
      'export:AI_AGENT',
      'export:InteractionService',
    ]);
  });
});

describe('analyzeNestGraph — only real injection sites', () => {
  // Found by running the extractor over this repository: an ordinary class with
  // a constructor was recorded as needing `(progress: string) => void`, which
  // is not a token and describes no wiring Nest performs.
  it('ignores the constructor of a class Nest never injects into', () => {
    const graph = analyzeNestGraph(
      'src/core/rag/indexer.ts',
      `
      export class IndexerService {
        constructor(
          embeddings: EmbeddingsPort = resolve(),
          progressObserver?: (progress: string) => void,
        ) {}
      }
      `,
    );

    expect(graph.injectables).toEqual([]);
    expect(graph.injections).toEqual([]);
  });

  it('still reads a decorated class in the same file', () => {
    const graph = analyzeNestGraph(
      'src/mixed/mixed.ts',
      `
      export class PlainHelper {
        constructor(private readonly thing: Thing) {}
      }

      @Injectable()
      export class RealService {
        constructor(private readonly repo: Repository) {}
      }
      `,
    );

    expect(graph.injectables).toEqual(['RealService']);
    expect(graph.injections).toEqual([
      { consumer: 'RealService', token: 'Repository', explicit: false },
    ]);
  });
});
