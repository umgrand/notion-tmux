import { TicketEngine } from "../core/engine.js";
import { loadLegacyConfig } from "./config.js";

const loaded = loadLegacyConfig();
const engine = new TicketEngine({ ...loaded, emit: () => undefined });
const report = await engine.doctor();
for (const check of report.checks) {
  const mark = check.status === "ok" ? "OK" : check.status === "warning" ? "WARN" : "FAIL";
  console.log(`${mark.padEnd(4)} ${check.label}: ${check.detail}`);
}
process.exit(report.ok ? 0 : 1);
