// アプリケーション状態
const state = {
    originalImage: null,   // HTML Image オブジェクト
    scaledWidth: 0,        // 内部処理用の縮小後幅
    scaledHeight: 0,       // 内部処理用の縮小後高さ
    points: [],            // ROI用の4点座標 [[x, y], ...]
    calibPoints: [],       // キャリブレーション用の2点座標 [[x, y], ...]
    calibScale: 0.05,      // 1ピクセルあたりの長さ (cm/px) デフォルトは 0.05
    isDrawingCalib: false,  // キャリブレーションモード中か
    imageLoaded: false
};

// UI要素の取得
const dropZone = document.getElementById('drop-zone');
const fileInput = document.getElementById('file-input');
const canvas = document.getElementById('interactive-canvas');
const ctx = canvas.getContext('2d');
const btnDrawCalib = document.getElementById('btn-draw-calib');
const calibLengthInput = document.getElementById('calib-length');
const scaleRatioText = document.getElementById('scale-ratio-text');
const threshSlider = document.getElementById('thresh-slider');
const threshValText = document.getElementById('thresh-val-text');
const sizeSlider = document.getElementById('size-slider');
const sizeValText = document.getElementById('size-val-text');
const btnAnalyze = document.getElementById('btn-analyze');
const btnReset = document.getElementById('btn-reset');
const loadingOverlay = document.getElementById('loading-overlay');
const loadingText = document.getElementById('loading-text');
const instructions = document.getElementById('instructions');

// 結果表示用要素
const resLength = document.getElementById('res-length');
const resTips = document.getElementById('res-tips');
const resJunctions = document.getElementById('res-junctions');
const overlayCanvas = document.getElementById('overlay-preview-canvas');
const binaryCanvas = document.getElementById('binary-preview-canvas');

// 最大画像処理サイズ (これより大きい画像は自動でリサイズして処理速度を担保)
const MAX_PROCESS_DIM = 1200;

// --- ファイルの読み込み処理 ---

dropZone.addEventListener('click', () => fileInput.click());

dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.classList.add('dragover');
});

dropZone.addEventListener('dragleave', () => {
    dropZone.classList.remove('dragover');
});

dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('dragover');
    if (e.dataTransfer.files.length > 0) {
        loadImage(e.dataTransfer.files[0]);
    }
});

fileInput.addEventListener('change', (e) => {
    if (e.target.files.length > 0) {
        loadImage(e.target.files[0]);
    }
});

function loadImage(file) {
    if (!file.type.startsWith('image/')) {
        alert('画像ファイルを選択してください。');
        return;
    }

    const reader = new FileReader();
    reader.onload = (e) => {
        state.originalImage = new Image();
        state.originalImage.onload = () => {
            // 解析処理をサクサク行うため、大きすぎる画像はアスペクト比を維持して縮小
            let w = state.originalImage.naturalWidth;
            let h = state.originalImage.naturalHeight;
            if (w > MAX_PROCESS_DIM || h > MAX_PROCESS_DIM) {
                const ratio = Math.min(MAX_PROCESS_DIM / w, MAX_PROCESS_DIM / h);
                w = Math.round(w * ratio);
                h = Math.round(h * ratio);
            }
            state.scaledWidth = w;
            state.scaledHeight = h;

            canvas.width = w;
            canvas.height = h;

            resetAnalysisState();
            state.imageLoaded = true;
            btnAnalyze.disabled = false;
            redrawCanvas();

            instructions.textContent = "画像が読み込まれました。解析範囲（ROI）を「左上、右上、右下、左下」の順に4隅クリックして囲むか、「スケール較正」を行ってください。";
        };
        state.originalImage.src = e.target.result;
    };
    reader.readAsDataURL(file);
}

// --- リセット処理 ---

btnReset.addEventListener('click', () => {
    resetAnalysisState();
    redrawCanvas();
    instructions.textContent = "リセットしました。解析範囲またはスケール較正線を再度クリックしてください。";
});

function resetAnalysisState() {
    state.points = [];
    state.calibPoints = [];
    state.isDrawingCalib = false;
    btnDrawCalib.classList.remove('active');

    // 結果表示のクリア
    resLength.textContent = "0.00";
    resTips.textContent = "0";
    resJunctions.textContent = "0";

    // プレビュー用キャンバスのクリア
    overlayCanvas.width = 0;
    overlayCanvas.height = 0;
    binaryCanvas.width = 0;
    binaryCanvas.height = 0;
}

