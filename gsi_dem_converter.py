import os
import sys
import zipfile
import threading
import logging
import traceback
import xml.etree.ElementTree as ET
import tkinter as tk
from tkinter import ttk, filedialog, messagebox
import numpy as np
import rasterio
from rasterio.transform import from_origin
import re

def parse_mesh_code(filename):
    """ファイル名から4桁の1次メッシュコードを抽出し、概略の中心緯度経度を返す"""
    match = re.search(r'\b(\d{4})-\d{2}\b', filename)
    if not match:
        match = re.search(r'\b(\d{4})\b', filename)
    
    if match:
        mesh_code = match.group(1)
        lat = int(mesh_code[:2]) / 1.5
        lon = int(mesh_code[2:]) + 100
        # 1次メッシュコード（緯度40分、経度1度）の中心座標を求める
        return lat + 0.3333, lon + 0.5
    return None

def estimate_jgd_zone(lat, lon):
    """緯度と経度から、最適な平面直交座標系の系番号(1〜19)を推定する"""
    # 離島や特殊地域の判定
    # 19系: 南鳥島 (東経153度以東)
    if lon > 150.0:
        return 19
    # 18系: 沖ノ鳥島 (北緯21度以南)
    if lat < 21.0:
        return 18
    # 14系: 小笠原諸島 (北緯28度以南、東経140度以東)
    if lat < 28.0 and lon > 140.0:
        return 14
    # 17系: 八重山 (北緯25度以南、東経124.5度以西)
    if lat < 25.0 and lon < 124.5:
        return 17
    # 16系: 宮古 (北緯25度以南、東経126.0度以西)
    if lat < 25.0 and lon < 126.0:
        return 16
    # 15系: 沖縄本島周辺 (北緯28度以南、東経129.0度以西)
    if lat < 28.0 and lon < 129.0:
        return 15
    # 3系・4系: 奄美・トカラ (北緯30.5度以南、東経131.0度以西)
    if lat < 30.5 and lon < 131.0:
        if lat < 28.5:
            return 3  # 奄美
        else:
            return 4  # トカラ

    # 北海道 (北緯41.3度以北)
    if lat > 41.3:
        if lon < 141.2:
            return 11
        elif lon < 143.3:
            return 12
        else:
            return 13

    # 本州・四国・九州 (北緯30度〜42度)
    if lon < 130.25:
        if lon < 130.1:
            return 1
        else:
            return 2
    elif lon < 132.5:
        return 2
    elif lon < 135.15:
        return 5
    elif lon < 136.6:
        # 石川・福井（7系）と京都・大阪（6系）の境界調整
        if lat > 35.3 and lon > 135.6:
            return 7
        return 6
    elif lon < 137.87:
        return 7
    elif lon < 139.16:
        return 8
    elif lon < 140.33:
        if lat > 38.7:
            return 10
        return 9
    else:
        if lat > 38.9:
            return 10
        return 9

def parse_coords_from_xml_content_extended(xml_content):
    """XML文字列から Envelope を解析し、中心の緯度経度と、元データがJGD2000かどうかを返す"""
    root = ET.fromstring(xml_content)
    FGD_NS = '{http://fgd.gsi.go.jp/spec/2008/FGD_GMLSchema}'
    GML_NS = '{http://www.opengis.net/gml/3.2}'

    dem_elem = root.find(f'.//{FGD_NS}DEM')
    if dem_elem is None:
        dem_elem = root.find('.//DEM')
        if dem_elem is None:
            raise ValueError("XML内に DEM 要素が見つかりません。")

    coverage_elem = dem_elem.find(f'.//{FGD_NS}coverage')
    if coverage_elem is None:
        coverage_elem = dem_elem.find('.//coverage')
        if coverage_elem is None:
            raise ValueError("DEM要素内に coverage 要素が見つかりません。")

    envelope = coverage_elem.find(f'.//{GML_NS}Envelope')
    if envelope is None:
        raise ValueError("gml:Envelope が見つかりません。")

    srs_name = envelope.get('srsName', '')
    is_jgd2000 = 'jgd2000' in srs_name.lower()

    lower_corner = envelope.find(f'.//{GML_NS}lowerCorner')
    upper_corner = envelope.find(f'.//{GML_NS}upperCorner')
    if lower_corner is None or upper_corner is None:
        raise ValueError("lowerCorner または upperCorner が見つかりません。")

    c1_low, c2_low = map(float, lower_corner.text.strip().split())
    c1_up, c2_up = map(float, upper_corner.text.strip().split())

    if c1_low > c2_low:
        lon_min, lat_min = c1_low, c2_low
        lon_max, lat_max = c1_up, c2_up
    else:
        lat_min, lon_min = c1_low, c2_low
        lat_max, lon_max = c1_up, c2_up

    return (lat_min + lat_max) / 2.0, (lon_min + lon_max) / 2.0, is_jgd2000

