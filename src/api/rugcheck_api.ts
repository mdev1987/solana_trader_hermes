export interface RugCheckResult {
  mint: string;
  isMintAbandoned: boolean;
  isBlockAddress: boolean;
  score: number;
  risks: string[];
}

export async function checkRug(mint: string): Promise<RugCheckResult> {
  return {
    mint,
    isMintAbandoned: false,
    isBlockAddress: false,
    score: 0,
    risks: [],
  };
}
