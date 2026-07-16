import { writeFileSync } from 'fs';
import { execSync } from 'child_process';
import { WriteHook, WriteEvent } from '../types/graph.js';

/**
 * Execute matching write hooks after a graph mutation.
 * Fire-and-forget — errors are logged, never thrown.
 */
export function executeHooks(event: WriteEvent, hooks: WriteHook[]): void {
  for (const hook of hooks) {
    if (!matchesHook(event, hook)) continue;

    try {
      if (hook.action === 'touch') {
        writeFileSync(hook.target, Date.now().toString());
      } else if (hook.action === 'exec') {
        execSync(hook.target, { stdio: 'ignore', timeout: 5000 });
      }
    } catch (err) {
      console.error(`[HOOK] ${hook.action} "${hook.target}" failed:`, err);
    }
  }
}

function matchesHook(event: WriteEvent, hook: WriteHook): boolean {
  if (hook.match.entity && event.entityNames.includes(hook.match.entity)) return true;
  if (hook.match.entity_type && event.entityTypes.includes(hook.match.entity_type)) return true;
  return false;
}
