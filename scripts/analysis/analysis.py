"""Statistical analysis, PnL regression, SHAP, Optuna full-parameter optimization."""

import pandas as pd
import numpy as np
from pathlib import Path
import json
import warnings
warnings.filterwarnings('ignore')


def parse_features(trade_row) -> dict:
    f = getattr(trade_row, 'features', None) or getattr(trade_row, 'features', '{}')
    if isinstance(f, str):
        try:
            return json.loads(f) if f else {}
        except (json.JSONDecodeError, TypeError):
            return {}
    return f or {}


def load_trades_from_csv(csv_path: str | Path) -> pd.DataFrame:
    df = pd.read_csv(csv_path)
    numeric = ['pnl', 'pnl_percent', 'entry_score', 'signal_age_ms',
               'entry_delay_ms', 'entry_price', 'exit_price', 'max_price', 'min_price']
    for c in numeric:
        if c in df.columns:
            df[c] = pd.to_numeric(df[c], errors='coerce')

    feat_rows = []
    for _, row in df.iterrows():
        feat_rows.append(parse_features(row))
    feat_df = pd.DataFrame(feat_rows)
    feat_df = feat_df.apply(pd.to_numeric, errors='coerce')
    df = pd.concat([df, feat_df.add_prefix('feat_')], axis=1)

    df['is_win'] = (df['pnl'] > 0).astype(int)
    df['mfe'] = (df['max_price'] - df['entry_price']) / df['entry_price']
    df['mae'] = (df['entry_price'] - df['min_price']) / df['entry_price']
    df['hold_sec'] = (df['exit_time'] - df['entry_time']) / 1000

    # ── Engineered features (rate-based, interaction) ──
    df['r_signal_age_s'] = df['signal_age_ms'] / 1000
    df['wallet_density'] = df['feat_wallets'] / (df['r_signal_age_s'] + 1)
    df['liq_per_wallet'] = df['feat_liquidity'] / (df['feat_wallets'] + 1)
    df['buy_velocity'] = df['feat_buyRatio'] / (df['r_signal_age_s'] + 1)
    df['activity_accel'] = df['feat_activity'] / (df['r_signal_age_s'] / 60 + 1)
    df['score_x_wallets'] = df['entry_score'] * df['feat_wallets'] / 100
    df['wallets_signal_interact'] = df['feat_wallets'] * df['r_signal_age_s'] / 1000
    return df


def load_rejected_from_csv(csv_path: str | Path) -> pd.DataFrame:
    df = pd.read_csv(csv_path)
    for c in df.columns:
        try:
            df[c] = pd.to_numeric(df[c], errors='coerce')
        except (ValueError, TypeError):
            pass
    return df


def avail_features(df: pd.DataFrame) -> list:
    cols = ['entry_score', 'signal_age_ms', 'entry_delay_ms',
            'feat_wallets', 'feat_liquidity', 'feat_buyRatio', 'feat_activity',
            'wallet_density', 'liq_per_wallet', 'buy_velocity',
            'activity_accel', 'score_x_wallets', 'wallets_signal_interact']
    return [c for c in cols if c in df.columns and df[c].notna().sum() > 5]


# ── Rolling Metrics ──────────────────────────────────────────────────────────

def rolling_metrics(df: pd.DataFrame, window: int = 20) -> pd.DataFrame:
    """Rolling PF/WR and equity-curve drawdown (from cumulative realized PnL)."""
    if len(df) < window * 2:
        return pd.DataFrame()
    df_sorted = df.sort_values('exit_time').reset_index(drop=True)
    roll = df_sorted.rolling(window, min_periods=window)
    gross_win = roll['pnl'].apply(lambda x: x[x > 0].sum())
    gross_loss = roll['pnl'].apply(lambda x: abs(x[x <= 0].sum()))
    pf = gross_win / gross_loss.replace(0, np.nan)
    wr = roll['is_win'].mean()

    # Equity-curve drawdown: cumulative realized PnL, peak-to-trough
    equity = df_sorted['pnl'].cumsum()
    rolling_max = equity.expanding().max()
    dd = (equity - rolling_max) / (rolling_max + 1e-9)

    return pd.DataFrame({
        'trade_end': df_sorted['exit_time'],
        'rolling_pf': pf,
        'rolling_wr': wr,
        'equity': equity,
        'drawdown': dd,
    }).dropna().reset_index(drop=True)


