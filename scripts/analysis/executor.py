"""Position management and paper executor — Python port of TS PositionManager + PaperExecutor."""

import config as cfg
from engine import FeatureSnapshot, TradeResult
import hashlib
import uuid


# ── Position Manager ─────────────────────────────────────────────────────────

class OpenPosition:
    __slots__ = ('id', 'mint', 'entry_price', 'quantity', 'entry_time',
                 'highest_price', 'lowest_price', 'entry_delay_ms',
                 'signal_age_ms', 'decision_price', 'entry_score',
                 'stop_loss', 'take_profit', 'ttl', 'trailing_stop_activated',
                 'price_history')
    def __init__(self, id: str, mint: str, entry_price: float, quantity: float,
                 entry_time: int, entry_delay_ms: int, signal_age_ms: int,
                 decision_price: float, entry_score: float,
                 stop_loss: float, take_profit: float, ttl: int):
        self.id = id
        self.mint = mint
        self.entry_price = entry_price
        self.quantity = quantity
        self.entry_time = entry_time
        self.highest_price = entry_price
        self.lowest_price = entry_price
        self.entry_delay_ms = entry_delay_ms
        self.signal_age_ms = signal_age_ms
        self.decision_price = decision_price
        self.entry_score = entry_score
        self.stop_loss = stop_loss
        self.take_profit = take_profit
        self.ttl = ttl
        self.trailing_stop_activated = False
        self.price_history: list[tuple[int, float]] = [(entry_time, entry_price)]


class PositionManager:
    def calc_stop_loss(self, entry_price: float) -> float:
        return entry_price * (1 + cfg.STOP_LOSS_PERCENT)

    def calc_take_profit(self, entry_price: float) -> float:
        return entry_price * (1 + cfg.TAKE_PROFIT_PERCENT)

    def check_exit(self, pos: OpenPosition, current_price: float, timestamp: int) -> str | None:
        if current_price > pos.highest_price:
            pos.highest_price = current_price
        if current_price < pos.lowest_price:
            pos.lowest_price = current_price

        # Break-even: if price reached activate% above entry, move SL to entry
        be_threshold = pos.entry_price * (1 + cfg.BREAK_EVEN_ACTIVATE)
        if pos.highest_price >= be_threshold and pos.stop_loss < pos.entry_price:
            pos.stop_loss = pos.entry_price * 0.995

        if current_price <= pos.stop_loss:
            return 'sl'
        if current_price >= pos.take_profit:
            return 'tp'
        if timestamp >= pos.ttl:
            return 'ttl'

        hold_ms = timestamp - pos.entry_time
        if hold_ms >= cfg.MAX_DEAD_HOLD_MS and pos.highest_price <= pos.entry_price:
            return 'dead'

        # Trailing stop
        if not pos.trailing_stop_activated:
            activate_price = pos.entry_price * (1 + cfg.TRAILING_STOP_ACTIVATE)
            if current_price >= activate_price:
                pos.trailing_stop_activated = True

        if pos.trailing_stop_activated:
            trail_distance = cfg.TRAILING_STOP_DISTANCE
            trail_stop = pos.highest_price * (1 - trail_distance)
            if current_price <= trail_stop:
                return 'trailing'

        return None


# ── Paper Executor ───────────────────────────────────────────────────────────

class PaperExecutor:
    def __init__(self, balance: float, sol_amount: float):
        self.balance = balance
        self.sol_amount = sol_amount
        self._positions: dict[str, OpenPosition] = {}
        self._trades: list[TradeResult] = []
        self._recently_sold: dict[str, int] = {}
        self._position_manager = PositionManager()

    def get_positions(self) -> dict[str, OpenPosition]:
        return self._positions

    def get_trades(self) -> list[TradeResult]:
        return self._trades

    def get_position_count(self) -> int:
        return len(self._positions)

    def open_position(self, snap: FeatureSnapshot, price: float,
                      entry_delay_ms: int, signal_age_ms: int,
                      decision_price: float, entry_score: float) -> OpenPosition | None:
        if price <= 0:
            return None
        if snap.mint in self._positions:
            return None
        if len(self._positions) >= cfg.MAX_POSITIONS:
            return None
        sold_at = self._recently_sold.get(snap.mint)
        if sold_at and snap.timestamp - sold_at < cfg.COOLDOWN_MS:
            return None

        quantity = self.sol_amount / price
        stop_loss = self._position_manager.calc_stop_loss(price)
        take_profit = self._position_manager.calc_take_profit(price)
        ttl = snap.timestamp + cfg.POSITION_TTL_MS
        trade_id = hashlib.md5(f"{snap.mint}{snap.timestamp}{price}".encode()).hexdigest()[:16]

        pos = OpenPosition(
            id=trade_id,
            mint=snap.mint,
            entry_price=price,
            quantity=quantity,
            entry_time=snap.timestamp,
            entry_delay_ms=entry_delay_ms,
            signal_age_ms=signal_age_ms,
            decision_price=decision_price,
            entry_score=entry_score,
            stop_loss=stop_loss,
            take_profit=take_profit,
            ttl=ttl,
        )
        self._positions[snap.mint] = pos
        return pos

    def update_positions(self, prices: dict[str, float], timestamp: int) -> list[TradeResult]:
        exited: list[TradeResult] = []
        for mint, pos in list(self._positions.items()):
            price = prices.get(mint)
            if price is None or price <= 0:
                continue
            pos.price_history.append((timestamp, price))
            exit_reason = self._position_manager.check_exit(pos, price, timestamp)
            if exit_reason:
                self._positions.pop(mint)
                pnl = (price - pos.entry_price) * pos.quantity
                pnl_pct = (price - pos.entry_price) / pos.entry_price
                import json
                trade = TradeResult(
                    id=pos.id,
                    mint=pos.mint,
                    entry_price=pos.entry_price,
                    exit_price=price,
                    max_price=pos.highest_price,
                    min_price=pos.lowest_price,
                    quantity=pos.quantity,
                    entry_time=pos.entry_time,
                    exit_time=timestamp,
                    entry_delay_ms=pos.entry_delay_ms,
                    signal_age_ms=pos.signal_age_ms,
                    decision_price=pos.decision_price,
                    entry_score=pos.entry_score,
                    pnl=pnl,
                    pnl_percent=pnl_pct,
                    exit_reason=exit_reason,
                    fees=0,
                    price_path=json.dumps(pos.price_history),
                )
                self._trades.append(trade)
                self._recently_sold[mint] = timestamp
                exited.append(trade)
        return exited
