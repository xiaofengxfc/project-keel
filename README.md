# KEEL 个人交易工作台

KEEL 是一个面向个人交易的 Binance USDⓈ-M Futures 工作台，采用白色、简洁的界面，并针对手机端做了单列布局和底部操作导航。

## 当前功能

- 通过 Binance Futures REST API 获取真实 K 线。
- 通过 Binance WebSocket 接收实时价格和涨跌幅。
- 使用 Lightweight Charts 展示可缩放的 K 线图。
- 支持支撑位、止损水平线和趋势线，并将画线按交易对保存到浏览器本地。
- 双击水平线可以删除，趋势线需要在图表上依次选择起点和终点。
- AI 助手可携带当前交易对、周期、价格和画线信息提问。
- 本地 Fastify 后端负责账户读取、交易规则校验和 Binance 私有接口签名。
- 实盘交易默认关闭，未配置 API 或未打开安全开关时不会提交订单。

## 启动项目

```bash
npm install
npm run dev
```

打开 <http://localhost:5173>。开发服务器同时启动 Vite 前端和 `8787` 端口的本地后端。

## 私有 API 配置

复制 `.env.example` 为 `.env`，然后填写本地后端需要的配置：

```env
BINANCE_API_KEY=你的币安APIKey
BINANCE_API_SECRET=你的币安APISecret
TRADING_ENABLED=false
```

建议先使用只读 API 权限完成账户联调。确认订单参数、数量精度、价格精度和风险控制均符合预期后，再由你手动将 `TRADING_ENABLED` 改为 `true`。API Key 不会进入浏览器，也不应开启提现权限。

如需接入真实 AI 服务，可以继续配置：

```env
OPENAI_API_KEY=你的服务密钥
OPENAI_MODEL=你的模型名称
```

未配置 AI 服务时，界面会给出明确的未配置提示，不会把演示文本当作真实分析结果。

## 检查命令

```bash
npm run build
npm run lint
```

行情连接失败时，界面会显示空状态和连接状态，不会静默使用模拟行情或虚构账户数据。
