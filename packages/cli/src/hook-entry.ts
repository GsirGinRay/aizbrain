/**
 * Entry point of `.ai/bin/aizbrain-hook.mjs`, the script AI tools run. It is
 * self-contained, so a session needs neither npx nor the network.
 */
import { emitOutcome, HOOK_FLAG, QUIET, runHookEvent } from "./hook";

const args = process.argv.slice(2);
try {
  emitOutcome(args[0] === HOOK_FLAG ? await runHookEvent(args.slice(1)) : { ...QUIET, stderr: `usage: ${HOOK_FLAG} session-start|stop`, exitCode: 1 });
} catch {
  // Fail open: nothing here may stop the AI tool.
  process.exitCode = 0;
}
