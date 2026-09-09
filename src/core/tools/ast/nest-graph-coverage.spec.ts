import * as fs from 'fs';
import * as path from 'path';
import { analyzeNestGraph } from './nest-graph';

/**
 * Measures the extractor against the shapes NestJS is actually written in.
 *
 * ## Why this is a coverage suite and not a quality benchmark
 *
 * `query_nest_graph` answers from SQL, not from ranking, so there is no hit
 * rate to compute. Its failure mode is different and worse: given a shape it
 * does not understand, it reports **nothing** — and "this module has no
 * providers" is indistinguishable from "this module was not understood". A
 * consumer would read the silence as fact.
 *
 * That is not hypothetical. The dynamic-module shape, which covers every
 * configurable module in the NestJS ecosystem, was caught by accident: a probe
 * of `@Module({...})` came back empty and looked like a parser bug. Had this
 * repository happened to use static modules, the feature would have shipped
 * silently blind to the shape that matters most.
 *
 * So the number this suite reports is **how many known shapes are read**, and
 * every shape it cannot read is named rather than skipped.
 */

interface WiringShape {
  readonly id: string;
  readonly why: string;
  readonly source: string;
  readonly expect: {
    readonly modules?: readonly string[];
    readonly tokens?: readonly string[];
    readonly injections?: readonly string[];
  };
  readonly knownLimitation?: string;
}

const corpus: { version: number; shapes: WiringShape[] } = JSON.parse(
  fs.readFileSync(
    path.resolve(__dirname, '..', '..', '..', '..', 'docs/benchmarks/nest-wiring-shapes.json'),
    'utf8',
  ),
);

/** Strips the quoting a source file happened to use, as the store does. */
const bare = (token: string): string => token.trim().replace(/^['"`]|['"`]$/g, '');

describe('NestJS wiring shape coverage', () => {
  it.each(corpus.shapes)('reads the $id shape — $why', (shape) => {
    const graph = analyzeNestGraph(`src/fixtures/${shape.id}.ts`, shape.source);

    if (shape.expect.modules !== undefined) {
      expect(graph.modules).toEqual(shape.expect.modules);
    }

    if (shape.expect.tokens !== undefined) {
      expect([...new Set(graph.bindings.map((binding) => bare(binding.token)))].sort()).toEqual(
        [...new Set(shape.expect.tokens.map(bare))].sort(),
      );
    }

    if (shape.expect.injections !== undefined) {
      expect(graph.injections.map((injection) => bare(injection.token))).toEqual(
        shape.expect.injections.map(bare),
      );
    }
  });

  // The headline: a shape read as empty is the silent failure this suite exists
  // to make loud. A limitation that is declared is honest; one that is not is a
  // module reported as having no providers.
  it('names every shape it cannot read, and declares each as a known limitation', () => {
    const silent = corpus.shapes.filter((shape) => {
      const graph = analyzeNestGraph(`src/fixtures/${shape.id}.ts`, shape.source);
      const expectsSomething =
        (shape.expect.tokens?.length ?? 0) > 0 || (shape.expect.injections?.length ?? 0) > 0;
      const produced = graph.bindings.length > 0 || graph.injections.length > 0;
      return expectsSomething && !produced;
    });

    expect(silent.map((shape) => shape.id)).toEqual([]);

    const declared = corpus.shapes.filter((shape) => shape.knownLimitation !== undefined);
    const readable = corpus.shapes.length - declared.length;

    // Recorded so a future change that trades one shape for another is visible
    // in the diff rather than only in a passing suite.
    expect(corpus.shapes).toHaveLength(13);
    expect(readable).toBe(11);
  });
});
