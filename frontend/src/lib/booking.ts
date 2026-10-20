export interface BookingAttempt { payload: string; key: string }

/** Reuse a key only for the same unchanged form attempt. No payload is persisted. */
export function bookingAttempt(previous: BookingAttempt | null, body: unknown, makeKey = () => crypto.randomUUID()): BookingAttempt {
  const payload = JSON.stringify(body);
  return previous?.payload === payload ? previous : { payload, key: makeKey() };
}
