/**
 * geotiffHandler.js - GeoTIFFファイルのデコードと地図オーバーレイ表示
 * 500MB以上のファイルはCanvasでリサンプリング（最大2048×2048px）
 * GIS Browser - Leaflet WebGIS
 */
(function (GIS) {
  'use strict';

  /** geotiff.js ライブラリのCDN URL */
  const GEOTIFF_CDN = 'https://cdn.jsdelivr.net/npm/geotiff@2.1.3/dist-browser/geotiff.js';

  /** 圧縮閾値 (500MB) */
  const COMPRESS_THRESHOLD = 500 * 1024 * 1024;

  /** リサンプリング後の最大解像度 */
  const MAX_RESAMPLE_SIZE = 2048;

  let geotiffReady = false;
  let geotiffLoading = false;
  let geotiffCallbacks = [];

  GIS.GeoTiffHandler = {

    /**
     * GeoTIFFファイルを読み込み、地図にオーバーレイ表示する
     * @param {File} file
     */
    async load(file) {
      const sizeMB = (file.size / 1024 / 1024).toFixed(1);
      const needsCompression = file.size >= COMPRESS_THRESHOLD;

      // プログレスバーを表示
      GIS.UI.showProgress(
        `🛰️ GeoTIFF 読み込み中`,
        `${file.name} (${sizeMB} MB)`
      );

      try {
        // Step 1: ライブラリ読み込み
        GIS.UI.updateProgress(5, 'geotiff.js ライブラリを準備中...');
        await this._ensureGeotiff();

        // Step 2: ファイルバッファ読み込み
        GIS.UI.updateProgress(15, `ファイルを読み込んでいます... (${sizeMB} MB)`);
        await this._yield();
        const arrayBuffer = await file.arrayBuffer();

        // Step 3: TIFFデコード
        GIS.UI.updateProgress(30, 'TIFFヘッダを解析中...');
        await this._yield();
        const tiff  = await window.GeoTIFF.fromArrayBuffer(arrayBuffer);
        const image = await tiff.getImage();

        // Step 4: 地理参照情報を取得
        GIS.UI.updateProgress(40, '地理参照情報を取得中...');
        await this._yield();
        const bounds = this._extractBounds(image);
        if (!bounds) {
          throw new Error(
            'GeoTIFFの地理参照情報が見つかりません。\n' +
            'EPSG:4326（WGS84）またはEPSG:3857（Web Mercator）の座標系に対応しています。'
          );
        }

        // Step 5: ラスタデータをCanvas経由でPNG化（進捗コールバック付き）
        GIS.UI.updateProgress(45, 'ラスタデータを読み込んでいます...');
        if (needsCompression) {
          GIS.UI.updateProgress(45, `大きなファイル (${sizeMB}MB) — 圧縮処理を行います`);
        }
        const dataUrl = await this._rasterToCanvas(image, needsCompression,
          (pct, msg) => GIS.UI.updateProgress(pct, msg)
        );

        // Step 6: Leafletへ追加
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
                <div>幅: ${image.getWidth()}px / 高さ: ${image.getHeight()}px</div>
                ${needsCompression ? '<div class="compressed-badge">圧縮表示中</div>' : ''}
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
        GIS.UI.showToast(`✅ GeoTIFF読み込み完了${needsCompression ? '（圧縮済み）' : ''}: ${file.name}`, 'success');

      } catch (err) {
        GIS.UI.hideProgress();
        throw err; // fileHandler.jsでキャッチされる
      }
    },

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

        // EPSGコードを取得
        const geoKeys = image.getGeoKeys();
        const epsg = geoKeys && (geoKeys.ProjectedCSTypeGeoKey || geoKeys.GeographicTypeGeoKey);

        // EPSG:3857（Web Mercator）の場合は変換
        if (epsg === 3857 || epsg === 900913) {
          const sw = this._merc2latlon(minX, minY);
          const ne = this._merc2latlon(maxX, maxY);
          return L.latLngBounds(sw, ne);
        }

        // EPSG:4326（WGS84）またはデフォルト
        // 座標が合理的な経緯度範囲内かチェック
        if (minX >= -180 && maxX <= 180 && minY >= -90 && maxY <= 90) {
          return L.latLngBounds([minY, minX], [maxY, maxX]);
        }

        // 上記以外は3857として試みる
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
     * @param {number} x
     * @param {number} y
     * @returns {[number, number]} [lat, lon]
     */
    _merc2latlon(x, y) {
      const lon = (x * 180) / 20037508.342789244;
      const lat = (Math.atan(Math.exp((y * Math.PI) / 20037508.342789244)) * 360) / Math.PI - 90;
      return [lat, lon];
    },

    /**
     * GeoTIFFラスタをCanvasに描画してDataURLを返す
     * ピクセル処理をチャンク分割してUIスレッドをブロックしない
     * @param {GeoTIFF.GeoTIFFImage} image
     * @param {boolean} needsCompression
     * @param {Function} onProgress - (percent: number, message: string) => void
     * @returns {Promise<string>}
     */
    async _rasterToCanvas(image, needsCompression, onProgress = () => {}) {
      const origW = image.getWidth();
      const origH = image.getHeight();

      // 出力サイズを決定
      let outW = origW;
      let outH = origH;
      if (needsCompression || origW > MAX_RESAMPLE_SIZE || origH > MAX_RESAMPLE_SIZE) {
        const scale = MAX_RESAMPLE_SIZE / Math.max(origW, origH);
        outW = Math.round(origW * scale);
        outH = Math.round(origH * scale);
      }

      // ラスタデータを読み込む
      onProgress(50, 'ラスタデータをデコード中...');
      await this._yield();
      const data = await image.readRasters({ interleave: true });
      const samplesPerPixel = image.getSamplesPerPixel();

      // Canvas初期化
      const canvas = document.createElement('canvas');
      canvas.width  = origW;
      canvas.height = origH;
      const ctx     = canvas.getContext('2d');
      const imgData = ctx.createImageData(origW, origH);
      const buf     = imgData.data;
      const pixelCount = origW * origH;

      // ---- チャンク分割ピクセル処理 ----
      // 1チャンクあたりの行数（画像幅を基準）
      const ROWS_PER_CHUNK = Math.max(1, Math.ceil(50000 / origW));
      const noData = image.noDataValue;

      // グレースケールの場合は先に準化パラメータを計算しておく
      let grayMin = Infinity, grayMax = -Infinity;
      if (samplesPerPixel < 3) {
        onProgress(55, '色尺度範囲を分析中...');
        await this._yield();
        const step = Math.max(1, Math.floor(data.length / 20000));
        for (let i = 0; i < data.length; i += step) {
          if (isFinite(data[i])) {
            if (data[i] < grayMin) grayMin = data[i];
            if (data[i] > grayMax) grayMax = data[i];
          }
        }
      }

      // チャンク分割で描画
      for (let row = 0; row < origH; row += ROWS_PER_CHUNK) {
        const rowEnd = Math.min(row + ROWS_PER_CHUNK, origH);

        if (samplesPerPixel >= 3) {
          // RGB / RGBA
          for (let r = row; r < rowEnd; r++) {
            for (let c = 0; c < origW; c++) {
              const i = r * origW + c;
              buf[i * 4]     = data[i * samplesPerPixel];
              buf[i * 4 + 1] = data[i * samplesPerPixel + 1];
              buf[i * 4 + 2] = data[i * samplesPerPixel + 2];
              buf[i * 4 + 3] = samplesPerPixel >= 4 ? data[i * samplesPerPixel + 3] : 255;
            }
          }
        } else {
          // グレースケール (1バンド)
          for (let r = row; r < rowEnd; r++) {
            for (let c = 0; c < origW; c++) {
              const i = r * origW + c;
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

        // 進捗報告とUIスレッドへのヨール
        const pct = 58 + Math.round((rowEnd / origH) * 35); // 58〜93%
        onProgress(pct, `描画中... ${Math.round((rowEnd / origH) * 100)}% (${rowEnd.toLocaleString()} / ${origH.toLocaleString()} 行)`);
        await this._yield();
      }

      ctx.putImageData(imgData, 0, 0);
      onProgress(94, '画像をエンコード中...');
      await this._yield();

      // リサンプリングが必要な場合
      if (outW !== origW || outH !== origH) {
        const resCanvas = document.createElement('canvas');
        resCanvas.width  = outW;
        resCanvas.height = outH;
        const resCtx = resCanvas.getContext('2d');
        resCtx.imageSmoothingEnabled = true;
        resCtx.imageSmoothingQuality = 'high';
        resCtx.drawImage(canvas, 0, 0, outW, outH);
        onProgress(97, 'リサンプリング完了');
        return resCanvas.toDataURL('image/png');
      }

      return canvas.toDataURL('image/png');
    },

    /**
     * UIスレッドをブロックしないように処理を一層層本的な非同期にする
     * @returns {Promise<void>}
     */
    _yield() {
      return new Promise(resolve => setTimeout(resolve, 0));
    },

    /**
     * geotiff.jsライブラリを動的に読み込む
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
          geotiffReady = true;
          geotiffLoading = false;
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
