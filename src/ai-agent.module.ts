// src/ai-agent.module.ts
import { Module, Global } from "@nestjs/common";
import { AgentFactory } from "./core/agent/factory";

@Global()
@Module({
  providers: [
    {
      provide: "AI_AGENT",
      useFactory: async () => {
        // Aquí usamos tu lógica actual
        return await AgentFactory.create("nestjs-instance");
      },
    },
  ],
  exports: ["AI_AGENT"],
})
export class AiAgentModule {}
