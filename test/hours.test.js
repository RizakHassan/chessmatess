import test from 'node:test';
import assert from 'node:assert';
import { memoryClub } from './helpers.js';

// London is UTC+1 (BST) until 25 Oct 2026, then UTC+0.
const at = iso => ({ club } = memoryClub({ clock: () => new Date(iso) }), club);
let club;

test('default: Mondays 18:00–22:00 club time', () => {
  // Mon 12 Oct 2026
  assert.strictEqual(at('2026-10-12T16:59:00Z').loggingStatus().open, false); // 17:59 BST
  assert.strictEqual(at('2026-10-12T17:00:00Z').loggingStatus().open, true);  // 18:00 BST
  assert.strictEqual(at('2026-10-12T20:59:00Z').loggingStatus().open, true);  // 21:59
  const after = at('2026-10-12T21:00:00Z').loggingStatus();                   // 22:00 -> closed
  assert.strictEqual(after.open, false);
  assert.strictEqual(after.next, 'Monday at 18:00');
  assert.strictEqual(at('2026-10-12T09:00:00Z').loggingStatus().next, 'today at 18:00');
  assert.strictEqual(at('2026-10-11T12:00:00Z').loggingStatus().next, 'tomorrow at 18:00'); // Sunday
  // After the clocks go back (GMT), 18:00 local is 18:00Z.
  assert.strictEqual(at('2026-11-02T17:30:00Z').loggingStatus().open, false); // 17:30 GMT: not yet
  assert.strictEqual(at('2026-11-02T18:30:00Z').loggingStatus().open, true);
  assert.strictEqual(at('2026-11-02T22:00:00Z').loggingStatus().open, false);
});

test('requireLoggingOpen throws a closed error outside hours', () => {
  const c = at('2026-10-13T19:00:00Z'); // Tuesday
  assert.throws(() => c.requireLoggingOpen(), e => e.code === 'closed' && /opens Monday at 18:00/.test(e.message));
  at('2026-10-12T18:00:00Z').requireLoggingOpen(); // Monday 19:00 BST: fine
});

test('custom days, overnight windows and always-open', () => {
  const c = at('2026-10-15T23:30:00Z'); // Fri 00:30 BST
  c.setHours({ days: [4], start: '20:00', end: '01:00' }); // Thursday night into Friday
  assert.strictEqual(c.loggingStatus().open, true);
  c.setHours({ days: [1, 4], start: '18:00', end: '22:00' });
  assert.strictEqual(c.loggingStatus().open, false);
  assert.strictEqual(c.loggingStatus().next, 'Monday at 18:00');
  c.setHours({ always: true, days: [], start: '18:00', end: '22:00' });
  assert.strictEqual(c.loggingStatus().open, true);
  assert.strictEqual(c.snapshot().logging.open, true);
});

test('bad hours are rejected', () => {
  const c = at('2026-10-12T12:00:00Z');
  assert.throws(() => c.setHours({ days: [1], start: '6pm', end: '22:00' }), /Times must/);
  assert.throws(() => c.setHours({ days: [1], start: '18:00', end: '18:00' }), /different/);
  assert.throws(() => c.setHours({ days: [], start: '18:00', end: '22:00' }), /at least one day/);
});
