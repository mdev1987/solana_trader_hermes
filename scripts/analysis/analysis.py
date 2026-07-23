"""Statistical analysis, PnL regression, SHAP, Optuna full-parameter optimization."""

import pandas as pd
import numpy as np
from pathlib import Path
import json

import config as cfg


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

    # ── Engineered features ──
    df['r_signal_age_s'] = df['signal_age_ms'] / 1000
    df['wallet_density'] = df['feat_wallets'] / (df['r_signal_age_s'] + 1)
    df['liq_per_wallet'] = df['feat_liquidity'] / (df['feat_wallets'] + 1)
    df['buy_velocity'] = df['feat_buyRatio'] / (df['r_signal_age_s'] + 1)
    df['activity_accel'] = df['feat_activity'] / (df['r_signal_age_s'] / 60 + 1)
    df['score_x_wallets'] = df['entry_score'] * df['feat_wallets'] / 100
    df['wallets_signal_interact'] = df['feat_wallets'] * df['r_signal_age_s'] / 1000

    # Velocity features from engine.py FeatureSnapshot
    df['feat_fresh_wallet_ratio'] = pd.to_numeric(df.get('feat_fresh_wallet_ratio', 0), errors='coerce')
    df['feat_wallet_growth_10s'] = pd.to_numeric(df.get('feat_wallet_growth_10s', 0), errors='coerce')
    df['feat_wallet_growth_30s'] = pd.to_numeric(df.get('feat_wallet_growth_30s', 0), errors='coerce')
    df['feat_wallet_growth_60s'] = pd.to_numeric(df.get('feat_wallet_growth_60s', 0), errors='coerce')
    df['feat_volume_last_10s'] = pd.to_numeric(df.get('feat_volume_last_10s', 0), errors='coerce')
    df['feat_volume_last_30s'] = pd.to_numeric(df.get('feat_volume_last_30s', 0), errors='coerce')
    df['feat_buy_velocity_10s'] = pd.to_numeric(df.get('feat_buy_velocity_10s', 0), errors='coerce')

    # Ratio features from velocities
    df['wallet_growth_rate'] = df['feat_wallet_growth_10s'] / (df['r_signal_age_s'] + 1)
    df['volume_velocity'] = df['feat_volume_last_10s'] / (df['r_signal_age_s'] + 1)
    df['buy_surge'] = df['feat_buy_velocity_10s'] / (df['feat_wallet_growth_10s'] + 1)
    df['fresh_wallet_ratio_sq'] = df['feat_fresh_wallet_ratio'] ** 2

    # Tick-level price path (JSON [[timestamp, price], ...])
    df['price_path'] = df.get('price_path', '').fillna('')
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
            'activity_accel', 'score_x_wallets', 'wallets_signal_interact',
            'feat_fresh_wallet_ratio', 'feat_wallet_growth_10s',
            'feat_wallet_growth_30s', 'feat_wallet_growth_60s',
            'feat_volume_last_10s', 'feat_volume_last_30s',
            'feat_buy_velocity_10s',
            'wallet_growth_rate', 'volume_velocity', 'buy_surge',
            'fresh_wallet_ratio_sq']
    return [c for c in cols if c in df.columns and df[c].notna().sum() > 5]


def pre_trade_features(df: pd.DataFrame) -> list:
    """Features available BEFORE trade entry (no lookahead)."""
    cols = ['entry_score', 'signal_age_ms',
            'feat_wallets', 'feat_liquidity', 'feat_buyRatio', 'feat_activity',
            'feat_fresh_wallet_ratio', 'feat_wallet_growth_10s',
            'feat_wallet_growth_30s', 'feat_wallet_growth_60s',
            'feat_volume_last_10s', 'feat_volume_last_30s',
            'feat_buy_velocity_10s',
            'wallet_density', 'liq_per_wallet', 'buy_velocity',
            'activity_accel', 'score_x_wallets', 'wallets_signal_interact',
            'wallet_growth_rate', 'volume_velocity', 'buy_surge',
            'fresh_wallet_ratio_sq']
    return [c for c in cols if c in df.columns and df[c].notna().sum() > 5]


# ── Walk-Forward Folds (shared by XGBoost, SHAP, permutation, Optuna) ──────

