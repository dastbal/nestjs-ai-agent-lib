import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { exec } from "child_process";
import { promisify } from "util";
import { RetrieverService } from "../rag/retriever";
import * as fs from "fs";
import * as path from "path";
import chalk from "chalk";
import { IndexerService } from "../rag/indexer";
import {
  safeWriteFileTool,
  safeReadFileTool,
  askCodebaseTool,
  integrityCheckTool,
  refreshIndexTool,
  executeTestsTool,
  listFilesTool,
} from "./tools";

// Mocking dependencies
jest.mock("child_process");
jest.mock("fs");
jest.mock("path");
jest.mock("../rag/retriever");
jest.mock("../rag/indexer");
jest.mock("dotenv", () => ({ config: jest.fn() }));

// Mock promisify to control execAsync behavior
jest.mock("util", () => ({
  promisify: jest.fn((fn) => {
    if (fn === exec) {
      return mockExecAsync;
    }
    return jest.fn();
  }),
}));

// Use Jest's mocked types for modules
const mockedExec = jest.mocked(exec);
const mockedFs = jest.mocked(fs);
const mockedPath = jest.mocked(path);
const MockedRetrieverService = jest.mocked(RetrieverService);
const MockedIndexerService = jest.mocked(IndexerService);

// Mock implementations for functions and methods at the top level
const mockExecAsync = jest.fn();
const mockReadFileSync = jest.fn();
const mockWriteFileSync = jest.fn();
const mockExistsSync = jest.fn();
const mockMkdirSync = jest.fn();
const mockReaddirSync = jest.fn();
// Declare mock implementations for service methods at the top level
let mockGetContextForLLM: jest.Mock;
let mockIndexProject: jest.Mock;

// Mock Langchain tool invocation
const mockToolInvoke = jest.fn();

// Assign mock implementations to the mocked module functions/methods
mockedFs.readFileSync = mockReadFileSync;
mockedFs.writeFileSync = mockWriteFileSync;
mockedFs.existsSync = mockExistsSync;
mockedFs.mkdirSync = mockMkdirSync;
mockedFs.readdirSync = mockReaddirSync;

// Assign mock implementations to mocked path functions
mockedPath.resolve = jest.fn((...args) => args.join("/"));
mockedPath.dirname = jest.fn((p) => p.split("/").slice(0, -1).join("/"));

// Mock chalk
jest.mock("chalk", () => ({
  blue: jest.fn((str) => str),
  yellow: jest.fn((str) => str),
  gray: jest.fn((str) => str),
  red: jest.fn((str) => str),
  magenta: jest.fn((str) => str),
}));

// Mock process.cwd()
const mockCwd = jest.fn(() => "/mock/project/root");
(process.cwd as any) = mockCwd;

// Helper to mock tool invocation
const mockTool = (toolInstance: any) => {
  toolInstance.invoke = mockToolInvoke.mockImplementation(async (params) => {
    if (toolInstance === listFilesTool) {
      const dirPath = params?.dirPath || ".";
      const targetDir = mockedPath.resolve(mockCwd(), dirPath);
      if (!mockedFs.existsSync(targetDir))
        return `❌ Directory not found: ${dirPath}`;
      const files = mockedFs.readdirSync(targetDir, {
        withFileTypes: true,
      }) as fs.Dirent[];
      const list = files
        .map((f: fs.Dirent) => `${f.isDirectory() ? "📂" : "📄"} ${f.name}`)
        .join("\n");
      return `Contents of ${dirPath}:\n${list}`;
    }
    if (toolInstance === safeWriteFileTool) {
      const { filePath, content } = params;
      const targetPath = mockedPath.resolve(mockCwd(), filePath);
      if (!targetPath.startsWith(mockCwd())) return "❌ Error: Access denied.";
      const dir = mockedPath.dirname(targetPath);
      if (!mockedFs.existsSync(dir))
        mockedFs.mkdirSync(dir, { recursive: true });
      mockedFs.writeFileSync(targetPath, content, "utf-8");
      await mockIndexProject(); // Use the mock function directly
      return `✅ File saved to REAL DISK: ${filePath}`;
    }
    if (toolInstance === safeReadFileTool) {
      const { filePath } = params;
      const targetPath = mockedPath.resolve(mockCwd(), filePath);
      if (!mockedFs.existsSync(targetPath))
        return `❌ File not found: ${filePath}`;
      if (!targetPath.startsWith(mockCwd())) return "❌ Error: Access denied.";
      return mockedFs.readFileSync(targetPath, "utf-8");
    }
    if (toolInstance === askCodebaseTool) {
      const { query } = params;
      return mockGetContextForLLM(query); // Use the mock function directly
    }
    if (toolInstance === integrityCheckTool) {
      const { stdout, stderr } = mockExecAsync("npx tsc --noEmit", {
        cwd: mockCwd(),
      });
      if (stderr) return `❌ INTEGRITY CHECK FAILED.\n${stderr}`;
      return `✅ INTEGRITY CHECK PASSED.\n${stdout}`;
    }
    if (toolInstance === refreshIndexTool) {
      await mockIndexProject(); // Use the mock function directly
      return "✅ Index successfully updated. I now have access to the latest code version.";
    }
    if (toolInstance === executeTestsTool) {
      const { filePath } = params;
      const command = filePath
        ? `npx jest ${filePath} --passWithNoTests --no-stack-trace`
        : "npm test";
      const { stdout, stderr } = mockExecAsync(command, { cwd: mockCwd() });
      if (stderr) return `❌ TEST FAILED.\n${stderr}`;
      return `✅ TEST SUCCESS.\n${stdout}`;
    }

    return `Mocked invocation for ${toolInstance.name}`;
  });
  return toolInstance;
};

