import chalk from "chalk";

export const log = {
  ai: (msg: string) => console.log(chalk.blue("🤖 [AI]: ") + msg),
  tool: (msg: string) => console.log(chalk.yellow("🛠️  [TOOL]: ") + msg),
  sys: (msg: string) => console.log(chalk.gray("⚙️  [SYS]: ") + msg),
  error: (msg: string) => console.log(chalk.red("❌ [ERR]: ") + msg),
  debug: (msg: string) => console.log(chalk.magenta("🐛 [DEBUG]: ") + msg),
};
