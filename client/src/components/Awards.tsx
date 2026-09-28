import type { CSSProperties } from 'react';
import type { ColorOf } from '../players';
import { Avatar } from './Avatar';

export type Award = {
  id: string;
  icon: string;
  title: string;
  playerId: string;
  name: string;
  detail: string;
};

/** A row of three cards, faded in once `shown` — always laid out, so nothing below jumps. */
export function Awards({
  awards,
  youId,
  colorOf,
  shown,
  label,
}: {
  awards: Award[];
  youId: string;
  colorOf: ColorOf;
  shown: boolean;
  label: string;
}) {
  if (awards.length === 0) return null;
  return (
    <ul className={`awards${shown ? ' is-shown' : ''}`} aria-label={label}>
      {awards.map((award, i) => (
        <li
          key={award.id}
          className={`award${award.playerId === youId ? ' award--you' : ''}`}
          style={{ '--i': i } as CSSProperties}
        >
          <span className="award__title">
            <span aria-hidden>{award.icon}</span> {award.title}
          </span>
          <span className="award__who">
            <Avatar name={award.name} color={colorOf(award.playerId)} size="sm" />
            <span className="award__name">{award.name}</span>
          </span>
          <span className="award__detail">{award.detail}</span>
        </li>
      ))}
    </ul>
  );
}
