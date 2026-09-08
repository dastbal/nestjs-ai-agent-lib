import { resetLogSink } from '../observability/console-sink';
import { IndexerService } from './indexer';

describe('IndexerService interactive failure progress', () => {
  let writeSpy: jest.SpyInstance;
  let consoleSpy: jest.SpyInstance;
  let originalIsTTY: PropertyDescriptor | undefined;

  beforeEach(() => {
    resetLogSink();
    originalIsTTY = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });
    writeSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    IndexerService.silent = false;
  });

  afterEach(() => {
    privateIndexer().finishProgress();
    writeSpy.mockRestore();
    consoleSpy.mockRestore();
    if (originalIsTTY === undefined) delete (process.stdout as { isTTY?: boolean }).isTTY;
    else Object.defineProperty(process.stdout, 'isTTY', originalIsTTY);
    resetLogSink();
  });

  it('repaints repeated file failures instead of appending one line per file in a TTY', () => {
    privateIndexer().failure('❌ 1/9 pending | src/one.ts             | chunking produced no output');
    privateIndexer().failure('❌ 2/9 pending | src/two.ts             | chunking produced no output');

    expect(consoleSpy).not.toHaveBeenCalled();
    expect(writeSpy).toHaveBeenCalledTimes(2);
    expect(writeSpy.mock.calls.map(([value]) => String(value))).toEqual([
      expect.stringMatching(/^\r\u001b\[2K/),
      expect.stringMatching(/^\r\u001b\[2K/),
    ]);

    privateIndexer().finishProgress();
    expect(writeSpy).toHaveBeenLastCalledWith('\n');
  });
});

/** Accesses the private static rendering seam only to protect the TTY contract. */
function privateIndexer(): { failure(message: string): void; finishProgress(): void } {
  return IndexerService as unknown as { failure(message: string): void; finishProgress(): void };
}
