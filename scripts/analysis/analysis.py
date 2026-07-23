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

def rolling_metrics(df: pd.DataFrame, window: int = 20, initial_capital: float = 10.0) -> pd.DataFrame:
    """Rolling PF/WR and equity-curve drawdown (from cumulative realized PnL)."""
    if len(df) < window * 2:
        return pd.DataFrame()
    df_sorted = df.sort_values('exit_time').reset_index(drop=True)
    roll = df_sorted.rolling(window, min_periods=window)
    gross_win = roll['pnl'].apply(lambda x: x[x > 0].sum())
    gross_loss = roll['pnl'].apply(lambda x: abs(x[x <= 0].sum()))
    pf = gross_win / gross_loss.replace(0, np.nan)
    wr = roll['is_win'].mean()

    # Drawdown from equity curve with starting capital
    equity = initial_capital + df_sorted['pnl'].cumsum()
    dd = equity / equity.cummax() - 1

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
    model = LogisticRegression(penalty='l1', solver='saga', max_iter=2000, random_state=42)
    model.fit(Xs, y)
    return pd.DataFrame({
        'feature': avail, 'coef': model.coef_[0], 'abs_coef': abs(model.coef_[0]),
    }).sort_values('abs_coef', ascending=False)


# ── XGBoost PnL Regressor ────────────────────────────────────────────────────

def xgboost_regression(df: pd.DataFrame, n_folds: int = 4) -> dict | None:
    from sklearn.metrics import mean_absolute_error, r2_score, mean_squared_error
    import xgboost as xgb

    avail = avail_features(df)
    if len(avail) < 2:
        return None

    df_sorted = df.sort_values('exit_time').reset_index(drop=True)
    X = df_sorted[avail].fillna(0).values
    y = df_sorted['pnl'].values
    n = len(df_sorted)
    if n < 15:
        return None

    fold_ends = [int(n * f) for f in [0.40, 0.55, 0.70, 0.85]]
    folds = []
    for fe in fold_ends:
        te = int(n * min(fe / 0.85 + 0.15, 1.0))
        if fe >= te or fe < 5 or te - fe < 3:
            continue
        folds.append((fe, te))
    if not folds:
        folds = [(int(n * 0.6), n)]

    _xgb = lambda: xgb.XGBRegressor(
        n_estimators=100, max_depth=3, learning_rate=0.1,
        random_state=42, objective='reg:squarederror',
    )

    y_test_all, y_pred_all = [], []
    cv_maes = []
    for fe, te in folds:
        X_tr, X_te = X[:fe], X[fe:te]
        y_tr, y_te = y[:fe], y[fe:te]
        m = _xgb()
        m.fit(X_tr, y_tr, verbose=False)
        y_p = m.predict(X_te)
        y_test_all.extend(y_te)
        y_pred_all.extend(y_p)
        cv_maes.append(mean_absolute_error(y_te, y_p))

    y_test_a = np.array(y_test_all)
    y_pred_a = np.array(y_pred_all)

    dir_acc = (np.sign(y_pred_a) == np.sign(y_test_a)).mean() if len(y_test_a) else 0

    return {
        'r2': r2_score(y_test_a, y_pred_a),
        'mae': mean_absolute_error(y_test_a, y_pred_a),
        'rmse': np.sqrt(mean_squared_error(y_test_a, y_pred_a)),
        'direction_accuracy': dir_acc,
        'cv_mae_mean': np.mean(cv_maes) if cv_maes else 0,
        'cv_mae_std': np.std(cv_maes) if cv_maes else 0,
        'fold_details': [(fe, te, te - fe) for (fe, te) in folds],
    }


# ── SHAP Explanation ─────────────────────────────────────────────────────────

def shap_analysis(df: pd.DataFrame) -> dict | None:
    try:
        import shap
        import xgboost as xgb
    except ImportError:
        return None

    avail = avail_features(df)
    if len(avail) < 2:
        return None

    df_sorted = df.sort_values('exit_time').reset_index(drop=True)
    X = df_sorted[avail].fillna(0).values
    y = df_sorted['pnl'].values
    split = int(len(df_sorted) * 0.7)
    if split < 5 or len(df_sorted) - split < 3:
        split = max(len(df_sorted) - 3, 3)
    X_train, X_test = X[:split], X[split:]

    model = xgb.XGBRegressor(
        n_estimators=100, max_depth=3, learning_rate=0.1,
        random_state=42, objective='reg:squarederror',
    )
    model.fit(X_train, y[:split], verbose=False)

    explainer = shap.Explainer(model, X_train)
    shap_values = explainer(X_test)
    mean_shap = np.abs(shap_values.values).mean(axis=0)
    return {
        'feature_importance': pd.DataFrame({
            'feature': avail, 'mean_shap': mean_shap,
        }).sort_values('mean_shap', ascending=False),
    }