def _walk_forward_folds(n: int):
    """
    Return (fold_splits, train_end, test_end) for expanding walk-forward:
      fold 0: train 0-40%, test 40-55%
      fold 1: train 0-55%, test 55-70%
      fold 2: train 0-70%, test 70-85%
      fold 3: train 0-85%, test 85-100%  (held out as final evaluation)
    """
    fold_ends = [int(n * f) for f in [0.40, 0.55, 0.70, 0.85]]
    fold_splits = []
    for fe in fold_ends:
        te = int(n * min(fe / 0.85 + 0.15, 1.0))
        if fe >= te or fe < 5 or te - fe < 3:
            continue
        fold_splits.append((fe, te))
    if not fold_splits:
        fold_splits = [(int(n * 0.6), n)]
    last_train_end = fold_ends[-1] if fold_splits else int(n * 0.7)
    last_test_end = n
    return fold_splits, last_train_end, last_test_end


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
    """
    Logistic regression with L1 penalty, trained on walk-forward train split only
    to avoid future leakage. Coefficients reflect predictive (not descriptive) signal.
    """
    from sklearn.linear_model import LogisticRegression
    from sklearn.preprocessing import StandardScaler

    avail = pre_trade_features(df)
    if len(avail) < 2 or target not in df.columns:
        return None

    df_sorted = df.sort_values('exit_time').reset_index(drop=True)
    n = len(df_sorted)
    if n < 10:
        return None

    _, train_end, _ = _walk_forward_folds(n)
    if train_end < 5:
        train_end = int(n * 0.7)

    train_df = df_sorted.iloc[:train_end]
    X = train_df[avail].fillna(0).values
    y = train_df[target].values

    scaler = StandardScaler()
    Xs = scaler.fit_transform(X)
    model = LogisticRegression(penalty='l1', solver='saga', max_iter=2000,
                               random_state=cfg.SEED, C=0.1)
    model.fit(Xs, y)
    return pd.DataFrame({
        'feature': avail, 'coef': model.coef_[0], 'abs_coef': abs(model.coef_[0]),
    }).sort_values('abs_coef', ascending=False)


# ── XGBoost Classifier (P(win)) ──────────────────────────────────────────────

def xgb_classifier(df: pd.DataFrame, target: str = 'is_win') -> dict | None:
    """
    Train XGBoost classifier on trades; predicts P(win).
    Expanding walk-forward evaluation across folds.
    """
    from sklearn.metrics import accuracy_score, roc_auc_score, precision_score, recall_score
    import xgboost as xgb

    avail = pre_trade_features(df)
    if len(avail) < 2 or target not in df.columns:
        return None

    df_sorted = df.sort_values('exit_time').reset_index(drop=True)
    X = df_sorted[avail].fillna(0).values
    y = df_sorted[target].values
    n = len(df_sorted)
    if n < 15:
        return None

    folds, _, _ = _walk_forward_folds(n)
    n_pos = y.sum()
    scale_pos = (len(y) - n_pos) / n_pos if n_pos > 0 else 1

    _clf = lambda: xgb.XGBClassifier(
        n_estimators=100, max_depth=3, learning_rate=0.1,
        random_state=cfg.SEED, scale_pos_weight=scale_pos,
        eval_metric='logloss',
    )

    y_test_all, y_prob_all, y_pred_all = [], [], []
    fold_metrics = []
    for fe, te in folds:
        X_tr, X_te = X[:fe], X[fe:te]
        y_tr, y_te = y[:fe], y[fe:te]
        m = _clf()
        m.fit(X_tr, y_tr, verbose=False)
        y_prob = m.predict_proba(X_te)[:, 1]
        y_pred = (y_prob >= 0.5).astype(int)
        y_test_all.extend(y_te)
        y_prob_all.extend(y_prob)
        y_pred_all.extend(y_pred)
        fold_metrics.append({
            'accuracy': accuracy_score(y_te, y_pred),
            'auc': roc_auc_score(y_te, y_prob) if len(np.unique(y_te)) > 1 else 0,
            'precision': precision_score(y_te, y_pred, zero_division=0),
            'recall': recall_score(y_te, y_pred, zero_division=0),
            'n_test': len(y_te),
        })

    y_test_a = np.array(y_test_all)
    y_prob_a = np.array(y_prob_all)
    y_pred_a = np.array(y_pred_all)

    avg_win = df[df['is_win'] == 1]['pnl'].mean() if y_test_a.sum() > 0 else 0
    avg_loss = abs(df[df['is_win'] == 0]['pnl'].mean()) if (1 - y_test_a).sum() > 0 else 0
    ev_per_trade = y_prob_a * avg_win - (1 - y_prob_a) * avg_loss

    return {
        'accuracy': accuracy_score(y_test_a, y_pred_a),
        'auc': roc_auc_score(y_test_a, y_prob_a) if len(np.unique(y_test_a)) > 1 else 0,
        'precision': precision_score(y_test_a, y_pred_a, zero_division=0),
        'recall': recall_score(y_test_a, y_pred_a, zero_division=0),
        'avg_win_usd': avg_win,
        'avg_loss_usd': avg_loss,
        'ev_mean': ev_per_trade.mean(),
        'ev_median': np.median(ev_per_trade),
        'fold_details': fold_metrics,
        'n_test': len(y_test_a),
    }


