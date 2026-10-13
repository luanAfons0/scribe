/**
 * The Plugin Page, as the bytes a browser is served.
 *
 * The Host returns a Plugin's `web/` directory unchanged (FirstMate ADR-0008),
 * so what this test reads off disk is exactly what a browser gets. It asserts
 * the things the Host will not check for you and that break a Page after it is
 * registered: a path that is not relative, an asset that is not there, and an
 * element the script reaches for that the markup does not declare.
 */
import { strict as assert } from 'node:assert';
import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const REPOSITORY = dirname(dirname(fileURLToPath(import.meta.url)));
const WEB = join(REPOSITORY, 'web');

/** Every page in web/, and the scripts of its own that reach for its elements. */
const PAGES = [
  { page: 'index.html', script: 'app.js' },
  { page: 'index.html', script: 'time.js' },
  { page: 'index.html', script: 'settings.js' },
  { page: 'index.html', script: 'downloads.js' },
  { page: 'index.html', script: 'calendar.js' },
  { page: 'index.html', script: 'events.js' },
  { page: 'index.html', script: 'shortcut.js' },
  { page: 'jot.html', script: 'jot.js' },
  { page: 'jot.html', script: 'time.js' },
];

/** Every `href` and `src` the page names, in the order it names them. */
function pathsIn(html: string): string[] {
  return [...html.matchAll(/(?:href|src)="([^"]*)"/g)].map((found) => found[1] ?? '');
}

test('the Plugin Page is served as index.html', async () => {
  const page = await stat(join(WEB, 'index.html'));

  assert.ok(page.isFile());
});

for (const { page, script } of PAGES) {
  test(
    `every path in ${page} is relative, so nothing assumes an address it does not own`,
    async () => {
      const html = await readFile(join(WEB, page), 'utf8');

      for (const path of pathsIn(html)) {
        if (path.startsWith('data:')) continue;
        assert.ok(!path.startsWith('/'), `${path} assumes it is served from the root`);
        assert.ok(!/^[a-z]+:/i.test(path), `${path} reaches outside the Plugin`);
      }
    },
  );

  test(
    `every asset ${page} names is beside it in web/, because there is no build step`,
    async () => {
      const html = await readFile(join(WEB, page), 'utf8');

      for (const path of pathsIn(html)) {
        if (path.startsWith('data:') || path.startsWith('#')) continue;
        const asset = await stat(join(WEB, path));
        assert.ok(asset.isFile(), `${path} is named by ${page} and is not in web/`);
      }
    },
  );

  test(`every element ${script} reaches for is one ${page} declares`, async () => {
    // The Page is the one part of this Plugin no test can drive, so this is
    // the mistake worth catching without a browser: a renamed id leaves the
    // script reading null and the Page blank, and nothing else would say so.
    const html = await readFile(join(WEB, page), 'utf8');
    const code = await readFile(join(WEB, script), 'utf8');
    const declared = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((found) => found[1]));

    for (const found of code.matchAll(/(?:byId|getElementById)\('([^']+)'\)/g)) {
      assert.ok(declared.has(found[1]), `${script} reaches for #${found[1]}, which ${page} lacks`);
    }
  });

  test(`${page} calls its tools through rpc.js, loaded before ${script}`, async () => {
    const html = await readFile(join(WEB, page), 'utf8');
    const code = await readFile(join(WEB, script), 'utf8');
    const paths = pathsIn(html);

    assert.ok(paths.includes('rpc.js'), `${page} does not load rpc.js`);
    assert.ok(paths.indexOf('rpc.js') < paths.indexOf(script), 'rpc.js loads too late');
    assert.ok(!code.includes('/p/scribe'), `${script} names the Plugin's address by hand`);
  });
}