// --- キャンバスクリックイベント (ROI/較正線) ---

canvas.addEventListener('click', (e) => {
    if (!state.imageLoaded) return;

    // キャンバス上の座標を計算
    const rect = canvas.getBoundingClientRect();
    const x = Math.round((e.clientX - rect.left) * (canvas.width / rect.width));
    const y = Math.round((e.clientY - rect.top) * (canvas.height / rect.height));

    if (state.isDrawingCalib) {
        // キャリブレーション描画モード
        state.calibPoints.push([x, y]);
        if (state.calibPoints.length === 2) {
            const p1 = state.calibPoints[0];
            const p2 = state.calibPoints[1];
            const dx = p1[0] - p2[0];
            const dy = p1[1] - p2[1];
            const pxLen = Math.sqrt(dx*dx + dy*dy);
            const physicalCm = parseFloat(calibLengthInput.value);
            
            if (pxLen > 0 && physicalCm > 0) {
                state.calibScale = physicalCm / pxLen;
                scaleRatioText.textContent = `${state.calibScale.toFixed(5)} cm/px (${pxLen.toFixed(1)} px = ${physicalCm} cm)`;
            }

            state.isDrawingCalib = false;
            btnDrawCalib.classList.remove('active');
            instructions.textContent = "スケール較正が完了しました。解析範囲 (4点) を指定するか、「根の解析を実行」をクリックしてください。";
        } else {
            instructions.textContent = "スケール基準線の終点（2点目）をクリックしてください。";
        }
        redrawCanvas();
    } else {
        // ROI（四隅）指定モード
        if (state.points.length < 4) {
            state.points.push([x, y]);
            redrawCanvas();

            if (state.points.length === 4) {
                instructions.textContent = "解析範囲 (ROI) の四隅が決定されました。「根の解析を実行」をクリックして開始します。やり直す場合は「初期化」を押してください。";
            } else {
                instructions.textContent = `解析範囲を囲むようにクリックしてください (あと ${4 - state.points.length} 点)。`;
            }
        }
    }
});

btnDrawCalib.addEventListener('click', () => {
    if (!state.imageLoaded) {
        alert('先に画像を読み込んでください。');
        return;
    }
    state.isDrawingCalib = true;
    state.calibPoints = [];
    btnDrawCalib.classList.add('active');
    instructions.textContent = "画像上のスケール基準線（例: 10cmのグリッド）の始点（1点目）をクリックしてください。";
    redrawCanvas();
});

// パラメータ変更のリアルタイム表示
threshSlider.addEventListener('input', (e) => {
    threshValText.textContent = e.target.value;
});
sizeSlider.addEventListener('input', (e) => {
    sizeValText.textContent = e.target.value;
});

// キャンバスの再描画
function redrawCanvas() {
    if (!state.imageLoaded) return;

    // 画像の描画
    ctx.drawImage(state.originalImage, 0, 0, state.scaledWidth, state.scaledHeight);

    // キャリブレーション線
    if (state.calibPoints.length > 0) {
        ctx.strokeStyle = '#00ff66';
        ctx.fillStyle = '#00ff66';
        ctx.lineWidth = Math.max(3, state.scaledWidth / 300);
        
        // 始点
        ctx.beginPath();
        ctx.arc(state.calibPoints[0][0], state.calibPoints[0][1], Math.max(5, state.scaledWidth / 150), 0, 2 * Math.PI);
        ctx.fill();

        if (state.calibPoints.length === 2) {
            // 終点と接続線
            ctx.beginPath();
            ctx.arc(state.calibPoints[1][0], state.calibPoints[1][1], Math.max(5, state.scaledWidth / 150), 0, 2 * Math.PI);
            ctx.fill();

            ctx.beginPath();
            ctx.moveTo(state.calibPoints[0][0], state.calibPoints[0][1]);
            ctx.lineTo(state.calibPoints[1][0], state.calibPoints[1][1]);
            ctx.stroke();
        }
    }

    // ROI 多角形
    if (state.points.length > 0) {
        ctx.strokeStyle = '#ff00ff';
        ctx.fillStyle = '#ff00ff';
        ctx.lineWidth = Math.max(3, state.scaledWidth / 250);

        state.points.forEach((pt, idx) => {
            ctx.beginPath();
            ctx.arc(pt[0], pt[1], Math.max(6, state.scaledWidth / 120), 0, 2 * Math.PI);
            ctx.fill();

            ctx.fillStyle = '#ffffff';
            ctx.font = `bold ${Math.max(14, state.scaledWidth / 60)}px Arial`;
            ctx.fillText(idx + 1, pt[0] + 10, pt[1] - 10);
            ctx.fillStyle = '#ff00ff';
        });

        if (state.points.length > 1) {
            ctx.beginPath();
            ctx.moveTo(state.points[0][0], state.points[0][1]);
            for (let i = 1; i < state.points.length; i++) {
                ctx.lineTo(state.points[i][0], state.points[i][1]);
            }
            if (state.points.length === 4) {
                ctx.closePath();
            }
            ctx.stroke();
        }
    }
}


