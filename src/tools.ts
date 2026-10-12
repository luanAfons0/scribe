/**
 * The tools this Plugin ships: one for each thing the Plugin Page or another
 * Plugin can ask scribe to do (FirstMate ADR-0009).
 *
 * Every tool answers the same data twice — as text, for whoever reads it in a
 * terminal, and as structure, for the Page, which draws it.
 */
import type { Track } from './audio.ts';
import { forgetCall } from './audio.ts';
import {
  checkCallId,
  checkJottings,
  checkMinutes,
  checkTitle,
  deleteCall,
  listCalls,
  recordingCall,
  renameCall,
  saveJottings,
  saveMinutes,
  viewOf,
} from './calls.ts';
import type { Fetcher } from './fetcher.ts';
import { badInput } from './mcp.ts';
import type { Tool, ToolResult } from './mcp.ts';
import type { MinutesMaker } from './minutes-maker.ts';
import type { Recorder } from './recorder.ts';
import type { Choices } from './settings.ts';
import { within, type Store } from './store.ts';
import type { Transcriber } from './transcriber.ts';
import type { EntrySender } from './worklog-entry.ts';

const ID = { type: 'integer', description: 'The id of the Call, from list_calls.' };

/** What the tools work over: the Store, and the Call that records. */
export type Parts = {
  readonly store: Store;
  readonly recorder: Recorder;
  readonly transcriber: Transcriber;
  readonly maker: MinutesMaker;
  readonly sender: EntrySender;
  readonly choices: Choices;
  readonly fetcher: Fetcher;
};

