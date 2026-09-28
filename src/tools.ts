/**
 * The tools this Plugin ships: one for each thing the Plugin Page, the Popup
 * or another Plugin can ask scribe to do (FirstMate ADR-0009).
 *
 * Every tool answers the same data twice — as text, for whoever reads it in a
 * terminal, and as structure, for the Page, which draws it.
 */
import type { Track } from './audio.ts';
import {
  checkCallId,
  checkJottings,
  listCalls,
  recordingCall,
  saveJottings,
  viewOf,
} from './calls.ts';
import { badInput } from './mcp.ts';
import type { Tool, ToolResult } from './mcp.ts';
import type { Recorder } from './recorder.ts';
import { within, type Store } from './store.ts';
import type { Transcriber } from './transcriber.ts';

const ID = { type: 'integer', description: 'The id of the Call, from list_calls.' };

/** What the tools work over: the Store, and the Call that records. */
export type Parts = {
  readonly store: Store;
  readonly recorder: Recorder;
  readonly transcriber: Transcriber;
};

/** The tools, over the parts of one running Plugin Server. */
export function toolsFor({ store, recorder, transcriber }: Parts): readonly Tool[] {
  const view = (id: number) => viewOf(store, id, transcriber.busyWith(id));

  return [
    {
      name: 'list_calls',
      description: 'Every Call, newest first, with its title, state and when it started and ended.',
      inputSchema: { type: 'object', properties: {}, required: [] },
      call: () => told({ calls: listCalls(store) }),
    },

    {
      name: 'get_call',
      description:
        'One Call, whole: its state, Jottings, Transcript and Minutes. Without an id, the ' +
        'Call that records now, or null when none does.',
      inputSchema: {
        type: 'object',
        properties: { id: { ...ID, description: 'The id of the Call. Optional.' } },
        required: [],
      },
      call: (given) => {
        if (given['id'] !== undefined) return told({ call: view(checkCallId('get_call', given['id'])) });
        const running = recordingCall(store);
        return told({ call: running === null ? null : view(running.id) });
      },
    },

    {
      name: 'start_call',
      description:
        'Start a Call. It is refused while another Call records, with a sentence that names it.',
      inputSchema: { type: 'object', properties: {}, required: [] },
      call: () => told({ call: recorder.start() }),
    },

    {
      name: 'append_audio',
      description:
        'Keep one chunk of the audio of the Call that records: 16 kHz mono 16-bit PCM, as ' +
        'base64, from the mic or from the shared tab. Chunks of a track are numbered from 0.',
      inputSchema: {
        type: 'object',
        properties: {
          id: ID,
          track: { type: 'string', enum: ['mic', 'tab'], description: 'Where the audio is from.' },
          seq: { type: 'integer', description: 'The number of this chunk in its track, from 0.' },
          pcm: { type: 'string', description: 'The audio, as base64 of little-endian PCM.' },
        },
        required: ['id', 'track', 'seq', 'pcm'],
      },
      call: (given) => {
        const id = checkCallId('append_audio', given['id']);
        const track = checkTrack(given['track']);
        const seq = checkSeq(given['seq']);
        if (typeof given['pcm'] !== 'string') {
          throw badInput('append_audio needs "pcm" as a base64 string.');
        }
        return told(recorder.append(id, track, seq, Buffer.from(given['pcm'], 'base64')));
      },
    },

    {
      name: 'stop_call',
      description:
        'Stop the Call that records. With an id, it must be that Call. Whisper goes on to ' +
        'read what is left of its audio.',
      inputSchema: {
        type: 'object',
        properties: { id: { ...ID, description: 'The id of the Call. Optional.' } },
        required: [],
      },
      call: (given) => {
        const id = given['id'] === undefined ? null : checkCallId('stop_call', given['id']);
        return told({ call: recorder.stop(id) });
      },
    },

    {
      name: 'save_jottings',
      description:
        'Keep the Jottings of a Call: the whole text, in place of what was there. A line ' +
        'that starts with # is a heading. Any Call may have its Jottings changed, at any time.',
      inputSchema: {
        type: 'object',
        properties: {
          id: ID,
          jottings: { type: 'string', description: 'The whole text of the Jottings.' },
        },
        required: ['id', 'jottings'],
      },
      call: (given) => {
        const id = checkCallId('save_jottings', given['id']);
        const jottings = checkJottings(given['jottings']);
        return told(within(store, () => saveJottings(store, id, jottings)));
      },
    },
  ];
}

function checkTrack(given: unknown): Track {
  if (given === 'mic' || given === 'tab') return given;
  throw badInput(
    `append_audio takes "track" as "mic" or "tab", and was given ${JSON.stringify(given)}.`,
  );
}

function checkSeq(given: unknown): number {
  if (typeof given === 'number' && Number.isSafeInteger(given) && given >= 0) return given;
  throw badInput(
    `append_audio takes "seq" as a whole number from 0, and was given ${JSON.stringify(given)}.`,
  );
}

/** One answer, in both the shapes MCP offers, from one value. */
function told(value: unknown): ToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    structuredContent: value,
  };
}
