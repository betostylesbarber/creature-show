// Evaluates JavaScript in a running stream window over the DevTools protocol (Chrome started
// with --remote-debugging-port), for sound tests: node scripts/sound/drive.mjs "<expr>" [port]
// [--console ms] prints the page's console output for that long as well.
import { cdp } from "./lib/chrome.mjs";

const args = process.argv.slice(2);
const expr = args[0];
const port = Number(args[1] && !args[1].startsWith("--") ? args[1] : 9333);
const ci = args.indexOf("--console");
const page = await cdp(port, (t) => t.url.includes("/stream") || t.url.includes("sound-lab"));
const logs = [];
if (ci >= 0) {
  page.on((m) => {
    if (m.method === "Runtime.consoleAPICalled") logs.push(`${m.params.type}: ${m.params.args.map((a) => a.value ?? a.description ?? "").join(" ")}`);
    if (m.method === "Runtime.exceptionThrown") logs.push(`exception: ${m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text}`);
  });
  await page.send("Runtime.enable");
}
if (expr) {
  const v = await page.evaluate(expr);
  console.log(typeof v === "string" ? v : JSON.stringify(v, null, 1));
}
if (ci >= 0) {
  await new Promise((r) => setTimeout(r, Number(args[ci + 1] || 2000)));
  console.log(logs.join("\n"));
}
page.close();
