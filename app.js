// app.js

// グローバル変数
let map;
let marker;
let meshPolygon;
let charts = {
    climograph: null,
    snow: null,
    sunshine: null
};

// 12ヶ月のラベル
const MONTH_LABELS = ['1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月'];

// DOM要素の読み込み
document.addEventListener('DOMContentLoaded', () => {
    initMap();
    initSidebar();
    checkDatabaseStatus();
});

// 地図の初期化
function initMap() {
    // 日本全体を表示するように初期化 (淡色地図をデフォルトに)
    map = L.map('map', {
        zoomControl: false // カスタマイズのためデフォルトのズームコントロールは無効化
    }).setView([36.5, 137.5], 5);
    
    // ズームコントロールを右上に配置
    L.control.zoom({
        position: 'topleft'
    }).addTo(map);

    // 国土地理院タイルの定義
    const paleLayer = L.tileLayer('https://cyberjapandata2.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png', {
        attribution: '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank">国土地理院</a>',
        maxZoom: 18
    });
    
    const stdLayer = L.tileLayer('https://cyberjapandata2.gsi.go.jp/xyz/std/{z}/{x}/{y}.png', {
        attribution: '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank">国土地理院</a>',
        maxZoom: 18
    });
    
    const photoLayer = L.tileLayer('https://cyberjapandata2.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg', {
        attribution: '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank">国土地理院</a>',
        maxZoom: 18
    });

    // 初期レイヤーを追加
    paleLayer.addTo(map);

    // ベースレイヤーの選択肢
    const baseMaps = {
        "地理院 淡色地図": paleLayer,
        "地理院 標準地図": stdLayer,
        "地理院 空中写真": photoLayer
    };

    // レイヤーコントロールを左下に追加
    L.control.layers(baseMaps, null, {
        position: 'bottomleft',
        collapsed: false
    }).addTo(map);

    // 地図クリックイベント
    map.on('click', onMapClick);
}

// サイドバー開閉制御
function initSidebar() {
    const sidebar = document.getElementById('sidebar');
    const toggleBtn = document.getElementById('sidebar-toggle');
    
    toggleBtn.addEventListener('click', () => {
        sidebar.classList.toggle('collapsed');
        // 地図サイズをリサイズ（サイドバーの開閉に追従させる）
        setTimeout(() => {
            map.invalidateSize();
        }, 400);
    });
}

// 地図クリック時の処理
function onMapClick(e) {
    const lat = e.latlng.lat;
    const lon = e.latlng.lng;
    
    // ピンの更新
    if (marker) {
        marker.setLatLng(e.latlng);
    } else {
        marker = L.marker(e.latlng).addTo(map);
    }
    
    // 既存のメッシュポリゴンを削除
    if (meshPolygon) {
        map.removeLayer(meshPolygon);
        meshPolygon = null;
    }

    // サイドバーを展開
    const sidebar = document.getElementById('sidebar');
    sidebar.classList.remove('collapsed');
    
    // 地図のクリック位置へゆっくり移動 (ズームレベルが低い場合はズームイン)
    const currentZoom = map.getZoom();
    const targetZoom = currentZoom < 10 ? 11 : currentZoom;
    map.setView(e.latlng, targetZoom, { animate: true });
    
    // 表示状態の切り替え (ローディング状態風に見せる)
    document.getElementById('sidebar-instructions').classList.add('hidden');
    document.getElementById('sidebar-data').classList.remove('hidden');
    
    // プレースホルダーでリセット
    setDOMValues({
        lat: lat.toFixed(6),
        lon: lon.toFixed(6),
        meshCode: '計算中...',
        elevation: '取得中...',
        elevationSrc: '-',
        tempAvg: '-',
        precipAnn: '-',
        snowMax: '-',
        sunAnn: '-'
    });

    // APIリクエスト
    fetch(`/api/climate?lat=${lat}&lon=${lon}`)
        .then(response => {
            if (!response.ok) {
                throw new Error('サーバーエラーが発生しました。');
            }
            return response.json();
        })
        .then(data => {
            updateUI(data, lat, lon);
        })
        .catch(err => {
            console.error(err);
            alert('データの取得に失敗しました。');
        });
}