// --- 解析処理の中核 (純粋なJavaScriptによる画像処理) ---

// 8x8連立一次方程式ソルバー (ガウス消去法)
function solve8x8(A, B) {
    const n = 8;
    for (let i = 0; i < n; i++) {
        // ピボット選択
        let maxRow = i;
        for (let k = i + 1; k < n; k++) {
            if (Math.abs(A[k][i]) > Math.abs(A[maxRow][i])) {
                maxRow = k;
            }
        }
        // 行入れ替え
        const tempRow = A[i];
        A[i] = A[maxRow];
        A[maxRow] = tempRow;
        
        const tempB = B[i];
        B[i] = B[maxRow];
        B[maxRow] = tempB;
        
        if (Math.abs(A[i][i]) < 1e-10) return null; // 解なし
        
        // 消去
        for (let k = i + 1; k < n; k++) {
            const factor = A[k][i] / A[i][i];
            for (let j = i; j < n; j++) {
                A[k][j] -= factor * A[i][j];
            }
            B[k] -= factor * B[i];
        }
    }
    // 後退代入
    const x = new Array(n).fill(0);
    for (let i = n - 1; i >= 0; i--) {
        let sum = B[i];
        for (let j = i + 1; j < n; j++) {
            sum -= A[i][j] * x[j];
        }
        x[i] = sum / A[i][i];
    }
    return x;
}

// 4点座標による射影変換 (逆マッピング)
function warpPerspectiveJS(srcCtx, srcPts, W, H) {
    // 宛先座標 [[0,0], [W-1,0], [W-1,H-1], [0,H-1]] から
    // 元画像座標 srcPts へのホモグラフィ行列 M を解く
    // x = (a*u + b*v + c)/(g*u + h*v + 1)
    // y = (d*u + e*v + f)/(g*u + h*v + 1)
    
    const A = [];
    const B = [];
    const dstPts = [
        [0, 0],
        [W - 1, 0],
        [W - 1, H - 1],
        [0, H - 1]
    ];

    for (let i = 0; i < 4; i++) {
        const u = dstPts[i][0];
        const v = dstPts[i][1];
        const x = srcPts[i][0];
        const y = srcPts[i][1];
        
        // x行
        A.push([u, v, 1, 0, 0, 0, -u*x, -v*x]);
        B.push(x);
        // y行
        A.push([0, 0, 0, u, v, 1, -u*y, -v*y]);
        B.push(y);
    }

    const M = solve8x8(A, B);
    if (!M) return null; // 変換行列の計算に失敗

    const [a, b, c, d, e, f, g, h] = M;

    // 出力用の ImageData を作成
    const outCanvas = document.createElement('canvas');
    outCanvas.width = W;
    outCanvas.height = H;
    const outCtx = outCanvas.getContext('2d');
    const outData = outCtx.createImageData(W, H);
    
    // 元画像の画像データを取得
    const srcData = srcCtx.getImageData(0, 0, srcCtx.canvas.width, srcCtx.canvas.height);
    const srcW = srcData.width;
    const srcH = srcData.height;
    const srcPixels = srcData.data;

    // 逆マッピング
    for (let v = 0; v < H; v++) {
        for (let u = 0; u < W; u++) {
            const denom = g * u + h * v + 1;
            const x = (a * u + b * v + c) / denom;
            const y = (d * u + e * v + f) / denom;

            const rx = Math.round(x);
            const ry = Math.round(y);

            let r = 255, gVal = 255, bVal = 255, alpha = 255;
            if (rx >= 0 && rx < srcW && ry >= 0 && ry < srcH) {
                const srcIdx = (ry * srcW + rx) * 4;
                r = srcPixels[srcIdx];
                gVal = srcPixels[srcIdx + 1];
                bVal = srcPixels[srcIdx + 2];
                alpha = srcPixels[srcIdx + 3];
            }

            const outIdx = (v * W + u) * 4;
            outData.data[outIdx] = r;
            outData.data[outIdx + 1] = gVal;
            outData.data[outIdx + 2] = bVal;
            outData.data[outIdx + 3] = alpha;
        }
    }
    
    outCtx.putImageData(outData, 0, 0);
    return outCtx;
}

