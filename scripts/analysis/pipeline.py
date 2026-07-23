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
                'price_path': t.price_path or '',
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
                'fresh_wallet_ratio': s.fresh_wallet_ratio,
                'wallet_growth_10s': s.wallet_growth_10s,
                'wallet_growth_30s': s.wallet_growth_30s,
                'wallet_growth_60s': s.wallet_growth_60s,
                'volume_last_10s': s.volume_last_10s,
                'volume_last_30s': s.volume_last_30s,
                'buy_velocity_10s': s.buy_velocity_10s,
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

    # Step 4: Optuna full-parameter optimization
    print(f"\n{'='*60}")
    print(f"STEP 4: Optuna Full-Parameter Optimization ({n_trials} trials)")
    print(f"{'='*60}")
    from analysis import optuna_optimize, load_trades_from_csv
    df = load_trades_from_csv(paths['trades'])
    opt_result = optuna_optimize(df, n_trials=n_trials)
    if opt_result:
        print(f"  Train PF ({opt_result['n_folds']}-fold avg): {opt_result['train_pf']:.2f}")
        print(f"  Test PF (pooled across folds): {opt_result['test_pf']:.2f} ({opt_result['pooled_test_trades']} test trades)")
        print(f"  Fold sizes (train_end, test_end, raw, selected): {opt_result['fold_sizes']}")
        print(f"\n  Best normalized weights:")
        bn = opt_result['best_weights_norm']
        print(f"    wallet={bn['wallet']:.3f}  age={bn['age']:.3f}  liq={bn['liq']:.3f}")
        print(f"\n  Best full params:")
        for k, v in sorted(opt_result['best_params'].items()):
            print(f"    {k}: {v}")
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
