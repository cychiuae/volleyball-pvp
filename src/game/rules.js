// Volleyball rules helpers: sides, bounds, scoring.
import { BALL, COURT, RULES } from '../config.js';

/** Sign of z for a team's half (team 0 -> +1, team 1 -> -1). */
export const side = (team) => (team === 0 ? 1 : -1);
/** Team whose half contains z. */
export const teamOfZ = (z) => (z >= 0 ? 0 : 1);
export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/** Lines are in: the ball counts as in if any part of it touches the court (radius tolerance). */
export function isInBounds(x, z) {
  return Math.abs(x) <= COURT.halfWidth + BALL.radius && Math.abs(z) <= COURT.halfLength + BALL.radius;
}

/** Clearly out (used by the AI to leave balls alone). */
export function isClearlyOut(x, z, margin = 0.35) {
  return Math.abs(x) > COURT.halfWidth + BALL.radius + margin ||
    Math.abs(z) > COURT.halfLength + BALL.radius + margin;
}

/** Winning team index, or -1 while the match is still going (first to 15, win by 2). */
export function matchWinner(score) {
  const [a, b] = score;
  if (a >= RULES.pointsToWin && a - b >= RULES.winBy) return 0;
  if (b >= RULES.pointsToWin && b - a >= RULES.winBy) return 1;
  return -1;
}

/**
 * Decide a rally that ended with the ball touching the sand.
 * @returns {{ winnerTeam: 0|1, reason: string }}
 */
export function judgeLanding({ x, z, lastTeam, netSinceTouch, serveUntouched, servingTeam }) {
  const landTeam = teamOfZ(z);
  let loser;
  let reason;
  if (isInBounds(x, z)) { loser = landTeam; reason = 'in'; }
  else { loser = lastTeam ?? landTeam; reason = 'out'; }
  if (serveUntouched && loser === servingTeam) reason = 'serveFault';
  else if (netSinceTouch && loser === lastTeam && landTeam === lastTeam) reason = 'net';
  return { winnerTeam: 1 - loser, reason };
}
