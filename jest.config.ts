import type { Config } from "jest";

const config: Config = {
  moduleFileExtensions: ["js", "json", "ts"],
  rootDir: ".",
  // Busca archivos que terminen en .spec.ts
  testRegex: ".*\\.spec\\.ts$",

  // A git worktree under `.claude/worktrees/<name>/` is a complete second
  // checkout of this repository, specs included. Without this the suite runs
  // twice: 183 suites and 1,633 tests instead of 93 and 818, five minutes
  // instead of two and a half — and a spec edited inside a worktree is
  // reported as if it were this checkout's, which is the part that misleads.
  // `dist` is excluded for the same reason: it holds compiled copies.
  // See ADR-031 and `IGNORED_DIRECTORIES` in `workspace-discovery.ts`, which
  // has the same hole for the same reason.
  testPathIgnorePatterns: ["/node_modules/", "/dist/", "/\\.claude/"],

  // 1. Usamos ts-jest para procesar archivos .ts y .js
  transform: {
    "^.+\\.(t|j)s$": ["ts-jest", { diagnostics: false }],
  },

  // 2. 🔥 EL PARCHE PARA EL ERROR DE UUID
  // Por defecto, Jest ignora todo lo que está en node_modules.
  // Aquí le decimos: "Ignora node_modules, PERO procesa (transforma) uuid, ts-morph y langchain"
  //
  // `uuid` stays listed even though this project no longer depends on it
  // directly: LangChain and deepagents pull it in, it is ESM-only, and removing
  // it here breaks 15 suites. The list is about what reaches Jest, not about
  // what package.json declares.
  // Esto obliga a Jest a transpilar el código ESM de esas librerías a CommonJS.
  transformIgnorePatterns: [
    "/node_modules/(?!(uuid|ts-morph|@langchain|langchain|deepagents)/)",
  ],

  collectCoverageFrom: ["**/*.(t|j)s"],
  coverageDirectory: "./coverage",
  testEnvironment: "node",

  // Opcional: Aumenta el timeout si tus tests son lentos
  testTimeout: 10000,
};

export default config;
