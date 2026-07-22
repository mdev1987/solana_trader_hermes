"""Download .zst replay files from pumpapi.io, decompress, and run the trading engine."""

import config as cfg
from engine import FeatureBuilder, TradeResult
from executor import PaperExecutor, OpenPosition

import json
import os
import struct
import urllib.request
import zstandard as zstd
from datetime import datetime, timezone, timedelta
from pathlib import Path


def get_recent_hours(count: int) -> list[dict]:
    now = datetime.now(timezone.utc)
    hours = []
    for i in range(count):
        dt = now - timedelta(hours=i)
        hours.append({'year': dt.year, 'month': dt.month, 'day': dt.day, 'hour': dt.hour})
    return hours


def build_url(h: dict) -> str:
    return f"{cfg.REPLAY_BASE_URL}/{h['year']}/{h['month']:02d}/{h['day']:02d}/{h['hour']:02d}.jsonl.zst"


def cache_path(h: dict) -> Path:
    return Path(cfg.DATA_DIR) / f"{h['year']}-{h['month']:02d}-{h['day']:02d}-{h['hour']:02d}.jsonl.zst"


def download_file(url: str, dest: Path) -> bool:
    if dest.exists():
        size_mb = dest.stat().st_size / 1_048_576
        print(f"  cached ({size_mb:.1f} MB)")
        return True
    print(f"  downloading {url} ...")
    try:
        req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
        with urllib.request.urlopen(req, timeout=300) as resp:
            total = int(resp.headers.get('content-length', 0))
            received = 0
            with open(dest, 'wb') as f:
                while True:
                    chunk = resp.read(65536)
                    if not chunk:
                        break
                    f.write(chunk)
                    received += len(chunk)
                    if total:
                        pct = int(received / total * 100)
                        bar = '█' * (pct // 5) + '░' * (20 - pct // 5)
                        print(f"\r  [{bar}] {pct}% ({received/1_048_576:.1f}MB / {total/1_048_576:.1f}MB)", end='')
            print()
        return True
    except Exception as e:
        print(f"  FAILED: {e}")
        if dest.exists():
            dest.unlink()
        return False


def stream_events(file_path: Path):
    """Yield parsed JSON events from a .zst file."""
    with open(file_path, 'rb') as f:
        dctx = zstd.ZstdDecompressor()
        reader = dctx.stream_reader(f)
        buffer = b''
        while True:
            chunk = reader.read(65536)
            if not chunk:
                break
            buffer += chunk
            while True:
                idx = buffer.find(b'\n')
                if idx == -1:
                    break
                line = buffer[:idx].strip()
                buffer = buffer[idx + 1:]
                if line:
                    try:
                        yield json.loads(line)
                    except json.JSONDecodeError:
                        pass
        if buffer.strip():
            try:
                yield json.loads(buffer.strip())
            except json.JSONDecodeError:
                pass


def count_lines(file_path: Path) -> int:
    """Fast line count of decompressed content."""
    count = 0
    with open(file_path, 'rb') as f:
        dctx = zstd.ZstdDecompressor()
        reader = dctx.stream_reader(f)
        while True:
            chunk = reader.read(65536)
            if not chunk:
                break
            count += chunk.count(b'\n')
    return count


class ReplayRunner:
    """Orchestrates download + replay for a set of hours."""

    def __init__(self, sol_balance: float = 10.0, sol_amount: float = 0.01):
        self.feature_builder = FeatureBuilder()
        self.executor = PaperExecutor(balance=sol_balance, sol_amount=sol_amount)
        self._pending_buys: list[dict] = []
        self._recently_sold: dict[str, int] = {}
        self._last_prices: dict[str, float] = {}
        self._event_count = 0
        self._rejected: list[dict] = []

    def get_result(self) -> dict:
        return {
            'trades': self.executor.get_trades(),
            'event_count': self._event_count,
            'rejected': self._rejected,
        }

    def _try_fill_pending_buy(self, event: dict) -> bool:
        filled = False
        i = 0
        while i < len(self._pending_buys):
            pb = self._pending_buys[i]
            if pb['mint'] != event.get('mint'):
                i += 1
                continue

            token_amount = event.get('tokenAmount') or event.get('initialBuy') or 0
            price = (event.get('quoteAmount') or 0) / token_amount if token_amount else 0
            timestamp = event['timestamp']

            if timestamp < pb['execute_at']:
                i += 1
                continue

            window_end = pb['execute_at'] + cfg.FILL_WINDOW_MS
            if timestamp >= window_end:
                self._pending_buys.pop(i)
                continue

            self._pending_buys.pop(i)

            if price <= 0:
                continue

            pos = self.executor.open_position(
                snap=pb['snapshot'],
                price=price,
                entry_delay_ms=timestamp - (pb['execute_at'] - cfg.EXECUTION_DELAY_MS),
                signal_age_ms=pb['snapshot'].time_since_launch_ms,
                decision_price=pb['decision_price'],
                entry_score=pb['score'],
            )
            if pos:
                filled = True
                age_sec = pb['snapshot'].time_since_launch_ms / 1000
                print(f"  [BUY] {pb['mint']} score={pb['score']:.1f} age={age_sec:.1f}s "
                      f"buyR={pb['snapshot'].buy_ratio:.2f} price={price:.4e}")
        return filled

    def _cleanup_expired(self, now: int):
        self._pending_buys = [pb for pb in self._pending_buys if pb['expires_at'] > now]

    def process_event(self, event: dict):
        mint = event.get('mint')
        if not mint or not mint.endswith('pump'):
            return
        action = event.get('action')
        if action not in ('buy', 'sell', 'create'):
            return

        token_amount = event.get('tokenAmount') or event.get('initialBuy') or 0
        price = (event.get('quoteAmount') or 0) / token_amount if token_amount else 0
        self._last_prices[mint] = price

        self._try_fill_pending_buy(event)
        self._cleanup_expired(event['timestamp'])

        if price <= 0:
            return

        snap = self.feature_builder.from_replay_event(event)
        if snap is None:
            return

        # Evaluate via strategy
        from engine import Strategy
        strategy = Strategy()
        decision, score, reason = strategy.evaluate(snap)

        if decision == 'BUY':
            if price < cfg.MIN_PRICE:
                return
            sold_at = self._recently_sold.get(mint)
            if sold_at and event['timestamp'] - sold_at < cfg.COOLDOWN_MS:
                return
            if any(pb['mint'] == mint for pb in self._pending_buys):
                return
            if self.executor.get_positions().get(mint):
                return
            if self.executor.get_position_count() + len(self._pending_buys) >= cfg.MAX_POSITIONS:
                return

            self._pending_buys.append({
                'mint': mint,
                'snapshot': snap,
                'score': score,
                'execute_at': event['timestamp'] + cfg.EXECUTION_DELAY_MS,
                'expires_at': event['timestamp'] + cfg.EXECUTION_DELAY_MS + cfg.PENDING_BUY_TIMEOUT_MS,
                'decision_price': price,
            })
        else:
            self._rejected.append({
                'mint': mint,
                'timestamp': event['timestamp'],
                'score': score,
                'reason': reason,
                'snapshot': snap,
                'price': price,
            })

        # Update positions with current price
        price_map = {mint: price}
        exited = self.executor.update_positions(price_map, event['timestamp'])
        for t in exited:
            hold_sec = (t.exit_time - t.entry_time) / 1000
            pnl_str = f"+${t.pnl:.4f}" if t.pnl >= 0 else f"-${abs(t.pnl):.4f}"
            roi_str = f"{t.pnl_percent * 100:.2f}%"
            print(f"  [SELL] {t.mint} pnl={pnl_str} ({roi_str}) reason={t.exit_reason} hold={hold_sec:.0f}s")

    def replay_file(self, file_path: Path) -> int:
        file_path = Path(file_path)
        if not file_path.exists():
            print(f"[runner] file not found: {file_path}")
            return 0

        print(f"[runner] {file_path.name}")
        total = count_lines(file_path)
        count = 0
        next_report = 10_000

        for event in stream_events(file_path):
            self.process_event(event)
            count += 1
            if count >= next_report:
                pct = count / total * 100 if total else 0
                print(f"  {count}/{total} ({pct:.1f}%)")
                next_report += 10_000

        print(f"  {count}/{total} (100%)")
        self._event_count += count
        return count

    def download_and_replay(self, hours: list[dict]) -> int:
        total_events = 0
        for h in hours:
            url = build_url(h)
            dest = cache_path(h)
            print(f"\n[{h['year']}-{h['month']:02d}-{h['day']:02d} {h['hour']:02d}:00]")
            ok = download_file(url, dest)
            if not ok:
                continue
            cnt = self.replay_file(dest)
            total_events += cnt
        return total_events

    def download_and_replay_recent(self, hours_count: int = 2):
        hours = get_recent_hours(hours_count)
        return self.download_and_replay(hours)

    def print_summary(self):
        trades = self.executor.get_trades()
        print(f"\n{'='*60}")
        print(f"Replay complete: {self._event_count} events, {len(trades)} trades")
        if not trades:
            return

        winners = [t for t in trades if t.pnl > 0]
        losers = [t for t in trades if t.pnl <= 0]
        wr = len(winners) / len(trades) * 100
        pnl = sum(t.pnl for t in trades)
        gross_win = sum(t.pnl for t in winners)
        gross_loss = abs(sum(t.pnl for t in losers))
        pf = gross_win / gross_loss if gross_loss > 0 else float('inf')

        print(f"  Win rate:  {wr:.1f}% ({len(winners)}/{len(trades)})")
        print(f"  Total PnL: ${pnl:.4f}")
        print(f"  PF:        {pf:.2f}")
        print(f"  Avg win:   ${(gross_win/len(winners)):.4f}" if winners else "")
        print(f"  Avg loss:  ${(gross_loss/len(losers)):.4f}" if losers else "")

        reasons = {}
        for t in trades:
            reasons[t.exit_reason] = reasons.get(t.exit_reason, 0) + 1
        print(f"  Exits:     {reasons}")
