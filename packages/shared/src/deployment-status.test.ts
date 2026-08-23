import { describe, it, expect } from 'vitest';
import {
  canTransition,
  assertTransition,
  isActive,
  isServing,
  InvalidTransitionError,
} from './deployment-status.js';

describe('deployment state machine', () => {
  it('allows the happy path', () => {
    const path = ['QUEUED', 'CLONING', 'BUILDING', 'STARTING', 'HEALTH_CHECKING', 'RUNNING'] as const;
    for (let i = 0; i < path.length - 1; i++) {
      expect(canTransition(path[i]!, path[i + 1]!)).toBe(true);
    }
  });

  it('rejects skipping stages', () => {
    expect(canTransition('QUEUED', 'RUNNING')).toBe(false);
    expect(canTransition('QUEUED', 'BUILDING')).toBe(false);
    expect(canTransition('BUILDING', 'RUNNING')).toBe(false);
    expect(canTransition('HEALTH_CHECKING', 'BUILDING')).toBe(false);
  });

  it('rejects resurrection from terminal states', () => {
    for (const to of ['QUEUED', 'CLONING', 'BUILDING', 'STARTING', 'HEALTH_CHECKING', 'RUNNING'] as const) {
      expect(canTransition('FAILED', to)).toBe(false);
      expect(canTransition('STOPPED', to)).toBe(false);
    }
  });

  it('allows failure from any active/serving state', () => {
    for (const from of ['QUEUED', 'CLONING', 'BUILDING', 'STARTING', 'HEALTH_CHECKING', 'RUNNING'] as const) {
      expect(canTransition(from, 'FAILED')).toBe(true);
    }
  });

  it('allows stop from serving/late states only', () => {
    expect(canTransition('RUNNING', 'STOPPED')).toBe(true);
    expect(canTransition('HEALTH_CHECKING', 'STOPPED')).toBe(true);
    expect(canTransition('BUILDING', 'STOPPED')).toBe(false);
  });

  it('assertTransition throws typed error on invalid moves', () => {
    expect(() => assertTransition('FAILED', 'RUNNING')).toThrow(InvalidTransitionError);
    expect(() => assertTransition('RUNNING', 'STOPPED')).not.toThrow();
  });

  it('classifies activity', () => {
    expect(isActive('BUILDING')).toBe(true);
    expect(isActive('RUNNING')).toBe(false);
    expect(isServing('RUNNING')).toBe(true);
    expect(isServing('STOPPED')).toBe(false);
  });
});
