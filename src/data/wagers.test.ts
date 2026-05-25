import { describe, expect, it } from 'vitest';
import { computePayout, type PayoutInput } from './wagers.js';

const p = (uid: string, optionId: string, stake: number, stakedAtMs: number): PayoutInput => ({
  uid,
  optionId,
  stake,
  stakedAt: new Date(stakedAtMs),
});

describe('computePayout — FR-07 / FR-15', () => {
  it('1v1 with equal stakes — winner takes the full pot, loser gets 0', () => {
    const res = computePayout(
      [p('alice', 'yes', 100, 1), p('bob', 'no', 100, 2)],
      'yes',
    );
    expect(res.voided).toBe(false);
    expect(res.payouts).toEqual({ alice: 200, bob: 0 });
    expect(sum(res.payouts)).toBe(res.totalPot);
  });

  it('1v1 with asymmetric stakes — winner gets stake + entire loser stake', () => {
    const res = computePayout(
      [p('alice', 'yes', 50, 1), p('bob', 'no', 300, 2)],
      'yes',
    );
    expect(res.payouts).toEqual({ alice: 350, bob: 0 });
    expect(sum(res.payouts)).toBe(350);
  });

  it('multi-winner side, equal stakes — pot splits evenly', () => {
    const res = computePayout(
      [
        p('alice', 'yes', 100, 1),
        p('bob', 'yes', 100, 2),
        p('carol', 'no', 200, 3),
      ],
      'yes',
    );
    // loserPool=200, winnerTotal=200, each winner gets stake + (100/200)*200 = 100+100 = 200
    expect(res.payouts).toEqual({ alice: 200, bob: 200, carol: 0 });
  });

  it('multi-winner side, proportional stakes — pot splits by stake share', () => {
    const res = computePayout(
      [
        p('alice', 'yes', 30, 1),
        p('bob', 'yes', 70, 2),
        p('carol', 'no', 100, 3),
      ],
      'yes',
    );
    // loserPool=100, winnerTotal=100.
    // alice share = floor(30*100/100) = 30 → payout 60
    // bob share = floor(70*100/100) = 70 → payout 140
    expect(res.payouts).toEqual({ alice: 60, bob: 140, carol: 0 });
    expect(sum(res.payouts)).toBe(200);
  });

  it('rounding remainder goes to the largest-stake winner', () => {
    const res = computePayout(
      [
        p('alice', 'yes', 1, 1),
        p('bob', 'yes', 3, 2),
        p('carol', 'no', 10, 3),
      ],
      'yes',
    );
    // loserPool=10, winnerTotal=4
    // alice share = floor(1*10/4) = 2 → payout 1+2 = 3
    // bob share = floor(3*10/4) = 7 → payout 3+7 = 10
    // distributed = 9, remainder = 1
    // remainder goes to bob (larger stake) → bob payout becomes 11
    expect(res.payouts).toEqual({ alice: 3, bob: 11, carol: 0 });
    expect(sum(res.payouts)).toBe(14);
  });

  it('rounding remainder ties broken by earliest stakedAt', () => {
    const res = computePayout(
      [
        p('alice', 'yes', 5, 1), // earlier
        p('bob', 'yes', 5, 2),
        p('carol', 'no', 3, 3),
      ],
      'yes',
    );
    // loserPool=3, winnerTotal=10
    // alice share = floor(5*3/10) = 1 → payout 6
    // bob share = floor(5*3/10) = 1 → payout 6
    // distributed = 2, remainder = 1 → goes to alice (earliest)
    expect(res.payouts.alice).toBe(7);
    expect(res.payouts.bob).toBe(6);
    expect(sum(res.payouts)).toBe(13);
  });

  it('multi-option wager — pays only the winning option backers', () => {
    const res = computePayout(
      [
        p('alice', 'A', 50, 1),
        p('bob', 'B', 100, 2),
        p('carol', 'C', 150, 3),
        p('dan', 'A', 50, 4),
      ],
      'A',
    );
    // winners on A: alice (50) + dan (50) = 100 total
    // losers: bob+carol = 250
    // alice share = floor(50*250/100) = 125 → payout 175
    // dan share = floor(50*250/100) = 125 → payout 175
    // distributed = 250, no remainder
    expect(res.payouts).toEqual({ alice: 175, bob: 0, carol: 0, dan: 175 });
    expect(sum(res.payouts)).toBe(350);
  });

  it('all participants on the winning option — no losers, everyone gets stake back', () => {
    const res = computePayout(
      [
        p('alice', 'yes', 50, 1),
        p('bob', 'yes', 100, 2),
      ],
      'yes',
    );
    // loserPool = 0, winnerTotal = 150
    // each winner share = floor(stake * 0 / 150) = 0
    // payouts = just stake back
    expect(res.payouts).toEqual({ alice: 50, bob: 100 });
    expect(res.voided).toBe(false);
  });

  it('winning option has zero backers (admin override) — voids, refunds everyone', () => {
    const res = computePayout(
      [
        p('alice', 'A', 100, 1),
        p('bob', 'B', 200, 2),
      ],
      'C', // unbacked
    );
    expect(res.voided).toBe(true);
    expect(res.payouts).toEqual({ alice: 100, bob: 200 });
  });

  it('preserves the conservation invariant across many random shapes', () => {
    const cases: PayoutInput[][] = [
      [p('a', 'x', 1, 1), p('b', 'y', 1, 2)],
      [p('a', 'x', 7, 1), p('b', 'x', 13, 2), p('c', 'y', 11, 3), p('d', 'y', 17, 4)],
      [p('a', 'x', 3, 1), p('b', 'y', 7, 2), p('c', 'z', 11, 3)],
      [p('a', 'x', 100, 1), p('b', 'x', 200, 2), p('c', 'x', 300, 3), p('d', 'y', 1, 4)],
    ];
    for (const participants of cases) {
      for (const optionId of new Set(participants.map(x => x.optionId))) {
        const res = computePayout(participants, optionId);
        const totalStake = participants.reduce((s, x) => s + x.stake, 0);
        expect(sum(res.payouts)).toBe(totalStake);
      }
    }
  });

  it('a winner with a 0-stake share-of-pot still gets their original stake back', () => {
    // Edge case: tiny winning stake, huge loser pool — floor may give 0 share but stake is preserved.
    const res = computePayout(
      [
        p('alice', 'yes', 1, 1),
        p('bob', 'yes', 1_000_000, 2),
        p('carol', 'no', 3, 3),
      ],
      'yes',
    );
    // winnerTotal = 1_000_001, loserPool = 3
    // alice share = floor(1*3/1_000_001) = 0 → payout 1
    // bob share = floor(1_000_000*3/1_000_001) = 2 → payout 1_000_002
    // distributed = 2, remainder = 1 → goes to bob (larger stake) → 1_000_003
    expect(res.payouts.alice).toBe(1);
    expect(res.payouts.bob).toBe(1_000_003);
    expect(res.payouts.carol).toBe(0);
    expect(sum(res.payouts)).toBe(1_000_004);
  });
});

const sum = (payouts: Record<string, number>): number =>
  Object.values(payouts).reduce((s, n) => s + n, 0);
