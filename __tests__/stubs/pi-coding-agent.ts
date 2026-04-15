import { homedir } from "node:os";
import { join } from "node:path";

export function getAgentDir(): string {
  return join(homedir(), ".pi", "agent");
}
