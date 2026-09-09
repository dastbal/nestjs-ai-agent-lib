/**
 * @module NestGraph
 *
 * Extracts the NestJS wiring a file declares: which module binds which
 * providers, controllers, imports and exports, and what each injectable asks
 * to be given.
 *
 * ## Why this is not the dependency graph Umbra already has
 *
 * `dependency_graph` records file-level imports — *this file imports that
 * file*. Every language server and every `grep -r` can answer that. What they
 * cannot answer is the question a NestJS developer actually asks: *which module
 * provides this token, and what breaks if I stop exporting it?* Injection is
 * resolved by token through a module tree, and the token frequently is not a
 * class at all but a string constant, so nothing about it is visible in the
 * import graph.
 *
 * ## The shape that generic tooling gets wrong
 *
 * A tool that reads only `@Module({ ... })` reports "no providers" for exactly
 * the modules that matter most. Every configurable NestJS module — every
 * `forRoot`, `forRootAsync`, `register` — carries a decorator that is literally
 * `@Module({})`, and returns its real wiring from a static method:
 *
 * ```ts
 * @Module({})
 * export class AiAgentHttpModule {
 *   public static forRoot(options: Options): DynamicModule {
 *     return { module: AiAgentHttpModule, controllers: [...], providers: [...] };
 *   }
 * }
 * ```
 *
 * Both this repository's own modules have exactly that shape. Reading the
 * decorator alone would report an empty graph and be confidently wrong, so a
 * static method returning an object literal with a `module` property is read as
 * a dynamic registration and its bindings are marked as such.
 *
 * ## What is deliberately not attempted
 *
 * No token resolution across files, and no attempt to decide whether an
 * injection is satisfiable. That needs the whole module tree, which is a
 * separate pass over the extracted rows rather than a property of one file.
 * This module reports what each file *declares*; joining declarations is the
 * next layer's job.
 */

import { Project, SyntaxKind, ScriptTarget } from 'ts-morph';
import type { ClassDeclaration, ObjectLiteralExpression, Node } from 'ts-morph';

/** Which position in a module's metadata a symbol was bound to. */
export type NestBindingKind = 'import' | 'provider' | 'controller' | 'export';

/** One symbol bound by one module. */
export interface NestBinding {
  /** The module class that declares the binding. */
  readonly module: string;
  readonly kind: NestBindingKind;
  /**
   * The token as written: a class name, or the `provide:` value of a custom
   * provider — which is frequently a string constant rather than a class, and
   * is the part a file-import graph cannot see.
   */
  readonly token: string;
  /** Where the value comes from, when the provider spells it out. */
  readonly useKind?: 'class' | 'value' | 'factory' | 'existing';
  /** True when the binding came from a `forRoot`-style static method. */
  readonly dynamic: boolean;
}

/** One dependency a class asks to be given. */
export interface NestInjection {
  /** The class whose constructor declares it. */
  readonly consumer: string;
  /** The declared type, or the argument of `@Inject(...)` when present. */
  readonly token: string;
  /** True when the token came from an explicit `@Inject(...)`. */
  readonly explicit: boolean;
}

/** Everything one file declares about NestJS wiring. */
export interface NestGraph {
  /** Classes carrying `@Module`. */
  readonly modules: readonly string[];
  /** Classes carrying `@Injectable` or `@Controller`. */
  readonly injectables: readonly string[];
  readonly bindings: readonly NestBinding[];
  readonly injections: readonly NestInjection[];
}

/** Metadata keys read from module metadata, mapped to their binding kind. */
const BINDING_KEYS: Readonly<Record<string, NestBindingKind>> = {
  imports: 'import',
  providers: 'provider',
  controllers: 'controller',
  exports: 'export',
};

/** `useClass` and friends, mapped to the compact form stored on a binding. */
const USE_KINDS: Readonly<Record<string, NestBinding['useKind']>> = {
  useClass: 'class',
  useValue: 'value',
  useFactory: 'factory',
  useExisting: 'existing',
};

/**
 * Reads one property of an object literal as an array of element texts.
 *
 * @param object - The metadata object.
 * @param key - Property to read.
 * @returns The elements, or an empty array when absent or not an array.
 */
function arrayProperty(object: ObjectLiteralExpression, key: string): Node[] {
  const assignment = object.getProperty(key)?.asKind(SyntaxKind.PropertyAssignment);
  const array = assignment?.getInitializer()?.asKind(SyntaxKind.ArrayLiteralExpression);
  return array ? [...array.getElements()] : [];
}

/**
 * Turns one entry of a `providers`-style array into a binding.
 *
 * Handles the two shapes Nest accepts: a bare class, and a custom provider
 * object whose `provide` is the token. The second is the one that matters —
 * a string token such as `'AI_AGENT_HTTP_OPTIONS'` is invisible to every
 * import-based tool, and is exactly what a developer needs to find.
 *
 * @param element - One array element.
 * @param module - Declaring module class name.
 * @param kind - Which metadata array it came from.
 * @param dynamic - Whether the array came from a dynamic registration.
 * @returns The binding, or `undefined` for a shape that names no token.
 */
