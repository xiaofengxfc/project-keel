# KEEL 个人交易工作台

KEEL 是一个面向个人交易的 Binance USDⓈ-M Futures 工作台，采用白色、简洁的界面，并针对手机端做了单列布局和底部操作导航。

## 当前功能

- 无需填写 Binance API Key 即可通过 Binance Futures 公共 REST API 和 WebSocket 获取真实行情。
- 通过 Binance WebSocket 接收实时价格和涨跌幅。
- 使用 Lightweight Charts 展示可缩放的 K 线图。
- 支持支撑位、止损水平线和趋势线，并将画线按交易对保存到浏览器本地；切回选择工具后双击手动画线或趋势线可删除，程序分析线不会被误删。
- 支持 15 分钟、1 小时、4 小时和 1 天 K 线；自动周期模式先用 1 小时识别，遇到震荡或突破观察时切换到 15 分钟并保持，直到手动选择周期或重新点击自动。
- 搜索框只过滤内置自选交易对，不会新增 Binance 交易对。
- AI 助手可按需携带当前交易对、周期、近期 K 线、程序分析和画线信息进行专项复核。
- 震荡区间会区分下沿做多、上沿做空和中部观望，并标注边界外止损、区间另一侧止盈及最低参考盈亏比。
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

如需接入真实 AI 服务，可以继续配置 OpenAI 兼容接口。`OPENAI_API_BASE` 填写服务的基础地址，程序会请求其 `/chat/completions` 路径；因此可以直接填写官方地址，也可以填写兼容中转地址。使用不要求鉴权的本地中转时，API Key 可以留空。

```env
OPENAI_API_BASE=https://api.openai.com/v1
OPENAI_API_KEY=你的服务密钥
OPENAI_MODEL=你的模型名称
```

也支持用 `OPENAI_BASE_URL` 作为 `OPENAI_API_BASE` 的别名。API Key 只保存在本地后端环境变量中，不会发送到浏览器。

未配置 AI 服务时，界面会给出明确的未配置提示，不会把演示文本当作真实分析结果。

## 检查命令

```bash
npm run build
npm run lint
```

行情连接失败时，界面会显示空状态和连接状态，不会静默使用模拟行情或虚构账户数据。