# ── Combined Classifier (trades=1 + rejected=0) ────────────────────────────

def load_data_for_classifier(trades_csv: str | Path, rejected_csv: str | Path) -> dict | None:
    """Load trades (class 1) and rejected signals (class 0), align on pre-trade features."""
    trades = load_trades_from_csv(trades_csv)
    rejected = load_rejected_from_csv(rejected_csv)
    if len(trades) < 3 or len(rejected) < 3:
        return None

    # Build two DataFrames with a shared feature set
    trades['label'] = 1
    rejected['label'] = 0

    shared_cols = [c for c in ['entry_score', 'signal_age_ms',
                                'wallet_count', 'liquidity', 'buy_ratio',
                                'activity_score', 'fresh_wallet_ratio',
                                'wallet_growth_10s', 'wallet_growth_30s',
                                'wallet_growth_60s', 'volume_last_10s',
                                'volume_last_30s', 'buy_velocity_10s']
                   if c in trades.columns or c in rejected.columns]

    # Rename rejected fields to match trade feature names
    rename_map = {
        'wallet_count': 'feat_wallets',
        'liquidity': 'feat_liquidity',
        'buy_ratio': 'feat_buyRatio',
        'activity_score': 'feat_activity',
        'signal_age_ms': 'signal_age_ms',
    }
    # Build combined rows
    rows = []
    for _, r in trades.iterrows():
        row = {'label': 1, 'timestamp': r.get('entry_time', 0)}
        for c in shared_cols:
            row[c] = r.get(rename_map.get(c, f'feat_{c}'), r.get(c, 0))
        rows.append(row)
    for _, r in rejected.iterrows():
        row = {'label': 0, 'timestamp': r.get('timestamp', 0)}
        for c in shared_cols:
            if c in rename_map:
                row[c] = r.get(c, 0)
            elif c in ('wallet_growth_10s', 'wallet_growth_30s',
                       'wallet_growth_60s', 'volume_last_10s',
                       'volume_last_30s', 'buy_velocity_10s',
                       'fresh_wallet_ratio'):
                row[c] = r.get(c, 0)
            else:
                row[c] = r.get(c, 0)
        rows.append(row)

    df = pd.DataFrame(rows)
    feat_cols = [c for c in shared_cols if c in df.columns and df[c].notna().sum() > 5]
    if len(feat_cols) < 2:
        return None

    df_sorted = df.sort_values('timestamp').reset_index(drop=True)
    return {'df': df_sorted, 'features': feat_cols}


