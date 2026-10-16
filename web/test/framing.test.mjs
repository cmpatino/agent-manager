// The in-app framing check (lib/framing.ts): which embeddings may render the
// app. Pure logic against fake window chains; the browser suite
// (framing.browser.test.mjs) drives real engines.
// Run:  node test/framing.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'framing-')), 'framing.mjs');
await build({ entryPoints: [path.join(HERE, '../src/lib/framing.ts')], outfile: out, format: 'esm', bundle: false, logLevel: 'error' });
const { ancestorOrigins, defaultTrusted, frameVerdict, standaloneUrl, HUB_ORIGIN } = await import(pathToFileURL(out).href);

const APP = 'https://owner-space.hf.space';
const crossOrigin = () => { throw new DOMException('Blocked a frame', 'SecurityError'); };
// A window whose location is readable only when `readable` (same-origin to us).
function win(origin, { parent, listed, readable = true, opaque = false } = {}) {
  const url = new URL(origin);
  const location = readable
    ? { origin, hostname: url.hostname, href: `${origin}/`, ...(listed ? { ancestorOrigins: { length: listed.length, item: (i) => listed[i] ?? null } } : {}) }
    : { get origin() { return crossOrigin(); }, get hostname() { return crossOrigin(); } };
  const w = { location, origin: opaque ? 'null' : origin };
  w.self = w;
  w.parent = parent || w;
  w.top = parent ? parent.top : w;
  return w;
}
const chain = (...origins) => {
  // origins: outermost first; the last one is "us". `readable` from our side.
  let w;
  for (const [i, o] of origins.entries()) {
    const ours = i === origins.length - 1;
    w = win(o.origin, { parent: w, readable: ours || o.origin === origins.at(-1).origin, listed: ours ? o.listed : undefined, opaque: ours && o.opaque });
  }
  return w;
};

// Top-level: always the app.
{
  const w = win(APP);
  assert.deepEqual(ancestorOrigins({ win: w, referrer: '' }), []);
  assert.equal(frameVerdict({ win: w, referrer: '' }, defaultTrusted(w)), 'top');
}
// Defaults: the Hub is trusted for *.hf.space only.
assert.deepEqual(defaultTrusted(win(APP)), [APP, HUB_ORIGIN]);
assert.deepEqual(defaultTrusted(win('http://127.0.0.1:7860')), ['http://127.0.0.1:7860']);
assert.deepEqual(defaultTrusted(win('https://hf.space.evil.example')), ['https://hf.space.evil.example']);

const verdict = (w, referrer = '', trusted = defaultTrusted(w)) => frameVerdict({ win: w, referrer }, trusted);

// Engines that list ancestors (Chromium, WebKit, current Firefox).
assert.equal(verdict(chain({ origin: HUB_ORIGIN }, { origin: APP, listed: [HUB_ORIGIN] })), 'trusted', 'the Hub Space page');
assert.equal(verdict(chain({ origin: APP }, { origin: APP, listed: [APP] })), 'trusted', 'the app framing itself');
assert.equal(verdict(chain({ origin: 'https://evil.example' }, { origin: APP, listed: ['https://evil.example'] })), 'untrusted');
assert.equal(verdict(chain({ origin: HUB_ORIGIN }, { origin: 'https://evil-x.hf.space' }, { origin: APP, listed: ['https://evil-x.hf.space', HUB_ORIGIN] })),
  'untrusted', 'every ancestor counts: an attacker Space inside the Hub page');
assert.equal(verdict(chain({ origin: 'https://evil.example' }, { origin: HUB_ORIGIN }, { origin: APP, listed: [HUB_ORIGIN, 'https://evil.example'] })),
  'untrusted', 'a trusted parent inside an untrusted top');
assert.equal(verdict(chain({ origin: HUB_ORIGIN }, { origin: APP, listed: ['null'] })), 'untrusted', 'a masked ancestor is unidentified');
assert.equal(verdict(chain({ origin: HUB_ORIGIN }, { origin: APP, listed: [HUB_ORIGIN], opaque: true })), 'untrusted',
  'a sandboxed (opaque-origin) frame never renders, even on the Hub');
assert.equal(verdict(chain({ origin: 'https://portal.example' }, { origin: APP, listed: ['https://portal.example'] }), '',
  [APP, HUB_ORIGIN, 'https://portal.example']), 'trusted', 'server-configured extra origin');
assert.equal(verdict(chain({ origin: 'https://huggingface.co.evil.example' }, { origin: APP, listed: ['https://huggingface.co.evil.example'] })), 'untrusted');

// Engines without ancestorOrigins: readable same-origin ancestors are identified;
// a cross-origin one only as the direct parent that is also the top and loaded us.
{
  const hub = chain({ origin: HUB_ORIGIN }, { origin: APP });
  assert.deepEqual(ancestorOrigins({ win: hub, referrer: 'https://huggingface.co/' }), [HUB_ORIGIN]);
  assert.equal(verdict(hub, 'https://huggingface.co/'), 'trusted', 'the Hub embed keeps working');
  assert.equal(verdict(hub, ''), 'untrusted', 'no referrer: unidentified');
  assert.equal(verdict(hub, `${APP}/somewhere`), 'untrusted', 'self-referrer says nothing about the parent');
  assert.equal(verdict(hub, 'not a url'), 'untrusted');
  const evil = chain({ origin: 'https://evil.example' }, { origin: APP });
  assert.equal(verdict(evil, 'https://evil.example/page'), 'untrusted');
  assert.equal(verdict(evil, ''), 'untrusted');
  const nested = chain({ origin: HUB_ORIGIN }, { origin: 'https://evil-x.hf.space' }, { origin: APP });
  assert.equal(verdict(nested, 'https://huggingface.co/'), 'untrusted', 'deeper cross-origin chains stay unidentified');
  const self = chain({ origin: APP }, { origin: APP });
  assert.equal(verdict(self, ''), 'trusted', 'same-origin parents are read directly');
}

// A throwing window.top (paranoid engines) is treated as framed.
{
  const w = win(APP);
  Object.defineProperty(w, 'top', { get: crossOrigin });
  assert.equal(verdict(w), 'untrusted');
}

assert.equal(standaloneUrl(`${APP}/?__sign=secret&x=1#h`), `${APP}/?x=1#h`);
assert.equal(standaloneUrl(`${APP}/`), `${APP}/`);
console.log('framing: all checks passed');
