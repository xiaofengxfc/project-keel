# KEEL 个人交易工作台

KEEL 是一个面向个人交易的 Binance USDⓈ-M Futures 工作台，采用白色、简洁的界面，并针对手机端做了单列布局和底部操作导航。

## 当前功能

- 无需填写 Binance API Key 即可通过 Binance Futures 公共 REST API 和 WebSocket 获取真实行情。
- 通过 Binance WebSocket 接收实时价格和涨跌幅。
- 搜索 Binance 可交易的 USDT 本位永续合约，并自动连接所选合约的行情与 K 线。
- 图表提供 EMA、SMA、布林带、VWAP、成交量、RSI、MACD、随机指标、ATR、ADX 和 OBV 显示；指标只用于观察 K 线，不自动生成交易结论。
- 使用 Lightweight Charts 展示可缩放的 K 线图。
- 图表显示参考入场、支撑、阻力、止损和止盈水平线，不额外绘制最新成交价线；自动价位线可双击隐藏并恢复。
- 支持手动画线和趋势线，并将画线按交易对保存到浏览器本地；切回选择工具后双击手动画线或趋势线可删除。
- 支持 15 分钟、1 小时、4 小时和 1 天 K 线；自动周期模式先用 1 小时识别，遇到震荡或突破观察时切换到 15 分钟并保持，直到手动选择周期、重新点击自动或切换交易对。
- 搜索框可搜索 Binance 可交易的 USDT 本位永续合约；点 ☆ 收藏后加入自选行情，列表支持拖拽或箭头排序并保存到浏览器本地。
- AI 解释层可读取通用模型的方向、概率、置信度和近期已收盘 K 线，解释模型依据、风险与失效条件。
- 震荡区间会区分下沿做多、上沿做空和中部观望，并标注边界外止损、区间另一侧止盈及最低参考盈亏比。
- 本地 Fastify 后端负责账户读取、交易规则校验和 Binance 私有接口签名。
- 下单支持限价、市价、止损/止盈限价与市价、追踪止损，以及订单有效期、触发价类型、价格保护、只减仓/全平、持仓模式、杠杆和全仓/逐仓设置；数量步长与价格 tick size 按 Binance 交易规则校验。
- 账户面板从 Binance 读取持仓、当前委托和所选交易对的历史订单，并支持撤单与刷新。
- 可在顶部或账户面板检测运行 KEEL 的机器当前出口 IP（由本地服务转发查询）；该地址可用于检查 Binance API IP 白名单配置。
- 预测卡片显示模型方向、概率、置信度、数据时间和模型版本；指标菜单只管理图表显示。
- 实盘交易默认关闭，未配置 API 或未打开安全开关时不会提交订单。

## 启动项目

```bash
npm install
npm run dev
```

打开 <http://localhost:5173>。开发服务器同时启动 Vite 前端和 `8788` 端口的本地后端。

## Binance 环境切换

通过 `.env` 中的 `BINANCE_ENV` 一键切换 Binance USDⓈ-M Futures 环境。修改后重启 `npm run dev` 并刷新页面：

```env
BINANCE_ENV=mainnet   # 正式网
# BINANCE_ENV=testnet # 合约测试网
```

`mainnet` 使用正式网 REST/WebSocket，`testnet` 使用 `https://testnet.binancefuture.com` 与 `wss://stream.binancefuture.com`。测试网凭证填写 `BINANCE_TESTNET_API_KEY` / `BINANCE_TESTNET_API_SECRET`，正式网凭证填写 `BINANCE_MAINNET_API_KEY` / `BINANCE_MAINNET_API_SECRET`。未设置正式网专用变量时，会兼容回退到旧的 `BINANCE_API_KEY` / `BINANCE_API_SECRET`。

## 私有 API 配置

复制 `.env.example` 为 `.env`，然后填写本地后端需要的配置：

```env
BINANCE_MAINNET_API_KEY=正式网APIKey
BINANCE_MAINNET_API_SECRET=正式网APISecret
BINANCE_TESTNET_API_KEY=测试网APIKey
BINANCE_TESTNET_API_SECRET=测试网APISecret
TRADING_ENABLED=false
```

建议先使用只读 API 权限完成账户联调。确认订单参数、数量精度、价格精度和风险控制均符合预期后，再由你手动将 `TRADING_ENABLED` 改为 `true`。API Key 不会进入浏览器，也不应开启提现权限。

如需接入真实 AI 服务，可以继续配置 OpenAI 兼容接口。`OPENAI_API_BASE` 填写服务的基础地址，程序会请求其 `/chat/completions` 路径；因此可以直接填写官方地址，也可以填写兼容中转地址。使用不要求鉴权的本地中转时，API Key 可以留空。

```env
OPENAI_API_BASE=https://api.openai.com/v1
OPENAI_API_KEY=你的服务密钥
OPENAI_MODEL=你的模型名称
```

也支持用 `OPENAI_BASE_URL` 作为 `OPENAI_API_BASE` 的别名。API Key 只保存在本地后端环境变量中，不会发送到浏览器。

未配置 AI 服务时，界面会给出明确的未配置提示，不会把演示文本当作真实分析结果。

## 本地预测模型

前端默认读取本地 Python 推理服务。模型使用已收盘 K 线训练 LightGBM 三分类器（下跌、中性、上涨），导出 ONNX 后由 FastAPI 在本机推理；AI 解释层只说明模型结果，不会自动下单。训练数据和模型文件默认被 `.gitignore` 排除，请在部署机器上重新生成。

```powershell
python -m pip install -r prediction\requirements.txt
python -m prediction.collect_klines --symbol BTCUSDT --interval 1h --start-time 1704067200000 --output data\BTCUSDT-1h.csv
python -m prediction.train --input data --interval 1h --horizon-bars 3 --output-dir prediction\models\1h
$env:PREDICTION_MODEL_DIR = "prediction\models"
python -m prediction.service
```

再在 `.env` 中启用后端代理：

```env
PREDICTION_ENABLED=true
PREDICTION_SERVICE_URL=http://127.0.0.1:8790/predict
```

将多个交易对的 CSV 一起传给训练命令会生成通用模型，特征使用相对收益、波动率和成交量比等指标，推理时可覆盖训练数据中的交易对。每个周期要单独训练并放入 `prediction/models/<interval>`；如果只传一个 CSV 并指定交易对，则生成的模型只适用于该交易对。

## 检查命令

```bash
npm run build
npm run lint
npm test
```

行情连接失败时，界面会显示空状态和连接状态，不会静默使用模拟行情或虚构账户数据。
