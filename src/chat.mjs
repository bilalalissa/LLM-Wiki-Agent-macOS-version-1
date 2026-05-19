import { getConfig } from "./config.mjs";
import { answerQuestion } from "./chat-lib.mjs";

const question = process.argv.slice(2).join(" ").trim();
if (!question) {
  console.error('Usage: npm run chat -- "What is an AI system?"');
  process.exit(1);
}

console.log(await answerQuestion(question, getConfig()));
