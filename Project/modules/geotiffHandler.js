/**
 * geotiffHandler.js - GeoTIFFファイルのデコードと地図オーバーレイ表示
 *
 * 【メモリ最適化】
 *   - fromBlob()              : file.arrayBuffer() を回避し初期メモリ削減
 *   - readRasters({w, h})    : 出力解像度で直接読み込みピーク使用量を大幅削減
 *   - チャンク分割描画         : UIスレッドをブロックしない
 *
 * GIS Browser - Leaflet WebGIS
 */
(function (GIS) {
  'use strict';

  /** geotiff.js ライブラリのCDN URL */
  const GEOTIFF_CDN = 'https://cdn.jsdelivr.net/npm/geotiff@2.1.3/dist-browser/geotiff.js';

  /**
   * 出力画像の最大解像度（ピクセル）
   * これを超える画像は readRasters の段階で縮小する（Canvas確保前に縮小）
   */
  const MAX_RESAMPLE_SIZE = 2048;

  let geotiffReady   = false;
  let geotiffLoading = false;
  let geotiffCallbacks = [];

  GIS.GeoTiffHandler = {

    /**
     * GeoTIFFファイルを読み込み、地図にオーバーレイ表示する
     * @param {File} file
     */
    async load(file) {
      const sizeMB = (file.size / 1024 / 1024).toFixed(1);

      GIS.UI.showProgress(
        '🛰️ GeoTIFF 読み込み中',
        `${file.name} (${sizeMB} MB)`
      );

      try {
        // Step 1: ライブラリ読み込み
        GIS.UI.updateProgress(5, 'geotiff.js ライブラリを準備中...');
        await this._ensureGeotiff();

        // Step 2: Blob URL 経由で TIFF を開く
        // ※ fromBlob() は内部で Blob URL を使うため file.arrayBuffer() を呼ばない
        //   → ファイル全体を一度にメモリへ展開しないので "Array buffer allocation failed" を回避
        GIS.UI.updateProgress(15, `TIFFを開いています... (${sizeMB} MB)`);
        await this._yield();
        const tiff  = await window.GeoTIFF.fromBlob(file);
        const image = await tiff.getImage();

        // Step 3: 画像サイズを確認して出力解像度を決定
        GIS.UI.updateProgress(28, 'TIFFヘッダを解析中...');
        await this._yield();
        const origW = image.getWidth();
        const origH = image.getHeight();

        // 最大辺が MAX_RESAMPLE_SIZE を超える場合に縮小比率を計算
        let outW = origW;
        let outH = origH;
        if (origW > MAX_RESAMPLE_SIZE || origH > MAX_RESAMPLE_SIZE) {
          const scale = MAX_RESAMPLE_SIZE / Math.max(origW, origH);
          outW = Math.max(1, Math.round(origW * scale));
          outH = Math.max(1, Math.round(origH * scale));
        }
        const isDownsampled = (outW !== origW || outH !== origH);

        if (isDownsampled) {
          GIS.UI.updateProgress(32,
            `大きな画像 (${origW}×${origH}px) → ${outW}×${outH}px に縮小して読み込みます`);
          await this._yield();
        }

        // Step 4: 地理参照情報を取得
        GIS.UI.updateProgress(38, '地理参照情報を取得中...');
        await this._yield();
        const bounds = this._extractBounds(image);
        if (!bounds) {
          throw new Error(
            'GeoTIFFの地理参照情報が見つかりません。\n' +
            'EPSG:4326（WGS84）またはEPSG:3857（Web Mercator）の座標系に対応しています。'
          );
        }

        // Step 5: ラスタを「出力解像度」で直接読み込んで Canvas 化
        // readRasters({ width, height }) を指定すると geotiff.js が内部でリサンプルするため
        // origW×origH の巨大バッファを作成せずに済む（メモリ削減の核心）
        GIS.UI.updateProgress(45, 'ラスタデータを読み込んでいます...');
        const dataUrl = await this._rasterToCanvas(
          image, outW, outH,
          (pct, msg) => GIS.UI.updateProgress(pct, msg)
        );

        // Step 6: Leaflet へ追加
        GIS.UI.updateProgress(97, '地図に追加中...');
        await this._yield();

        const overlay = L.imageOverlay(dataUrl, bounds, {
          opacity: 0.85,
          interactive: true
        });

        overlay.on('click', () => {
          L.popup()
            .setLatLng(bounds.getCenter())
            .setContent(`
              <div class="geotiff-popup">
                <strong>🛠️ ${GIS.UI.escHtml(file.name)}</strong>
                <div>${sizeMB} MB</div>
                <div>元サイズ: ${origW.toLocaleString()}×${origH.toLocaleString()}px</div>
                ${isDownsampled
                  ? `<div>表示サイズ: ${outW.toLocaleString()}×${outH.toLocaleString()}px</div>
                     <div class="compressed-badge">縮小表示中</div>`
                  : ''}
              </div>
            `)
            .openOn(GIS.AppState.map);
        });

        GIS.AppState.addLayer({
          name: file.name,
          type: 'geotiff',
          layer: overlay,
          file: file
        });

        GIS.AppState.map.fitBounds(bounds, { padding: [40, 40] });
        GIS.UI.hideProgress();
        GIS.UI.showToast(
          `✅ GeoTIFF読み込み完了${isDownsampled ? '（縮小表示）' : ''}: ${file.name}`,
          'success'
        );

      } catch (err) {
        GIS.UI.hideProgress();
        throw err; // fileHandler.js でキャッチされる
      }
    },

    // ------------------------------------------------------------------
    // 地理参照情報の取得
    // ------------------------------------------------------------------

    /**
     * GeoTIFFの地理参照情報からLeafletのLatLngBoundsを生成する
     * EPSG:4326 と EPSG:3857 に対応
     * @param {GeoTIFF.GeoTIFFImage} image
     * @returns {L.LatLngBounds|null}
     */
    _extractBounds(image) {
      try {
        const bbox = image.getBoundingBox(); // [minX, minY, maxX, maxY]
        if (!bbox || bbox.length < 4) return null;

        const [minX, minY, maxX, maxY] = bbox;
        const geoKeys = image.getGeoKeys();
        const epsg = geoKeys && (geoKeys.ProjectedCSTypeGeoKey || geoKeys.GeographicTypeGeoKey);

        // EPSG:3857 (Web Mercator)
        if (epsg === 3857 || epsg === 900913) {
          return L.latLngBounds(
            this._merc2latlon(minX, minY),
            this._merc2latlon(maxX, maxY)
          );
        }

        // EPSG:4326 (WGS84) または経緯度範囲内
        if (minX >= -180 && maxX <= 180 && minY >= -90 && maxY <= 90) {
          return L.latLngBounds([minY, minX], [maxY, maxX]);
        }

        // 上記以外は 3857 として試みる
        const sw = this._merc2latlon(minX, minY);
        const ne = this._merc2latlon(maxX, maxY);
        if (sw[0] >= -90 && sw[0] <= 90 && ne[0] >= -90 && ne[0] <= 90) {
          return L.latLngBounds(sw, ne);
        }

        return null;
      } catch (e) {
        console.error('[GeoTiffHandler] Bounds extraction error:', e);
        return null;
      }
    },

    /**
     * Web Mercator (EPSG:3857) → WGS84 (EPSG:4326) 変換
     */
    _merc2latlon(x, y) {
      const lon = (x * 180) / 20037508.342789244;
      const lat = (Math.atan(Math.exp((y * Math.PI) / 20037508.342789244)) * 360) / Math.PI - 90;
      return [lat, lon];
    },

    // ------------------------------------------------------------------
    // ラスタ → Canvas 変換
    // ------------------------------------------------------------------

    /**
     * GeoTIFFラスタをCanvasに描画してDataURLを返す
     *
     * readRasters({ width: outW, height: outH }) で geotiff.js に内部リサンプルを任せる。
     * これにより元解像度の巨大 ImageData を作成するステップが不要になる。
     *
     * @param {GeoTIFF.GeoTIFFImage} image
     * @param {number} outW   - 出力幅（ピクセル）
     * @param {number} outH   - 出力高（ピクセル）
     * @param {Function} onProgress - (percent: number, message: string) => void
     * @returns {Promise<string>} DataURL (PNG)
     */
    async _rasterToCanvas(image, outW, outH, onProgress = () => {}) {
      const samplesPerPixel = image.getSamplesPerPixel();

      // 出力解像度で直接読み込む（ここがメモリ節約の核心）
      onProgress(50, `ラスタをデコード中 (${outW}×${outH}px)...`);
      await this._yield();

      const data = await image.readRasters({
        interleave: true,
        width:  outW,
        height: outH
      });

      // Canvas 初期化（出力サイズのみ確保）
      const canvas  = document.createElement('canvas');
      canvas.width  = outW;
      canvas.height = outH;
      const ctx     = canvas.getContext('2d');
      const imgData = ctx.createImageData(outW, outH);
      const buf     = imgData.data;
      const noData  = image.noDataValue;

      // チャンク単位で処理する行数
      const ROWS_PER_CHUNK = Math.max(1, Math.ceil(50000 / outW));

      // グレースケール用: 正規化パラメータを事前計算
      let grayMin = Infinity, grayMax = -Infinity;
      if (samplesPerPixel < 3) {
        onProgress(55, '色尺度範囲を分析中...');
        await this._yield();
        const step = Math.max(1, Math.floor(data.length / 20000));
        for (let i = 0; i < data.length; i += step) {
          const v = data[i];
          if (isFinite(v)) {
            if (v < grayMin) grayMin = v;
            if (v > grayMax) grayMax = v;
          }
        }
      }

      // チャンク分割でピクセルデータを書き込む
      for (let row = 0; row < outH; row += ROWS_PER_CHUNK) {
        const rowEnd = Math.min(row + ROWS_PER_CHUNK, outH);

        if (samplesPerPixel >= 3) {
          // RGB / RGBA
          for (let r = row; r < rowEnd; r++) {
            for (let c = 0; c < outW; c++) {
              const i = r * outW + c;
              buf[i * 4]     = data[i * samplesPerPixel];
              buf[i * 4 + 1] = data[i * samplesPerPixel + 1];
              buf[i * 4 + 2] = data[i * samplesPerPixel + 2];
              buf[i * 4 + 3] = samplesPerPixel >= 4 ? data[i * samplesPerPixel + 3] : 255;
            }
          }
        } else {
          // グレースケール（1バンド）
          for (let r = row; r < rowEnd; r++) {
            for (let c = 0; c < outW; c++) {
              const i = r * outW + c;
              const v = data[i];
              const isNoData = noData !== undefined && v === noData;
              let gray = 128;
              if (!isNoData) {
                if (grayMax === grayMin) {
                  gray = 128;
                } else if (data instanceof Uint8Array) {
                  gray = v & 0xFF;
                } else if (data instanceof Uint16Array) {
                  gray = Math.round((v / 65535) * 255);
                } else {
                  gray = Math.round(((v - grayMin) / (grayMax - grayMin)) * 255);
                }
              }
              buf[i * 4]     = gray;
              buf[i * 4 + 1] = gray;
              buf[i * 4 + 2] = gray;
              buf[i * 4 + 3] = isNoData ? 0 : 200;
            }
          }
        }

        // 進捗報告 + UIスレッドへの制御返却
        const pct = 58 + Math.round((rowEnd / outH) * 35); // 58〜93%
        onProgress(pct,
          `描画中... ${Math.round((rowEnd / outH) * 100)}%` +
          ` (${rowEnd.toLocaleString()} / ${outH.toLocaleString()} 行)`
        );
        await this._yield();
      }

      ctx.putImageData(imgData, 0, 0);
      onProgress(95, '画像をエンコード中...');
      await this._yield();

      return canvas.toDataURL('image/png');
    },

    // ------------------------------------------------------------------
    // ユーティリティ
    // ------------------------------------------------------------------

    /**
     * UIスレッドをブロックしないように制御を返す
     * @returns {Promise<void>}
     */
    _yield() {
      return new Promise(resolve => setTimeout(resolve, 0));
    },

    /**
     * geotiff.js ライブラリを動的に読み込む
     * @returns {Promise<void>}
     */
    _ensureGeotiff() {
      if (geotiffReady) return Promise.resolve();
      if (geotiffLoading) {
        return new Promise((resolve, reject) => geotiffCallbacks.push({ resolve, reject }));
      }

      geotiffLoading = true;
      return new Promise((resolve, reject) => {
        geotiffCallbacks.push({ resolve, reject });
        const script = document.createElement('script');
        script.src = GEOTIFF_CDN;
        script.onload = () => {
          geotiffReady    = true;
          geotiffLoading  = false;
          geotiffCallbacks.forEach(cb => cb.resolve());
          geotiffCallbacks = [];
        };
        script.onerror = () => {
          geotiffLoading = false;
          const err = new Error('GeoTIFFライブラリの読み込みに失敗しました。');
          geotiffCallbacks.forEach(cb => cb.reject(err));
          geotiffCallbacks = [];
          reject(err);
        };
        document.head.appendChild(script);
      });
    }
  };

})(window.GIS = window.GIS || {});
