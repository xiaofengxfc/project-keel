# KEEL 本地预测模型

这套脚本使用已收盘的 Binance USDⓈ-M Futures K 线训练 LightGBM 三分类模型，再导出为 ONNX，由本地 FastAPI 服务加载推理。类别为 `DOWN`、`NEUTRAL`、`UP`。模型只返回方向概率，不生成订单参数。

## 安装

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r prediction\requirements.txt
```

## 采集训练数据

```powershell
python -m prediction.collect_klines --symbol BTCUSDT --interval 1h --start-time 1704067200000 --output data\BTCUSDT-1h.csv
```

采集器支持 `--base-url` 和 `HTTPS_PROXY`，默认使用正式网 Futures REST。训练数据必须保留时间顺序，不能随机打乱。

## 训练和导出

```powershell
python -m prediction.train --input data --interval 1h --horizon-bars 3 --output-dir prediction\models\1h
```

传入包含 `*-1h.csv` 文件的目录或多个 CSV 会训练一个通用模型，元数据中的 `symbol` 为 `*`，推理时可用于训练覆盖范围内的任意交易对。单个 CSV 可以通过 `--symbol BTCUSDT` 生成单币种模型。每个周期分别训练，不能把 15m、1h 等不同周期混在同一个模型中。训练会按时间顺序划分训练、验证和测试集，并输出：

- `direction.txt`：LightGBM 原生模型
- `direction.onnx`：CPU ONNX 推理模型
- `metadata.json`：特征、类别、周期、模型版本和测试指标

至少需要 120 条有效训练样本；通用模型建议为每个交易对准备数千根以上的历史 K 线，并覆盖不同市场阶段。特征使用收益率、波动率、成交量比等相对值，因此不会依赖某个币种的绝对价格。

## 启动推理服务

```powershell
$env:PREDICTION_MODEL_DIR = "prediction\models"
python -m prediction.service
```

服务默认监听 `127.0.0.1:8790`。没有模型文件或 ONNX 运行时不可用时，`/health` 会返回 `ready:false`，`/predict` 返回 503；这不会影响主交易后端降级到规则分析。

请求示例：

```json
POST /predict
{
  "symbol": "BTCUSDT",
  "interval": "1h",
  "horizonBars": 3,
  "candles": [
    {"time": 1704067200, "open": 42000, "high": 42100, "low": 41900, "close": 42050, "volume": 100}
  ]
}
```

返回包含模型版本、数据截至时间、预测周期、三个方向概率和置信度。服务会再次校验并剔除正在形成的 K 线，避免 lookahead。

首期建议使用影子模式：只展示预测并记录后续实际结果，观察命中率和 Brier 分数后再考虑用于辅助判断。模型不会直接驱动下单。

