import { CiCheck, CiState, CiStatus } from './types';

// Worst first: one failing check makes the whole commit "failure".
const RANK: CiState[] = ['failure', 'pending', 'cancelled', 'success', 'neutral', 'skipped'];

export function rollup(states: CiState[]): CiState {
  if (!states.length) return 'neutral';
  return states.reduce((worst, s) => (RANK.indexOf(s) < RANK.indexOf(worst) ? s : worst), 'skipped' as CiState);
}

export function toStatus(checks: CiCheck[]): CiStatus {
  return { state: rollup(checks.map(c => c.state)), checks };
}