# ── Permutation Importance ────────────────────────────────────────────────────

def permutation_importance(df: pd.DataFrame, n_repeats: int = 30) -> pd.DataFrame | None:
    try:
        import xgboost as xgb
    except ImportError:
        return None
    from sklearn.inspection import permutation_importance as sk_perm

    avail = avail_features(df)
    if len(avail) < 2:
        return None

    df_sorted = df.sort_values('exit_time').reset_index(drop=True)
    X = df_sorted[avail].fillna(0).values
    y = df_sorted['pnl'].values
    split = int(len(df_sorted) * 0.7)
    if split < 5 or len(df_sorted) - split < 3:
        split = max(len(df_sorted) - 3, 3)
    X_train, X_test = X[:split], X[split:]
    y_train, y_test = y[:split], y[split:]

    model = xgb.XGBRegressor(
        n_estimators=100, max_depth=3, learning_rate=0.1,
        random_state=42, objective='reg:squarederror',
    )
    model.fit(X_train, y_train, verbose=False)

    r = sk_perm(model, X_test, y_test, n_repeats=n_repeats, random_state=42, n_jobs=-1)
    return pd.DataFrame({
        'feature': avail,
        'importance_mean': r.importances_mean,
        'importance_std': r.importances_std,
    }).sort_values('importance_mean', ascending=False)


# ── Bootstrap Confidence Intervals ────────────────────────────────────────────

def bootstrap_ci(df: pd.DataFrame, n_bootstrap: int = 5000) -> dict:
    np.random.seed(42)
    n = len(df)
    pnls = df['pnl'].values
    is_win = df['is_win'].values

    stats = {'pf': [], 'wr': [], 'expectancy': [], 'sharpe': []}
    for _ in range(n_bootstrap):
        idx = np.random.randint(0, n, n)
        sample = pnls[idx]
        sw = is_win[idx]
        gw = sample[sample > 0].sum()
        gl = abs(sample[sample <= 0].sum())
        pf = gw / gl if gl > 1e-9 else (999 if gw > 0 else 0)
        wr = sw.mean()
        exp = sample.mean()
        sharpe = sample.mean() / sample.std() * np.sqrt(365) if sample.std() > 1e-9 else 0
        stats['pf'].append(pf)
        stats['wr'].append(wr)
        stats['expectancy'].append(exp)
        stats['sharpe'].append(sharpe)

    result = {}
    for k, v in stats.items():
        arr = np.array(v)
        result[k] = {
            'mean': arr.mean(),
            'median': np.median(arr),
            'ci_95': (np.percentile(arr, 2.5), np.percentile(arr, 97.5)),
        }
    return result

def simulate_trade_exit(row: dict, params: dict) -> float:
    """
    Simulate exit from pnl_percent + SL/TP caps only.
    Break-even and trailing stop require tick-level price paths
    (MFE is look-ahead bias) — they must be optimized via full replay.
    """
    pnl = row['pnl_pct_actual']
    sl = abs(params['stop_loss'])
    tp = params['take_profit']

    pnl = max(pnl, -sl)
    pnl = min(pnl, tp)
    return pnl


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
        sim_pnl = adj * r['notional']
        selected.append({'pnl_pct': adj, 'sim_pnl': sim_pnl, 'notional': r['notional']})
    return selected