def scan_input_directory_for_crs(input_dir):
    """入力フォルダをスキャンし、最初に見つかったXML等から推奨の系番号(1〜19)、元データがJGD2000かどうか、座標を返す"""
    for root_dir, _, filenames in os.walk(input_dir):
        for f in filenames:
            ext = os.path.splitext(f)[1].lower()
            file_path = os.path.join(root_dir, f)
            
            # まずファイル名から高速判定 (JGD2011をデフォルトとする)
            coords = parse_mesh_code(f)
            if coords:
                lat, lon = coords
                zone = estimate_jgd_zone(lat, lon)
                if zone:
                    return zone, False, lat, lon

            # ファイル名で判定できなかった場合は中身を解析
            if ext == '.xml':
                try:
                    with open(file_path, 'r', encoding='utf-8', errors='ignore') as file_obj:
                        xml_content = file_obj.read()
                    lat, lon, is_jgd2000 = parse_coords_from_xml_content_extended(xml_content)
                    zone = estimate_jgd_zone(lat, lon)
                    if zone:
                        return zone, is_jgd2000, lat, lon
                except Exception:
                    pass
            elif ext == '.zip':
                try:
                    with zipfile.ZipFile(file_path, 'r') as zf:
                        xml_members = [name for name in zf.namelist() if name.lower().endswith('.xml')]
                        if xml_members:
                            xml_content = zf.read(xml_members[0]).decode('utf-8', errors='ignore')
                            lat, lon, is_jgd2000 = parse_coords_from_xml_content_extended(xml_content)
                            zone = estimate_jgd_zone(lat, lon)
                            if zone:
                                return zone, is_jgd2000, lat, lon
                except Exception:
                    pass
    return None

