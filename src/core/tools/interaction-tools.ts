import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { log } from "./utils/logger";

export const askHumanTool = tool(
  async ({ question }) => {
    log.ai(`Question for Human: ${question}`);
    return `WAITING FOR HUMAN: ${question}`;
  },
  {
    name: "ask_human",
    description: "Asks the user for clarification or input.",
    schema: z.object({ question: z.string().describe("The question for the human.") }),
  },
);