# ── Bucket Analysis ──────────────────────────────────────────────────────────

def bucket_analysis(df: pd.DataFrame) -> dict:
    results = {}
    variants = [
        ('score_buckets', 'entry_score', [(45, 55, '45-54'), (55, 65, '55-64'),
         (65, 75, '65-74'), (75, 85, '75-84'), (85, 999, '85+')]),
        ('wallet_buckets', 'feat_wallets', [(0, 100, '0-100'), (100, 200, '100-200'),
         (200, 400, '200-400'), (400, 800, '400-800'), (800, 1e9, '800+')]),
        ('age_buckets', 'signal_age_ms', [(0, 5000, '0-5s'), (5000, 10000, '5-10s'),
         (10000, 15000, '10-15s'), (15000, 20000, '15-20s'),
         (20000, 30000, '20-30s'), (30000, 1e9, '30s+')]),
    ]
    for key, col, buckets in variants:
        rows = []
        if col not in df.columns:
            continue
        for lo, hi, label in buckets:
            sub = df[(df[col] >= lo) & (df[col] < hi)]
            if len(sub) == 0:
                continue
            wins = sub['is_win'].sum()
            gw = sub[sub['pnl'] > 0]['pnl'].sum()
            gl = abs(sub[sub['pnl'] <= 0]['pnl'].sum())
            rows.append({
                'bucket': label, 'n': len(sub), 'win_rate': wins / len(sub),
                'total_pnl': sub['pnl'].sum(),
                'avg_roi': sub['pnl_percent'].mean() * 100,
                'pf': gw / gl if gl > 1e-9 else float('inf'),
            })
        if rows:
            results[key] = pd.DataFrame(rows)

    if 'exit_reason' in df.columns:
        results['exit_reasons'] = df.groupby('exit_reason').agg(
            n=('pnl', 'count'), win_rate=('is_win', 'mean'),
            total_pnl=('pnl', 'sum'),
        ).reset_index()
    return results


# ── Feature Importance (Logistic Regression) ─────────────────────────────────

def feature_importance(df: pd.DataFrame, target: str = 'is_win') -> pd.DataFrame | None:
    from sklearn.linear_model import LogisticRegression
    from sklearn.preprocessing import StandardScaler

    avail = avail_features(df)
    avail = [c for c in avail if c in df.columns and df[c].notna().sum() > 5]
    if len(avail) < 2 or target not in df.columns:
        return None

    X = df[avail].fillna(0).values
    y = df[target].values
    scaler = StandardScaler()
    Xs = scaler.fit_transform(X)
    model = LogisticRegression(max_iter=1000, random_state=42)
    model.fit(Xs, y)
    return pd.DataFrame({
        'feature': avail, 'coef': model.coef_[0], 'abs_coef': abs(model.coef_[0]),
    }).sort_values('abs_coef', ascending=False)


# ── XGBoost PnL Regressor ────────────────────────────────────────────────────