/** The tools, over the parts of one running Plugin Server. */
export function toolsFor(parts: Parts): readonly Tool[] {
  const { store, recorder, transcriber, maker, sender, choices, fetcher } = parts;
  const view = (id: number) =>
    viewOf(store, id, transcriber.busyWith(id), sender.sending(id));

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
        if (given['id'] !== undefined) {
          return told({ call: view(checkCallId('get_call', given['id'])) });
        }
        const running = recordingCall(store);
        return told({ call: running === null ? null : view(running.id) });
      },
    },

    {
      name: 'start_call',
      description:
        'Start a Call. It is refused while another Call records, with a sentence that names it, ' +
        'and while whisper.cpp or its model is missing, with a sentence that names the setting.',
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

    {
      name: 'make_minutes',
      description:
        'Make the Minutes of a Call again, from its Jottings and its Transcript, with the ' +
        'Minutes command in get_settings. It starts the work and answers the Call at once; ' +
        'get_call shows minutesState "made", or "failed" with minutesError. It sends nothing ' +
        'to Worklog: when it writes other Topics on a sent Call, get_call shows ' +
        'topicsChangedSinceSent until send_to_worklog sends them again.',
      inputSchema: { type: 'object', properties: { id: ID }, required: ['id'] },
      call: (given) => {
        const id = checkCallId('make_minutes', given['id']);
        // Minutes made while the Topics are on their way would count as sent,
        // though Worklog got the old ones.
        if (sender.sending(id)) {
          throw badInput(
            `The Topics of Call ${id} are being sent to Worklog. ` +
              'Make its Minutes when that is done.',
          );
        }
        maker.make(id);
        return told({ call: view(id) });
      },
    },

    {
      name: 'send_to_worklog',
      description:
        'Send the Topics of an ended or Cut Call to the Worklog Plugin in get_settings, as ' +
        'one Done Entry with the Call\'s title and times; a Call sent before changes the ' +
        'same Entry. Nothing else leaves scribe, and nothing goes to Worklog until this is ' +
        'called. It starts the send and answers the Call at once; get_call shows ' +
        'sentToWorklogAt, or entryError with the sentence Worklog or the Host said. It is ' +
        'refused while the Call records, while it has no Topics, with no Worklog Plugin ' +
        'set, and while its Topics are being sent.',
      inputSchema: { type: 'object', properties: { id: ID }, required: ['id'] },
      call: (given) => {
        const id = checkCallId('send_to_worklog', given['id']);
        sender.send(id);
        return told({ call: view(id) });
      },
    },

    {
      name: 'rename_call',
      description:
        'Give a Call a title of your own. It replaces the date and time, or the title the ' +
        'Minutes proposed, and no Minutes made later replace it.',
      inputSchema: {
        type: 'object',
        properties: { id: ID, title: { type: 'string', description: 'One line.' } },
        required: ['id', 'title'],
      },
      call: (given) => {
        const id = checkCallId('rename_call', given['id']);
        const title = checkTitle(given['title']);
        return told({ call: within(store, () => renameCall(store, id, title)) });
      },
    },

    {
      name: 'save_minutes',
      description:
        'Keep Minutes written or corrected by hand, as Markdown, in place of what was there. ' +
        'The Transcript cannot be changed; it is the record of the Call.',
      inputSchema: {
        type: 'object',
        properties: {
          id: ID,
          minutes: { type: 'string', description: 'The Minutes, as Markdown.' },
        },
        required: ['id', 'minutes'],
      },
      call: (given) => {
        const id = checkCallId('save_minutes', given['id']);
        const minutes = checkMinutes(given['minutes']);
        within(store, () => saveMinutes(store, id, minutes));
        return told({ call: view(id) });
      },
    },

    {
      name: 'delete_call',
      description:
        'Delete a Call for good, with its Jottings, its Transcript, its Minutes and any audio ' +
        'of it that waits for Whisper. A Call that records must be stopped first.',
      inputSchema: { type: 'object', properties: { id: ID }, required: ['id'] },
      call: (given) => {
        const id = checkCallId('delete_call', given['id']);
        const deleted = within(store, () => deleteCall(store, id));
        forgetCall(id);
        return told(deleted);
      },
    },

    {
      name: 'get_settings',
      description:
        'The settings the operator chooses: whisper (the whisper.cpp executable), whisperModel ' +
        '(its model), minutesCommand (the program and arguments that make the Minutes) and ' +
        'worklogPlugin (the Plugin a Call\'s Entry goes to). Each has the value scribe uses ' +
        '(null for none); from: "environment" when its variable is set, "file" when the ' +
        'settings file holds it, "default" for none; saved, what the settings file holds; ' +
        'variable, the one that beats the file; problem, the one sentence that says what ' +
        'is missing or wrong, or null; and ignored, the one sentence that says its variable ' +
        'is set, not in its form, and ignored, or null.',
      inputSchema: { type: 'object', properties: {}, required: [] },
      call: () => told({ settings: choices.view() }),
    },

    {
      name: 'update_settings',
      description:
        'Change the settings the operator chooses, and keep them in settings.json in the ' +
        'Plugin directory. What is not given is kept; null takes a setting out of the file. ' +
        'A variable that is set still decides its setting. A bad value is refused with one ' +
        'sentence, and the file is left as it was. It answers what get_settings answers.',
      inputSchema: {
        type: 'object',
        properties: {
          whisper: {
            type: ['string', 'null'],
            description: 'The absolute path of the whisper.cpp executable, whisper-cli.',
          },
          whisperModel: {
            type: ['string', 'null'],
            description: 'The absolute path of the whisper.cpp model, such as ggml-small.bin.',
          },
          minutesCommand: {
            type: ['array', 'null'],
            items: { type: 'string' },
            description:
              'The command that makes the Minutes: the program, then each of its arguments. ' +
              'It reads a prompt on stdin and prints the Minutes.',
          },
          worklogPlugin: {
            type: ['string', 'null'],
            description: "The Registry name of the Worklog Plugin a Call's Entry goes to.",
          },
        },
        required: [],
      },
      call: (given) => {
        choices.update(given);
        return told({ settings: choices.view() });
      },
    },

    {
      name: 'get_downloads',
      description:
        'What scribe can fetch for this system, and how far each download got. whisper: the ' +
        'release, the build for this system (null when whisper.cpp publishes none, with ' +
        'missing, the sentence that says how to get one) and fetch. models: the models ' +
        'offered, each with its size in bytes, and fetch. A fetch is null when none runs, ' +
        'or { name, received, size, failed }, where failed is null while it runs and the ' +
        'one sentence it failed with after. Nothing is fetched by this tool.',
      inputSchema: { type: 'object', properties: {}, required: [] },
      call: () => told({ downloads: fetcher.view() }),
    },

    {
      name: 'fetch_whisper',
      description:
        'Fetch the whisper.cpp build for this system, check it against its SHA-256, unpack it ' +
        'under downloads/ in the Plugin directory, and set whisper to it. It starts the ' +
        'download and answers what get_downloads answers at once. It is refused where ' +
        'whisper.cpp publishes no build for this system, and while one is being fetched.',
      inputSchema: { type: 'object', properties: {}, required: [] },
      call: () => {
        fetcher.fetchWhisper();
        return told({ downloads: fetcher.view() });
      },
    },

    {
      name: 'fetch_model',
      description:
        'Fetch one whisper.cpp model of those get_downloads offers, check it against its ' +
        'SHA-256, keep it under downloads/ in the Plugin directory, and set whisperModel to ' +
        'it. It starts the download and answers what get_downloads answers at once. It is ' +
        'refused while a model is being fetched.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'The model, such as ggml-small.bin.' },
        },
        required: ['name'],
      },
      call: (given) => {
        fetcher.fetchModel(given['name']);
        return told({ downloads: fetcher.view() });
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
