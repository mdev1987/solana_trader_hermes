"""Statistical analysis, feature importance, XGBoost, SHAP, Optuna optimization."""

import pandas as pd
import numpy as np
from pathlib import Path
import json
import warnings
warnings.filterwarnings('ignore')


def parse_features(trade_row) -> dict:
    """Parse the features JSON column from a trade."""
    f = getattr(trade_row, 'features', None) or getattr(trade_row, 'features', '{}')
    if isinstance(f, str):
        try:
            return json.loads(f) if f else {}
        except (json.JSONDecodeError, TypeError):
            return {}
    return f or {}


def load_trades_from_csv(csv_path: str | Path) -> pd.DataFrame:
    df = pd.read_csv(csv_path)
    df['pnl'] = pd.to_numeric(df['pnl'], errors='coerce')
    df['pnl_percent'] = pd.to_numeric(df['pnl_percent'], errors='coerce')
    df['entry_score'] = pd.to_numeric(df['entry_score'], errors='coerce')
    df['signal_age_ms'] = pd.to_numeric(df['signal_age_ms'], errors='coerce')
    df['entry_delay_ms'] = pd.to_numeric(df['entry_delay_ms'], errors='coerce')
    df['entry_price'] = pd.to_numeric(df['entry_price'], errors='coerce')
    df['exit_price'] = pd.to_numeric(df['exit_price'], errors='coerce')
    df['max_price'] = pd.to_numeric(df['max_price'], errors='coerce')
    df['min_price'] = pd.to_numeric(df['min_price'], errors='coerce')

    # Parse features JSON into columns
    feat_rows = []
    for _, row in df.iterrows():
        feat = parse_features(row)
        feat_rows.append(feat)
    feat_df = pd.DataFrame(feat_rows)
    for col in feat_df.columns:
        feat_df[col] = pd.to_numeric(feat_df[col], errors='coerce')

    df = pd.concat([df, feat_df.add_prefix('feat_')], axis=1)

    # Derived features
    df['is_win'] = (df['pnl'] > 0).astype(int)
    df['mfe'] = (df['max_price'] - df['entry_price']) / df['entry_price']
    df['mae'] = (df['entry_price'] - df['min_price']) / df['entry_price']
    df['hold_sec'] = (df['exit_time'] - df['entry_time']) / 1000
    return df


def load_rejected_from_csv(csv_path: str | Path) -> pd.DataFrame:
    df = pd.read_csv(csv_path)
    numeric_cols = ['timestamp', 'score', 'activity_score', 'buy_ratio',
                    'wallet_count', 'liquidity', 'signal_age_ms', 'price']
    for c in numeric_cols:
        if c in df.columns:
            df[c] = pd.to_numeric(df[c], errors='coerce')
    return df


# ── Bucket Analysis ──────────────────────────────────────────────────────────

