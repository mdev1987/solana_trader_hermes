"""Feature builder, scorer, filters, and strategy — Python port of the TS trading engine."""

import config as cfg
from dataclasses import dataclass, field


@dataclass
class FeatureSnapshot:
    mint: str
    timestamp: int
    rank_score: float = 0
    signal_count: int = 0
    wallet_count: int = 0
    trade_volume: float = 0
    liquidity: float = 0
    holders: int = 0
    activity_score: float = 0
    smart_wallets: int = 0
    buy_ratio: float = 0
    time_since_launch_ms: int = 0


@dataclass
class TradeResult:
    id: str
    mint: str
    entry_price: float
    exit_price: float
    max_price: float
    min_price: float
    quantity: float
    entry_time: int
    exit_time: int
    entry_delay_ms: int
    signal_age_ms: int
    decision_price: float
    entry_score: float
    pnl: float
    pnl_percent: float
    exit_reason: str
    fees: float
    features: str | None = None


# ── Feature Builder ──────────────────────────────────────────────────────────

class MintState:
    __slots__ = ('first_seen', 'last_seen', 'event_count', 'buy_count',
                 'sell_count', 'volume_total', 'wallets',
                 'highest_quote_amount', 'last_quote_amount', 'last_token_amount')
    def __init__(self):
        self.first_seen: int = 0
        self.last_seen: int = 0
        self.event_count: int = 0
        self.buy_count: int = 0
        self.sell_count: int = 0
        self.volume_total: float = 0
        self.wallets: set[str] = set()
        self.highest_quote_amount: float = 0
        self.last_quote_amount: float = 0
        self.last_token_amount: float = 0


class FeatureBuilder:
    def __init__(self):
        self._state: dict[str, MintState] = {}

    def _get(self, mint: str) -> MintState:
        s = self._state.get(mint)
        if s is None:
            s = MintState()
            self._state[mint] = s
        return s

    def from_replay_event(self, event: dict) -> FeatureSnapshot | None:
        mint = event.get('mint')
        if not mint or not mint.endswith('pump'):
            return None
        action = event.get('action')
        if action not in ('buy', 'sell', 'create'):
            return None

        s = self._get(mint)
        timestamp = event['timestamp']

        if s.event_count == 0:
            s.first_seen = timestamp
        s.last_seen = timestamp
        s.event_count += 1

        if action == 'buy':
            s.buy_count += 1
        elif action == 'sell':
            s.sell_count += 1

        tx_signer = event.get('txSigner')
        if tx_signer:
            s.wallets.add(tx_signer)

        if action in ('buy', 'sell'):
            qa = event.get('quoteAmount') or 0
            s.volume_total += qa
            if qa > s.highest_quote_amount:
                s.highest_quote_amount = qa
            s.last_quote_amount = qa
            s.last_token_amount = event.get('tokenAmount') or 0

        if action == 'create':
            qa = event.get('quoteAmount') or 0
            s.volume_total += qa
            s.buy_count += 1
            s.last_quote_amount = qa
            s.last_token_amount = event.get('initialBuy') or 0

        time_span = max(s.last_seen - s.first_seen, 1)
        events_per_min = s.event_count / (time_span / 60000)
        activity_score = min(events_per_min / 100, 1)
        wallet_count = len(s.wallets)
        buy_ratio = s.buy_count / s.event_count if s.event_count > 0 else 0
        time_since_launch_ms = timestamp - s.first_seen

        return FeatureSnapshot(
            mint=mint,
            timestamp=timestamp,
            signal_count=s.event_count,
            wallet_count=wallet_count,
            trade_volume=s.volume_total,
            liquidity=s.volume_total,
            holders=wallet_count,
            activity_score=activity_score,
            buy_ratio=buy_ratio,
            time_since_launch_ms=time_since_launch_ms,
        )


# ── Scorer (v4) ──────────────────────────────────────────────────────────────

class Scorer:
    def score(self, snap: FeatureSnapshot) -> float:
        w = self._wallet_score(snap.wallet_count)
        s = self._signal_age_score(snap.time_since_launch_ms)
        l = self._liquidity_score(snap.liquidity)
        return (w * cfg.WALLET_WEIGHT + s * cfg.SIGNAL_AGE_WEIGHT + l * cfg.LIQUIDITY_WEIGHT) * 100

    def _wallet_score(self, wallets: int) -> float:
        if wallets < 20: return 0
        if wallets < 100: return (wallets - 20) / 80 * 0.3
        if wallets < 200: return 0.3 + (wallets - 100) / 100 * 0.1
        if wallets < 400: return 0.4 + (wallets - 200) / 200 * 0.2
        if wallets <= 800: return 0.6 + (wallets - 400) / 400 * 0.2
        if wallets <= 2000: return 0.8 + (wallets - 800) / 1200 * 0.2
        if wallets <= 5000: return 1 - (wallets - 2000) / 3000 * 0.4
        return 0.6

    def _liquidity_score(self, liq: float) -> float:
        if liq < 10: return 0
        if liq < 500: return (liq - 10) / 490
        if liq <= 900: return 1
        if liq <= 2000: return 1 - (liq - 900) / 1100
        return 0

    def _signal_age_score(self, ms: int) -> float:
        if ms < 5_000: return 0
        if ms < 12_000: return (ms - 5_000) / 7_000 * 0.4
        if ms < 18_000: return 0.4 + (ms - 12_000) / 6_000 * 0.3
        if ms <= 30_000: return 0.7 + (ms - 18_000) / 12_000 * 0.3
        if ms <= 60_000: return 1 - (ms - 30_000) / 30_000 * 0.6
        return 0.4


# ── Filters ──────────────────────────────────────────────────────────────────

class Filters:
    def passes(self, snap: FeatureSnapshot) -> str | None:
        if snap.time_since_launch_ms < cfg.MIN_SIGNAL_AGE_MS:
            return 'too_early'
        if snap.wallet_count < cfg.MIN_WALLET_COUNT:
            return 'wallets_below_min'
        if snap.liquidity < cfg.MIN_LIQUIDITY:
            return 'liquidity_below_min'
        if snap.liquidity > cfg.MAX_LIQUIDITY:
            return 'liquidity_above_max'
        if snap.time_since_launch_ms > cfg.MAX_SIGNAL_AGE_MS:
            return 'signal_too_old'
        if snap.wallet_count > cfg.MAX_WALLETS:
            return 'wallets_above_max'
        if snap.buy_ratio < cfg.MIN_BUY_RATIO:
            return 'buy_ratio_too_low'
        return None


# ── Strategy ──────────────────────────────────────────────────────────────────

class Strategy:
    def __init__(self):
        self.scorer = Scorer()
        self.filters = Filters()

    def evaluate(self, snap: FeatureSnapshot) -> tuple[str, float, str]:
        reason = self.filters.passes(snap)
        if reason:
            return ('SKIP', 0, reason)

        score = self.scorer.score(snap)
        if score >= cfg.HIGH_SCORE_THRESHOLD and snap.wallet_count < cfg.HIGH_SCORE_WALLET_FLOOR:
            return ('SKIP', score, 'high_score_low_wallets')
        if score < cfg.MIN_SCORE:
            return ('SKIP', score, 'below_min_score')

        return ('BUY', score, '')
