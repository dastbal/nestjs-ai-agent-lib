import { DependencyRelation, ChunkType, GraphEdge, ChunkMetadata, ProcessedChunk, FileAnalysisResult } from '../core/types';

describe('Core Types', () => {
  // Test 1: Ensure all types can be imported without syntax errors
  it('should successfully import all defined types', () => {
    // If this import statement works without throwing an error,
    // it means all types are correctly defined and exported.
    expect(true).toBe(true); // Explicitly pass if no error occurs
  });

  // Test 2: Basic type assertion example (optional, but good for confirmation)
  it('should allow type assertion for defined interfaces/types', () => {
    const mockEdge: GraphEdge = {
      sourcePath: 'src/some/path.ts',
      targetPath: 'src/another/path.ts',
      relation: 'import',
    };
    expect(mockEdge).toBeDefined();
    expect(mockEdge.sourcePath).toBe('src/some/path.ts');

    const mockChunk: ProcessedChunk = {
      id: 'mock-uuid-123',
      filePath: 'src/some/file.ts',
      type: 'method',
      content: 'console.log("hello");',
      metadata: { startLine: 10, endLine: 12, methodName: 'mockMethod' },
      parentId: 'mock-class-id',
    };
    expect(mockChunk).toBeDefined();
    expect(mockChunk.type).toBe('method');
  });

  // Add more specific tests if needed for complex types or enums
});