def bucket_analysis(df: pd.DataFrame) -> dict:
    results = {}

    # Score buckets
    score_buckets = [(45, 55, '45-54'), (55, 65, '55-64'), (65, 75, '65-74'),
                     (75, 85, '75-84'), (85, 999, '85+')]
    rows = []
    for lo, hi, label in score_buckets:
        sub = df[(df['entry_score'] >= lo) & (df['entry_score'] < hi)]
        if len(sub) == 0:
            continue
        wins = sub['is_win'].sum()
        rows.append({
            'bucket': label, 'n': len(sub), 'win_rate': wins / len(sub),
            'avg_pnl': sub['pnl'].mean(), 'total_pnl': sub['pnl'].sum(),
            'pf': sub[sub['pnl'] > 0]['pnl'].sum() / max(abs(sub[sub['pnl'] <= 0]['pnl'].sum()), 1e-9),
        })
    results['score_buckets'] = pd.DataFrame(rows)

    # Wallet buckets
    wallet_buckets = [(0, 100, '0-100'), (100, 200, '100-200'),
                      (200, 400, '200-400'), (400, 800, '400-800'),
                      (800, 1e9, '800+')]
    rows = []
    for lo, hi, label in wallet_buckets:
        sub = df[(df['feat_wallets'] >= lo) & (df['feat_wallets'] < hi)] if 'feat_wallets' in df.columns else df.iloc[:0]
        if len(sub) == 0:
            continue
        wins = sub['is_win'].sum()
        rows.append({
            'bucket': label, 'n': len(sub), 'win_rate': wins / len(sub),
            'total_pnl': sub['pnl'].sum(),
            'pf': sub[sub['pnl'] > 0]['pnl'].sum() / max(abs(sub[sub['pnl'] <= 0]['pnl'].sum()), 1e-9),
        })
    results['wallet_buckets'] = pd.DataFrame(rows)

    # Age buckets
    age_buckets = [(0, 5000, '0-5s'), (5000, 10000, '5-10s'),
                   (10000, 15000, '10-15s'), (15000, 20000, '15-20s'),
                   (20000, 30000, '20-30s'), (30000, 1e9, '30s+')]
    rows = []
    for lo, hi, label in age_buckets:
        sub = df[(df['signal_age_ms'] >= lo) & (df['signal_age_ms'] < hi)]
        if len(sub) == 0:
            continue
        wins = sub['is_win'].sum()
        rows.append({
            'bucket': label, 'n': len(sub), 'win_rate': wins / len(sub),
            'total_pnl': sub['pnl'].sum(),
            'pf': sub[sub['pnl'] > 0]['pnl'].sum() / max(abs(sub[sub['pnl'] <= 0]['pnl'].sum()), 1e-9),
        })
    results['age_buckets'] = pd.DataFrame(rows)

    # Exit reason breakdown
    if 'exit_reason' in df.columns:
        results['exit_reasons'] = df.groupby('exit_reason').agg(
            n=('pnl', 'count'),
            win_rate=('is_win', 'mean'),
            total_pnl=('pnl', 'sum'),
        ).reset_index()

    return results


# ── Feature Importance (Logistic Regression) ─────────────────────────────────

def feature_importance(df: pd.DataFrame) -> pd.DataFrame | None:
    from sklearn.linear_model import LogisticRegression
    from sklearn.preprocessing import StandardScaler

    feat_cols = ['entry_score', 'signal_age_ms', 'entry_delay_ms', 'feat_wallets',
                 'feat_liquidity', 'feat_buyRatio', 'feat_activity']
    avail = [c for c in feat_cols if c in df.columns and df[c].notna().sum() > 5]
    if len(avail) < 2:
        return None

    X = df[avail].fillna(0).values
    y = df['is_win'].values

    scaler = StandardScaler()
    X_scaled = scaler.fit_transform(X)

    model = LogisticRegression(max_iter=1000, random_state=42)
    model.fit(X_scaled, y)

    imp = pd.DataFrame({
        'feature': avail,
        'coef': model.coef_[0],
        'abs_coef': abs(model.coef_[0]),
    }).sort_values('abs_coef', ascending=False)
    return imp


# ── XGBoost Classifier ───────────────────────────────────────────────────────

