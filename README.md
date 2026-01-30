# Meet the NestJS Code Alchemist 🧙‍♂️

![NestJS Logo](https://nestjs.com/img/logo-small.svg)  

## Introduction

I am a specialized AI, a Principal Software Engineer, crafted to assist you in your NestJS projects. I operate directly on the project's local file system, enabling me to read, understand, and modify your codebase with precision and efficiency. My goal is to help you write clean, well-documented, and testable code, adhering to the best practices of NestJS and Domain-Driven Design (DDD).

## Core Functionality

Here's a breakdown of how I work:

1.  **Understanding Your Needs:** I start by carefully interpreting your requests. I clarify any ambiguities and break down complex tasks into manageable steps.

2.  **Code Exploration (🔍 `ask_codebase`):**
    *   Before making any changes, I use the `ask_codebase` tool. This is my primary research instrument.
    *   It allows me to perform semantic searches and analyze the project's dependency graph.
    *   I use it to find relevant code snippets, understand how different parts of the system interact, and locate the exact file paths I need.

3.  **Code Comprehension (📖 `safe_read_file`):**
    *   When I need to modify a file, I *always* read its contents first using `safe_read_file`.
    *   This ensures I understand the existing code, its structure, and any existing documentation (TSDocs).
    *   This is crucial for avoiding regressions and maintaining code quality.

4.  **Code Generation & Modification (✍️):**
    *   Based on your instructions and my understanding of the code, I generate or modify code.
    *   I adhere to strict TypeScript typing, DDD principles, and NestJS best practices.
    *   I also create corresponding tests to ensure code reliability.

5.  **Code Writing (💾 `safe_write_file`):**
    *   I write the generated or modified code to the file system using `safe_write_file`.
    *   This tool automatically creates a backup of the original file, providing a safety net.

6.  **Integrity Validation (✅ `run_integrity_check`):**
    *   Immediately after writing or modifying code, I run `run_integrity_check`.
    *   This is a critical step. It uses the TypeScript compiler to ensure that the code is type-safe and compiles without errors.
    *   This helps catch any mistakes I might have made.

7.  **Self-Correction (🛠️):**
    *   If the integrity check fails, I analyze the error messages and attempt to fix the code myself.
    *   I will retry up to three times. If I cannot fix the error, I will ask for human assistance.

8.  **Iteration and Refinement (🔄):**
    *   I repeat these steps as needed, refining the code and ensuring it meets your requirements.

9.  **Documentation (📝):**
    *   I always strive to maintain and improve code documentation (TSDocs).

10. **Learning and Adaptation (🧠):**
    *   I learn from your feedback. If you correct a style preference, I store it in `/memories/style-guide.txt` to improve future responses.

## Tools and Technologies

I am built upon a foundation of powerful tools and technologies:

*   **Language Model:** I leverage a large language model (LLM) from Google, enabling me to understand and generate human-like text.
*   **Retrieval-Augmented Generation (RAG):** I utilize a live RAG system. This means I can dynamically access and process information from your codebase to provide accurate and relevant responses. This allows me to understand the context of your project and generate code that fits seamlessly.
*   **NestJS Expertise:** I have been specifically trained on NestJS best practices, DDD, and related concepts.
*   **TypeScript:** I am fluent in TypeScript and adhere to strict typing.
*   **Libraries:** I utilize a suite of libraries for code analysis, generation, and validation.
*   **File System Access:** I have secure access to the project's local file system, allowing me to directly modify your code.

## Safety and Quality

*   **Strict Typing:** I enforce strict TypeScript typing to prevent common errors.
*   **Comprehensive Testing:** I create tests alongside the code to ensure its reliability.
*   **Error Handling:** I use standard NestJS HTTP exceptions and avoid swallowing errors silently.
*   **Code Reviews:** I am designed to be used in conjunction with human code reviews to ensure the highest quality.

## How to Interact with Me

Simply provide me with clear instructions, and I will do my best to assist you. For example:

*   "Add a new DTO for the User entity."
*   "Create a service to handle authentication."
*   "Write a unit test for the UserService."

I will guide you through the process, providing feedback and ensuring the code meets your requirements.

## Disclaimer

I am an AI assistant and should be used responsibly. Always review the code I generate before deploying it to production. I am constantly learning and improving, but I am not perfect. Please report any issues or suggestions.

## Let's Build Something Amazing! ✨
