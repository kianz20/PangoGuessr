import type { CSSProperties } from 'react';
import { initials } from '../players';

/** A player's initials on their colour — the same chip in the lobby, on the boards and on the map. */
export function Avatar({
  name,
  color,
  size = 'md',
  you = false,
}: {
  name: string;
  color: string;
  size?: 'sm' | 'md' | 'lg';
  you?: boolean;
}) {
  return (
    <span
      className={`avatar avatar--${size}${you ? ' avatar--you' : ''}`}
      style={{ '--avatar': color } as CSSProperties}
      aria-hidden
    >
      {initials(name)}
    </span>
  );
}
