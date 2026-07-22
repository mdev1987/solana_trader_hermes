"""Export SQLite trades/features/rejected signals to CSV via DuckDB."""

import duckdb
import pandas as pd
from pathlib import Path


DB_PATH = Path(__file__).resolve().parents[3] / 'data' / 'trader.db'
OUT_DIR = Path(__file__).resolve().parent / 'data'
TABLES = ['trades', 'features', 'rejected_signals', 'replay_state']


def export_csv(db_path: Path = DB_PATH, out_dir: Path = OUT_DIR) -> dict[str, pd.DataFrame]:
    if not db_path.exists():
        print(f"[export] DB not found: {db_path}")
        return {}
    out_dir.mkdir(parents=True, exist_ok=True)
    con = duckdb.connect()
    con.execute(f"INSTALL sqlite; LOAD sqlite;")
    con.execute(f"ATTACH '{db_path}' AS src (TYPE sqlite);")

    results = {}
    for tbl in TABLES:
        try:
            df = con.execute(f"SELECT * FROM src.{tbl}").fetchdf()
            if df.empty:
                print(f"[export] {tbl}: empty")
                continue
            path = out_dir / f"{tbl}.csv"
            df.to_csv(path, index=False)
            print(f"[export] {tbl}: {len(df)} rows → {path}")
            results[tbl] = df
        except Exception as e:
            print(f"[export] {tbl}: skipped ({e})")
    con.close()
    return results


if __name__ == '__main__':
    export_csv()
