// Plates as Ituran keys them: digits and capital letters, no spaces or dashes.
// A plate goes into a URL path, so it must fit one path segment.

import { usage } from './errors.ts';

export function normalizePlate(raw: string): string {
  const plate = raw.replace(/[\s-]+/g, '').toUpperCase();
  if (!/^[0-9A-Z]{1,12}$/.test(plate)) {
    throw usage(
      `${/^[\x21-\x7e]{1,20}$/.test(raw) ? `"${raw}"` : 'That value'} is not a plate. Use the digits and letters on it, such as 12345678.`,
    );
  }
  return plate;
}
