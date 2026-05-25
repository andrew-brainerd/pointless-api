import { ObjectId, type Collection, type WithId } from 'mongodb';
import { getDb } from '../db/mongo.js';

export type WagerStatus =
  | 'proposed'
  | 'active'
  | 'pending_confirmation'
  | 'disputed'
  | 'settled'
  | 'voided';

export type VoidReason =
  | 'cancelled'
  | 'all_one_option'
  | 'admin_void'
  | 'last_member_left'
  | 'pool_deleted';

export interface WagerOption {
  id: string;
  label: string;
}

export interface WagerParticipant {
  uid: string;
  optionId: string;
  stake: number;
  stakedAt: Date;
}

export interface WagerResolution {
  proposedBy: string;
  proposedAt: Date;
  optionId: string;
  confirmations: string[];
  disputes: string[];
}

export interface WagerDoc {
  _id: ObjectId;
  poolId: ObjectId;
  createdBy: string;
  createdAt: Date;
  description: string;
  options: WagerOption[];
  closeBy: Date | null;
  status: WagerStatus;
  participants: WagerParticipant[];
  invitedUids: string[];
  declinedUids: string[];
  resolution: WagerResolution | null;
  settledAt: Date | null;
  settledOptionId: string | null;
  voidedAt: Date | null;
  voidReason: VoidReason | null;
}

export const wagersCollection = async (): Promise<Collection<WagerDoc>> => {
  const db = await getDb();
  return db.collection<WagerDoc>('wagers');
};

// ---------------------------------------------------------------------------
// Proportional payout calculator (FR-07 + FR-15).
//
// Pure function — no DB calls. Tested in isolation in wagers.test.ts.
// Conservation invariant: sum of returned payouts === sum of all participant
// stakes (i.e. the full pot is conserved, modulo void).
// ---------------------------------------------------------------------------

export interface PayoutInput {
  uid: string;
  optionId: string;
  stake: number;
  stakedAt: Date;
}

export interface PayoutResult {
  // Map from uid -> credit to apply to the participant's `balance` (the
  // amount returned to their wallet; their `pending` always goes to 0).
  payouts: Record<string, number>;
  loserPool: number;
  winnerTotal: number;
  totalPot: number;
  // True if the winning option had no backers — wager voids and all stakes
  // are refunded. Cannot arise from creator-proposes path (creator's option
  // always has at least one backer); only via admin-override on dispute.
  voided: boolean;
}

export const computePayout = (
  participants: ReadonlyArray<PayoutInput>,
  winningOptionId: string,
): PayoutResult => {
  const winners = participants.filter(p => p.optionId === winningOptionId);
  const losers = participants.filter(p => p.optionId !== winningOptionId);
  const winnerTotal = winners.reduce((s, p) => s + p.stake, 0);
  const loserPool = losers.reduce((s, p) => s + p.stake, 0);
  const totalPot = winnerTotal + loserPool;

  const payouts: Record<string, number> = {};

  if (winnerTotal === 0) {
    // Winning option had no backers → void, refund everyone their stake.
    for (const p of participants) payouts[p.uid] = p.stake;
    return { payouts, loserPool, winnerTotal, totalPot, voided: true };
  }

  // Losers forfeit their stake.
  for (const l of losers) payouts[l.uid] = 0;

  // Winners: stake + floor((stake / winnerTotal) * loserPool).
  // Track distributedShare to compute the rounding remainder.
  let distributedShare = 0;
  const winnerShares = winners.map(w => {
    const share = Math.floor((w.stake * loserPool) / winnerTotal);
    distributedShare += share;
    return { uid: w.uid, stake: w.stake, stakedAt: w.stakedAt, share };
  });

  const remainder = loserPool - distributedShare;

  // FR-15: rounding remainder goes to the winner with the largest stake
  // (ties broken by earliest stake timestamp).
  if (remainder > 0) {
    const top = [...winnerShares].sort((a, b) => {
      if (b.stake !== a.stake) return b.stake - a.stake;
      return a.stakedAt.getTime() - b.stakedAt.getTime();
    })[0]!;
    top.share += remainder;
  }

  for (const w of winnerShares) payouts[w.uid] = w.stake + w.share;

  return { payouts, loserPool, winnerTotal, totalPot, voided: false };
};

// ---------------------------------------------------------------------------
// Basic CRUD (read-only + create). Transactional state changes (stake,
// settle, void) live in routes/wagers.ts where they're wrapped in
// Mongo transactions.
// ---------------------------------------------------------------------------

export interface CreateWagerInput {
  poolId: ObjectId;
  createdBy: string;
  description: string;
  options: WagerOption[];
  closeBy: Date | null;
  invitedUids: string[];
  creatorStake: { optionId: string; amount: number };
}

export const buildWagerDoc = (input: CreateWagerInput): WagerDoc => {
  const now = new Date();
  return {
    _id: new ObjectId(),
    poolId: input.poolId,
    createdBy: input.createdBy,
    createdAt: now,
    description: input.description,
    options: input.options,
    closeBy: input.closeBy,
    status: 'proposed',
    participants: [
      {
        uid: input.createdBy,
        optionId: input.creatorStake.optionId,
        stake: input.creatorStake.amount,
        stakedAt: now,
      },
    ],
    invitedUids: input.invitedUids.filter(u => u !== input.createdBy),
    declinedUids: [],
    resolution: null,
    settledAt: null,
    settledOptionId: null,
    voidedAt: null,
    voidReason: null,
  };
};

export const getWager = async (id: ObjectId): Promise<WagerDoc | null> => {
  const col = await wagersCollection();
  return col.findOne({ _id: id });
};

export const listWagersForPool = async (
  poolId: ObjectId,
  status?: WagerStatus,
): Promise<WithId<WagerDoc>[]> => {
  const col = await wagersCollection();
  const filter: Record<string, unknown> = { poolId };
  if (status) filter.status = status;
  return col.find(filter).sort({ createdAt: -1 }).toArray();
};

// Status helper for routes deciding whether a wager flips `proposed -> active`
// after a new stake. A wager is `active` once at least two distinct options
// have at least one backer.
export const computeStatusAfterStake = (wager: WagerDoc): WagerStatus => {
  if (wager.status !== 'proposed') return wager.status;
  const optionsWithBackers = new Set(wager.participants.map(p => p.optionId));
  return optionsWithBackers.size >= 2 ? 'active' : 'proposed';
};