// 二値化処理 (グレースケール変換 -> しきい値適用 -> 1D binary配列出力)
function thresholdImage(imgData, thresh) {
    const W = imgData.width;
    const H = imgData.height;
    const pixels = imgData.data;
    const binary = new Uint8Array(W * H);

    for (let i = 0; i < W * H; i++) {
        const idx = i * 4;
        const r = pixels[idx];
        const g = pixels[idx + 1];
        const b = pixels[idx + 2];
        
        // グレースケール (加重平均)
        const gray = 0.299 * r + 0.587 * g + 0.114 * b;
        
        // 根は暗い色(しきい値未満)なので、しきい値未満を「1(前景)」とする
        binary[i] = (gray < thresh) ? 1 : 0;
    }
    return binary;
}

// 接続成分フィルタリング (指定面積以下の小さなノイズを消去する)
function filterNoise(binary, W, H, minSize) {
    if (minSize <= 0) return binary;

    const visited = new Uint8Array(W * H);
    const filtered = new Uint8Array(binary); // コピー

    for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
            const idx = y * W + x;
            if (filtered[idx] === 1 && !visited[idx]) {
                // BFSで連結成分を走査
                const component = [];
                const queue = [[x, y]];
                visited[idx] = 1;
                
                let head = 0;
                while (head < queue.length) {
                    const [cx, cy] = queue[head++];
                    component.push(cy * W + cx);
                    
                    // 4近傍
                    const dirs = [[0,-1], [0,1], [-1,0], [1,0]];
                    for (const [dx, dy] of dirs) {
                        const nx = cx + dx;
                        const ny = cy + dy;
                        if (nx >= 0 && nx < W && ny >= 0 && ny < H) {
                            const nIdx = ny * W + nx;
                            if (filtered[nIdx] === 1 && !visited[nIdx]) {
                                visited[nIdx] = 1;
                                queue.push([nx, ny]);
                            }
                        }
                    }
                }

                // 面積が小さすぎる成分を消去
                if (component.length < minSize) {
                    for (const cIdx of component) {
                        filtered[cIdx] = 0;
                    }
                }
            }
        }
    }
    return filtered;
}

// Zhang-Suen 細線化 (スケルトン化) アルゴリズム
function zhangSuenThinning(binary, W, H) {
    const grid = new Uint8Array(binary);
    let changed = true;
    const toDelete = [];

    // 近傍配置
    // P9 P2 P3
    // P8 P1 P4
    // P7 P6 P5
    const getNeighbors = (grid, x, y, W, H) => {
        const p = new Uint8Array(10);
        const offsets = [
            [0,0], [0,-1], [1,-1], [1,0], [1,1],
            [0,1], [-1,1], [-1,0], [-1,-1], [0,-1] // 最後の[0,-1]はP2の複製（ループ処理用）
        ];
        
        for (let i = 1; i <= 9; i++) {
            const nx = x + offsets[i][0];
            const ny = y + offsets[i][1];
            if (nx >= 0 && nx < W && ny >= 0 && ny < H) {
                p[i] = grid[ny * W + nx];
            } else {
                p[i] = 0;
            }
        }
        p[0] = p[2]; // P2の参照
        return p;
    };

    while (changed) {
        changed = false;
        
        // --- サブステップ 1 ---
        for (let y = 1; y < H - 1; y++) {
            for (let x = 1; x < W - 1; x++) {
                const idx = y * W + x;
                if (grid[idx] === 0) continue;

                const p = getNeighbors(grid, x, y, W, H);
                
                // B(P1) = 近傍の黒画素数 (2 <= B <= 6)
                const B = p[2]+p[3]+p[4]+p[5]+p[6]+p[7]+p[8]+p[9];
                if (B < 2 || B > 6) continue;

                // A(P1) = 0->1の遷移数
                let A = 0;
                for (let i = 2; i <= 9; i++) {
                    if (p[i] === 0 && p[i+1] === 1) {
                        A++;
                    }
                }
                if (A !== 1) continue;

                // P2 * P4 * P6 = 0
                if (p[2] * p[4] * p[6] !== 0) continue;

                // P4 * P6 * P8 = 0
                if (p[4] * p[6] * p[8] !== 0) continue;

                toDelete.push(idx);
            }
        }
        
        if (toDelete.length > 0) {
            changed = true;
            for (const idx of toDelete) {
                grid[idx] = 0;
            }
            toDelete.length = 0;
        }

        // --- サブステップ 2 ---
        for (let y = 1; y < H - 1; y++) {
            for (let x = 1; x < W - 1; x++) {
                const idx = y * W + x;
                if (grid[idx] === 0) continue;

                const p = getNeighbors(grid, x, y, W, H);
                
                const B = p[2]+p[3]+p[4]+p[5]+p[6]+p[7]+p[8]+p[9];
                if (B < 2 || B > 6) continue;

                let A = 0;
                for (let i = 2; i <= 9; i++) {
                    if (p[i] === 0 && p[i+1] === 1) {
                        A++;
                    }
                }
                if (A !== 1) continue;

                // P2 * P4 * P8 = 0
                if (p[2] * p[4] * p[8] !== 0) continue;

                // P2 * P6 * P8 = 0
                if (p[2] * p[6] * p[8] !== 0) continue;

                toDelete.push(idx);
            }
        }
        
        if (toDelete.length > 0) {
            changed = true;
            for (const idx of toDelete) {
                grid[idx] = 0;
            }
            toDelete.length = 0;
        }
    }
    return grid;
}