def fit_combined_classifier(data: dict) -> dict | None:
    """Train XGBoost classifier on trades (1) vs rejected (0) with walk-forward CV."""
    import xgboost as xgb
    from sklearn.metrics import accuracy_score, roc_auc_score, precision_score, recall_score

    df = data['df']
    feat = data['features']
    X = df[feat].fillna(0).values
    y = df['label'].values
    n = len(df)
    if n < 15:
        return None

    folds, last_train, _ = _walk_forward_folds(n)
    n_pos = y.sum()
    scale_pos = (n - n_pos) / n_pos if n_pos > 0 else 1

    y_test_all, y_prob_all, y_pred_all = [], [], []
    for fe, te in folds:
        X_tr, X_te = X[:fe], X[fe:te]
        y_tr, y_te = y[:fe], y[fe:te]
        m = xgb.XGBClassifier(
            n_estimators=100, max_depth=3, learning_rate=0.1,
            random_state=cfg.SEED, scale_pos_weight=scale_pos,
            eval_metric='logloss',
        )
        m.fit(X_tr, y_tr, verbose=False)
        y_prob = m.predict_proba(X_te)[:, 1]
        y_pred = (y_prob >= 0.5).astype(int)
        y_test_all.extend(y_te)
        y_prob_all.extend(y_prob)
        y_pred_all.extend(y_pred)

    y_test_a = np.array(y_test_all)
    y_prob_a = np.array(y_prob_all)
    y_pred_a = np.array(y_pred_all)

    return {
        'accuracy': accuracy_score(y_test_a, y_pred_a),
        'auc': roc_auc_score(y_test_a, y_prob_a) if len(np.unique(y_test_a)) > 1 else 0,
        'precision': precision_score(y_test_a, y_pred_a, zero_division=0),
        'recall': recall_score(y_test_a, y_pred_a, zero_division=0),
        'n_trades': int(y_test_a.sum()),
        'n_rejected': int((1 - y_test_a).sum()),
        'features': feat,
    }


# ── SHAP Explanation (Classifier) ───────────────────────────────────────────

def shap_analysis(df: pd.DataFrame, target: str = 'is_win') -> dict | None:
    try:
        import shap
        import xgboost as xgb
    except ImportError:
        return None

    avail = pre_trade_features(df)
    if len(avail) < 2 or target not in df.columns:
        return None

    df_sorted = df.sort_values('exit_time').reset_index(drop=True)
    X = df_sorted[avail].fillna(0).values
    y = df_sorted[target].values
    n = len(df_sorted)
    if n < 10:
        return None

    _, train_end, test_end = _walk_forward_folds(n)
    if train_end < 5 or test_end - train_end < 3:
        train_end = int(n * 0.7)
    X_train, X_test = X[:train_end], X[train_end:test_end]
    y_train = y[:train_end]

    n_pos = y_train.sum()
    scale_pos = (len(y_train) - n_pos) / n_pos if n_pos > 0 else 1

    model = xgb.XGBClassifier(
        n_estimators=100, max_depth=3, learning_rate=0.1,
        random_state=42, scale_pos_weight=scale_pos,
        eval_metric='logloss',
    )
    model.fit(X_train, y_train, verbose=False)

    explainer = shap.Explainer(model, X_train)
    shap_values = explainer(X_test)
    mean_shap = np.abs(shap_values.values).mean(axis=0)
    return {
        'feature_importance': pd.DataFrame({
            'feature': avail, 'mean_shap': mean_shap,
        }).sort_values('mean_shap', ascending=False),
        'n_train': train_end,
        'n_test': test_end - train_end,
    }


# ── Permutation Importance (Classifier) ─────────────────────────────────────

def permutation_importance(df: pd.DataFrame, target: str = 'is_win', n_repeats: int = 30) -> pd.DataFrame | None:
    try:
        import xgboost as xgb
    except ImportError:
        return None
    from sklearn.inspection import permutation_importance as sk_perm

    avail = pre_trade_features(df)
    if len(avail) < 2 or target not in df.columns:
        return None

    df_sorted = df.sort_values('exit_time').reset_index(drop=True)
    X = df_sorted[avail].fillna(0).values
    y = df_sorted[target].values
    n = len(df_sorted)
    if n < 10:
        return None

    _, train_end, test_end = _walk_forward_folds(n)
    if train_end < 5 or test_end - train_end < 3:
        train_end = int(n * 0.7)
        test_end = n
    X_train, X_test = X[:train_end], X[train_end:test_end]
    y_train, y_test = y[:train_end], y[train_end:test_end]

    n_pos = y_train.sum()
    scale_pos = (len(y_train) - n_pos) / n_pos if n_pos > 0 else 1

    model = xgb.XGBClassifier(
        n_estimators=100, max_depth=3, learning_rate=0.1,
        random_state=42, scale_pos_weight=scale_pos,
        eval_metric='logloss',
    )
    model.fit(X_train, y_train, verbose=False)

    r = sk_perm(model, X_test, y_test, n_repeats=n_repeats, random_state=cfg.SEED, n_jobs=-1)
    return pd.DataFrame({
        'feature': avail,
        'importance_mean': r.importances_mean,
        'importance_std': r.importances_std,
    }).sort_values('importance_mean', ascending=False)