class ConverterApp(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title("国土地理院 DEM XML -> GeoTIFF 変換ツール")
        self.geometry("700x550")
        self.minsize(600, 450)
        self.setup_ui()
        self.processing = False

    def setup_ui(self):
        # Configure styles
        style = ttk.Style()
        style.theme_use('vista' if os.name == 'nt' else 'clam')

        # Main container
        main_frame = ttk.Frame(self, padding="15")
        main_frame.pack(fill=tk.BOTH, expand=True)

        # Title
        title_label = ttk.Label(main_frame, text="国土地理院 基盤地図情報 DEM 変換ツール", font=("Helvetica", 14, "bold"))
        title_label.pack(anchor=tk.W, pady=(0, 15))

        # Folder selection frame
        folder_frame = ttk.LabelFrame(main_frame, text="フォルダ設定", padding="10")
        folder_frame.pack(fill=tk.X, pady=(0, 15))

        # Input folder
        ttk.Label(folder_frame, text="入力フォルダ (XML / ZIP):").grid(row=0, column=0, sticky=tk.W, pady=5)
        self.input_dir_var = tk.StringVar()
        self.input_entry = ttk.Entry(folder_frame, textvariable=self.input_dir_var, width=50)
        self.input_entry.grid(row=0, column=1, padx=5, pady=5, sticky=tk.EW)
        self.input_btn = ttk.Button(folder_frame, text="参照...", command=self.browse_input)
        self.input_btn.grid(row=0, column=2, padx=5, pady=5)

        # Output folder
        ttk.Label(folder_frame, text="出力フォルダ (GeoTIFF):").grid(row=1, column=0, sticky=tk.W, pady=5)
        self.output_dir_var = tk.StringVar()
        self.output_entry = ttk.Entry(folder_frame, textvariable=self.output_dir_var, width=50)
        self.output_entry.grid(row=1, column=1, padx=5, pady=5, sticky=tk.EW)
        self.output_btn = ttk.Button(folder_frame, text="参照...", command=self.browse_output)
        self.output_btn.grid(row=1, column=2, padx=5, pady=5)

        folder_frame.columnconfigure(1, weight=1)

        # Settings frame
        settings_frame = ttk.LabelFrame(main_frame, text="変換設定", padding="10")
        settings_frame.pack(fill=tk.X, pady=(0, 15))

        ttk.Label(settings_frame, text="座標参照系 (CRS):").grid(row=0, column=0, sticky=tk.W, pady=5)
        self.crs_var = tk.StringVar(value="EPSG:6697 (JGD2011 - 推奨)")
        
        # Base CRS options
        self.base_crs_values = [
            "EPSG:6697 (JGD2011 - 推奨)",
            "EPSG:4612 (JGD2000)",
            "EPSG:4326 (WGS84)"
        ]
        
        # JGD2011 Plane Rectangular Coordinate System (Zones 1-19)
        for i in range(1, 20):
            self.base_crs_values.append(f"EPSG:{6668 + i} (JGD2011 / 平面直交座標第{i}系)")
            
        # JGD2000 Plane Rectangular Coordinate System (Zones 1-19)
        for i in range(1, 20):
            self.base_crs_values.append(f"EPSG:{2442 + i} (JGD2000 / 平面直交座標第{i}系)")

        self.crs_combo = ttk.Combobox(settings_frame, textvariable=self.crs_var, values=self.base_crs_values, state="readonly", width=45)
        self.crs_combo.grid(row=0, column=1, padx=5, pady=5, sticky=tk.W)

        # Progress Bar and Controls
        control_frame = ttk.Frame(main_frame)
        control_frame.pack(fill=tk.X, pady=(0, 10))

        self.start_btn = ttk.Button(control_frame, text="変換開始", command=self.start_conversion)
        self.start_btn.pack(side=tk.LEFT, padx=(0, 10))

        self.progress_var = tk.DoubleVar()
        self.progress_bar = ttk.Progressbar(control_frame, variable=self.progress_var, maximum=100)
        self.progress_bar.pack(side=tk.LEFT, fill=tk.X, expand=True, pady=5)

        # Log frame
        log_frame = ttk.LabelFrame(main_frame, text="処理ログ / 進捗状況", padding="5")
        log_frame.pack(fill=tk.BOTH, expand=True)

        # Text log widget with Scrollbar
        self.log_text = tk.Text(log_frame, wrap=tk.WORD, height=12, state=tk.DISABLED, font=("Consolas", 9))
        self.log_text.pack(fill=tk.BOTH, expand=True, side=tk.LEFT)

        scrollbar = ttk.Scrollbar(log_frame, command=self.log_text.yview)
        scrollbar.pack(fill=tk.Y, side=tk.RIGHT)
        self.log_text.config(yscrollcommand=scrollbar.set)

        # Trace input directory changes for automatic CRS selection
        self.input_dir_var.trace_add("write", self.on_input_dir_changed)

    def on_input_dir_changed(self, *args):
        input_dir = self.input_dir_var.get().strip()
        if not input_dir or not os.path.isdir(input_dir):
            return

        res = scan_input_directory_for_crs(input_dir)
        if res:
            zone, is_jgd2000, lat, lon = res
            if is_jgd2000:
                recommended_epsg = 2442 + zone
                crs_name = f"EPSG:{recommended_epsg} (JGD2000 / 平面直交座標第{zone}系) [自動判定・推奨]"
            else:
                recommended_epsg = 6668 + zone
                crs_name = f"EPSG:{recommended_epsg} (JGD2011 / 平面直交座標第{zone}系) [自動判定・推奨]"

            # Insert recommended CRS at the top
            current_values = list(self.base_crs_values)
            current_values.insert(0, crs_name)
            
            self.crs_combo.config(values=current_values)
            self.crs_var.set(crs_name)
            self.log(f"フォルダスキャン結果: 推奨座標系「{crs_name}」 (代表点: 北緯{lat:.3f}, 東経{lon:.3f})")

    def browse_input(self):
        dir_selected = filedialog.askdirectory(title="入力フォルダの選択")
        if dir_selected:
            self.input_dir_var.set(os.path.normpath(dir_selected))

    def browse_output(self):
        dir_selected = filedialog.askdirectory(title="出力フォルダの選択")
        if dir_selected:
            self.output_dir_var.set(os.path.normpath(dir_selected))

    def log(self, message, level="INFO"):
        self.log_text.config(state=tk.NORMAL)
        tag = level.lower()

        # Add tags for colored logging
        if tag not in self.log_text.tag_names():
            if tag == "error":
                self.log_text.tag_config("error", foreground="red")
            elif tag == "warning":
                self.log_text.tag_config("warning", foreground="orange")
            elif tag == "success":
                self.log_text.tag_config("success", foreground="green")

        self.log_text.insert(tk.END, f"[{level}] {message}\n", tag)
        self.log_text.see(tk.END)
        self.log_text.config(state=tk.DISABLED)

    def start_conversion(self):
        if self.processing:
            return

        input_dir = self.input_dir_var.get().strip()
        output_dir = self.output_dir_var.get().strip()

        if not input_dir or not os.path.isdir(input_dir):
            messagebox.showerror("エラー", "有効な入力フォルダを選択してください。")
            return
        if not output_dir:
            messagebox.showerror("エラー", "有効な出力フォルダを選択してください。")
            return

        try:
            os.makedirs(output_dir, exist_ok=True)
        except Exception as e:
            messagebox.showerror("エラー", f"出力フォルダを作成できませんでした:\n{str(e)}")
            return

        self.processing = True
        self.start_btn.config(state=tk.DISABLED)
        self.input_btn.config(state=tk.DISABLED)
        self.output_btn.config(state=tk.DISABLED)
        self.crs_combo.config(state=tk.DISABLED)

        self.log_text.config(state=tk.NORMAL)
        self.log_text.delete("1.0", tk.END)
        self.log_text.config(state=tk.DISABLED)
        self.progress_var.set(0)

        # Run conversion in background thread to avoid freezing GUI
        threading.Thread(target=self.run_conversion_thread, args=(input_dir, output_dir), daemon=True).start()

    def run_conversion_thread(self, input_dir, output_dir):
        log_filepath = os.path.join(output_dir, "conversion_log.txt")

        # Setup python logging to write to file
        logger = logging.getLogger("gsi_converter")
        logger.setLevel(logging.INFO)
        logger.handlers = []

        try:
            file_handler = logging.FileHandler(log_filepath, encoding="utf-8")
            file_handler.setFormatter(logging.Formatter('[%(asctime)s] [%(levelname)s] %(message)s'))
            logger.addHandler(file_handler)
        except Exception as e:
            self.log(f"ログファイルを作成できませんでした: {str(e)}", "WARNING")

        def log_msg(msg, level="INFO"):
            self.log(msg, level)
            if level == "INFO":
                logger.info(msg)
            elif level == "WARNING":
                logger.warning(msg)
            elif level == "ERROR":
                logger.error(msg)
            elif level == "SUCCESS":
                logger.info(f"SUCCESS: {msg}")

        log_msg("変換処理を開始します。")
        log_msg(f"入力フォルダ: {input_dir}")
        log_msg(f"出力フォルダ: {output_dir}")

        crs_selection = self.crs_var.get()
        match = re.search(r'EPSG:(\d+)', crs_selection)
        if match:
            default_epsg = int(match.group(1))
        else:
            default_epsg = 6697

        log_msg(f"デフォルト座標系 (EPSG): {default_epsg}")

        # Scan for target files
        all_files = []
        for root_dir, _, filenames in os.walk(input_dir):
            for f in filenames:
                ext = os.path.splitext(f)[1].lower()
                if ext in ['.xml', '.zip']:
                    all_files.append(os.path.join(root_dir, f))

        total_files = len(all_files)
        if total_files == 0:
            log_msg("入力フォルダ内に XML または ZIP ファイルが見つかりませんでした。", "WARNING")
            messagebox.showinfo("お知らせ", "処理対象のファイルが見つかりませんでした。")
            self.finish_conversion()
            return

        log_msg(f"処理対象ファイルを検出しました: {total_files} 件")

        success_count = 0
        error_count = 0
        skipped_count = 0

        # Process each file sequentially to save memory
        for idx, file_path in enumerate(all_files):
            basename = os.path.basename(file_path)
            log_msg(f"[{idx+1}/{total_files}] ファイルを処理中: {basename}")

            progress_percent = (idx / total_files) * 100
            self.progress_var.set(progress_percent)

            ext = os.path.splitext(file_path)[1].lower()
            if ext == '.xml':
                try:
                    with open(file_path, 'r', encoding='utf-8', errors='ignore') as f:
                        xml_content = f.read()

                    out_name = os.path.splitext(basename)[0] + ".tif"
                    out_path = os.path.join(output_dir, out_name)

                    self.convert_xml_content(xml_content, out_path, default_epsg)
                    log_msg(f"変換完了: {out_name}", "SUCCESS")
                    success_count += 1
                except Exception as e:
                    err_msg = f"ファイル {basename} の変換中にエラーが発生しました:\n{traceback.format_exc()}"
                    log_msg(err_msg, "ERROR")
                    error_count += 1

            elif ext == '.zip':
                try:
                    with zipfile.ZipFile(file_path, 'r') as zf:
                        xml_members = [name for name in zf.namelist() if name.lower().endswith('.xml')]

                        if not xml_members:
                            log_msg(f"ZIP内にXMLファイルが含まれていません: {basename}", "WARNING")
                            skipped_count += 1
                            continue

                        for member_name in xml_members:
                            member_basename = os.path.basename(member_name)
                            log_msg(f"  ZIP内ファイルを処理中: {member_basename}")

                            xml_content = zf.read(member_name).decode('utf-8', errors='ignore')

                            out_name = os.path.splitext(member_basename)[0] + ".tif"
                            out_path = os.path.join(output_dir, out_name)

                            self.convert_xml_content(xml_content, out_path, default_epsg)
                            log_msg(f"  変換完了: {out_name}", "SUCCESS")
                            success_count += 1
                except Exception as e:
                    err_msg = f"ZIPファイル {basename} の処理中にエラーが発生しました:\n{traceback.format_exc()}"
                    log_msg(err_msg, "ERROR")
                    error_count += 1

        self.progress_var.set(100)
        log_msg("--- 変換処理が終了しました ---")
        summary_msg = f"結果: 成功 {success_count} 件, エラー {error_count} 件, スキップ {skipped_count} 件"
        log_msg(summary_msg)

        if error_count > 0:
            messagebox.showwarning("処理完了（一部エラーあり）", 
                                   f"変換処理が完了しましたが、{error_count} 件のエラーが発生しました。\n詳細はログファイルを確認してください。\n\n{summary_msg}")
        else:
            messagebox.showinfo("処理完了", f"すべてのファイルの変換処理が成功しました！\n\n{summary_msg}")

        self.finish_conversion()

    def convert_xml_content(self, xml_content, output_filepath, default_epsg):
        root = ET.fromstring(xml_content)

        FGD_NS = '{http://fgd.gsi.go.jp/spec/2008/FGD_GMLSchema}'
        GML_NS = '{http://www.opengis.net/gml/3.2}'

        dem_elem = root.find(f'.//{FGD_NS}DEM')
        if dem_elem is None:
            dem_elem = root.find('.//DEM')
            if dem_elem is None:
                raise ValueError("XML内に DEM 要素が見つかりません。")

        coverage_elem = dem_elem.find(f'.//{FGD_NS}coverage')
        if coverage_elem is None:
            coverage_elem = dem_elem.find('.//coverage')
            if coverage_elem is None:
                raise ValueError("DEM要素内に coverage 要素が見つかりません。")

        envelope = coverage_elem.find(f'.//{GML_NS}Envelope')
        if envelope is None:
            raise ValueError("gml:Envelope が見つかりません。")

        srs_name = envelope.get('srsName', '')

        lower_corner = envelope.find(f'.//{GML_NS}lowerCorner')
        upper_corner = envelope.find(f'.//{GML_NS}upperCorner')
        if lower_corner is None or upper_corner is None:
            raise ValueError("lowerCorner または upperCorner が見つかりません。")

        grid_envelope = coverage_elem.find(f'.//{GML_NS}GridEnvelope')
        if grid_envelope is None:
            raise ValueError("gml:GridEnvelope が見つかりません。")

        low_elem = grid_envelope.find(f'.//{GML_NS}low')
        high_elem = grid_envelope.find(f'.//{GML_NS}high')
        if low_elem is None or high_elem is None:
            raise ValueError("low または high が見つかりません。")

        grid_func = coverage_elem.find(f'.//{GML_NS}GridFunction')
        start_point_elem = grid_func.find(f'.//{GML_NS}startPoint') if grid_func is not None else None
        start_point_text = start_point_elem.text if start_point_elem is not None else "0 0"

        tuple_list_elem = coverage_elem.find(f'.//{GML_NS}tupleList')
        if tuple_list_elem is None:
            raise ValueError("gml:tupleList が見つかりません。")

        lower_text = lower_corner.text
        upper_text = upper_corner.text
        low_text = low_elem.text
        high_text = high_elem.text
        tuple_list_text = tuple_list_elem.text

        # Extract envelope corners
        c1_low, c2_low = map(float, lower_text.strip().split())
        c1_up, c2_up = map(float, upper_text.strip().split())

        # Safely identify latitude and longitude
        # Since longitude in Japan is > 100 and latitude is < 50, the larger coordinate is always longitude.
        if c1_low > c2_low:
            lon_min, lat_min = c1_low, c2_low
            lon_max, lat_max = c1_up, c2_up
        else:
            lat_min, lon_min = c1_low, c2_low
            lat_max, lon_max = c1_up, c2_up

        low_x, low_y = map(int, low_text.strip().split())
        high_x, high_y = map(int, high_text.strip().split())

        width = high_x - low_x + 1
        height = high_y - low_y + 1

        # Calculate grid cell sizes
        dx = (lon_max - lon_min) / width
        dy = (lat_max - lat_min) / height

        # Parse start point relative to low
        sp_parts = start_point_text.strip().split()
        start_x = int(sp_parts[0]) if len(sp_parts) >= 1 else 0
        start_y = int(sp_parts[1]) if len(sp_parts) >= 2 else 0

        # Pre-allocate array filled with NoData
        data = np.full((height, width), -9999.0, dtype=np.float32)

        if tuple_list_text:
            lines = tuple_list_text.strip().split()

            x_offset = start_x - low_x
            y_offset = start_y - low_y

            x, y = x_offset, y_offset
            max_x = high_x - low_x
            max_y = high_y - low_y

            for line in lines:
                parts = line.split(',')
                if len(parts) >= 2:
                    val_str = parts[1]
                    try:
                        val = float(val_str)
                        if val <= -9999.0:
                            data[y, x] = -9999.0
                        else:
                            data[y, x] = val
                    except ValueError:
                        data[y, x] = -9999.0
                x += 1
                if x > max_x:
                    x = 0
                    y += 1
                    if y > max_y:
                        break

        # Determine source CRS (from XML)
        src_epsg = 6697
        if 'jgd2011' in srs_name.lower():
            src_epsg = 6697
        elif 'jgd2000' in srs_name.lower():
            src_epsg = 4612
        src_crs = f"EPSG:{src_epsg}"

        # Determine target CRS (from user selection)
        dst_epsg = default_epsg
        dst_crs = f"EPSG:{dst_epsg}"

        # Origin of source data (latitude/longitude)
        src_transform = from_origin(lon_min, lat_max, dx, dy)

        if src_epsg == dst_epsg:
            # No reprojection needed
            out_crs = src_crs
            out_transform = src_transform
            out_width = width
            out_height = height
            out_data = data
        else:
            # Reprojection needed
            from rasterio.warp import calculate_default_transform, reproject, Resampling
            
            # Calculate output transform and dimensions
            out_transform, out_width, out_height = calculate_default_transform(
                src_crs, dst_crs, width, height,
                left=lon_min, bottom=lat_min, right=lon_max, top=lat_max
            )
            
            out_data = np.full((out_height, out_width), -9999.0, dtype=np.float32)
            
            reproject(
                source=data,
                destination=out_data,
                src_transform=src_transform,
                src_crs=src_crs,
                dst_transform=out_transform,
                dst_crs=dst_crs,
                resampling=Resampling.bilinear,
                src_nodata=-9999.0,
                dst_nodata=-9999.0
            )
            out_crs = dst_crs

        # Write data to GeoTIFF using rasterio
        with rasterio.open(
            output_filepath,
            'w',
            driver='GTiff',
            height=out_height,
            width=out_width,
            count=1,
            dtype='float32',
            crs=out_crs,
            transform=out_transform,
            nodata=-9999.0
        ) as dst:
            dst.write(out_data, 1)

    def finish_conversion(self):
        self.processing = False
        self.start_btn.config(state=tk.NORMAL)
        self.input_btn.config(state=tk.NORMAL)
        self.output_btn.config(state=tk.NORMAL)
        self.crs_combo.config(state=tk.READONLY)

if __name__ == "__main__":
    app = ConverterApp()
    app.mainloop()