def xgboost_analysis(df: pd.DataFrame) -> dict | None:
    from sklearn.model_selection import cross_val_score, train_test_split
    from sklearn.metrics import roc_auc_score, classification_report, confusion_matrix
    import xgboost as xgb

    feat_cols = ['entry_score', 'signal_age_ms', 'entry_delay_ms', 'feat_wallets',
                 'feat_liquidity', 'feat_buyRatio', 'feat_activity']
    avail = [c for c in feat_cols if c in df.columns and df[c].notna().sum() > 5]
    if len(avail) < 2:
        return None

    X = df[avail].fillna(0).values
    y = df['is_win'].values

    X_train, X_test, y_train, y_test = train_test_split(
        X, y, test_size=0.3, random_state=42, stratify=y
    )

    model = xgb.XGBClassifier(
        n_estimators=100, max_depth=3, learning_rate=0.1,
        random_state=42, eval_metric='logloss',
    )
    model.fit(X_train, y_train,
              eval_set=[(X_test, y_test)],
              verbose=False)

    y_pred = model.predict(X_test)
    y_prob = model.predict_proba(X_test)[:, 1]

    cv_scores = cross_val_score(model, X, y, cv=min(5, len(df) // 3))

    # Feature importance from XGBoost
    imp = pd.DataFrame({
        'feature': avail,
        'importance': model.feature_importances_,
    }).sort_values('importance', ascending=False)

    return {
        'model': model,
        'feature_names': avail,
        'accuracy': (y_pred == y_test).mean(),
        'roc_auc': roc_auc_score(y_test, y_prob),
        'cv_mean': cv_scores.mean(),
        'cv_std': cv_scores.std(),
        'feature_importance': imp,
        'confusion_matrix': confusion_matrix(y_test, y_pred).tolist(),
        'classification_report': classification_report(y_test, y_pred, output_dict=True),
        'X_train': X_train, 'X_test': X_test, 'y_train': y_train, 'y_test': y_test,
        'y_pred': y_pred, 'y_prob': y_prob,
    }


# ── SHAP Explanation ─────────────────────────────────────────────────────────

def shap_analysis(xgb_result: dict) -> dict | None:
    try:
        import shap
    except ImportError:
        return None

    model = xgb_result['model']
    X_test = xgb_result['X_test']
    feature_names = xgb_result['feature_names']

    explainer = shap.TreeExplainer(model)
    shap_values = explainer.shap_values(X_test)

    # Global feature importance via SHAP
    mean_shap = np.abs(shap_values).mean(axis=0)
    imp = pd.DataFrame({
        'feature': feature_names,
        'mean_shap': mean_shap,
    }).sort_values('mean_shap', ascending=False)

    return {
        'explainer': explainer,
        'shap_values': shap_values,
        'feature_importance': imp,
        'n_samples': len(X_test),
    }


# ── Optuna Weight Optimization ───────────────────────────────────────────────

def optuna_optimize(df: pd.DataFrame, n_trials: int = 500) -> dict | None:
    """Optimize scorer weights using Optuna to maximize profit factor."""
    try:
        import optuna
    except ImportError:
        return None

    from engine import FeatureSnapshot, Filters, Scorer

    # We need raw snapshot features per trade
    snapshots = []
    for _, row in df.iterrows():
        snapshots.append({
            'wallet_count': row.get('feat_wallets', 0),
            'liquidity': row.get('feat_liquidity', 0),
            'buy_ratio': row.get('feat_buyRatio', 0),
            'time_since_launch_ms': row.get('signal_age_ms', 0),
            'is_win': row['is_win'],
            'pnl': row['pnl'],
        })
    if len(snapshots) < 10:
        return None

    def compute_pf(weights: dict, snaps: list) -> float:
        w_wallet, w_age, w_liq = weights['wallet'], weights['age'], weights['liq']
        total_w = w_wallet + w_age + w_liq
        w_wallet /= total_w
        w_age /= total_w
        w_liq /= total_w

        trades = []
        for s in snaps:
            snap = FeatureSnapshot(
                mint='', timestamp=0,
                wallet_count=s['wallet_count'],
                liquidity=s['liquidity'],
                buy_ratio=s['buy_ratio'],
                time_since_launch_ms=s['time_since_launch_ms'],
            )
            score = (w_wallet * calc_wallet(s['wallet_count']) +
                     w_age * calc_signal_age(s['time_since_launch_ms']) +
                     w_liq * calc_liquidity(s['liquidity'])) * 100
            trades.append({'is_win': s['is_win'], 'pnl': s['pnl'], 'score': score})
        if not trades:
            return 0

        gross_win = sum(t['pnl'] for t in trades if t['pnl'] > 0)
        gross_loss = abs(sum(t['pnl'] for t in trades if t['pnl'] <= 0))
        return gross_win / gross_loss if gross_loss > 1e-9 else 999

    s_snap = FeatureSnapshot(mint='', timestamp=0, wallet_count=500, liquidity=1000, buy_ratio=0.5, time_since_launch_ms=15000)
    s_scorer = Scorer()

    def calc_wallet(w): return s_scorer._wallet_score(w)
    def calc_signal_age(a): return s_scorer._signal_age_score(a)
    def calc_liquidity(l): return s_scorer._liquidity_score(l)

    def objective(trial):
        w_wallet = trial.suggest_float('wallet', 0.05, 0.8)
        w_age = trial.suggest_float('age', 0.05, 0.8)
        w_liq = trial.suggest_float('liq', 0.05, 0.8)
        return compute_pf({'wallet': w_wallet, 'age': w_age, 'liq': w_liq}, snapshots)

    study = optuna.create_study(direction='maximize', sampler=optuna.samplers.TPESampler(seed=42))
    study.optimize(objective, n_trials=n_trials, show_progress_bar=False)

    best = study.best_params
    total = best['wallet'] + best['age'] + best['liq']
    best_norm = {k: v / total for k, v in best.items()}

    return {
        'best_params_raw': best,
        'best_params_norm': best_norm,
        'best_value': study.best_value,
        'trials': n_trials,
        'study': study,
    }


# ── Analysis Report ──────────────────────────────────────────────────────────

def run_analysis(trades_csv: str | Path, rejected_csv: str | Path | None = None) -> dict:
    print("Loading trades...")
    df = load_trades_from_csv(trades_csv)
    print(f"  {len(df)} trades loaded")

    if rejected_csv:
        rej = load_rejected_from_csv(rejected_csv)
        print(f"  {len(rej)} rejected signals loaded")
    else:
        rej = None

    result = {'n_trades': len(df)}

    # Basic stats
    wins = df[df['is_win'] == 1]
    losses = df[df['is_win'] == 0]
    result['win_rate'] = len(wins) / len(df) if len(df) else 0
    result['total_pnl'] = df['pnl'].sum()
    result['avg_win'] = wins['pnl'].mean() if len(wins) else 0
    result['avg_loss'] = losses['pnl'].mean() if len(losses) else 0
    gross_win = wins['pnl'].sum()
    gross_loss = abs(losses['pnl'].sum())
    result['pf'] = gross_win / gross_loss if gross_loss > 1e-9 else float('inf')

    print(f"  Win rate: {result['win_rate']*100:.1f}%")
    print(f"  PnL: ${result['total_pnl']:.4f}")
    print(f"  PF: {result['pf']:.2f}")

    # Buckets
    print("\nScore buckets...")
    result['buckets'] = bucket_analysis(df)

    # Feature importance
    if len(avail_features(df)) >= 2:
        print("Feature importance (logistic regression)...")
        result['feature_importance_lr'] = feature_importance(df)

        print("XGBoost classifier...")
        result['xgb'] = xgboost_analysis(df)
        if result.get('xgb'):
            print(f"  Accuracy: {result['xgb']['accuracy']:.3f}  ROC-AUC: {result['xgb']['roc_auc']:.3f}")
            print(f"  CV: {result['xgb']['cv_mean']:.3f} ± {result['xgb']['cv_std']:.3f}")

            print("SHAP analysis...")
            result['shap'] = shap_analysis(result['xgb'])
            if result.get('shap'):
                print(f"  Top features: {result['shap']['feature_importance'].head(3).to_string(index=False)}")
    else:
        print("Not enough features for ML analysis")

    return result


def avail_features(df: pd.DataFrame) -> list:
    feat_cols = ['entry_score', 'signal_age_ms', 'entry_delay_ms',
                 'feat_wallets', 'feat_liquidity', 'feat_buyRatio', 'feat_activity']
    return [c for c in feat_cols if c in df.columns and df[c].notna().sum() > 5]


def print_report(result: dict):
    print(f"\n{'='*60}")
    print("TRADING ANALYSIS REPORT")
    print(f"{'='*60}")
    print(f"Trades: {result['n_trades']}  Win rate: {result['win_rate']*100:.1f}%  "
          f"PnL: ${result['total_pnl']:.4f}  PF: {result['pf']:.2f}")

    if 'buckets' in result:
        for key, label in [('score_buckets', 'Score'), ('wallet_buckets', 'Wallet'), ('age_buckets', 'Age')]:
            bdf = result['buckets'].get(key)
            if bdf is not None and len(bdf):
                print(f"\n{label} Buckets:")
                print(bdf.to_string(index=False))

    if result.get('xgb'):
        x = result['xgb']
        print(f"\nXGBoost Classifier:")
        print(f"  Accuracy: {x['accuracy']:.3f}  ROC-AUC: {x['roc_auc']:.3f}")
        print(f"  CV: {x['cv_mean']:.3f} ± {x['cv_std']:.3f}")
        print(f"\nFeature Importance:")
        print(x['feature_importance'].to_string(index=False))

    if result.get('shap'):
        print(f"\nSHAP Feature Importance:")
        print(result['shap']['feature_importance'].to_string(index=False))


if __name__ == '__main__':
    import sys
    trades_csv = sys.argv[1] if len(sys.argv) > 1 else 'data/trades.csv'
    rejected_csv = sys.argv[2] if len(sys.argv) > 2 else None
    result = run_analysis(trades_csv, rejected_csv)
    print_report(result)
