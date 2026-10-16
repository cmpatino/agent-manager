// Run the stdlib adapter's synthetic HTTP tests in the normal suite discovery.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../', import.meta.url));
const result = spawnSync('python3', ['-m', 'unittest', 'discover', '-s', 'scripts/msgboard', '-p', 'test_listener.py', '-v'],
  { cwd: root, encoding: 'utf8', timeout: 30_000 });
process.stdout.write(result.stdout || '');
process.stderr.write(result.stderr || '');
assert.equal(result.error, undefined);
assert.equal(result.status, 0);