// Helper to mock rejection
const mockReject = (mockFn: jest.Mock, error: any) => {
  mockFn.mockImplementation(async () => {
    throw error;
  });
};

// Re-assign tools with mock invoke
const mockedSafeWriteFileTool = mockTool(safeWriteFileTool);
const mockedSafeReadFileTool = mockTool(safeReadFileTool);
const mockedAskCodebaseTool = mockTool(askCodebaseTool);
const mockedIntegrityCheckTool = mockTool(integrityCheckTool);
const mockedRefreshIndexTool = mockTool(refreshIndexTool);
const mockedExecuteTestsTool = mockTool(executeTestsTool);
const mockedListFilesTool = mockTool(listFilesTool);

describe("Tools", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockExecAsync.mockResolvedValue({ stdout: "", stderr: "" });
    mockReadFileSync.mockReturnValue("file content");
    mockExistsSync.mockReturnValue(true);
    // Reset mock implementations for service methods
    mockGetContextForLLM = jest.fn().mockResolvedValue("mock context");
    mockIndexProject = jest.fn().mockResolvedValue(undefined);

    mockReaddirSync.mockReturnValue([
      { name: "file1.ts", isDirectory: () => false },
      { name: "subdir", isDirectory: () => true },
      { name: ".hiddenfile", isDirectory: () => false },
    ]);
    mockToolInvoke.mockClear();
  });

  // --- safe_write_file tests ---
  describe("safe_write_file", () => {
    it("should write content to a file and trigger re-index", async () => {
      const filePath = "src/app.service.ts";
      const content = "new content";
      const result = await mockedSafeWriteFileTool.invoke({
        filePath,
        content,
      });

      expect(mockedPath.resolve).toHaveBeenCalledWith(
        expect.any(String),
        filePath,
      );
      expect(mockedPath.dirname).toHaveBeenCalled();
      expect(mockedFs.existsSync).toHaveBeenCalled();
      expect(mockedFs.mkdirSync).not.toHaveBeenCalled();
      expect(mockedFs.writeFileSync).toHaveBeenCalledWith(
        expect.any(String),
        content,
        "utf-8",
      );
      expect(mockIndexProject).toHaveBeenCalledTimes(1);
      expect(result).toBe(`✅ File saved to REAL DISK: ${filePath}`);
    });

    it("should create directory if it does not exist", async () => {
      const filePath = "src/new/app.service.ts";
      const content = "new content";
      mockedFs.existsSync.mockReturnValue(false);

      await mockedSafeWriteFileTool.invoke({ filePath, content });

      expect(mockedFs.mkdirSync).toHaveBeenCalledWith(
        expect.stringContaining("src/new"),
        { recursive: true },
      );
      expect(mockedFs.writeFileSync).toHaveBeenCalled();
    });

    it("should return an error if writing outside the root directory", async () => {
      const filePath = "../outside.ts";
      const content = "content";
      mockedPath.resolve.mockReturnValue("/outside/path/outside.ts");

      const result = await mockedSafeWriteFileTool.invoke({
        filePath,
        content,
      });

      expect(result).toBe(
        "❌ Error: Access denied. Cannot write outside the project root.",
      );
      expect(mockedFs.writeFileSync).not.toHaveBeenCalled();
      expect(mockIndexProject).not.toHaveBeenCalled();
    });

    it("should create a backup before writing", async () => {
      const filePath = "src/config.ts";
      const content = "new config";
      const createBackupSpy = jest.spyOn(global as any, "createBackup");
      createBackupSpy.mockImplementation(() => {});

      await mockedSafeWriteFileTool.invoke({ filePath, content });

      expect(createBackupSpy).toHaveBeenCalledWith(filePath);
    });
  });

  // --- safe_read_file tests ---
  describe("safe_read_file", () => {
    it("should read file content successfully", async () => {
      const filePath = "src/app.module.ts";
      const expectedContent = "module content";
      mockedFs.readFileSync.mockReturnValue(expectedContent);

      const result = await mockedSafeReadFileTool.invoke({ filePath });

      expect(mockedPath.resolve).toHaveBeenCalledWith(
        expect.any(String),
        filePath,
      );
      expect(mockedFs.existsSync).toHaveBeenCalledWith(expect.any(String));
      expect(mockedFs.readFileSync).toHaveBeenCalledWith(
        expect.any(String),
        "utf-8",
      );
      expect(result).toBe(expectedContent);
    });

    it("should return file not found error", async () => {
      const filePath = "src/nonexistent.ts";
      mockedFs.existsSync.mockReturnValue(false);

      const result = await mockedSafeReadFileTool.invoke({ filePath });

      expect(result).toBe(`❌ File not found: ${filePath}`);
      expect(mockedFs.readFileSync).not.toHaveBeenCalled();
    });

    it("should return an error if reading fails", async () => {
      const filePath = "src/app.service.ts";
      const readError = new Error("Permission denied");
      mockedFs.readFileSync.mockImplementation(() => {
        throw readError;
      });

      const result = await mockedSafeReadFileTool.invoke({ filePath });

      expect(result).toBe(`❌ Error reading file: ${readError.message}`);
    });

    it("should return an error if reading outside the root directory", async () => {
      const filePath = "../outside.ts";
      mockedFs.existsSync.mockReturnValue(true);
      mockedPath.resolve.mockReturnValue("/outside/path/outside.ts");

      const result = await mockedSafeReadFileTool.invoke({ filePath });

      expect(result).toBe(
        "❌ Error: Access denied. Cannot read outside the project root.",
      );
      expect(mockedFs.readFileSync).not.toHaveBeenCalled();
    });
  });

  // --- ask_codebase tests ---
  describe("ask_codebase", () => {
    it("should call RetrieverService and return context", async () => {
      const query = "find user entity";
      const expectedContext = "mock context";
      mockGetContextForLLM.mockResolvedValue(expectedContext);

      const result = await mockedAskCodebaseTool.invoke({ query });

      expect(MockedRetrieverService).toHaveBeenCalledTimes(1);
      expect(mockGetContextForLLM).toHaveBeenCalledWith(query);
      expect(result).toBe(expectedContext);
    });

    it("should handle errors from RetrieverService", async () => {
      const query = "find user entity";
      const retrievalError = new Error("Network error");
      mockReject(mockGetContextForLLM, retrievalError);

      const result = await mockedAskCodebaseTool.invoke({ query });

      expect(result).toBe(
        `❌ Error querying codebase: ${retrievalError.message}`,
      );
    });
  });

  // --- integrityCheckTool tests ---
  describe("run_integrity_check", () => {
    it("should call execAsync with tsc --noEmit and return success on stdout", async () => {
      mockExecAsync.mockResolvedValue({
        stdout: "Type checking successful.",
        stderr: "",
      });

      const result = await mockedIntegrityCheckTool.invoke({});

      expect(mockExecAsync).toHaveBeenCalledWith("npx tsc --noEmit", {
        cwd: expect.any(String),
      });
      expect(result).toContain("✅ INTEGRITY CHECK PASSED");
      expect(result).toContain("Type checking successful.");
    });

    it("should return success even with stderr if stdout indicates success", async () => {
      mockExecAsync.mockResolvedValue({
        stdout: "Type checking successful.",
        stderr: "Some warning message.",
      });

      const result = await mockedIntegrityCheckTool.invoke({});

      expect(mockExecAsync).toHaveBeenCalledWith("npx tsc --noEmit", {
        cwd: expect.any(String),
      });
      expect(result).toContain("✅ INTEGRITY CHECK PASSED");
      expect(result).toContain("Some warning message.");
    });

    it("should return failure message with error output on exec error", async () => {
      const execError = {
        stdout: "",
        stderr: "error: Found 1 error. (2304)",
        message: "Command failed: npx tsc --noEmit",
      };
      mockReject(mockExecAsync, execError);

      const result = await mockedIntegrityCheckTool.invoke({});

      expect(mockExecAsync).toHaveBeenCalledWith("npx tsc --noEmit", {
        cwd: expect.any(String),
      });
      expect(result).toContain("❌ INTEGRITY CHECK FAILED");
      expect(result).toContain("(2304)");
    });

    it("should handle errors where stdout/stderr are missing", async () => {
      const execError = { message: "Unknown execution error" };
      mockReject(mockExecAsync, execError);

      const result = await mockedIntegrityCheckTool.invoke({});

      expect(result).toContain("❌ INTEGRITY CHECK FAILED");
      expect(result).toContain("Unknown execution error");
    });
  });

  // --- refreshIndexTool tests ---
  describe("refreshIndexTool", () => {
    it("should call IndexerService.indexProject and return success", async () => {
      const result = await mockedRefreshIndexTool.invoke({});

      expect(MockedIndexerService).toHaveBeenCalledTimes(1);
      expect(mockIndexProject).toHaveBeenCalledTimes(1);
      expect(result).toBe(
        "✅ Index successfully updated. I now have access to the latest code version.",
      );
    });

    it("should handle errors during indexing", async () => {
      const indexError = new Error("Indexing failed");
      mockReject(mockIndexProject, indexError);

      const result = await mockedRefreshIndexTool.invoke({});

      expect(mockIndexerInstance.indexProject).toHaveBeenCalledTimes(1);
      expect(result).toBe(
        `❌ Critical error while attempting to index the project: ${indexError.message}. Please try again or check the logs.`,
      );
    });
  });

  // --- executeTestsTool tests ---
  describe("executeTestsTool", () => {
    it("should run all tests when no filePath is provided", async () => {
      mockExecAsync.mockResolvedValue({
        stdout: "All tests passed",
        stderr: "",
      });
      await mockedExecuteTestsTool.invoke({});

      expect(mockExecAsync).toHaveBeenCalledWith("npm test", {
        cwd: expect.any(String),
      });
    });

    it("should run tests for a specific file when filePath is provided", async () => {
      const filePath = "src/my.spec.ts";
      mockExecAsync.mockResolvedValue({
        stdout: "Specific test passed",
        stderr: "",
      });

      await mockedExecuteTestsTool.invoke({ filePath });

      expect(mockExecAsync).toHaveBeenCalledWith(
        `npx jest ${filePath} --passWithNoTests --no-stack-trace`,
        { cwd: expect.any(String) },
      );
    });

    it("should return success message on test pass", async () => {
      const stdout = "Test suite passed\n10 passed, 0 failed";
      mockExecAsync.mockResolvedValue({ stdout, stderr: "" });

      const result = await mockedExecuteTestsTool.invoke({});

      expect(result).toContain("✅ TEST SUCCESS.");
      expect(result).toContain(stdout.slice(-1000));
    });

    it("should return failure message with output on test failure", async () => {
      const stderr = "Test suite failed\n1 error found";
      const error = { stdout: "", stderr, message: "Jest failed" };
      mockReject(mockExecAsync, error);

      const result = await mockedExecuteTestsTool.invoke({});

      expect(result).toContain("❌ TEST FAILED.");
      expect(result).toContain(stderr.slice(-2000));
    });
  });

  // --- listFilesTool tests ---
  describe("listFilesTool", () => {
    it("should list files and directories in the current directory by default", async () => {
      mockReaddirSync.mockReturnValue([
        { name: "file1.ts", isDirectory: () => false },
        { name: "subdir", isDirectory: () => true },
        { name: ".hiddenfile", isDirectory: () => false },
      ]);
      mockExistsSync.mockReturnValue(true);

      const result = await mockedListFilesTool.invoke({});

      expect(mockedPath.resolve).toHaveBeenCalledWith(mockCwd(), ".");
      expect(mockedFs.readdirSync).toHaveBeenCalledWith(".", {
        withFileTypes: true,
      });
      expect(result).toContain("Contents of .");
      expect(result).toContain("📄 file1.ts");
      expect(result).toContain("📂 subdir");
      expect(result).toContain("📄 .hiddenfile");
    });

    it("should list files and directories in a specified directory", async () => {
      const dirPath = "src/components";
      mockReaddirSync.mockReturnValue([
        { name: "compA.ts", isDirectory: () => false },
      ]);
      mockExistsSync.mockReturnValue(true);

      await mockedListFilesTool.invoke({ dirPath });

      expect(mockedPath.resolve).toHaveBeenCalledWith(mockCwd(), dirPath);
      expect(mockedFs.readdirSync).toHaveBeenCalledWith(
        expect.stringContaining(dirPath),
        { withFileTypes: true },
      );
    });

    it("should return an error if the directory does not exist", async () => {
      const dirPath = "nonexistent/dir";
      mockedFs.existsSync.mockReturnValue(false);

      const result = await mockedListFilesTool.invoke({ dirPath });

      expect(result).toBe(`❌ Directory not found: ${dirPath}`);
      expect(mockedFs.readdirSync).not.toHaveBeenCalled();
    });

    it("should handle errors during directory listing", async () => {
      const dirPath = "src";
      const listError = new Error("Permission denied");
      mockedFs.readdirSync.mockImplementation(() => {
        throw listError;
      });
      mockedFs.existsSync.mockReturnValue(true);

      const result = await mockedListFilesTool.invoke({ dirPath });

      expect(result).toBe(`❌ Error listing directory: ${listError.message}`);
    });
  });
});
