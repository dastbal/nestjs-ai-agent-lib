import {
  importSpecifierOf,
  isFirstPartySpecifier,
  renderSkeletonForContext,
} from './skeleton-render';

describe('importSpecifierOf', () => {
  it('reads the specifier out of a named import', () => {
    expect(importSpecifierOf("import { AgentDB } from '../state/db';")).toBe('../state/db');
  });

  it('reads the specifier out of a multi-line import, as ts-morph prints it', () => {
    const statement = "import {\n  fuseRankings,\n  hasGroundedEvidence,\n} from './hybrid-ranking';";
    expect(importSpecifierOf(statement)).toBe('./hybrid-ranking');
  });

  it('reads a side-effect import, which names a dependency with no from clause', () => {
    expect(importSpecifierOf("import 'reflect-metadata';")).toBe('reflect-metadata');
  });

  it('returns undefined for text that is not an import it can read', () => {
    expect(importSpecifierOf('export const answer = 42;')).toBeUndefined();
  });
});

describe('isFirstPartySpecifier', () => {
  it.each([
    ['./math', true],
    ['../state/db', true],
    ['@langchain/core', false],
    ['better-sqlite3', false],
    // A tsconfig path alias is first-party to a human and external to this rule.
    // That is deliberate: `extractDependencies` draws the graph edge by the same
    // test, so the two lists in one answer must not disagree about the word.
    ['@/lib/thing', false],
  ])('classifies %s as first-party=%s', (specifier, expected) => {
    expect(isFirstPartySpecifier(specifier as string)).toBe(expected);
  });
});

describe('renderSkeletonForContext', () => {
  it('omits the block for an absent or blank column', () => {
    expect(renderSkeletonForContext(undefined)).toBeUndefined();
    expect(renderSkeletonForContext('   ')).toBeUndefined();
  });

  // The registry holds rows whose skeleton column is SQLite NULL, and
  // `getFileSkeleton` passes it straight through under a `string | undefined`
  // declaration. The quality gate crashed on exactly this the first time the
  // check here was strict rather than truthy.
  it('omits the block for a SQL NULL, which is what the column really yields', () => {
    expect(renderSkeletonForContext(null)).toBeUndefined();
  });

  it('omits the block rather than putting a corrupt payload in front of the model', () => {
    expect(renderSkeletonForContext('{not json')).toBeUndefined();
    expect(renderSkeletonForContext('"a string"')).toBeUndefined();
  });

  it('omits the block for an atomic file, whose snippet is already the whole file', () => {
    expect(renderSkeletonForContext(JSON.stringify({ type: 'full' }))).toBeUndefined();
  });

  it('renders class and method signatures, which are the map', () => {
    const rendered = renderSkeletonForContext(
      JSON.stringify({
        imports: [],
        classes: [{ name: 'RetrieverService', methods: ['query(limit: number): void;'] }],
      }),
    );

    expect(rendered).toBe('CLASS RetrieverService:\n  - query(limit: number): void;');
  });

  it('names a class with no methods rather than rendering an empty heading', () => {
    const rendered = renderSkeletonForContext(
      JSON.stringify({ classes: [{ name: 'Marker', methods: [] }] }),
    );

    expect(rendered).toBe('CLASS Marker:\n  (no methods)');
  });

  it('emits specifiers rather than statements, split by first-party', () => {
    const rendered = renderSkeletonForContext(
      JSON.stringify({
        imports: [
          "import { AgentDB } from '../state/db';",
          "import { ChatAnthropic } from '@langchain/anthropic';",
        ],
        classes: [],
      }),
    );

    expect(rendered).toBe('IMPORTS: ../state/db\nPACKAGES: @langchain/anthropic');
  });

  it('drops the named bindings, which the snippet already carries verbatim', () => {
    const rendered = renderSkeletonForContext(
      JSON.stringify({
        imports: ["import { one, two, three, four, five } from './wide';"],
      }),
    );

    expect(rendered).toBe('IMPORTS: ./wide');
    expect(rendered).not.toContain('three');
  });

  it('collapses repeated specifiers, so one module is listed once', () => {
    const rendered = renderSkeletonForContext(
      JSON.stringify({
        imports: [
          "import { a } from './same';",
          "import type { B } from './same';",
        ],
      }),
    );

    expect(rendered).toBe('IMPORTS: ./same');
  });

  it('caps each group and says how many it withheld', () => {
    const imports = Array.from(
      { length: 11 },
      (_unused, index) => `import { x } from './mod-${index}';`,
    );

    const rendered = renderSkeletonForContext(JSON.stringify({ imports }));

    expect(rendered).toContain('./mod-0');
    expect(rendered).toContain('./mod-7');
    expect(rendered).not.toContain('./mod-8');
    expect(rendered).toContain('(...and 3 more)');
  });

  it('caps the two groups independently', () => {
    const imports = [
      ...Array.from({ length: 9 }, (_unused, i) => `import { x } from './rel-${i}';`),
      ...Array.from({ length: 9 }, (_unused, i) => `import { y } from 'pkg-${i}';`),
    ];

    const rendered = renderSkeletonForContext(JSON.stringify({ imports })) ?? '';

    expect(rendered.match(/\(\.\.\.and 1 more\)/g)).toHaveLength(2);
  });

  it('counts an unreadable statement instead of silently losing it', () => {
    const rendered = renderSkeletonForContext(
      JSON.stringify({ imports: ['this is not an import'] }),
    );

    expect(rendered).toBe('(1 import statement(s) could not be read)');
  });

  it('omits the block when the skeleton holds nothing to say', () => {
    expect(renderSkeletonForContext(JSON.stringify({ imports: [], classes: [] }))).toBeUndefined();
    expect(renderSkeletonForContext(JSON.stringify({}))).toBeUndefined();
  });

  it('renders classes before imports, so the structure leads', () => {
    const rendered = renderSkeletonForContext(
      JSON.stringify({
        imports: ["import { a } from './a';"],
        classes: [{ name: 'Service', methods: ['run(): void;'] }],
      }),
    ) ?? '';

    expect(rendered.indexOf('CLASS Service')).toBeLessThan(rendered.indexOf('IMPORTS'));
  });
});