// 芯線のトポロジー・距離の計算
function analyzeSkeleton(skeleton, W, H, scale) {
    const tips = [];
    const junctions = [];
    let totalLenPx = 0.0;

    const neighbors = [
        [-1,-1], [0,-1], [1,-1],
        [-1,0],          [1,0],
        [-1,1],  [0,1],  [1,1]
    ];

    for (let y = 1; y < H - 1; y++) {
        for (let x = 1; x < W - 1; x++) {
            const idx = y * W + x;
            if (skeleton[idx] === 0) continue;

            let connCount = 0;
            let orthoCount = 0;
            let diagCount = 0;

            for (const [dx, dy] of neighbors) {
                const nx = x + dx;
                const ny = y + dy;
                if (skeleton[ny * W + nx] === 1) {
                    connCount++;
                    if (dx !== 0 && dy !== 0) {
                        diagCount++;
                    } else {
                        orthoCount++;
                    }
                }
            }

            // 長さの局所加算 (重複を避けるため半分の重みで積算)
            totalLenPx += (orthoCount * 0.5) + (diagCount * 0.707);

            // トポロジー判定
            if (connCount === 1) {
                tips.push([x, y]); // 根端
            } else if (connCount >= 3) {
                junctions.push([x, y]); // 分岐点
            }
        }
    }

    return {
        totalLengthCm: totalLenPx * scale,
        rootTips: tips.length,
        junctions: junctions.length,
        tipsCoords: tips,
        junctionsCoords: junctions
    };
}


// --- メイン解析実行処理 ---

