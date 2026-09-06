# 源码开发

需要 Node.js 20.3 或更新版本。

```bash
npm ci
npm run build
npm test
```

构建结果在 `release/`，包含前端、服务端、安装器和供一键更新使用的更新包。前后端版本来自 `server/version.js` 与 `extension/manifest.json`，发布时需与 `package.json` 同步。

## 浏览器测试

使用独立的 SillyTavern 1.18.0 或更新版本测试实例，不要在真实聊天实例上运行测试。测试会修改该实例的节点、连接和聊天数据。

将构建结果安装到测试实例，在端口 8017 启动酒馆，并准备至少一个可选择的角色。另开两个终端启动模拟上游：

```bash
node tests/mock-provider.mjs --serve
```

```bash
node tests/native-provider.mjs --serve
```

模拟服务分别使用端口 9107 和 9108。准备 Chromium 后运行：

```bash
npx playwright install chromium
npm run test:e2e
```

测试产物保存在 `test-results/`、`playwright-report/` 和 `artifacts/`，不应提交。只使用模拟 Key 和本地模拟上游，勿在测试源码中加入真实密钥或供应商配置。