// UIの更新
function updateUI(data, clickedLat, clickedLon) {
    // 1. メッシュポリゴンの描画
    if (data.bbox) {
        const bounds = [
            [data.bbox.south, data.bbox.west],
            [data.bbox.north, data.bbox.east]
        ];
        
        meshPolygon = L.rectangle(bounds, {
            color: "#ef4444",      // 赤い枠線
            weight: 2,
            fillColor: "#ef4444",
            fillOpacity: 0.15,
            interactive: false     // クリックイベントを透過
        }).addTo(map);
    }
    
    // 2. 基本データ表示
    const elevationVal = data.elevation !== null ? data.elevation.toLocaleString() : 'データなし';
    const elevationSrcVal = data.elevation_source ? `データソース: ${data.elevation_source}` : 'データソース: 不明';
    
    setDOMValues({
        lat: clickedLat.toFixed(6),
        lon: clickedLon.toFixed(6),
        meshCode: data.mesh_code || '範囲外',
        elevation: elevationVal,
        elevationSrc: elevationSrcVal
    });

    // 3. 気候データの表示
    const climate = data.climate;
    
    if (climate && climate.has_data) {
        // サマリー値の更新
        setDOMValues({
            tempAvg: climate.temperature_average !== null ? climate.temperature_average.toFixed(1) : '-',
            precipAnn: climate.precipitation_annual !== null ? climate.precipitation_annual.toLocaleString() : '-',
            snowMax: climate.snow_depth_max !== null ? climate.snow_depth_max.toLocaleString() : '-',
            sunAnn: climate.sunshine_annual !== null ? climate.sunshine_annual.toLocaleString() : '-'
        });

        // グラフの描画
        renderCharts(climate);
    } else {
        // 気候データがない場合 (海の上など)
        setDOMValues({
            tempAvg: 'データなし',
            precipAnn: 'データなし',
            snowMax: 'データなし',
            sunAnn: 'データなし'
        });
        
        // 既存のグラフを破棄
        destroyCharts();
    }
}

// DOMへの値設定ヘルパー
defValues = {};
function setDOMValues(vals) {
    if (vals.lat !== undefined) document.getElementById('val-lat').textContent = vals.lat;
    if (vals.lon !== undefined) document.getElementById('val-lon').textContent = vals.lon;
    if (vals.meshCode !== undefined) document.getElementById('val-mesh-code').textContent = vals.meshCode;
    if (vals.elevation !== undefined) document.getElementById('val-elevation').textContent = vals.elevation;
    if (vals.elevationSrc !== undefined) document.getElementById('val-elevation-src').textContent = vals.elevationSrc;
    if (vals.tempAvg !== undefined) document.getElementById('val-temp-avg').textContent = vals.tempAvg;
    if (vals.precipAnn !== undefined) document.getElementById('val-precip-ann').textContent = vals.precipAnn;
    if (vals.snowMax !== undefined) document.getElementById('val-snow-max').textContent = vals.snowMax;
    if (vals.sunAnn !== undefined) document.getElementById('val-sun-ann').textContent = vals.sunAnn;
}

