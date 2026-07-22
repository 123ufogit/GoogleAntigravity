#!/usr/bin/env python
# -*- coding: utf-8 -*-

"""
server.py
WebGISのバックエンドサーバー。APIと静的ファイルを配信します。
"""

import os
import json
import sqlite3
import urllib.request
import urllib.parse
from http.server import SimpleHTTPRequestHandler, HTTPServer
import sys

# ポート番号
PORT = 8000
# データベースのパス
DB_PATH = "climate_mesh.db"

def latlon_to_mesh(lat, lon):
    """緯度経度から3次メッシュコードを算出する"""
    try:
        p = int(lat * 1.5)
        u = int(lon - 100)
        
        lat_rem = lat * 1.5 - p
        lon_rem = lon - 100 - u
        
        q = int(lat_rem * 8)
        v = int(lon_rem * 8)
        
        lat_rem2 = lat_rem * 8 - q
        lon_rem2 = lon_rem * 8 - v
        
        r = int(lat_rem2 * 10)
        w = int(lon_rem2 * 10)
        
        return f"{p:02d}{u:02d}{q}{v}{r}{w}"
    except Exception:
        return None

def mesh_to_bbox(mesh_code):
    """3次メッシュコードから緯度経度範囲（四隅）を算出する"""
    try:
        mesh_code = str(mesh_code)
        if len(mesh_code) != 8:
            return None
        p = int(mesh_code[0:2])
        u = int(mesh_code[2:4])
        q = int(mesh_code[4])
        v = int(mesh_code[5])
        r = int(mesh_code[6])
        w = int(mesh_code[7])
        
        lat_sw = (p / 1.5) + (q / 12.0) + (r / 120.0)
        lon_sw = (u + 100.0) + (v / 8.0) + (w / 80.0)
        
        lat_ne = lat_sw + (1.0 / 120.0)
        lon_ne = lon_sw + (1.0 / 80.0)
        
        return {
            "south": lat_sw,
            "west": lon_sw,
            "north": lat_ne,
            "east": lon_ne
        }
    except Exception:
        return None

def get_elevation_from_gsi(lat, lon):
    """国土地理院の標高APIから標高を取得する"""
    url = f"https://cyberjapandata2.gsi.go.jp/general/dem/scripts/getelevation.php?lon={lon}&lat={lat}&outtype=JSON"
    try:
        req = urllib.request.Request(
            url, 
            headers={'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'}
        )
        with urllib.request.urlopen(req, timeout=3.0) as response:
            data = json.loads(response.read().decode('utf-8'))
            elevation = data.get("elevation")
            hsrc = data.get("hsrc", "不明")
            
            # 国土地理院APIがデータなしのときに返す "-----" のハンドリング
            if elevation == "-----" or elevation is None:
                return None, hsrc
            return float(elevation), hsrc
    except Exception as e:
        print(f"警告: 国土地理院標高APIの呼び出しに失敗しました: {e}", file=sys.stderr)
        return None, "APIエラー"

def extract_climate_data(db_path, mesh_code):
    """SQLiteから気候値メッシュデータを取得してパースする"""
    guide_info = {
        "guide_url": "/download_guide.html",
        "official_url": "https://nlftp.mlit.go.jp/ksj/gml/datalist/KsjTmplt-G02-v3_0.html"
    }
    
    if not os.path.exists(db_path):
        return {"has_data": False, "reason": "データベースファイルが存在しません。process_climate_mesh.pyを実行してください。", **guide_info}
        
    try:
        conn = sqlite3.connect(db_path)
        conn.row_factory = sqlite3.Row
        cursor = conn.cursor()
        
        # テーブル構造の確認
        cursor.execute("PRAGMA table_info(climate_data)")
        columns = [row["name"] for row in cursor.fetchall()]
        
        if not columns:
            conn.close()
            return {"has_data": False, "reason": "データベース内にテーブルが存在しません。", **guide_info}
            
        # メッシュコードカラムの特定
        mesh_col = columns[0]
        
        cursor.execute(f"SELECT * FROM climate_data WHERE {mesh_col} = ?", (mesh_code,))
        row = cursor.fetchone()
        
        if not row:
            conn.close()
            return {"has_data": False, "reason": "該当するメッシュコードの気候データがありません。", **guide_info}
            
        data_dict = dict(row)
        conn.close()
        
        # 第3.0版（カラム数が90件以上）を判定
        # G02_002〜G02_092 のカラム構成をパース
        is_ver3 = "G02_092" in data_dict or len(columns) >= 90
        
        climate_summary = {
            "has_data": True,
            "version": "3.0" if is_ver3 else "1.x/2.x"
        }
        
        def safe_div10(val):
            return round(val * 0.1, 1) if val is not None else None
            
        if is_ver3:
            # 降水量 (G02_002 ~ 013: 1~12月, G02_014: 年合計) 0.1mm単位
            precip_monthly = [safe_div10(data_dict.get(f"G02_{i:03d}")) for i in range(2, 14)]
            precip_annual = safe_div10(data_dict.get("G02_014"))
            
            # 平均気温 (G02_015 ~ 026: 1~12月, G02_027: 年平均) 0.1℃単位
            temp_monthly = [safe_div10(data_dict.get(f"G02_{i:03d}")) for i in range(15, 27)]
            temp_annual = safe_div10(data_dict.get("G02_027"))
            
            # 日最高気温平均 (G02_028 ~ 039: 1~12月, G02_040: 年平均) 0.1℃単位
            temp_max_monthly = [safe_div10(data_dict.get(f"G02_{i:03d}")) for i in range(28, 40)]
            temp_max_annual = safe_div10(data_dict.get("G02_040"))
            
            # 日最低気温平均 (G02_041 ~ 052: 1~12月, G02_053: 年平均) 0.1℃単位
            temp_min_monthly = [safe_div10(data_dict.get(f"G02_{i:03d}")) for i in range(41, 53)]
            temp_min_annual = safe_div10(data_dict.get("G02_053"))
            
            # 最深積雪 (G02_054 ~ 065: 1~12月, G02_066: 年最大値) 1cm単位
            snow_monthly = [data_dict.get(f"G02_{i:03d}") for i in range(54, 66)]
            snow_max = data_dict.get("G02_066")
            
            # 日照時間 (G02_067 ~ 078: 1~12月, G02_079: 年合計) 0.1時間単位
            sun_monthly = [safe_div10(data_dict.get(f"G02_{i:03d}")) for i in range(67, 79)]
            sun_annual = safe_div10(data_dict.get("G02_079"))
            
            # 全天日射量 (G02_080 ~ 091: 1~12月, G02_092: 年平均) 0.1 MJ/m2 単位
            solar_monthly = [safe_div10(data_dict.get(f"G02_{i:03d}")) for i in range(80, 92)]
            solar_annual = safe_div10(data_dict.get("G02_092"))
            
            climate_summary.update({
                "precipitation_annual": precip_annual,
                "precipitation_monthly": precip_monthly,
                "temperature_average": temp_annual,
                "temperature_average_monthly": temp_monthly,
                "temperature_max_annual": temp_max_annual,
                "temperature_max_monthly": temp_max_monthly,
                "temperature_min_annual": temp_min_annual,
                "temperature_min_monthly": temp_min_monthly,
                "snow_depth_max": snow_max,
                "snow_depth_monthly": snow_monthly,
                "sunshine_annual": sun_annual,
                "sunshine_monthly": sun_monthly,
                "solar_radiation_average": solar_annual,
                "solar_radiation_monthly": solar_monthly
            })
            
        else:
            # 旧バージョン (G02_004〜G02_015: 降水量1〜12月, G02_016: 年合計 などを想定したフォールバック)
            # カラムをそのまま辞書で返却し、フロントエンド側で処理できるようにする
            climate_summary["raw_data"] = data_dict
            
        return climate_summary
    except Exception as e:
        return {"has_data": False, "reason": f"データベースクエリ中にエラーが発生しました: {e}"}

