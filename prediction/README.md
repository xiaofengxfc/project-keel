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

服务默认监听 `127.0.0.1:8790`。没有模型文件或 ONNX 运行时不可用时，`/health` 会返回 `ready:false`，`/predict` 返回 503；前端会明确显示预测不可用，不会生成替代性的自动交易结论。

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

模型结果只展示方向概率并交给 AI 解释层说明，模型不会直接驱动下单。上线前应记录后续真实结果，持续观察命中率、覆盖率和 Brier 分数。

## 自动重训练

可以把下面的一次性命令交给 Windows 任务计划程序或其他调度器定期执行。它会采集多个交易对、训练候选通用模型，并且只有候选模型同时不劣于当前模型时才替换；旧模型保存在 `prediction/models/1h.previous`。

```powershell
python -m prediction.auto_train --symbols BTCUSDT,ETHUSDT,BNBUSDT,SOLUSDT --interval 1h
```

重训练任务按时间顺序建立训练、校准和独立测试折，并 purge 标签跨界样本，要求足够的独立测试样本，报告准确率、平衡准确率、宏 F1、覆盖率和 Brier 分数；当前模型可兼容时，会在同一测试折上做比较，无法公平比较时不会自动晋级。该留出评估不等同于“未见币种”测试，也不证明模型能泛化到任意资产；应在不同币种与市场阶段持续评估。不会用固定准确率百分比隐藏方向概率。界面显示上涨、下跌和中性概率，并同时呈现测试指标与持续累积的前向验证结果；这些历史指标不保证未来表现。

重训练完成后重启本地推理服务，使其加载新模型。不要把自动重训练直接连接到下单逻辑。

侧边栏的“模型训练”页面可同时选择多个周期。后端会在一个持久任务中逐周期训练，各周期独立验证、晋级并保存在 `prediction/models/<周期>/`；刷新页面会重新读取任务状态。任务状态和最近日志默认保存在 `prediction/validation/training-state.json` 与 `training.log`，可用 `PREDICTION_TRAINING_STATE_FILE`、`PREDICTION_TRAINING_LOG_FILE` 更改位置。各周期结果相互独立，单个周期失败不会撤销其他已完成周期。

采集会复用 `data/<币种>-<周期>.csv`，先补最新 K 线，再补全已有历史缺口；每页成功后原子写入检查点，便于失败后续跑。Binance 限流、服务器错误和网络超时会进行退避重试，次数可由 `PREDICTION_COLLECT_RETRIES` 配置。训练页面会显示当前周期、币种、采集阶段和周期结果。关闭浏览器不影响后端 worker；若 worker 在后端重启期间已退出，状态会标记为中断并保留日志。

## 前向验证记录

推理服务会把每次预测的方向概率和必要的结算信息保存在本机 SQLite 数据库中，后续收到目标 K 线后计算真实类别、命中率和 Brier 分数。数据库默认位于 `prediction/validation/predictions.sqlite3`，默认保留 90 天；只保存预测结果及用于结算的收盘价，不保存原始 K 线。该目录已加入 `.gitignore`，不会随源码提交。

可通过 `PREDICTION_VALIDATION_DB` 指定数据库文件，或用 `PREDICTION_VALIDATION_DIR` 指定数据库目录；`PREDICTION_VALIDATION_RETENTION_DAYS` 可调整保留天数。服务提供只含聚合指标的 `GET /validation/metrics`，可选按 `symbol`、`interval` 和 `horizonBars` 筛选，例如：

```text
GET /validation/metrics?symbol=BTCUSDT&interval=1h&horizonBars=3
```

如果本地数据库不可写，预测仍可正常运行，只是前向验证记录暂不可用。