// グラフ描画
function renderCharts(climate) {
    destroyCharts(); // 既存のグラフを安全に破棄

    const fontColor = '#94a3b8'; // Slate 400
    const gridColor = 'rgba(255, 255, 255, 0.08)';

    // 1. 雨温図 (気温: 折れ線, 降水量: 棒)
    const ctxClimograph = document.getElementById('chart-climograph').getContext('2d');
    charts.climograph = new Chart(ctxClimograph, {
        type: 'bar',
        data: {
            labels: MONTH_LABELS,
            datasets: [
                {
                    label: '降水量 (mm)',
                    data: climate.precipitation_monthly,
                    yAxisID: 'yRain',
                    backgroundColor: 'rgba(59, 130, 246, 0.5)',
                    borderColor: 'rgba(59, 130, 246, 0.8)',
                    borderWidth: 1,
                    borderRadius: 4,
                    order: 2
                },
                {
                    label: '平均気温 (℃)',
                    data: climate.temperature_average_monthly,
                    yAxisID: 'yTemp',
                    type: 'line',
                    borderColor: 'rgba(249, 115, 22, 1)',
                    backgroundColor: 'rgba(249, 115, 22, 0.2)',
                    borderWidth: 3,
                    tension: 0.3,
                    pointBackgroundColor: 'rgba(249, 115, 22, 1)',
                    order: 1
                }
            ]
        },
        options: {
            responsive: true,
            scales: {
                x: {
                    grid: { display: false },
                    ticks: { color: fontColor }
                },
                yTemp: {
                    type: 'linear',
                    position: 'left',
                    title: {
                        display: true,
                        text: '気温 (℃)',
                        color: fontColor
                    },
                    grid: { color: gridColor },
                    ticks: { color: fontColor }
                },
                yRain: {
                    type: 'linear',
                    position: 'right',
                    title: {
                        display: true,
                        text: '降水量 (mm)',
                        color: fontColor
                    },
                    grid: { display: false }, // 二重線を避ける
                    ticks: { color: fontColor },
                    min: 0
                }
            },
            plugins: {
                legend: {
                    labels: { color: fontColor }
                }
            }
        }
    });

    // 2. 最深積雪 (棒グラフ)
    const ctxSnow = document.getElementById('chart-snow').getContext('2d');
    // 積雪深のグラデーションを作成
    const gradSnow = ctxSnow.createLinearGradient(0, 0, 0, 200);
    gradSnow.addColorStop(0, 'rgba(56, 189, 248, 0.7)'); // Sky 300
    gradSnow.addColorStop(1, 'rgba(56, 189, 248, 0.1)');

    charts.snow = new Chart(ctxSnow, {
        type: 'bar',
        data: {
            labels: MONTH_LABELS,
            datasets: [{
                label: '最深積雪 (cm)',
                data: climate.snow_depth_monthly,
                backgroundColor: gradSnow,
                borderColor: 'rgba(56, 189, 248, 0.9)',
                borderWidth: 1,
                borderRadius: 4
            }]
        },
        options: {
            responsive: true,
            scales: {
                x: {
                    grid: { display: false },
                    ticks: { color: fontColor }
                },
                y: {
                    title: {
                        display: true,
                        text: '積雪深 (cm)',
                        color: fontColor
                    },
                    grid: { color: gridColor },
                    ticks: { color: fontColor },
                    min: 0
                }
            },
            plugins: {
                legend: {
                    labels: { color: fontColor }
                }
            }
        }
    });

    // 3. 日照時間 (棒グラフ)
    const ctxSun = document.getElementById('chart-sunshine').getContext('2d');
    const gradSun = ctxSun.createLinearGradient(0, 0, 0, 200);
    gradSun.addColorStop(0, 'rgba(234, 179, 8, 0.7)'); // Yellow 500
    gradSun.addColorStop(1, 'rgba(234, 179, 8, 0.1)');

    charts.sunshine = new Chart(ctxSun, {
        type: 'bar',
        data: {
            labels: MONTH_LABELS,
            datasets: [{
                label: '日照時間 (時間)',
                data: climate.sunshine_monthly,
                backgroundColor: gradSun,
                borderColor: 'rgba(234, 179, 8, 0.9)',
                borderWidth: 1,
                borderRadius: 4
            }]
        },
        options: {
            responsive: true,
            scales: {
                x: {
                    grid: { display: false },
                    ticks: { color: fontColor }
                },
                y: {
                    title: {
                        display: true,
                        text: '日照時間 (時間)',
                        color: fontColor
                    },
                    grid: { color: gridColor },
                    ticks: { color: fontColor },
                    min: 0
                }
            },
            plugins: {
                legend: {
                    labels: { color: fontColor }
                }
            }
        }
    });
}

// グラフの破棄
function destroyCharts() {
    if (charts.climograph) {
        charts.climograph.destroy();
        charts.climograph = null;
    }
    if (charts.snow) {
        charts.snow.destroy();
        charts.snow = null;
    }
    if (charts.sunshine) {
        charts.sunshine.destroy();
        charts.sunshine = null;
    }
}

// データベース状態のチェック
function checkDatabaseStatus() {
    fetch('/api/status')
        .then(res => res.ok ? res.json() : null)
        .then(status => {
            if (!status) return;
            const noticeCard = document.querySelector('.data-notice-card');
            if (!noticeCard) return;
            
            if (!status.db_exists || status.record_count === 0) {
                noticeCard.style.borderColor = 'rgba(239, 68, 68, 0.6)';
                noticeCard.style.background = 'rgba(239, 68, 68, 0.1)';
                const title = noticeCard.querySelector('.notice-title');
                if (title) {
                    title.innerHTML = '<i class="fa-solid fa-triangle-exclamation" style="color: #f87171;"></i> 平年値メッシュデータ未登録';
                }
            } else {
                noticeCard.style.borderColor = 'rgba(52, 211, 153, 0.3)';
                const title = noticeCard.querySelector('.notice-title');
                if (title) {
                    title.innerHTML = `<i class="fa-solid fa-circle-check" style="color: #34d399;"></i> 平年値データ登録済み (${status.record_count.toLocaleString()} メッシュ)`;
                }
            }
        })
        .catch(err => console.error('ステータス確認エラー:', err));
}