function toBinding(
  element: Node,
  module: string,
  kind: NestBindingKind,
  dynamic: boolean,
): NestBinding | undefined {
  const object = element.asKind(SyntaxKind.ObjectLiteralExpression);

  if (object === undefined) {
    // `Service`, `ConfigModule.forRoot()`, `forwardRef(() => X)`. The text is
    // kept verbatim rather than resolved: a caller searching for what a module
    // registers wants to see what the file says.
    const text = element.getText().trim();
    return text.length === 0 ? undefined : { module, kind, token: text, dynamic };
  }

  const provide = object.getProperty('provide')?.asKind(SyntaxKind.PropertyAssignment);
  const token = provide?.getInitializer()?.getText().trim();
  if (token === undefined || token.length === 0) return undefined;

  let useKind: NestBinding['useKind'];
  for (const [property, mapped] of Object.entries(USE_KINDS)) {
    if (object.getProperty(property) !== undefined) {
      useKind = mapped;
      break;
    }
  }

  return { module, kind, token, useKind, dynamic };
}

/**
 * Collects the bindings declared by one metadata object.
 *
 * Bindings come out grouped by kind — imports, then providers, then
 * controllers, then exports — rather than in the order the developer happened
 * to write the object. A stored graph should not change because someone moved
 * `controllers` above `providers` in a file.
 *
 * @param object - `@Module({...})` metadata, or a returned `DynamicModule`.
 * @param module - Declaring module class name.
 * @param dynamic - Whether this came from a static registration method.
 * @returns The bindings, grouped by kind.
 */
function bindingsOf(
  object: ObjectLiteralExpression,
  module: string,
  dynamic: boolean,
): NestBinding[] {
  const bindings: NestBinding[] = [];
  for (const [key, kind] of Object.entries(BINDING_KEYS)) {
    for (const element of arrayProperty(object, key)) {
      const binding = toBinding(element, module, kind, dynamic);
      if (binding !== undefined) bindings.push(binding);
    }
  }
  return bindings;
}

/**
 * Finds the object literals a class returns from its static methods.
 *
 * A returned object is treated as a dynamic module registration only when it
 * has a `module` property, which is what `DynamicModule` requires. Without that
 * test any static factory returning a config object would be read as wiring.
 *
 * @param cls - The module class.
 * @returns The dynamic metadata objects it returns.
 */
function dynamicMetadataOf(cls: ClassDeclaration): ObjectLiteralExpression[] {
  const found: ObjectLiteralExpression[] = [];

  for (const method of cls.getStaticMethods()) {
    for (const statement of method.getDescendantsOfKind(SyntaxKind.ReturnStatement)) {
      const object = statement.getExpression()?.asKind(SyntaxKind.ObjectLiteralExpression);
      if (object !== undefined && object.getProperty('module') !== undefined) {
        found.push(object);
      }
    }
  }

  return found;
}

/**
 * Reads the constructor injections a class declares.
 *
 * `@Inject(TOKEN)` wins over the declared type, because that is what Nest
 * resolves by. A parameter typed `AgentRuntime` but injected with `AI_AGENT`
 * depends on `AI_AGENT`; recording the interface name would point a reader at
 * a type that nothing provides.
 *
 * @param cls - Any class.
 * @returns Its constructor injections.
 */
function injectionsOf(cls: ClassDeclaration): NestInjection[] {
  const consumer = cls.getName();
  if (consumer === undefined) return [];

  const constructor = cls.getConstructors()[0];
  if (constructor === undefined) return [];

  return constructor.getParameters().flatMap((parameter): NestInjection[] => {
    const inject = parameter
      .getDecorators()
      .find((decorator) => decorator.getName() === 'Inject');

    if (inject !== undefined) {
      const argument = inject.getArguments()[0]?.getText().trim();
      if (argument !== undefined && argument.length > 0) {
        return [{ consumer, token: argument, explicit: true }];
      }
    }

    const declared = parameter.getTypeNode()?.getText().trim();
    return declared === undefined || declared.length === 0
      ? []
      : [{ consumer, token: declared, explicit: false }];
  });
}

/**
 * Extracts the NestJS wiring declared by one source file.
 *
 * Parsed in an in-memory project without type resolution: the graph is read
 * from syntax, so it costs no program build and works on a file whose imports
 * do not resolve — which is the normal case when indexing a repository one
 * file at a time.
 *
 * @param filePath - Repository-relative path, for the in-memory file name.
 * @param source - File contents.
 * @returns What the file declares. Every array is empty for a file with no
 *          NestJS constructs, which is most files.
 */
export function analyzeNestGraph(filePath: string, source: string): NestGraph {
  const project = new Project({
    useInMemoryFileSystem: true,
    compilerOptions: { target: ScriptTarget.Latest },
  });
  const file = project.createSourceFile(filePath, source, { overwrite: true });

  const modules: string[] = [];
  const injectables: string[] = [];
  const bindings: NestBinding[] = [];
  const injections: NestInjection[] = [];

  for (const cls of file.getClasses()) {
    const name = cls.getName();
    if (name === undefined) continue;

    const decorators = cls.getDecorators().map((decorator) => decorator.getName());

    if (decorators.includes('Module')) {
      modules.push(name);

      const moduleDecorator = cls.getDecorator('Module');
      const declared = moduleDecorator
        ?.getArguments()[0]
        ?.asKind(SyntaxKind.ObjectLiteralExpression);
      if (declared !== undefined) bindings.push(...bindingsOf(declared, name, false));

      for (const dynamic of dynamicMetadataOf(cls)) {
        bindings.push(...bindingsOf(dynamic, name, true));
      }
    }

    if (decorators.includes('Injectable') || decorators.includes('Controller')) {
      injectables.push(name);
    }

    injections.push(...injectionsOf(cls));
  }

  return { modules, injectables, bindings, injections };
}