# ── Bootstrap Confidence Intervals ────────────────────────────────────────────

def bootstrap_ci(df: pd.DataFrame, n_bootstrap: int = 5000) -> dict:
    np.random.seed(cfg.SEED)
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

def simulate_trade_ticks(price_path: list, entry_price: float, params: dict) -> tuple[float, str]:
    """
    Replay tick-level price path through exit logic.
    Returns (pnl_percent, exit_reason).
    Supports SL, TP, break-even, trailing, dead, TTL — all without MFE look-ahead.
    """
    if not price_path or len(price_path) < 2:
        return 0, 'no_path'

    entry_time = price_path[0][0]
    highest = entry_price
    stop_loss = entry_price * (1 + params['stop_loss'])
    take_profit = entry_price * (1 + params['take_profit'])
    be_activate = entry_price * (1 + params.get('break_even_activate', 0.10))
    trail_activate_pct = params.get('trail_activate', 0.25)
    trail_distance = params.get('trail_distance', 0.12)
    dead_hold_ms = params.get('dead_hold_ms', 240_000)
    ttl_ms = params.get('ttl_ms', 24 * 3600_000)
    trailing_activated = False

    for ts, price in price_path[1:]:
        if price > highest:
            highest = price

        # Break-even: after +BE% lock in entry
        if highest >= be_activate and stop_loss < entry_price * 0.999:
            stop_loss = entry_price * 0.995

        # Stop loss
        if price <= stop_loss:
            sim_pnl = (price - entry_price) / entry_price
            return sim_pnl, 'sl'

        # Take profit
        if price >= take_profit:
            sim_pnl = (price - entry_price) / entry_price
            return sim_pnl, 'tp'

        # TTL
        if ts - entry_time >= ttl_ms:
            sim_pnl = (price - entry_price) / entry_price
            return sim_pnl, 'ttl'

        # Dead hold: never green past deadline
        hold = ts - entry_time
        if hold >= dead_hold_ms and highest <= entry_price * 1.001:
            sim_pnl = (price - entry_price) / entry_price
            return sim_pnl, 'dead'

        # Trailing stop
        if not trailing_activated:
            if highest >= entry_price * (1 + trail_activate_pct):
                trailing_activated = True
        if trailing_activated:
            trail_stop = highest * (1 - trail_distance)
            if price <= trail_stop:
                sim_pnl = (price - entry_price) / entry_price
                return sim_pnl, 'trailing'

    # Never exited — use last tick
    last_price = price_path[-1][1]
    sim_pnl = (last_price - entry_price) / entry_price
    return sim_pnl, 'end_of_data'


def filtered_trades(params: dict, raw: list) -> list:
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
        if r['price_path']:
            sim_pnl_pct, reason = simulate_trade_ticks(r['price_path'], r['entry_price'], params)
        else:
            sim_pnl_pct = r['pnl_pct_actual']
            sim_pnl_pct = max(sim_pnl_pct, -abs(params['stop_loss']))
            sim_pnl_pct = min(sim_pnl_pct, params['take_profit'])
        sim_pnl = sim_pnl_pct * r['notional']
        selected.append({'pnl_pct': sim_pnl_pct, 'sim_pnl': sim_pnl, 'notional': r['notional']})
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
    return pf_from_pnl_list(filtered_trades(params, raw))


