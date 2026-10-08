import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConflictError, createBooking, findOverlappingBooking, listBookings, ValidationError } from '../src/bookings.js';
import { createStore } from '../src/store.js';

const validBooking = {
  roomId: 'cedar',
  title: 'Product brainstorm',
  organizer: 'Alex Morgan',
  startTime: '2030-06-12T09:00:00Z',
  endTime: '2030-06-12T10:00:00Z',
};

test('each store starts with three stable rooms and no bookings', () => {
  const first = createStore();
  assert.deepEqual(first.rooms.map((room) => room.id), ['cedar', 'maple', 'aspen']);
  first.bookings.push({});
  first.rooms[0].name = 'Changed';
  const second = createStore();
  assert.equal(second.bookings.length, 0);
  assert.equal(second.rooms[0].name, 'Cedar');
});

test('creates a booking, trims text, and normalizes UTC timestamps', () => {
  const store = createStore();
  const result = createBooking(store, { ...validBooking, title: '  Product brainstorm  ', ignored: true });
  assert.match(result.id, /^[0-9a-f-]{36}$/);
  assert.deepEqual(result, {
    id: result.id, ...validBooking,
    startTime: '2030-06-12T09:00:00.000Z', endTime: '2030-06-12T10:00:00.000Z',
  });
  assert.equal(store.bookings.length, 1);
});

test('lists only the selected room and date in start-time order', () => {
  const store = createStore();
  const late = createBooking(store, { ...validBooking, startTime: '2030-06-12T14:00:00Z', endTime: '2030-06-12T15:00:00Z' });
  const early = createBooking(store, validBooking);
  createBooking(store, { ...validBooking, roomId: 'maple' });
  createBooking(store, { ...validBooking, startTime: '2030-06-13T09:00:00Z', endTime: '2030-06-13T10:00:00Z' });
  assert.deepEqual(listBookings(store, 'cedar', '2030-06-12').map((booking) => booking.id), [early.id, late.id]);
  assert.deepEqual(listBookings(store, 'cedar', '2030-06-14'), []);
});

test('a booking spanning midnight appears on each affected day, but not after its end', () => {
  const store = createStore();
  const booking = createBooking(store, {
    ...validBooking, startTime: '2030-06-12T23:00:00Z', endTime: '2030-06-14T00:00:00Z',
  });
  assert.deepEqual(listBookings(store, 'cedar', '2030-06-12'), [booking]);
  assert.deepEqual(listBookings(store, 'cedar', '2030-06-13'), [booking]);
  assert.deepEqual(listBookings(store, 'cedar', '2030-06-14'), []);
});

test('accepts a real leap day and millisecond timestamps', () => {
  const booking = createBooking(createStore(), {
    ...validBooking, startTime: '2032-02-29T09:00:00.125Z', endTime: '2032-02-29T10:00:00.125Z',
  });
  assert.equal(booking.startTime, '2032-02-29T09:00:00.125Z');
});

const invalidInputs = [
  ['missing body', undefined],
  ['null body', null],
  ['array body', []],
  ['unknown room', { ...validBooking, roomId: 'missing' }],
  ['missing title', { ...validBooking, title: undefined }],
  ['blank title', { ...validBooking, title: '  ' }],
  ['long title', { ...validBooking, title: 'a'.repeat(101) }],
  ['blank organizer', { ...validBooking, organizer: ' ' }],
  ['non-string organizer', { ...validBooking, organizer: 123 }],
  ['missing timestamp', { ...validBooking, startTime: undefined }],
  ['invalid timestamp', { ...validBooking, startTime: 'not-a-date' }],
  ['missing UTC suffix', { ...validBooking, startTime: '2030-06-12T09:00:00' }],
  ['non-UTC offset', { ...validBooking, startTime: '2030-06-12T09:00:00+02:00' }],
  ['impossible day', { ...validBooking, startTime: '2030-02-30T09:00:00Z' }],
  ['invalid leap day', { ...validBooking, startTime: '2030-02-29T09:00:00Z' }],
  ['impossible hour', { ...validBooking, startTime: '2030-06-12T24:00:00Z' }],
  ['zero duration', { ...validBooking, endTime: validBooking.startTime }],
  ['negative duration', { ...validBooking, endTime: '2030-06-12T08:00:00Z' }],
];

for (const [description, input] of invalidInputs) {
  test(`rejects ${description} without storing a booking`, () => {
    const store = createStore();
    assert.throws(() => createBooking(store, input), ValidationError);
    assert.equal(store.bookings.length, 0);
  });
}