for (const { page } of PAGES) {
  test(`no name is declared twice across the scripts ${page} loads`, async () => {
    // Classic scripts share one global scope, so a name two of them declare at
    // the top stops the second one dead, and the page is blank with no test
    // to say why.
    const html = await readFile(join(WEB, page), 'utf8');
    const seen = new Map<string, string>();
    for (const script of pathsIn(html).filter((path) => path.endsWith('.js'))) {
      const code = await readFile(join(WEB, script), 'utf8');
      for (const found of code.matchAll(/^(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/gm)) {
        const name = found[1] ?? '';
        assert.ok(!seen.has(name), `${name} is declared by ${seen.get(name)} and by ${script}`);
        seen.set(name, script);
      }
    }
  });
}

test('rpc.js calls the tools over the relative rpc address, never an absolute one', async () => {
  const code = await readFile(join(WEB, 'rpc.js'), 'utf8');

  assert.match(code, /const RPC = 'rpc';/);
  assert.match(code, /method: 'tools\/call'/);
  assert.ok(!code.includes('/p/scribe'), "rpc.js names the Plugin's address by hand");
});

test(
  'the Settings view offers each setting, with a place for its problem and an ignored variable',
  async () => {
    const html = await readFile(join(WEB, 'index.html'), 'utf8');

    for (const name of ['whisper', 'whisperModel', 'minutesCommand', 'worklogPlugin']) {
      assert.ok(html.includes(`id="set-${name}"`), `index.html has no field for ${name}`);
      assert.ok(html.includes(`id="${name}-problem"`), `index.html has no place for ${name}'s`);
      assert.ok(html.includes(`id="${name}-from"`), `index.html cannot say who decides ${name}`);
      assert.ok(
        html.includes(`id="${name}-ignored"`),
        `index.html cannot say that the variable of ${name} is ignored`,
      );
    }
    assert.ok(html.includes('href="#settings"'), 'nothing on the Page leads to the Settings view');
  },
);

test('settings.js reads and changes the settings through the settings tools', async () => {
  const code = await readFile(join(WEB, 'settings.js'), 'utf8');

  assert.match(code, /call\('get_settings'/);
  assert.match(code, /call\('update_settings'/);
});

test('settings.js loads before app.js, which shows it', async () => {
  const paths = pathsIn(await readFile(join(WEB, 'index.html'), 'utf8'));

  assert.ok(paths.includes('settings.js'), 'index.html does not load settings.js');
  assert.ok(paths.indexOf('settings.js') < paths.indexOf('app.js'), 'settings.js loads too late');
});

test(
  'the Settings view offers to fetch whisper.cpp and a model, each on its own, with its progress',
  async () => {
    const html = await readFile(join(WEB, 'index.html'), 'utf8');

    for (const id of [
      'whisper-offer', 'fetch-whisper', 'whisper-progress', 'whisper-fetch-failed',
      'model-choice', 'fetch-model', 'model-progress', 'model-fetch-failed',
    ]) {
      assert.ok(html.includes(`id="${id}"`), `index.html has no #${id}`);
    }
    for (const id of ['fetch-whisper', 'fetch-model']) {
      // A button in the settings form submits it unless it says otherwise.
      const button =
        `<button[^>]*type="button"[^>]*id="${id}"|<button[^>]*id="${id}"[^>]*type="button"`;
      assert.match(html, new RegExp(button));
    }
  },
);

test('downloads.js fetches through the fetch tools, and only from a click', async () => {
  const code = await readFile(join(WEB, 'downloads.js'), 'utf8');

  assert.match(code, /call\('get_downloads'/);
  assert.match(code, /call\('fetch_whisper'/);
  assert.match(code, /call\('fetch_model'/);
  assert.match(code, /call\('fetch_diarizer'/);
  // Nothing is fetched without the operator asking: each fetch tool is
  // called once, in the click handler of its own button.
  for (const [tool, button] of [
    ['fetch_whisper', 'fetch-whisper'],
    ['fetch_model', 'fetch-model'],
    ['fetch_diarizer', 'fetch-diarizer'],
  ]) {
    assert.equal(code.split(`call('${tool}'`).length, 2, `${tool} is called more than once`);
    const handler = new RegExp(
      `getElementById\\('${button}'\\)\\.addEventListener\\('click'[\\s\\S]*?call\\('${tool}'`,
    );
    assert.match(code, handler, `${tool} is not called from the click of #${button}`);
  }
});

test(
  'the Settings view offers to fetch the diarizer, with its progress, its result, and its problem',
  async () => {
    const html = await readFile(join(WEB, 'index.html'), 'utf8');

    for (const id of [
      'diarizer-offer', 'diarizer-offer-text', 'fetch-diarizer', 'diarizer-progress',
      'diarizer-fetch-failed', 'diarizer-done', 'diarizer-done-text', 'diarizer-ignored',
      'diarizer-problem',
    ]) {
      assert.ok(html.includes(`id="${id}"`), `index.html has no #${id}`);
    }
    // A Speaker is a Transcript line's label, not a program: the button names the program.
    assert.match(
      html,
      /<button[^>]*id="fetch-diarizer"[^>]*type="button"[^>]*>Fetch the diarizer</,
    );
    assert.ok(!/Fetch Speakers/.test(html), 'index.html still offers to fetch Speakers');
    assert.match(html, /Tells the people in the call’s sound apart after each Call stops\./);
  },
);

test('downloads.js offers the diarizer only while it is not set or has a problem', async () => {
  const code = await readFile(join(WEB, 'downloads.js'), 'utf8');

  assert.match(code, /diarizerSetting = settings\.diarizer/);
  assert.match(code, /setting\.value !== null && setting\.problem === null/);
  assert.match(code, /scribe does not run it yet: Calls get no Speakers until it does\./);
});

test('downloads.js offers whisper.cpp only while it is not set or has a problem', async () => {
  const code = await readFile(join(WEB, 'downloads.js'), 'utf8');

  assert.match(code, /settings\.whisper\.value !== null && settings\.whisper\.problem === null/);
  assert.match(code, /fetchWhisper\.hidden = !offered/);
  assert.ok(!code.includes("'ggml-small.bin'"), 'downloads.js names the default model by hand');
});

test('downloads.js loads before app.js, which shows the Settings view', async () => {
  const paths = pathsIn(await readFile(join(WEB, 'index.html'), 'utf8'));

  assert.ok(paths.includes('downloads.js'), 'index.html does not load downloads.js');
  assert.ok(paths.indexOf('downloads.js') < paths.indexOf('app.js'), 'downloads.js loads too late');
});

test('no script of the Page loads from the web or names an absolute path', async () => {
  const scripts = (await readdir(WEB)).filter((name) => name.endsWith('.js'));
  assert.ok(scripts.includes('app.js'), 'no script was read');
  for (const script of scripts) {
    const code = await readFile(join(WEB, script), 'utf8');

    assert.ok(!/https?:\/\//.test(code), `${script} names an address on the web`);
    // A string that is a path from the root, such as '/p/scribe/rpc'.
    assert.ok(!/(['"])\/[\w.-]+(\/[\w.-]*)*\1/.test(code), `${script} names an absolute path`);
  }
});

test('the Call shows its Topics read-only, above Send to Worklog', async () => {
  const html = await readFile(join(WEB, 'index.html'), 'utf8');

  const topics = html.indexOf('id="topics"');
  const button = html.indexOf('id="send-worklog"');
  assert.ok(topics > 0 && button > topics, 'the Topics are not above Send to Worklog');
  assert.match(html, /<p class="topics" id="topics"><\/p>/, 'the Topics are not read-only text');
  assert.match(html, /<button[^>]*id="send-worklog"[^>]*type="button"/);
});

test('app.js sends to Worklog only from a click of Send to Worklog', async () => {
  const code = await readFile(join(WEB, 'app.js'), 'utf8');

  // Nothing goes to Worklog without the operator asking: the tool is called
  // once, in the function the button's click runs.
  assert.equal(code.split("call('send_to_worklog'").length, 2, 'send_to_worklog is called twice');
  assert.match(code, /async function sendToWorklog\(\) \{[\s\S]*?call\('send_to_worklog'/);
  assert.match(code, /sendButton\.addEventListener\('click', sendToWorklog\)/);
  assert.ok(code.includes("byId('send-worklog')"), 'app.js does not reach for the button');
});

test(
  'app.js marks a sent Call in the list, and disables Send with no Worklog Plugin set',
  async () => {
    const code = await readFile(join(WEB, 'app.js'), 'utf8');

    assert.match(code, /found\.sentToWorklogAt !== null[\s\S]*?'Sent to Worklog'/);
    assert.match(
      code,
      /worklogPluginSet\(\)[\s\S]*?No Worklog Plugin is set[\s\S]*?disabled = true/,
    );
  },
);

test(
  "the Settings view takes the calendar's secret address, and shows it masked once saved",
  async () => {
    const html = await readFile(join(WEB, 'index.html'), 'utf8');
    const paths = pathsIn(html);

    for (const id of [
      'set-calendarUrl', 'calendar-empty', 'calendar-saved', 'calendarUrl-from',
      'calendarUrl-ignored', 'calendar-read', 'calendar-problem',
    ]) {
      assert.ok(html.includes(`id="${id}"`), `index.html has no #${id}`);
    }
    for (const id of ['calendar-replace', 'calendar-remove']) {
      // A button in the settings form submits it unless it says otherwise.
      assert.match(html, new RegExp(`<button[^>]*type="button"[^>]*id="${id}"`));
    }
    const late = paths.indexOf('calendar.js') > paths.indexOf('settings.js');
    assert.ok(!late, 'calendar.js loads late');
  },
);

test('calendar.js never puts the address back on the Page', async () => {
  const code = await readFile(join(WEB, 'calendar.js'), 'utf8');

  // get_settings has no address to give; the field is emptied once it is sent.
  assert.ok(!code.includes('calendarUrl.value'), 'calendar.js reads an address from the settings');
  assert.match(code, /field\.value = '';/);
  assert.match(code, /call\('update_settings', \{ calendarUrl: null \}\)/);
  assert.match(code, /call\('list_events'\)/);
});

test(
  'app.js says the Topics changed since sent, and offers Send again as the main act',
  async () => {
    const code = await readFile(join(WEB, 'app.js'), 'utf8');
    const css = await readFile(join(WEB, 'app.css'), 'utf8');

    assert.match(
      code,
      new RegExp(
        "found\\.topicsChangedSinceSent\\)[\\s\\S]*?'The Topics changed since you sent them '" +
          "[\\s\\S]*?classList\\.add\\('changed'\\)",
      ),
    );
    assert.match(css, /\.worklog-state\.changed \{[^}]*color: var\(--cut\)/);
  },
);

test('app.js says when the Topics went to Worklog as the approved design does', async () => {
  const code = await readFile(join(WEB, 'app.js'), 'utf8');

  // "Sent to Worklog today at 14:55", and "on 9 Oct at 14:55" on another day.
  assert.match(code, /return 'today at ' \+ time;/);
  assert.match(code, /return 'on ' \+ day \+ ' at ' \+ time;/);
  assert.match(code, /'Sent to Worklog ' \+ sentWhen\(found\.sentToWorklogAt\)/);
  // The changed sentence says "at 14:55" today, as the approved design does.
  assert.match(code, /sentWhen\(found\.sentToWorklogAt\)\.replace\(\/\^today \/, ''\)/);
  assert.ok(!/when\(found\.sentToWorklogAt\)/.test(code), 'a send is said with the full date');
});

test('after a send that failed, even the first, the button says Send again', async () => {
  const code = await readFile(join(WEB, 'app.js'), 'utf8');

  assert.match(
    code,
    new RegExp(
      'found\\.sentToWorklogAt !== null \\|\\| found\\.entryError !== null;\\s*' +
        "sendButton\\.textContent = sentOrTried \\? 'Send again' : 'Send to Worklog';",
    ),
  );
});

test('the Popup is jot.html, in the look of the Page, light and dark', async () => {
  const html = await readFile(join(WEB, 'jot.html'), 'utf8');
  const css = await readFile(join(WEB, 'app.css'), 'utf8');

  assert.match(html, /<meta name="color-scheme" content="light dark">/);
  const paths = pathsIn(html);
  assert.ok(paths.includes('app.css'), 'jot.html does not share app.css');
  assert.match(css, /@media \(prefers-color-scheme: dark\)/);
});

test('the Popup shows the Jottings of the Call that records, and keeps every change', async () => {
  const html = await readFile(join(WEB, 'jot.html'), 'utf8');
  const code = await readFile(join(WEB, 'jot.js'), 'utf8');

  assert.match(html, /<textarea[^>]*id="jot-jottings"/);
  // Without an id, get_call answers the Call that records, or null.
  assert.match(code, /call\('get_call'\)/);
  // The same box the Call's page keeps: every change is saved with save_jottings.
  assert.ok(pathsIn(html).includes('jottings.js'), 'jot.html does not load jottings.js');
  assert.match(code, /keepJottings\(/);
});

test('Stop in the Popup stops the Call with stop_call, and only from its click', async () => {
  const html = await readFile(join(WEB, 'jot.html'), 'utf8');
  const code = await readFile(join(WEB, 'jot.js'), 'utf8');

  assert.match(html, /<button[^>]*id="jot-stop"[^>]*type="button"[^>]*>Stop<\/button>/);
  assert.equal(code.split("call('stop_call'").length, 2, 'stop_call is called more than once');
  assert.match(code, /stopButton\.addEventListener\('click'/);
});

test('with no Call recording, the Popup says so, with no button and no link', async () => {
  const html = await readFile(join(WEB, 'jot.html'), 'utf8');

  const empty = /<div class="pop-empty" id="jot-empty"[^>]*>([\s\S]*?)<\/div>/.exec(html);
  assert.ok(empty, 'jot.html has no empty state');
  assert.match(empty[1] ?? '', /No Call is recording/);
  assert.match(empty[1] ?? '', /scribe’s page in the FirstMate window/);
  // In the Popup, a link to the Host only hides it (FirstMate's popup.ts).
  assert.ok(!/<(?:button|a)\b/.test(empty[1] ?? ''), 'the empty state offers a way out');
});

test('the Popup never records (ADR-0008)', async () => {
  const html = await readFile(join(WEB, 'jot.html'), 'utf8');
  const code = await readFile(join(WEB, 'jot.js'), 'utf8');

  assert.ok(!pathsIn(html).includes('capture.js'), 'jot.html loads the capture');
  assert.ok(!/getDisplayMedia|getUserMedia|startCapture|start_call/.test(code));
});

test("the Call's page reads the Jottings again when it gets focus", async () => {
  const code = await readFile(join(WEB, 'app.js'), 'utf8');

  assert.match(code, /window\.addEventListener\('focus', show\)/);
});

test('a reread never writes an old copy over a save that was on its way', async () => {
  const code = await readFile(join(WEB, 'jottings.js'), 'utf8');
  const app = await readFile(join(WEB, 'app.js'), 'utf8');

  // A read asked for before a save ended may hold the text before it.
  assert.match(code, /mark\(\)/);
  assert.match(
    app,
    /const mark = jottings\.mark\(\);[\s\S]*?jottings\.show\(found\.id, found\.jottings, mark\)/,
  );
});

test('a small tool call outlives the page, so a Popup that hides keeps its last save', async () => {
  const code = await readFile(join(WEB, 'rpc.js'), 'utf8');

  assert.match(code, /keepalive: /);
});

test(
  'Settings shows the firstmate bind command line for the Popup, with a copy button',
  async () => {
    const html = await readFile(join(WEB, 'index.html'), 'utf8');
    const code = await readFile(join(WEB, 'shortcut.js'), 'utf8');

    assert.match(
      html,
      /<code id="bind-command">firstmate bind Ctrl\+Shift\+J scribe jot\.html<\/code>/,
    );
    assert.match(html, /<button[^>]*id="copy-bind"[^>]*type="button"/);
    assert.match(code, /navigator\.clipboard\.writeText/);
  },
);

test('the Calls list shows the Event that starts within five minutes as a banner', async () => {
  const html = await readFile(join(WEB, 'index.html'), 'utf8');
  const code = await readFile(join(WEB, 'events.js'), 'utf8');
  const app = await readFile(join(WEB, 'app.js'), 'utf8');

  // A Notice opens #upcoming, so the banner carries that id.
  const banner = /<div class="event" id="upcoming"[^>]*>([\s\S]*?)<\/div>\s*<p class="next-event"/
    .exec(html);
  assert.ok(banner, 'index.html has no banner with the id a Notice opens');
  assert.match(
    banner[1] ?? '',
    /<a id="upcoming-meet"[^>]*target="_blank"[^>]*>Open the Meet<\/a>/,
  );
  assert.match(
    banner[1] ?? '',
    /<button class="act go" id="upcoming-start" type="button">Start a Call<\/button>/,
  );
  const under = html.indexOf('id="upcoming"') > html.indexOf('id="start"');
  assert.ok(!under, 'the banner is under the list');
  assert.match(code, /call\('list_events'\)/);
  assert.match(code, /const SOON_MS = 5 \* 60_000;/);
  assert.match(code, /Date\.parse\(event\.end\) > now/);
  assert.match(code, /scrollIntoView/);
  assert.match(app, /byId\('upcoming-start'\)\.addEventListener\('click', start\)/);
});

test('further away, the Calls list says the next Event in one line', async () => {
  const html = await readFile(join(WEB, 'index.html'), 'utf8');
  const code = await readFile(join(WEB, 'events.js'), 'utf8');

  assert.match(html, /<p class="next-event" id="next-event" hidden>/);
  assert.match(code, /'Next Event: '/);
  assert.match(code, /', on Google Meet\.'/);
});

test('the banner is the accent blue, light and dark, and never red', async () => {
  const css = await readFile(join(WEB, 'app.css'), 'utf8');

  assert.equal(css.match(/--accent-soft: /g)?.length, 2, 'the soft accent is not set for both');
  const rule = /\.event \{[^}]*\}/.exec(css)?.[0] ?? '';
  assert.match(rule, /border: 1px solid var\(--accent\)/);
  assert.match(rule, /background: var\(--accent-soft\)/);
  assert.ok(!/--live/.test(rule), 'the banner uses the red of recording');
});

test(
  'a Call named after its Event says so on its meta line, with Event in the accent',
  async () => {
    const code = await readFile(join(WEB, 'app.js'), 'utf8');
    const css = await readFile(join(WEB, 'app.css'), 'utf8');

    assert.match(code, /found\.event !== null && found\.title === found\.event\.name/);
    assert.match(code, /className = 'from-event';\s*event\.textContent = 'Event';/);
    assert.match(code, /callMeta\.append\(' · Title from the ', event\)/);
    assert.match(css, /\.from-event \{[^}]*color: var\(--accent\)/);
  },
);

test(
  'a calendar that cannot be read is said once, quietly, where the next Event shows',
  async () => {
    const html = await readFile(join(WEB, 'index.html'), 'utf8');
    const code = await readFile(join(WEB, 'events.js'), 'utf8');

    const line = /<p class="next-event" id="calendar-unread" hidden>([\s\S]*?)<\/p>/.exec(html);
    assert.ok(line, 'the Calls list has no line for a calendar that cannot be read');
    assert.ok(
      html.indexOf('id="next-event"') < html.indexOf('id="calendar-unread"'),
      'the line is not where the next Event shows',
    );
    assert.match(line[1] ?? '', /scribe cannot read the calendar now/);
    assert.match(line[1] ?? '', /<a href="#settings">See why in Settings<\/a>/);
    // The line is the Page's own words: the fault's sentence stays in Settings.
    assert.match(code, /calendar\.read\.problem === null/);
    assert.ok(!/textContent = calendar\.read\.problem/.test(code), 'the fault is put on the list');
  },
);

test('the Jottings of a recording Call say how to write from anywhere', async () => {
  const html = await readFile(join(WEB, 'index.html'), 'utf8');
  const code = await readFile(join(WEB, 'app.js'), 'utf8');

  const hint = /<p class="shortcut-hint" id="shortcut-hint" hidden>([\s\S]*?)<\/p>/.exec(html);
  assert.ok(hint, 'the Call has no Shortcut hint');
  assert.ok(
    html.indexOf('id="call-jottings"') < html.indexOf('id="shortcut-hint"'),
    'the hint is not under the Jottings',
  );
  const words = (hint[1] ?? '').replace(/\s+/g, ' ').trim();
  assert.equal(
    words,
    'Write from anywhere with <kbd>Ctrl</kbd> <kbd>Shift</kbd> <kbd>J</kbd>. ' +
      'The Popup shows these Jottings.',
  );
  assert.match(code, /shortcutHint\.hidden = !isRecording\(found\);/);
});

test(
  "the Settings view says when declined Events show, as the calendar's read gives it",
  async () => {
    const code = await readFile(join(WEB, 'calendar.js'), 'utf8');

    assert.match(code, /read\.declined === null \? '' : ' ' \+ read\.declined/);
  },
);

test(
  'the Page and the Popup say a time through one time.js, loaded before their script',
  async () => {
    for (const { page, script } of [
      { page: 'index.html', script: 'app.js' },
      { page: 'jot.html', script: 'jot.js' },
    ]) {
      const paths = pathsIn(await readFile(join(WEB, page), 'utf8'));

      assert.ok(paths.includes('time.js'), `${page} does not load time.js`);
      assert.ok(paths.indexOf('time.js') < paths.indexOf(script), `time.js loads after ${script}`);
    }
  },
);