btnAnalyze.addEventListener('click', () => {
    if (!state.imageLoaded) return;

    // ローディング表示
    loadingOverlay.style.display = 'flex';
    btnAnalyze.disabled = true;

    // スレッド解放のために少し遅延させて画像処理を実行
    setTimeout(() => {
        try {
            // 1. 対象領域(ROI)の切り出し・補正（無ければ全体）
            let warpCtx = null;
            let width = 0;
            let height = 0;

            if (state.points.length === 4) {
                // 四隅が指定されている場合：射影変換
                // 切り出し後の幅と高さを、指定四角形の縦横の最大値から決定
                const p1 = state.points[0];
                const p2 = state.points[1];
                const p3 = state.points[2];
                const p4 = state.points[3];

                const w1 = Math.sqrt((p1[0] - p2[0])**2 + (p1[1] - p2[1])**2);
                const w2 = Math.sqrt((p4[0] - p3[0])**2 + (p4[1] - p3[1])**2);
                width = Math.round(Math.max(w1, w2));

                const h1 = Math.sqrt((p1[0] - p4[0])**2 + (p1[1] - p4[1])**2);
                const h2 = Math.sqrt((p2[0] - p3[0])**2 + (p2[1] - p3[1])**2);
                height = Math.round(Math.max(h1, h2));

                // 最低限のサイズ担保
                width = Math.max(100, width);
                height = Math.max(100, height);

                loadingText.textContent = "射影変換（歪み補正）を計算中...";
                warpCtx = warpPerspectiveJS(ctx, state.points, width, height);
            } else {
                // 四隅の指定がない場合：全体を解析
                width = state.scaledWidth;
                height = state.scaledHeight;
                const tempCanvas = document.createElement('canvas');
                tempCanvas.width = width;
                tempCanvas.height = height;
                warpCtx = tempCanvas.getContext('2d');
                warpCtx.drawImage(canvas, 0, 0);
            }

            if (!warpCtx) {
                throw new Error("射影変換の行列計算に失敗しました。四隅のクリック位置を確認してください。");
            }

            const imgData = warpCtx.getImageData(0, 0, width, height);

            // 2. 二値化の実行
            loadingText.textContent = "二値化＆ノイズフィルタリングを実行中...";
            const thresh = parseInt(threshSlider.value);
            const minSize = parseInt(sizeSlider.value);
            let binary = thresholdImage(imgData, thresh);
            binary = filterNoise(binary, width, height, minSize);

            // 二値化プレビューキャンバスへの描画
            binaryCanvas.width = width;
            binaryCanvas.height = height;
            const binCtx = binaryCanvas.getContext('2d');
            const binDataOut = binCtx.createImageData(width, height);
            for (let i = 0; i < width * height; i++) {
                const val = (binary[i] === 1) ? 255 : 0;
                const idx = i * 4;
                binDataOut.data[idx] = val;     // R
                binDataOut.data[idx + 1] = val; // G
                binDataOut.data[idx + 2] = val; // B
                binDataOut.data[idx + 3] = 255; // A
            }
            binCtx.putImageData(binDataOut, 0, 0);

            // 3. 細線化の実行
            loadingText.textContent = "細線化（Zhang-Suenアルゴリズム）を適用中...";
            const skeleton = zhangSuenThinning(binary, width, height);

            // 4. トポロジー・長さの計算
            loadingText.textContent = "長さおよび本数を測定中...";
            const analysis = analyzeSkeleton(skeleton, width, height, state.calibScale);

            // 数値表示の更新
            resLength.textContent = analysis.totalLengthCm.toFixed(2);
            resTips.textContent = analysis.rootTips;
            resJunctions.textContent = analysis.junctions;

            // 5. 重ね書き画像の描画
            overlayCanvas.width = width;
            overlayCanvas.height = height;
            const overCtx = overlayCanvas.getContext('2d');
            overCtx.putImageData(imgData, 0, 0); // ベース画像

            // スケルトンの描画 (赤線)
            overCtx.fillStyle = '#ff0000';
            for (let y = 0; y < height; y++) {
                for (let x = 0; x < width; x++) {
                    if (skeleton[y * width + x] === 1) {
                        overCtx.fillRect(x, y, 1, 1);
                    }
                }
            }

            // 根端の描画 (青丸)
            overCtx.fillStyle = '#0055ff';
            for (const [x, y] of analysis.tipsCoords) {
                overCtx.beginPath();
                overCtx.arc(x, y, 3, 0, 2 * Math.PI);
                overCtx.fill();
            }

            // 分岐点の描画 (黄四角)
            overCtx.fillStyle = '#ffb700';
            for (const [x, y] of analysis.junctionsCoords) {
                overCtx.fillRect(x - 2, y - 2, 5, 5);
            }

            instructions.textContent = "解析が完了しました！下の「解析オーバーレイ」または「二値化マスク」のタブをクリックして、詳細画像を確認できます。";
            switchTab('tab-overlay');

        } catch (err) {
            alert("エラーが発生しました: " + err.message);
        } finally {
            loadingOverlay.style.display = 'none';
            btnAnalyze.disabled = false;
        }
    }, 50);
});

// --- タブ切り替え処理 ---
const tabButtons = document.querySelectorAll('.tab-btn');
const tabPanes = document.querySelectorAll('.tab-pane');

tabButtons.forEach(btn => {
    btn.addEventListener('click', () => {
        const targetId = btn.getAttribute('data-target');
        switchTab(targetId);
    });
});

function switchTab(targetId) {
    tabButtons.forEach(b => {
        if (b.getAttribute('data-target') === targetId) {
            b.classList.add('active');
        } else {
            b.classList.remove('active');
        }
    });

    tabPanes.forEach(pane => {
        if (pane.id === targetId) {
            pane.classList.add('active');
        } else {
            pane.classList.remove('active');
        }
    });
}
