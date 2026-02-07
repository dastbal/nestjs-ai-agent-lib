#!/usr/bin/env node
import * as dotenv from "dotenv";
dotenv.config(); // Carga las variables del .env si existen
import { Command } from "commander";
import chalk from "chalk";
import { HumanMessage } from "@langchain/core/messages";
import { AgentFactory } from "../core/agent/factory";
import { GraphAgentFactory } from "../core/agent/graph-factory";

const program = new Command();

// Logs con estilo (Chalk 4 syntax)
const log = {
  ai: (msg: string) => console.log(chalk.blue("🤖 [AI]: ") + msg),
  sys: (msg: string) => console.log(chalk.gray("⚙️  [SYS]: ") + msg),
  error: (msg: string) => console.log(chalk.red("❌ [ERR]: ") + msg),
};

program
  .name("gen")
  .description("Agente Autónomo de Ingeniería NestJS")
  .argument("<instruction>", "La instrucción técnica para el agente")
  .action(async (instruction: string) => {
    try {
      if (!instruction || instruction.trim().length === 0) {
        log.error("Proporciona una instrucción válida.");
        return;
      }

      log.sys("Inicializando Agente en modo CLI...");

      // El threadId puede ser fijo para sesiones de CLI o dinámico
      const threadId = "cli-user";
      const agent = await AgentFactory.create(threadId);

      log.ai(`Procesando: "${instruction}"`);

      const response = await agent.invoke(
        { messages: [new HumanMessage(instruction)] },
        { configurable: { thread_id: threadId }, recursionLimit: 50 },
      );

      const lastMessage = response.messages[response.messages.length - 1];

      if (lastMessage && lastMessage.content) {
        console.log("\n" + chalk.green("--- RESPUESTA DEL AGENTE ---"));
        console.log(lastMessage.content);
        console.log(chalk.green("----------------------------\n"));
      }

      log.sys("Tarea completada.");
    } catch (error: any) {
      log.error("Error en el agente:");
      log.error(error?.message || "Error desconocido");
    }
  });

program
  .command("node")
  .description("Agente Autónomo de Ingeniería NestJS (Modo Grafo)")
  .argument("<instruction>", "La instrucción técnica para el agente")
  .action(async (instruction: string) => {
    try {
      if (!instruction || instruction.trim().length === 0) {
        log.error("Proporciona una instrucción válida.");
        return;
      }

      log.sys("Inicializando Agente en modo GRAFO (LangGraph)...");

      const threadId = "cli-user-graph";
      const agent = await GraphAgentFactory.create(threadId);

      log.ai(`Procesando (Grafo): "${instruction}"`);

      const response = await agent.invoke(
        { messages: [new HumanMessage(instruction)] },
        { configurable: { thread_id: threadId }, recursionLimit: 50 },
      );

      const lastMessage = response.messages[response.messages.length - 1];

      if (lastMessage && lastMessage.content) {
        console.log("\n" + chalk.cyan("--- RESPUESTA DEL AGENTE (GRAFO) ---"));
        console.log(lastMessage.content);
        console.log(chalk.cyan("------------------------------------\n"));
      }

      log.sys("Tarea completada (Grafo).");
    } catch (error: any) {
      log.error("Error en el agente de grafo:");
      log.error(error?.message || "Error desconocido");
    }
  });

program.parse(process.argv);