class WebGISHandler(SimpleHTTPRequestHandler):
    """APIリクエストと静的ファイルをハンドリングする"""
    
    def do_GET(self):
        parsed_url = urllib.parse.urlparse(self.path)
        path = parsed_url.path
        
        # APIエンドポイント: /api/status
        if path == "/api/status":
            db_exists = os.path.exists(DB_PATH)
            record_count = 0
            if db_exists:
                try:
                    conn = sqlite3.connect(DB_PATH)
                    cursor = conn.cursor()
                    cursor.execute("SELECT COUNT(*) FROM climate_data")
                    record_count = cursor.fetchone()[0]
                    conn.close()
                except Exception:
                    pass
            self.send_json({
                "db_exists": db_exists,
                "record_count": record_count,
                "guide_url": "/download_guide.html",
                "official_url": "https://nlftp.mlit.go.jp/ksj/gml/datalist/KsjTmplt-G02-v3_0.html"
            })
            return

        # APIエンドポイント: /api/climate
        if path == "/api/climate":
            query = urllib.parse.parse_qs(parsed_url.query)
            lat_arr = query.get("lat")
            lon_arr = query.get("lon")
            
            if not lat_arr or not lon_arr:
                self.send_error_json(400, "必須パラメータ 'lat' または 'lon' が不足しています。")
                return
                
            try:
                lat = float(lat_arr[0])
                lon = float(lon_arr[0])
            except ValueError:
                self.send_error_json(400, "パラメータ 'lat' または 'lon' は数値である必要があります。")
                return
                
            # メッシュコードの計算
            mesh_code = latlon_to_mesh(lat, lon)
            if not mesh_code:
                self.send_error_json(400, "無効な緯度経度です。日本国内の座標を指定してください。")
                return
                
            # 境界の計算
            bbox = mesh_to_bbox(mesh_code)
            
            # 国土地理院から標高を取得
            elevation, hsrc = get_elevation_from_gsi(lat, lon)
            
            # 気候データを取得
            climate = extract_climate_data(DB_PATH, mesh_code)
            
            response_data = {
                "mesh_code": mesh_code,
                "bbox": bbox,
                "elevation": elevation,
                "elevation_source": hsrc,
                "climate": climate
            }
            
            self.send_json(response_data)
            
        else:
            # それ以外は静的ファイルを配信用に親クラスのメソッドを呼ぶ
            # ルートパスにアクセスした場合は index.html を返す
            if path == "/":
                self.path = "/index.html"
            super().do_GET()

    def send_json(self, data, status=200):
        """JSON形式でレスポンスを返す"""
        try:
            response_body = json.dumps(data, ensure_ascii=False).encode('utf-8')
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(response_body)))
            self.send_header("Access-Control-Allow-Origin", "*") # 開発用のCORS許可
            self.end_headers()
            self.wfile.write(response_body)
        except Exception as e:
            print(f"エラー: レレスポンス送信中にエラーが発生しました: {e}", file=sys.stderr)

    def send_error_json(self, status, message):
        """JSON形式のエラーメッセージを返す"""
        self.send_json({"error": message}, status=status)

def run_server():
    server_address = ('', PORT)
    httpd = HTTPServer(server_address, WebGISHandler)
    print(f"WebGIS サーバーを起動しました: http://localhost:{PORT}")
    print("終了するには Ctrl+C を押してください。")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nサーバーを停止しています...")
        httpd.server_close()
        print("停止しました。")

if __name__ == "__main__":
    run_server()