def optuna_optimize(df: pd.DataFrame, n_trials: int = 1000) -> dict | None:
    """
    Optimize weights + filters + exits to maximize PF.
    Multi-fold walk-forward (folds 0-2 only; fold 3 is final untouched holdout).
    """
    try:
        import optuna
    except ImportError:
        return None

    df_sorted = df.sort_values('exit_time').reset_index(drop=True)
    n = len(df_sorted)
    if n < 30:
        return None

    all_folds, holdout_train_end, _ = _walk_forward_folds(n)
    # Use only the first 3 folds for optimization; reserve the last (85-100%) as true final holdout
    fold_splits = all_folds[:-1] if len(all_folds) > 1 else all_folds
    if not fold_splits:
        fold_splits = [(int(n * 0.6), int(n * 0.85))]

    train_raw_all = _df_to_raw(df_sorted)

    def compute_pf_for_split(params: dict, train_end: int, test_end: int) -> dict:
        train_raw = train_raw_all[:train_end]
        test_raw = train_raw_all[train_end:test_end]
        train_pf = compute_pf_full(params, train_raw)
        test_selected = filtered_trades(params, test_raw)
        test_pf = pf_from_pnl_list(test_selected) if len(test_selected) >= 3 else 0
        n_test = len(test_selected)
        wins = sum(1 for t in test_selected if t['pnl_pct'] > 0)
        wr = wins / n_test if n_test > 0 else 0
        cumulative = [t['sim_pnl'] for t in test_selected]
        equity = np.cumsum(cumulative) if cumulative else np.array([0])
        max_dd = (equity / np.maximum.accumulate(equity) - 1).min() if len(equity) > 0 else 0
        return {
            'train_pf': train_pf,
            'test_pf': test_pf,
            'n_test': n_test,
            'wr': wr,
            'max_dd': max_dd,
        }

    def objective(trial):
        params = _suggest_params(trial)
        results = [compute_pf_for_split(params, te, tte) for te, tte in fold_splits]
        avg_test_pf = sum(r['test_pf'] for r in results) / len(results)
        total_n = sum(r['n_test'] for r in results)
        avg_wr = sum(r['wr'] for r in results) / len(results)
        max_dd = min(r['max_dd'] for r in results)
        score = avg_test_pf * np.sqrt(total_n) * avg_wr - abs(max_dd)
        return score

    study = optuna.create_study(direction='maximize', sampler=optuna.samplers.TPESampler(seed=cfg.SEED))
    study.optimize(objective, n_trials=n_trials, show_progress_bar=False)

    best = study.best_params
    train_pfs = []
    all_test_trades: list[dict] = []
    fold_sizes = []
    for te, tte in fold_splits:
        r = compute_pf_for_split(best, te, tte)
        train_pfs.append(r['train_pf'])
        test_raw = train_raw_all[te:tte]
        selected = filtered_trades(best, test_raw)
        all_test_trades.extend(selected)
        fold_sizes.append((te, tte, len(test_raw), len(selected)))
    train_pf = sum(train_pfs) / len(train_pfs)
    test_pf = pf_from_pnl_list(all_test_trades)

    # ── Final untouched holdout (fold 3: 85-100%) ──
    holdout_start = holdout_train_end
    holdout_raw = train_raw_all[holdout_start:]
    holdout_trades = filtered_trades(best, holdout_raw)
    holdout_pf = pf_from_pnl_list(holdout_trades) if len(holdout_trades) >= 3 else None

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
        'holdout_pf': holdout_pf,
        'n_holdout_trades': len(holdout_trades),
        'n_folds': len(fold_splits),
        'fold_sizes': [(tr, te, n_raw, n_sel) for tr, te, n_raw, n_sel in fold_sizes],
        'pooled_test_trades': len(all_test_trades),
        'trials': n_trials,
        'study': study,
        'n_params': len(best),
    }


