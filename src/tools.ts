/**
 * The tools this Plugin ships: one for each thing the Plugin Page, the Popup
 * or another Plugin can ask scribe to do (FirstMate ADR-0009).
 *
 * Every tool answers the same data twice — as text, for whoever reads it in a
 * terminal, and as structure, for the Page, which draws it.
 */
import { listCalls } from './calls.ts';
import type { Tool, ToolResult } from './mcp.ts';
import type { Store } from './store.ts';

/** The tools, over one open Store. */
export function toolsFor(store: Store): readonly Tool[] {
  return [
    {
      name: 'list_calls',
      description: 'Every Call, newest first, with its title, state and when it started and ended.',
      inputSchema: { type: 'object', properties: {}, required: [] },
      call: () => told({ calls: listCalls(store) }),
    },
  ];
}

/** One answer, in both the shapes MCP offers, from one value. */
function told(value: unknown): ToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    structuredContent: value,
  };
}