def xgboost_regression(df: pd.DataFrame) -> dict | None:
    from sklearn.model_selection import cross_val_score, train_test_split
    from sklearn.metrics import mean_absolute_error, r2_score, mean_squared_error
    import xgboost as xgb

    avail = avail_features(df)
    if len(avail) < 2:
        return None

    X = df[avail].fillna(0).values
    y = df['pnl'].values

    X_train, X_test, y_train, y_test = train_test_split(
        X, y, test_size=0.3, random_state=42
    )

    model = xgb.XGBRegressor(
        n_estimators=100, max_depth=3, learning_rate=0.1,
        random_state=42, objective='reg:squarederror',
    )
    model.fit(X_train, y_train, eval_set=[(X_test, y_test)], verbose=False)

    y_pred = model.predict(X_test)
    cv_scores = cross_val_score(model, X, y, cv=min(5, len(df) // 3), scoring='neg_mean_absolute_error')

    # Direction accuracy: does sign(predicted) == sign(actual)?
    dir_acc = (np.sign(y_pred) == np.sign(y_test)).mean()

    imp = pd.DataFrame({
        'feature': avail,
        'importance': model.feature_importances_,
    }).sort_values('importance', ascending=False)

    return {
        'model': model, 'feature_names': avail,
        'r2': r2_score(y_test, y_pred),
        'mae': mean_absolute_error(y_test, y_pred),
        'rmse': np.sqrt(mean_squared_error(y_test, y_pred)),
        'direction_accuracy': dir_acc,
        'cv_mae_mean': -cv_scores.mean(),
        'cv_mae_std': cv_scores.std(),
        'feature_importance': imp,
        'X_train': X_train, 'X_test': X_test,
        'y_train': y_train, 'y_test': y_test,
        'y_pred': y_pred,
    }


# ── SHAP Explanation ─────────────────────────────────────────────────────────

def shap_analysis(model_result: dict) -> dict | None:
    try:
        import shap
    except ImportError:
        return None
    model = model_result['model']
    X_test = model_result['X_test']
    names = model_result['feature_names']
    explainer = shap.Explainer(model, X_test)
    shap_values = explainer(X_test)
    mean_shap = np.abs(shap_values.values).mean(axis=0)
    return {
        'explainer': explainer, 'shap_values': shap_values,
        'feature_importance': pd.DataFrame({
            'feature': names, 'mean_shap': mean_shap,
        }).sort_values('mean_shap', ascending=False),
    }


# ── Optuna Full-Parameter Optimization with Walk-Forward ─────────────────────

def simulate_trade_exit(row: dict, params: dict) -> float:
    """
    Simulate exit for a single trade given params.
    Order matches live engine: SL/TP caps → break-even → trailing stop.
    Returns the realized pnl_percent.
    """
    pnl_pct = row['pnl_pct_actual']
    mfe = row['mfe']
    sl = abs(params['stop_loss'])
    tp = params['take_profit']
    be = params['break_even']
    trail_act = params.get('trail_activate', 0.25)
    trail_dist = params.get('trail_distance', 0.12)

    if pnl_pct < -sl:
        pnl_pct = -sl
    if pnl_pct > tp:
        pnl_pct = tp

    if mfe >= be and pnl_pct < 0:
        pnl_pct = 0.0

    if mfe >= trail_act:
        trail_price = (1 + mfe) * (1 - trail_dist) - 1
        if trail_price > pnl_pct:
            pnl_pct = trail_price

    return pnl_pct


def filtered_pnl_percents(params: dict, raw: list) -> list:
    selected = []
    for r in raw:
        if r['wallet'] < params['min_wallet']:
            continue
        if r['buy_r'] < params['min_buy_r']:
            continue
        if r['age_ms'] < params['min_age']:
            continue
        score = compute_score(params['w_wallet'], params['w_age'],
                              params['w_liq'], r['wallet'], r['liq'], r['age_ms'])
        if score < params['min_score']:
            continue
        adj = simulate_trade_exit(r, params)
        selected.append({'pnl_pct': adj, 'pnl': r.get('pnl', 0)})
    return selected


def pf_from_pnl_list(trades: list) -> float:
    if len(trades) < 3:
        return 0
    gross_win = sum(abs(t['pnl']) for t in trades if t['pnl_pct'] > 0)
    gross_loss = sum(abs(t['pnl']) for t in trades if t['pnl_pct'] <= 0)
    if gross_loss < 1e-9:
        return 999 if gross_win > 0 else 0
    return gross_win / gross_loss


def compute_score(w_wallet, w_age, w_liq, wallet_count, liq, age_ms):
    from engine import Scorer
    sc = Scorer()
    tw = w_wallet + w_age + w_liq
    return (w_wallet / tw * sc._wallet_score(wallet_count) +
            w_age / tw * sc._signal_age_score(age_ms) +
            w_liq / tw * sc._liquidity_score(liq)) * 100


def compute_pf_full(params: dict, raw: list) -> float:
    return pf_from_pnl_list(filtered_pnl_percents(params, raw))


def optuna_optimize(df: pd.DataFrame, n_trials: int = 1000) -> dict | None:
    """
    Optimize weights + filters + exits to maximize PF.
    Uses walk-forward: trains on first 60% of chronologically-sorted trades,
    evaluates on last 40%. Returns both in-sample and out-of-sample PF.
    """
    try:
        import optuna
    except ImportError:
        return None

    df_sorted = df.sort_values('exit_time').reset_index(drop=True)
    split = int(len(df_sorted) * 0.6)
    if split < 10 or len(df_sorted) - split < 5:
        split = max(len(df_sorted) - 5, 5)

    train_raw = _df_to_raw(df_sorted.iloc[:split])
    test_raw = _df_to_raw(df_sorted.iloc[split:])

    if len(train_raw) < 5:
        return None

    def objective(trial):
        params = _suggest_params(trial)
        return compute_pf_full(params, train_raw)

    study = optuna.create_study(direction='maximize', sampler=optuna.samplers.TPESampler(seed=42))
    study.optimize(objective, n_trials=n_trials, show_progress_bar=False)

    best = study.best_params
    train_pf = study.best_value
    test_pf = compute_pf_full(best, test_raw)

    tw = best['w_wallet'] + best['w_age'] + best['w_liq']
    best_norm = {
        'wallet': best['w_wallet'] / tw,
        'age': best['w_age'] / tw,
        'liq': best['w_liq'] / tw,
    }

    return {
        'best_params': best,
        'best_weights_norm': best_norm,
        'train_pf': train_pf,
        'test_pf': test_pf,
        'n_train': len(train_raw),
        'n_test': len(test_raw),
        'trials': n_trials,
        'study': study,
        'n_params': len(best),
    }


def _df_to_raw(df_slice):
    """Convert a DataFrame slice to the raw list format."""
    raw = []
    for _, row in df_slice.iterrows():
        raw.append({
            'wallet': row.get('feat_wallets', 0),
            'liq': row.get('feat_liquidity', 0),
            'buy_r': row.get('feat_buyRatio', 0.5),
            'age_ms': row.get('signal_age_ms', 0),
            'pnl': row['pnl'],
            'pnl_pct_actual': row['pnl_percent'],
            'mfe': row['mfe'] if 'mfe' in row and not pd.isna(row['mfe']) else 0,
            'max_price': row.get('max_price', 0),
            'entry_price': row.get('entry_price', 1),
        })
    return raw


def _suggest_params(trial):
    return {
        'w_wallet': trial.suggest_float('w_wallet', 0.05, 0.9),
        'w_age': trial.suggest_float('w_age', 0.05, 0.9),
        'w_liq': trial.suggest_float('w_liq', 0.05, 0.9),
        'min_score': trial.suggest_int('min_score', 30, 85, step=5),
        'min_wallet': trial.suggest_int('min_wallet', 10, 100, step=10),
        'min_buy_r': trial.suggest_float('min_buy_r', 0.20, 0.60, step=0.05),
        'min_age': trial.suggest_int('min_age', 0, 20000, step=2000),
        'stop_loss': trial.suggest_float('stop_loss', -0.50, -0.10, step=0.05),
        'take_profit': trial.suggest_float('take_profit', 0.20, 1.0, step=0.10),
        'break_even': trial.suggest_float('break_even', 0.05, 0.30, step=0.05),
        'trail_activate': trial.suggest_float('trail_activate', 0.10, 0.40, step=0.05),
        'trail_distance': trial.suggest_float('trail_distance', 0.05, 0.25, step=0.05),
    }


# ── Analysis Report ──────────────────────────────────────────────────────────

def run_analysis(trades_csv: str | Path, rejected_csv: str | Path | None = None) -> dict:
    print("Loading trades...")
    df = load_trades_from_csv(trades_csv)
    print(f"  {len(df)} trades loaded")
    if rejected_csv:
        rej = load_rejected_from_csv(rejected_csv)
        print(f"  {len(rej)} rejected signals loaded")

    result = {'n_trades': len(df)}
    wins = df[df['is_win'] == 1]
    losses = df[df['is_win'] == 0]
    result['win_rate'] = len(wins) / len(df) if len(df) else 0
    result['total_pnl'] = df['pnl'].sum()
    result['avg_win'] = wins['pnl'].mean() if len(wins) else 0
    result['avg_loss'] = losses['pnl'].mean() if len(losses) else 0
    gw = wins['pnl'].sum()
    gl = abs(losses['pnl'].sum())
    result['pf'] = gw / gl if gl > 1e-9 else float('inf')
    print(f"  Win rate: {result['win_rate']*100:.1f}%  PnL: ${result['total_pnl']:.4f}  PF: {result['pf']:.2f}")

    result['buckets'] = bucket_analysis(df)

    # Rolling metrics
    result['rolling'] = rolling_metrics(df)

    # Feature importance (logistic regression)
    if len(avail_features(df)) >= 2:
        print("Feature importance (logistic regression)...")
        result['feature_importance_lr'] = feature_importance(df)

    # XGBoost PnL regression
    if len(avail_features(df)) >= 2:
        print("XGBoost PnL regression...")
        result['xgb'] = xgboost_regression(df)
        if result.get('xgb'):
            x = result['xgb']
            print(f"  R²={x['r2']:.3f}  MAE=${x['mae']:.4f}  DirAcc={x['direction_accuracy']:.1%}")
            print(f"  CV MAE={x['cv_mae_mean']:.4f} ± {x['cv_mae_std']:.4f}")

            print("SHAP analysis...")
            result['shap'] = shap_analysis(x)
            if result.get('shap'):
                top = result['shap']['feature_importance'].head(5)
                print(f"  Top features:\n{top.to_string(index=False)}")

    return result


def print_report(result: dict):
    print(f"\n{'='*60}")
    print("TRADING ANALYSIS REPORT")
    print(f"{'='*60}")
    print(f"Trades: {result['n_trades']}  Win rate: {result['win_rate']*100:.1f}%  "
          f"PnL: ${result['total_pnl']:.4f}  PF: {result['pf']:.2f}")

    if 'buckets' in result:
        for key, label in [('score_buckets', 'Score Buckets'),
                           ('wallet_buckets', 'Wallet Buckets'),
                           ('age_buckets', 'Age Buckets'),
                           ('exit_reasons', 'Exit Reasons')]:
            bdf = result['buckets'].get(key)
            if bdf is not None and len(bdf):
                print(f"\n{label}:")
                print(bdf.to_string(index=False))

    if not result.get('rolling', pd.DataFrame()).empty:
        r = result['rolling']
        print(f"\nRolling {len(r)}-trade windows:")
        print(f"  PF went from {r['rolling_pf'].iloc[0]:.2f} -> {r['rolling_pf'].iloc[-1]:.2f}")
        print(f"  WR went from {r['rolling_wr'].iloc[0]:.1%} -> {r['rolling_wr'].iloc[-1]:.1%}")
        max_dd = r['drawdown'].min()
        print(f"  Max drawdown: {max_dd:.1%}")

    if result.get('xgb'):
        x = result['xgb']
        print(f"\nXGBoost PnL Regressor:")
        print(f"  R²={x['r2']:.3f}  MAE=${x['mae']:.4f}  RMSE=${x['rmse']:.4f}")
        print(f"  Direction accuracy: {x['direction_accuracy']:.1%}")
        print(f"  CV MAE: {x['cv_mae_mean']:.4f} ± {x['cv_mae_std']:.4f}")
        print(f"\nFeature Importance:")
        print(x['feature_importance'].to_string(index=False))

    if result.get('shap'):
        print(f"\nSHAP Feature Importance (mean |SHAP|):")
        print(result['shap']['feature_importance'].to_string(index=False))

    if result.get('feature_importance_lr') is not None:
        print(f"\nLogistic Regression Coefficients:")
        print(result['feature_importance_lr'].to_string(index=False))


if __name__ == '__main__':
    import sys
    tc = sys.argv[1] if len(sys.argv) > 1 else 'data/trades.csv'
    rc = sys.argv[2] if len(sys.argv) > 2 else None
    r = run_analysis(tc, rc)
    print_report(r)