def _df_to_raw(df_slice):
    """Convert a DataFrame slice to the raw list format with price_path."""
    raw = []
    for _, row in df_slice.iterrows():
        entry_px = row.get('entry_price') or 0
        qty = row.get('quantity') or 0
        pp = row.get('price_path', '')
        price_path = json.loads(pp) if isinstance(pp, str) and pp.startswith('[') else []
        raw.append({
            'wallet': row.get('feat_wallets', 0),
            'liq': row.get('feat_liquidity', 0),
            'buy_r': row.get('feat_buyRatio', 0.5),
            'age_ms': row.get('signal_age_ms', 0),
            'pnl_pct_actual': row['pnl_percent'],
            'entry_price': entry_px,
            'quantity': qty,
            'notional': entry_px * qty,
            'price_path': price_path,
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
        'break_even_activate': trial.suggest_float('break_even_activate', 0.05, 0.30, step=0.05),
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
    if len(pre_trade_features(df)) >= 2:
        print("Feature importance (logistic regression)...")
        result['feature_importance_lr'] = feature_importance(df)

    # XGBoost classifier (P(win)) → expected value
    if len(pre_trade_features(df)) >= 2:
        print("XGBoost classifier (P(win))...")
        result['classifier'] = xgb_classifier(df)
        if result.get('classifier'):
            c = result['classifier']
            print(f"  Accuracy={c['accuracy']:.1%}  AUC={c['auc']:.3f}  "
                  f"Prec={c['precision']:.1%}  Recall={c['recall']:.1%}")
            print(f"  Avg win=${c['avg_win_usd']:.4f}  Avg loss=${c['avg_loss_usd']:.4f}")
            print(f"  Expected value: mean=${c['ev_mean']:.4f}  median=${c['ev_median']:.4f}")

            print("Permutation importance...")
            result['permutation_imp'] = permutation_importance(df)

            print("SHAP analysis...")
            result['shap'] = shap_analysis(df)
            if result.get('shap'):
                top = result['shap']['feature_importance'].head(5)
                print(f"  Top features:\n{top.to_string(index=False)}")

    # Combined classifier (trades=1 + rejected=0)
    if rejected_csv:
        print("Combined classifier (trades vs rejected)...")
        combined = load_data_for_classifier(trades_csv, rejected_csv)
        if combined:
            result['combined_clf'] = fit_combined_classifier(combined)
            if result.get('combined_clf'):
                cc = result['combined_clf']
                print(f"  Accuracy={cc['accuracy']:.1%}  AUC={cc['auc']:.3f}  "
                      f"Prec={cc['precision']:.1%}  Recall={cc['recall']:.1%}")
                print(f"  Trades (1): {cc['n_trades']}  Rejected (0): {cc['n_rejected']}")

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

    if result.get('classifier'):
        c = result['classifier']
        print(f"\nXGBoost Classifier (P(win)) — expanding walk-forward:")
        print(f"  Accuracy={c['accuracy']:.1%}  AUC={c['auc']:.3f}  "
              f"Prec={c['precision']:.1%}  Recall={c['recall']:.1%}")
        print(f"  Avg win=${c['avg_win_usd']:.4f}  Avg loss=${c['avg_loss_usd']:.4f}")
        print(f"  Expected value: mean=${c['ev_mean']:.4f}  median=${c['ev_median']:.4f}")
        if c.get('fold_details'):
            print(f"  Across {len(c['fold_details'])} folds:")
            avg_acc = np.mean([f['accuracy'] for f in c['fold_details']])
            avg_auc = np.mean([f['auc'] for f in c['fold_details']])
            print(f"    Avg accuracy={avg_acc:.1%}  Avg AUC={avg_auc:.3f}")

    if result.get('combined_clf'):
        cc = result['combined_clf']
        print(f"\nCombined Classifier (trades[1] vs rejected[0]):")
        print(f"  Accuracy={cc['accuracy']:.1%}  AUC={cc['auc']:.3f}  "
              f"Prec={cc['precision']:.1%}  Recall={cc['recall']:.1%}")
        print(f"  Trades in test: {cc['n_trades']}  Rejected in test: {cc['n_rejected']}")

    if result.get('permutation_imp') is not None:
        print(f"\nPermutation Importance (XGBoost Classifier):")
        print(result['permutation_imp'].to_string(index=False))

    if result.get('shap'):
        print(f"\nSHAP Feature Importance (mean |SHAP|):")
        print(result['shap']['feature_importance'].to_string(index=False))

    if result.get('feature_importance_lr') is not None:
        print(f"\nLogistic Regression Coefficients (L1 — sparse):")
        lr = result['feature_importance_lr']
        nonzero = lr[lr['abs_coef'] > 1e-6]
        if len(nonzero):
            print(nonzero.to_string(index=False))
        else:
            print("  All features eliminated by L1 penalty")

    if result.get('bootstrap'):
        b = result['bootstrap']
        print(f"\nBootstrap 95% CI (n={5000}):")
        for k, v in b.items():
            lo, hi = v['ci_95']
            print(f"  {k}: {v['mean']:.4f} [{lo:.4f}, {hi:.4f}]")

    if result.get('holdout_pf') is not None:
        print(f"\nFinal untouched holdout (fold 3, 85-100%):")
        print(f"  PF={result['holdout_pf']:.2f}  n={result['n_holdout_trades']}")


if __name__ == '__main__':
    import sys
    tc = sys.argv[1] if len(sys.argv) > 1 else 'data/trades.csv'
    rc = sys.argv[2] if len(sys.argv) > 2 else None
    r = run_analysis(tc, rc)
    print_report(r)
