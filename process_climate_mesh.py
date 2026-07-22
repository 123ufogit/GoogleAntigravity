#!/usr/bin/env python
# -*- coding: utf-8 -*-

"""
process_climate_mesh.py
国土数値情報「平年値メッシュデータ」のDBFファイルをSQLiteデータベースに集約・変換するスクリプト。
"""

import os
import sqlite3
import argparse
import glob
import shapefile
import sys
import webbrowser
from pathlib import Path

def get_dbf_files(src_path):
    """
    指定されたパスからDBFファイルの一覧を取得する。
    """
    if os.path.isfile(src_path):
        if src_path.lower().endswith('.dbf'):
            return [src_path]
        elif src_path.lower().endswith('.shp'):
            return [src_path.replace('.shp', '.dbf')]
        else:
            print(f"エラー: サポートされていないファイル形式です: {src_path}", file=sys.stderr)
            return []
    
    # ディレクトリの場合、再帰的に検索
    dbf_files = glob.glob(os.path.join(src_path, "**", "*.dbf"), recursive=True)
    # 大文字・小文字両対応
    dbf_files.extend(glob.glob(os.path.join(src_path, "**", "*.DBF"), recursive=True))
    # 重複排除
    return sorted(list(set(dbf_files)))

def create_database(db_path, dbf_fields):
    """
    SQLiteデータベースとテーブルを作成する。
    """
    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()
    
    # dbf_fieldsは ('G02_001', 'C', 8, 0) のような形式のリスト
    # 主キーは3次メッシュコード（通常 G02_001 またはそれに類する最初のカラム）
    mesh_code_col = None
    other_cols = []
    
    for f in dbf_fields:
        col_name = f[0]
        col_type = f[1] # 'C' (文字), 'N' (数値), 'F' (実数) など
        
        # 最初に見つかった文字型で長さが8前後の列をメッシュコードとみなす
        if mesh_code_col is None and (col_name.endswith('001') or 'code' in col_name.lower()):
            mesh_code_col = col_name
        else:
            # 型のマッピング
            sql_type = "INTEGER"
            if col_type == 'C':
                sql_type = "TEXT"
            elif col_type in ('F', 'N') and f[3] > 0: # 小数部桁数が1以上ならREAL
                sql_type = "REAL"
            
            other_cols.append((col_name, sql_type))
            
    if not mesh_code_col:
        # フォールバック: 最初のエントリをキーにする
        mesh_code_col = dbf_fields[0][0]
        other_cols = [(f[0], "TEXT" if f[1] == 'C' else "INTEGER") for f in dbf_fields[1:]]
        
    print(f"解析結果: メッシュコード列 = '{mesh_code_col}', 気候データ列数 = {len(other_cols)}")
    
    # メインテーブルの作成
    cols_def = [f"{mesh_code_col} TEXT PRIMARY KEY"]
    for col_name, sql_type in other_cols:
        cols_def.append(f"{col_name} {sql_type}")
        
    create_table_sql = f"CREATE TABLE IF NOT EXISTS climate_data ({', '.join(cols_def)})"
    cursor.execute(create_table_sql)
    
    # メタデータテーブルの作成
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS climate_meta (
            column_name TEXT PRIMARY KEY,
            sql_type TEXT,
            description TEXT
        )
    """)
    
    # メタデータの登録（既存のカラム情報を記録）
    for col_name, sql_type in other_cols:
        cursor.execute(
            "INSERT OR REPLACE INTO climate_meta (column_name, sql_type) VALUES (?, ?)",
            (col_name, sql_type)
        )
    # メッシュコード列も登録
    cursor.execute(
        "INSERT OR REPLACE INTO climate_meta (column_name, sql_type, description) VALUES (?, ?, ?)",
        (mesh_code_col, "TEXT", "3次メッシュコード")
    )
    
    conn.commit()
    conn.close()
    
    return mesh_code_col, [col[0] for col in other_cols]

def process_dbf(dbf_path, db_path, mesh_code_col, climate_cols):
    """
    1つのDBFファイルをSQLiteにインポートする。
    """
    print(f"ファイルを処理中: {os.path.basename(dbf_path)} ...")
    
    try:
        reader = shapefile.Reader(dbf=dbf_path)
    except Exception as e:
        print(f"エラー: DBFファイルを読み込めません: {dbf_path}. 原因: {e}", file=sys.stderr)
        return 0
        
    fields = [f[0] for f in reader.fields if f[0] != 'DeletionFlag']
    
    # 列名のインデックスマッピングを作成
    try:
        mesh_idx = fields.index(mesh_code_col)
    except ValueError:
        print(f"エラー: DBF内にメッシュコード列 '{mesh_code_col}' が見つかりません。フィールド一覧: {fields}", file=sys.stderr)
        return 0
        
    col_indices = []
    for col in climate_cols:
        if col in fields:
            col_indices.append((col, fields.index(col)))
        else:
            col_indices.append((col, None))
            
    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()
    
    # クエリの動的生成
    insert_cols = [mesh_code_col] + [col for col, _ in col_indices]
    placeholders = ",".join(["?"] * len(insert_cols))
    insert_sql = f"INSERT OR REPLACE INTO climate_data ({','.join(insert_cols)}) VALUES ({placeholders})"
    
    records_added = 0
    batch = []
    batch_size = 5000
    
    for record in reader.iterRecords():
        # メッシュコードの取得
        mesh_code = str(record[mesh_idx]).strip()
        if not mesh_code or len(mesh_code) < 8:
            continue
            
        row_values = [mesh_code]
        for col_name, idx in col_indices:
            if idx is None:
                row_values.append(None)
                continue
                
            val = record[idx]
            # 欠損値 (999999やそれに類する極端な値) のハンドリング
            if val == 999999 or val == "999999" or val is None:
                row_values.append(None)
            else:
                # 数値型で文字列として入っている場合があるためキャスト
                row_values.append(val)
                
        batch.append(row_values)
        
        if len(batch) >= batch_size:
            cursor.executemany(insert_sql, batch)
            records_added += len(batch)
            batch = []
            
    if batch:
        cursor.executemany(insert_sql, batch)
        records_added += len(batch)
        
    conn.commit()
    conn.close()
    
    print(f"  完了: {records_added} 件のレコードを登録/更新しました。")
    return records_added

def main():
    parser = argparse.ArgumentParser(description="国土数値情報 平年値メッシュデータ (DBF) を SQLite データベースに変換します。")
    parser.add_argument("--src_dir", "-s", default="data", help="Shapefile/DBFが格納されているディレクトリ、またはDBFファイルへのパス (デフォルト: 'data')")
    parser.add_argument("--db_out", "-o", default="climate_mesh.db", help="出力するSQLiteデータベースファイルパス (デフォルト: 'climate_mesh.db')")
    
    args = parser.parse_args()
    
    dbf_files = get_dbf_files(args.src_dir)
    if not dbf_files and args.src_dir == "data":
        # カレントディレクトリ以下をフォールバック検索
        dbf_files = get_dbf_files(".")
        
    if not dbf_files:
        download_url = "https://nlftp.mlit.go.jp/ksj/gml/datalist/KsjTmplt-G02-v3_0.html"
        guide_file = os.path.abspath("download_guide.html")
        
        print("=" * 60)
        print(f" [警告] '{args.src_dir}' 内に DBF ファイルが見つかりませんでした。")
        print("=" * 60)
        print("【データ取得とセットアップ手順】")
        print(f" 1. ダウンロードサイト: {download_url}")
        print(" 2. ZIP解凍後、.dbf / .shp ファイルを 'data/' フォルダ内に配置")
        print(" 3. 再度 'python process_climate_mesh.py' を実行")
        print("=" * 60)
        
        if os.path.exists(guide_file):
            guide_uri = Path(guide_file).as_uri()
            print(f"ガイド画面をブラウザで開きます:\n -> {guide_file}")
            try:
                webbrowser.open(guide_uri)
            except Exception as e:
                print(f"ブラウザの起動に失敗しました: {e}", file=sys.stderr)
        else:
            try:
                webbrowser.open(download_url)
            except Exception:
                pass
        return
        
    print(f"見つかったDBFファイル数: {len(dbf_files)}")
    
    # 最初のファイルのヘッダー情報を読み取ってデータベース構造を定義
    first_dbf = dbf_files[0]
    try:
        reader = shapefile.Reader(dbf=first_dbf)
        # DeletionFlagを除外したフィールドリスト
        dbf_fields = [f for f in reader.fields if f[0] != 'DeletionFlag']
    except Exception as e:
        print(f"エラー: 最初のDBFファイルを解析できません: {first_dbf}. 原因: {e}", file=sys.stderr)
        return
        
    mesh_code_col, climate_cols = create_database(args.db_out, dbf_fields)
    
    total_records = 0
    for dbf in dbf_files:
        total_records += process_dbf(dbf, args.db_out, mesh_code_col, climate_cols)
        
    print(f"\n============================================================")
    print(f" すべての処理が正常に完了しました！")
    print(f" 作成されたデータベース: {args.db_out}")
    print(f" 総登録レコード数    : {total_records} メッシュ")
    print(f"============================================================")
    print(f" 次の手順: 'python server.py' を実行してWebGISを起動してください。")

if __name__ == "__main__":
    main()