for (const date of [undefined, '', '2030-2-1', '2030-02-30', 'not-a-date']) {
  test(`rejects invalid date filter: ${String(date)}`, () => {
    assert.throws(() => listBookings(createStore(), 'cedar', date), ValidationError);
  });
}

test('rejects an unknown room filter', () => {
  assert.throws(() => listBookings(createStore(), 'missing', '2030-06-12'), ValidationError);
});

test('findOverlappingBooking returns the first matching booking in the same room, or null', () => {
  const bookings = [{ roomId: 'cedar', startTime: '2030-06-12T09:00:00.000Z', endTime: '2030-06-12T10:00:00.000Z' }];
  assert.equal(findOverlappingBooking(bookings, 'cedar', '2030-06-12T09:30:00.000Z', '2030-06-12T09:45:00.000Z'), bookings[0]);
  assert.equal(findOverlappingBooking(bookings, 'cedar', '2030-06-12T10:00:00.000Z', '2030-06-12T11:00:00.000Z'), null);
  assert.equal(findOverlappingBooking(bookings, 'maple', '2030-06-12T09:00:00.000Z', '2030-06-12T10:00:00.000Z'), null);
});

test('rejects a partially overlapping booking in the same room with a structured ConflictError', () => {
  const store = createStore();
  const existing = createBooking(store, validBooking);
  assert.throws(
    () => createBooking(store, {
      ...validBooking, title: 'Budget review', organizer: 'Priya Shah',
      startTime: '2030-06-12T09:30:00Z', endTime: '2030-06-12T10:30:00Z',
    }),
    (error) => {
      assert.ok(error instanceof ConflictError);
      assert.equal(error.status, 409);
      assert.equal(
        error.message,
        'Room Cedar is already booked from 09:00 to 10:00, resulting in a conflict from 09:30 to 10:00.'
      );
      assert.equal(error.room, 'Cedar');
      assert.deepEqual(error.conflict, { start: existing.startTime, end: existing.endTime });
      assert.deepEqual(error.overlapWindow, { start: '2030-06-12T09:30:00.000Z', end: '2030-06-12T10:00:00.000Z' });
      assert.equal(error.title, existing.title);
      assert.equal(error.organizer, existing.organizer);
      return true;
    }
  );
  assert.equal(store.bookings.length, 1);
});

test('rejects a request that fully contains an existing booking, and one fully contained within one', () => {
  const store = createStore();
  createBooking(store, validBooking);
  assert.throws(
    () => createBooking(store, { ...validBooking, startTime: '2030-06-12T08:30:00Z', endTime: '2030-06-12T10:30:00Z' }),
    ConflictError
  );
  assert.throws(
    () => createBooking(store, { ...validBooking, startTime: '2030-06-12T09:15:00Z', endTime: '2030-06-12T09:45:00Z' }),
    ConflictError
  );
  assert.equal(store.bookings.length, 1);
});

test('rejects an exact duplicate time range in the same room', () => {
  const store = createStore();
  createBooking(store, validBooking);
  assert.throws(() => createBooking(store, validBooking), ConflictError);
  assert.equal(store.bookings.length, 1);
});

test('allows a booking that starts exactly when another ends in the same room', () => {
  const store = createStore();
  createBooking(store, validBooking);
  const backToBack = createBooking(store, { ...validBooking, startTime: '2030-06-12T10:00:00Z', endTime: '2030-06-12T11:00:00Z' });
  assert.equal(store.bookings.length, 2);
  assert.equal(backToBack.startTime, '2030-06-12T10:00:00.000Z');
});

test('allows a booking that ends exactly when another starts in the same room', () => {
  const store = createStore();
  createBooking(store, { ...validBooking, startTime: '2030-06-12T11:00:00Z', endTime: '2030-06-12T12:00:00Z' });
  const before = createBooking(store, { ...validBooking, startTime: '2030-06-12T10:00:00Z', endTime: '2030-06-12T11:00:00Z' });
  assert.equal(store.bookings.length, 2);
  assert.equal(before.endTime, '2030-06-12T11:00:00.000Z');
});

test('allows an identical time range to be booked in a different room', () => {
  const store = createStore();
  createBooking(store, validBooking);
  const other = createBooking(store, { ...validBooking, roomId: 'maple' });
  assert.equal(store.bookings.length, 2);
  assert.equal(other.roomId, 'maple');
});
