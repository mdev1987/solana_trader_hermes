export interface Transfer {
  from: string;
  to: string;
  amount: number;
  isSolana: boolean;
  mint: string;
  programsUsed: string[];
}

export type ReplayEvent = {
  action: string;
  signature: string;
  timestamp: number;
  localTimestamp?: number;
  mint?: string;
  poolId?: string;
  quoteMint?: string;
  txSigner?: string;
  tokenAmount?: number;
  quoteAmount?: number;
  initialBuy?: number;
  transfers?: Transfer[];
  postBalances?: Record<string, { sol?: number; tokens?: Record<string, number> }>;
  priorityFee?: number;
  block?: number;
  tokensInPool?: number;
  creatorFeeAddress?: string;
  feeMint?: string;
  feeAmount?: number;
};

export interface ReplayHour {
  year: number;
  month: number;
  day: number;
  hour: number;
}
