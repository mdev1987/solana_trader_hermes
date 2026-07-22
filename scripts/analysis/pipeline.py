#!/usr/bin/env python3
"""Full pipeline: download → replay → export → analyze → optimize → report."""

import sys
import os
sys.path.insert(0, os.path.dirname(__file__))

import config as cfg
from runner import ReplayRunner
import pandas as pd
from pathlib import Path
import json
import time


def export_to_csv(trades: list, rejected: list, out_dir: str = None) -> dict:
    out = Path(out_dir or cfg.DATA_DIR)
    out.mkdir(parents=True, exist_ok=True)

    paths = {}

    if trades:
        rows = []
        for t in trades:
            rows.append({
                'id': t.id, 'mint': t.mint,
                'entry_price': t.entry_price, 'exit_price': t.exit_price,
                'max_price': t.max_price, 'min_price': t.min_price,
                'quantity': t.quantity,
                'entry_time': t.entry_time, 'exit_time': t.exit_time,
                'entry_delay_ms': t.entry_delay_ms,
                'signal_age_ms': t.signal_age_ms,
                'decision_price': t.decision_price,
                'entry_score': t.entry_score,
                'pnl': t.pnl, 'pnl_percent': t.pnl_percent,
                'exit_reason': t.exit_reason, 'fees': t.fees,
                'features': t.features or '',
            })
        df = pd.DataFrame(rows)
        path = out / 'trades.csv'
        df.to_csv(path, index=False)
        print(f"[pipeline] {len(df)} trades → {path}")
        paths['trades'] = str(path)

    if rejected:
        rows = []
        for r in rejected:
            s = r['snapshot']
            rows.append({
                'mint': r['mint'], 'timestamp': r['timestamp'],
                'score': r['score'], 'reason': r['reason'],
                'activity_score': s.activity_score,
                'buy_ratio': s.buy_ratio,
                'wallet_count': s.wallet_count,
                'liquidity': s.liquidity,
                'signal_age_ms': s.time_since_launch_ms,
                'price': r['price'],
            })
        df = pd.DataFrame(rows)
        path = out / 'rejected_signals.csv'
        df.to_csv(path, index=False)
        print(f"[pipeline] {len(df)} rejected → {path}")
        paths['rejected'] = str(path)

    return paths


def run(hours: int = 2, n_trials: int = 200):
    t0 = time.time()

    # Step 1: Replay
    print(f"{'='*60}")
    print(f"STEP 1: Download & Replay ({hours} hours)")
    print(f"{'='*60}")
    runner = ReplayRunner(sol_balance=10.0, sol_amount=0.01)
    runner.download_and_replay_recent(hours)
    runner.print_summary()
    result = runner.get_result()
    trades = result['trades']
    rejected = result['rejected']

    if not trades:
        print("[pipeline] No trades — nothing to analyze.")
        return

    # Step 2: Export to CSV
    print(f"\n{'='*60}")
    print("STEP 2: Export to CSV")
    print(f"{'='*60}")
    paths = export_to_csv(trades, rejected)

    # Step 3: Analysis (XGBoost + SHAP)
    print(f"\n{'='*60}")
    print("STEP 3: Analysis (XGBoost + SHAP)")
    print(f"{'='*60}")
    from analysis import run_analysis, print_report
    analysis_result = run_analysis(
        paths.get('trades', ''),
        paths.get('rejected'),
    )
    print_report(analysis_result)

    # Step 4: Optuna weight optimization
    print(f"\n{'='*60}")
    print(f"STEP 4: Optuna Weight Optimization ({n_trials} trials)")
    print(f"{'='*60}")
    trades_df = pd.read_csv(paths['trades'])
    from analysis import optuna_optimize, avail_features, load_trades_from_csv
    df = load_trades_from_csv(paths['trades'])
    opt_result = optuna_optimize(df, n_trials=n_trials)
    if opt_result:
        print(f"  Best PF: {opt_result['best_value']:.2f}")
        print(f"  Best weights (raw):  wallet={opt_result['best_params_raw']['wallet']:.3f}, "
              f"age={opt_result['best_params_raw']['age']:.3f}, "
              f"liq={opt_result['best_params_raw']['liq']:.3f}")
        print(f"  Best weights (norm): wallet={opt_result['best_params_norm']['wallet']:.3f}, "
              f"age={opt_result['best_params_norm']['age']:.3f}, "
              f"liq={opt_result['best_params_norm']['liq']:.3f}")
    else:
        print("  Not enough data for optimization.")

    elapsed = time.time() - t0
    print(f"\n{'='*60}")
    print(f"Pipeline complete in {elapsed:.0f}s")


if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser(description='Full analysis pipeline')
    parser.add_argument('--hours', type=int, default=2, help='Hours of replay data')
    parser.add_argument('--trials', type=int, default=200, help='Optuna trials')
    args = parser.parse_args()
    run(hours=args.hours, n_trials=args.trials)
