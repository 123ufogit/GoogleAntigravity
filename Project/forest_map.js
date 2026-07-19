/* forest_map.js */
document.addEventListener('DOMContentLoaded', function() {
    // UI要素の取得
    const opacitySlider = document.getElementById('opacity-slider');
    const opacityVal = document.getElementById('opacity-val');
    const baseMapSelect = document.getElementById('basemap-select');
    const detailPlaceholder = document.getElementById('detail-placeholder');
    const detailContent = document.getElementById('detail-content');
    const loadingOverlay = document.getElementById('loading-overlay');
    
    // プリセット地点の座標定義
    const presets = {
        yoshino: { coords: [34.364, 135.962], name: "吉野スギ・ヒノキ美林", desc: "奈良県吉野町。日本三大美林の一つ。" },
        kiso: { coords: [35.792, 137.625], name: "木曽ひのき美林", desc: "長野県上松町。赤沢自然休養林周辺。" },
        akita: { coords: [40.216, 140.216], name: "秋田スギ美林", desc: "秋田県能代市周辺。天然スギの銘木地。" },
        yanase: { coords: [33.633, 134.108], name: "魚梁瀬スギ美林", desc: "高知県馬路村。天然スギの巨樹群。" }
    };

    // 樹種とカラーのマッピング (style.json準拠)
    const speciesStyles = {
        'スギ': { color: '#FF4B00', name: 'スギ' },
        'ヒノキ類': { color: '#4DC4FF', name: 'ヒノキ類' },
        'マツ類': { color: '#89FAC2', name: 'マツ類' },
        'カラマツ': { color: '#005AFF', name: 'カラマツ' },
        'トドマツ': { color: '#FF9933', name: 'トドマツ' },
        'エゾマツ': { color: '#89FAC2', name: 'エゾマツ' },
        'ヒバ': { color: '#FFFF00', name: 'ヒバ' },
        'その他針葉樹': { color: '#000000', name: 'その他針葉樹' },
        '広葉樹': { color: '#03AF7A', name: '広葉樹' },
        'タケ': { color: '#FFCABF', name: 'タケ' },
        '針広混交林': { color: '#9E9E9E', name: '針広混交林' },
        '新植地': { color: '#757575', name: '新植地' },
        '伐採跡地': { color: '#616161', name: '伐採跡地' },
        'その他': { color: '#424242', name: 'その他' }
    };

    // 凡例の初期表示
    renderLegend();

    // Leafletマップの初期化 (初期表示は吉野美林)
    const initialLocation = presets.yoshino.coords;
    const map = L.map('map', {
        zoomControl: false // 右下にカスタム配置するため初期は無効化
    }).setView(initialLocation, 14);

    // ズームコントロールを右下に配置
    L.control.zoom({
        position: 'bottomright'
    }).addTo(map);

    // 地理院タイルの定義
    const baseLayers = {
        standard: L.tileLayer('https://cyberjapandata.gsi.go.jp/xyz/std/{z}/{x}/{y}.png', {
            attribution: "<a href='https://maps.gsi.go.jp/development/ichiran.html' target='_blank'>国土地理院</a> | 林野庁「全国森林資源メッシュ」"
        }),
        ortho: L.tileLayer('https://cyberjapandata.gsi.go.jp/xyz/ort/{z}/{x}/{y}.jpg', {
            attribution: "<a href='https://maps.gsi.go.jp/development/ichiran.html' target='_blank'>国土地理院</a> | 林野庁「全国森林資源メッシュ」"
        })
    };

    // 標準地図を最初に追加
    baseLayers.standard.addTo(map);

    // ベースマップの切り替えイベント
    baseMapSelect.addEventListener('change', function(e) {
        const val = e.target.value;
        if (val === 'standard') {
            map.removeLayer(baseLayers.ortho);
            baseLayers.standard.addTo(map);
        } else if (val === 'ortho') {
            map.removeLayer(baseLayers.standard);
            baseLayers.ortho.addTo(map);
        }
    });

    // 全国森林資源メッシュ・ベクトルタイルのロード (Leaflet.VectorGrid)
    const forestTileUrl = "https://rinya-tiles.geospatial.jp/fr_mesh20m_pbf_2025/{z}/{x}/{y}.pbf";
    
    // 透過度設定の反映用
    let currentOpacity = parseFloat(opacitySlider.value) / 100;

    // スタイル決定関数
    function getSpeciesColor(species) {
        return speciesStyles[species] ? speciesStyles[species].color : '#BFBFBF';
    }

    const vectorGridOptions = {
        rendererFactory: L.canvas.tile,
        vectorTileLayerStyles: {
            '全国森林資源メッシュ': function(properties) {
                const species = properties.森林簿樹種1;
                const color = getSpeciesColor(species);
                return {
                    fill: true,
                    fillColor: color,
                    fillOpacity: currentOpacity * 0.7,
                    stroke: false // 境界線を描くと重くなるため無効化（20mメッシュは細かいため）
                };
            }
        },
        minZoom: 13,
        maxZoom: 16,
        interactive: true,
        getFeatureId: function(f) {
            // フィーチャを特定するための一意なID
            return f.properties.id || (f.properties.平均標高 + "_" + f.properties.林齢 + "_" + f.properties.森林簿樹種1 + "_" + Math.random());
        }
    };

    const forestVectorLayer = L.vectorGrid.protobuf(forestTileUrl, vectorGridOptions);
    forestVectorLayer.addTo(map);

    // ローディングアニメーション制御
    forestVectorLayer.on('loading', function() {
        loadingOverlay.classList.add('visible');
    });
    forestVectorLayer.on('load', function() {
        loadingOverlay.classList.remove('visible');
    });

    // 透過度スライダーのイベントリスナー
    opacitySlider.addEventListener('input', function(e) {
        const val = e.target.value;
        opacityVal.textContent = val + '%';
        currentOpacity = parseFloat(val) / 100;
        
        // Leaflet.VectorGridのコンテナの不透明度を調整
        if (forestVectorLayer.setOpacity) {
            forestVectorLayer.setOpacity(currentOpacity);
        } else {
            // フォールバック: redraw
            forestVectorLayer.redraw();
        }
    });

    // 地物クリック時のインタラクション
    forestVectorLayer.on('click', function(e) {
        const props = e.layer.properties;
        if (!props) return;

        // 地図上にポップアップを表示
        const popupContent = `
            <div style="font-family: 'Inter', sans-serif;">
                <strong style="color: #00e676; font-size: 1rem;">${props.森林簿樹種1 || '不明'}</strong><br>
                <span>林種: ${props.林種 || '不明'}</span><br>
                <span>林齢: ${props.林齢 ? props.林齢 + ' 年' : '不明'}</span>
            </div>
        `;
        L.popup()
            .setLatLng(e.latlng)
            .setContent(popupContent)
            .openOn(map);

        // サイドバー詳細パネルの更新
        updateDetailPanel(props);
    });

    // プリセットナビゲーションのクリックイベント登録
    document.querySelectorAll('.preset-btn').forEach(btn => {
        btn.addEventListener('click', function() {
            const key = this.getAttribute('data-preset');
            if (presets[key]) {
                const target = presets[key];
                map.flyTo(target.coords, 14, {
                    animate: true,
                    duration: 1.5
                });
                
                // ナビゲーション完了後の表示用に一時的に詳細を表示
                detailPlaceholder.style.display = 'none';
                detailContent.style.display = 'flex';
                detailContent.innerHTML = `
                    <div class="detail-content">
                        <div class="detail-main-val">
                            <span class="detail-species">${target.name}</span>
                        </div>
                        <p style="font-size: 0.85rem; color: var(--text-secondary); line-height: 1.5;">
                            ${target.desc}
                        </p>
                        <div class="info-item" style="margin-top: 10px;">
                            <span class="info-label">🔎 森林資源の確認方法</span>
                            <span style="font-size: 0.8rem; color: var(--text-primary);">地図をズーム（Z=13以上）し、表示された色つきのメッシュをクリックすると詳細情報がここに表示されます。</span>
                        </div>
                    </div>
                `;
            }
        });
    });

    // 凡例を描画する関数
    function renderLegend() {
        const legendList = document.getElementById('legend-list');
        legendList.innerHTML = '';
        
        Object.keys(speciesStyles).forEach(key => {
            const style = speciesStyles[key];
            const item = document.createElement('div');
            item.className = 'legend-item';
            item.innerHTML = `
                <div class="legend-color-label">
                    <span class="color-box" style="background-color: ${style.color};"></span>
                    <span class="species-name">${style.name}</span>
                </div>
            `;
            
            // 凡例クリックによる特定樹種の強調表示（フィルタ機能のデモ）
            item.addEventListener('click', function() {
                const isActive = this.classList.contains('active');
                
                // 他の凡例のアクティブ状態をクリア
                document.querySelectorAll('.legend-item').forEach(li => li.classList.remove('active'));
                
                if (!isActive) {
                    this.classList.add('active');
                    // 選択された樹種以外を半透明にするなどのフィルタ処理を模倣（VectorGridスタイル関数の再設定）
                    forestVectorLayer.setStyle(function(properties) {
                        const species = properties.森林簿樹種1;
                        const isMatch = (species === key);
                        const baseColor = getSpeciesColor(species);
                        return {
                            fill: true,
                            fillColor: baseColor,
                            fillOpacity: isMatch ? currentOpacity * 0.9 : currentOpacity * 0.1,
                            stroke: false
                        };
                    });
                } else {
                    // 元のスタイルに戻す
                    forestVectorLayer.setStyle(function(properties) {
                        const species = properties.森林簿樹種1;
                        const baseColor = getSpeciesColor(species);
                        return {
                            fill: true,
                            fillColor: baseColor,
                            fillOpacity: currentOpacity * 0.7,
                            stroke: false
                        };
                    });
                }
            });
            
            legendList.appendChild(item);
        });
    }

    // 属性詳細情報の表示更新関数
    function updateDetailPanel(props) {
        detailPlaceholder.style.display = 'none';
        detailContent.style.display = 'flex';
        
        const species1 = props.森林簿樹種1 || '不明';
        const species2 = props.森林簿樹種2 || 'なし';
        const species3 = props.森林簿樹種3 || 'なし';
        const forestType = props.林種 || 'データなし';
        const age = props.林齢 !== undefined ? props.林齢 : '不明';
        const dchm = props.平均樹冠高 !== undefined ? props.平均樹冠高.toFixed(1) : (props.樹冠高 !== undefined ? props.樹冠高.toFixed(1) : 'データなし');
        const elev = props.平均標高 !== undefined ? props.平均標高.toFixed(0) : (props.標高 !== undefined ? props.標高.toFixed(0) : 'データなし');
        const density = props.立木密度 !== undefined ? props.立木密度.toFixed(0) : 'データなし';

        // 林齢のプログレスバー計算 (最大100年とする)
        let agePercent = 0;
        if (typeof age === 'number') {
            agePercent = Math.min(Math.max((age / 100) * 100, 0), 100);
        }

        detailContent.innerHTML = `
            <div class="detail-main-val">
                <span class="detail-species">${species1}</span>
                <span class="detail-type">${forestType}</span>
            </div>
            
            <div class="info-grid">
                <div class="info-item">
                    <span class="info-label">林齢 (主樹種)</span>
                    <span class="info-value">${age} <span>年</span></span>
                    ${typeof age === 'number' ? `
                        <div class="progress-container">
                            <div class="progress-bar-bg">
                                <div class="progress-bar-fill" style="width: ${agePercent}%"></div>
                            </div>
                        </div>
                    ` : ''}
                </div>
                <div class="info-item">
                    <span class="info-label">平均標高</span>
                    <span class="info-value">${elev} ${elev !== 'データなし' ? '<span>m</span>' : ''}</span>
                </div>
                <div class="info-item">
                    <span class="info-label">樹種構成 (副樹種)</span>
                    <span style="font-size: 0.8rem; font-weight: 500; display: block; margin-top: 4px; color: var(--text-primary);">
                        2: ${species2}<br>3: ${species3}
                    </span>
                </div>
                <div class="info-item">
                    <span class="info-label">立木密度 / 樹高</span>
                    <span style="font-size: 0.8rem; font-weight: 500; display: block; margin-top: 4px; color: var(--text-primary);">
                        密度: ${density} ${density !== 'データなし' ? '<span>本/ha</span>' : ''}<br>
                        樹高: ${dchm} ${dchm !== 'データなし' ? '<span>m</span>' : ''}
                    </span>
                </div>
            </div>
            
            <div style="margin-top: 10px; font-size: 0.75rem; color: var(--text-secondary); text-align: right; border-top: 1px solid rgba(255,255,255,0.05); padding-top: 8px;">
                データ元: 林野庁・全国森林資源メッシュ (2025年版)
            </div>
        `;
    }
});
