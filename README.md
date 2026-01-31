# @dastbal/nestjs-ai-agent 🧙‍♂️
### Autonomous Principal Software Engineer for NestJS

[![npm version](https://img.shields.io/npm/v/@dastbal/nestjs-ai-agent.svg)](https://www.npmjs.com/package/@dastbal/nestjs-ai-agent)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Transform your NestJS development with an agent that doesn't just "chat", but **operates** directly on your codebase with Senior-level precision.

---

## 🚀 Quick Start

```bash
# Install the agent
npm install @dastbal/nestjs-ai-agent

# Run your first command
npx gen "Create a new Payments service with DDD patterns"
```

---

## 💎 Key Features

This agent operates with a strict set of principles and advanced capabilities:

*   **🔍 RAG Search:** Performs semantic search across your entire codebase before proposing changes, ensuring context-aware development.
*   **🩺 The Surgeon Rule:** Never overwrites a file without reading and analyzing it first, preserving existing logic and intent.
*   **✅ Self-Healing:** Runs integrity checks (TypeScript compiler) and attempts to auto-fix compilation errors (up to 3 retries).
*   **💾 Safe Writes:** Automatically creates backups before any file modification, ensuring data safety.
*   **🧠 SQLite Memory:** Remembers conversation threads and learned preferences across restarts using a local SQLite database.
*   **🔐 Configuration:** Leverages Google Vertex AI. Requires a service account JSON file (`credentials_vertex.json`) in the root folder and specific environment variables.

    **Credentials File:** Place your Google Service Account JSON in the root folder and name it exactly `credentials_vertex.json`.

    **Environment Variables:** Add the following to your `.env` file:
    ```dotenv
    GOOGLE_APPLICATION_CREDENTIALS="./credentials_vertex.json"
    GCP_PROJECT_ID="your-project-id"
    GCP_LOCATION="us-central1"
    ```
    **[CAUTION] Security First:** Always add `credentials_vertex.json` and `.env` to your `.gitignore` file to protect your credentials.

---

## ⚙️ Internal Workflow

The agent follows a strict Principal Engineer protocol:

1.  **Research:** Uses `ask_codebase` to find existing patterns, logic, and dependencies.
2.  **Comprehension:** Reads existing code using `safe_read_file` to understand context and avoid regressions.
3.  **Implementation:** Writes new code adhering to DDD principles, strict TypeScript typing (no `any`), and TSDocs.
4.  **Validation:** Runs `run_integrity_check` (TypeScript compiler) immediately after implementation to ensure type safety.
5.  **Safety:** Creates backups before writing files using `safe_write_file`.
6.  **Human-in-the-loop:** Pauses for explicit approval before performing critical file operations or major changes.

---

## 💡 Usage Examples

Try these commands to see the agent in action:

*   **Scaffolding:** `"Create a UserEntity with email and password fields using TypeORM"`
*   **Logic Implementation:** `"Add a validation pipe to the login DTO"`
*   **Testing:** `"Write a unit test for the AuthService including mocks for the repository"`
*   **Refactoring:** `"Standardize all HTTP exceptions in the users controller"`
*   **Code Generation:** `"Generate a NestJS module for handling user authentication"`

---

## 🧠 Learning & Adaptation

The agent learns from your feedback. If you provide a style correction or a new pattern, it stores this information in `.agent/memories/style-guide.txt` to ensure future code generation aligns with your preferences.

---

## 📄 License

This project is released under the MIT License. Build something amazing! ✨