def pf_from_pnl_list(trades: list) -> float:
    if len(trades) < 3:
        return 0
    gross_win = sum(abs(t['sim_pnl']) for t in trades if t['pnl_pct'] > 0)
    gross_loss = sum(abs(t['sim_pnl']) for t in trades if t['pnl_pct'] <= 0)
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
    Multi-fold walk-forward: expanding window (4 folds) for robust OOS estimate.
    """
    try:
        import optuna
    except ImportError:
        return None

    df_sorted = df.sort_values('exit_time').reset_index(drop=True)
    n = len(df_sorted)
    if n < 20:
        return None

    fold_ends = [int(n * f) for f in [0.40, 0.55, 0.70, 0.85]]
    fold_splits = []
    for fe in fold_ends:
        te = int(n * min(n / fold_ends[-1] if fe == fold_ends[-1] else (fe / n + 0.15), 1.0))
        if fe >= te or fe < 5 or te - fe < 3:
            continue
        fold_splits.append((fe, te))

    if not fold_splits:
        fold_splits = [(int(n * 0.6), n)]

    train_raw_all = _df_to_raw(df_sorted)

    def compute_pf_for_split(params: dict, train_end: int, test_end: int) -> tuple:
        train_raw = train_raw_all[:train_end]
        test_raw = train_raw_all[train_end:test_end]
        return compute_pf_full(params, train_raw), compute_pf_full(params, test_raw)

    def objective(trial):
        params = _suggest_params(trial)
        pfs = [compute_pf_for_split(params, te, tte) for te, tte in fold_splits]
        train_pfs = [p[0] for p in pfs]
        test_pfs = [p[1] for p in pfs]
        avg_train = sum(train_pfs) / len(train_pfs)
        avg_test = sum(test_pfs) / len(test_pfs)
        return avg_test - 0.3 * abs(avg_train - avg_test)

    study = optuna.create_study(direction='maximize', sampler=optuna.samplers.TPESampler(seed=42))
    study.optimize(objective, n_trials=n_trials, show_progress_bar=False)

    best = study.best_params
    train_pfs = []
    all_test_trades: list[dict] = []  # pooled test trades across folds
    fold_sizes = []
    for te, tte in fold_splits:
        tr, _ = compute_pf_for_split(best, te, tte)
        train_pfs.append(tr)
        test_raw = train_raw_all[te:tte]
        selected = filtered_pnl_percents(best, test_raw)
        all_test_trades.extend(selected)
        fold_sizes.append((te, tte, len(test_raw), len(selected)))
    train_pf = sum(train_pfs) / len(train_pfs)
    test_pf = pf_from_pnl_list(all_test_trades)

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
        'n_folds': len(fold_splits),
        'fold_sizes': [(tr, te, n_raw, n_sel) for tr, te, n_raw, n_sel in fold_sizes],
        'pooled_test_trades': len(all_test_trades),
        'trials': n_trials,
        'study': study,
        'n_params': len(best),
    }


def _df_to_raw(df_slice):
    """Convert a DataFrame slice to the raw list format."""
    raw = []
    for _, row in df_slice.iterrows():
        entry_px = row.get('entry_price') or 0
        qty = row.get('quantity') or 0
        raw.append({
            'wallet': row.get('feat_wallets', 0),
            'liq': row.get('feat_liquidity', 0),
            'buy_r': row.get('feat_buyRatio', 0.5),
            'age_ms': row.get('signal_age_ms', 0),
            'pnl_pct_actual': row['pnl_percent'],
            'mfe': row['mfe'] if 'mfe' in row and not pd.isna(row['mfe']) else 0,
            'entry_price': entry_px,
            'quantity': qty,
            'notional': entry_px * qty,
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

            print("Permutation importance...")
            result['permutation_imp'] = permutation_importance(df)

            print("SHAP analysis...")
            result['shap'] = shap_analysis(df)
            if result.get('shap'):
                top = result['shap']['feature_importance'].head(5)
                print(f"  Top features:\n{top.to_string(index=False)}")

    # Bootstrap CIs
    print("Bootstrap confidence intervals...")
    result['bootstrap'] = bootstrap_ci(df)

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
        print(f"  Max drawdown from equity peak: {max_dd:.1%}")
        final_equity = r['equity'].iloc[-1]
        print(f"  Final equity: ${final_equity:.2f}")

    if result.get('xgb'):
        x = result['xgb']
        print(f"\nXGBoost PnL Regressor (expanding walk-forward):")
        print(f"  R²={x['r2']:.3f}  MAE=${x['mae']:.4f}  RMSE=${x['rmse']:.4f}")
        print(f"  Direction accuracy: {x['direction_accuracy']:.1%}")
        print(f"  CV MAE: {x['cv_mae_mean']:.4f} ± {x['cv_mae_std']:.4f}")

    if result.get('permutation_imp') is not None:
        print(f"\nPermutation Importance (XGBoost):")
        print(result['permutation_imp'].to_string(index=False))

    if result.get('shap'):
        print(f"\nSHAP Feature Importance (mean |SHAP|):")
        print(result['shap']['feature_importance'].to_string(index=False))

    if result.get('feature_importance_lr') is not None:
        print(f"\nLogistic Regression Coefficients (L1 penalty):")
        print(result['feature_importance_lr'].to_string(index=False))

    if result.get('bootstrap'):
        b = result['bootstrap']
        print(f"\nBootstrap 95% CI (n={5000}):")
        for k, v in b.items():
            lo, hi = v['ci_95']
            print(f"  {k}: {v['mean']:.4f} [{lo:.4f}, {hi:.4f}]")


if __name__ == '__main__':
    import sys
    tc = sys.argv[1] if len(sys.argv) > 1 else 'data/trades.csv'
    rc = sys.argv[2] if len(sys.argv) > 2 else None
    r = run_analysis(tc, rc)
    print_report(r)
