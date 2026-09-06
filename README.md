# 静默 API 故障转移 1.1.1

SillyTavern 浏览器扩展与配套服务端插件。按优先级尝试多个 API 地址、Key 和模型，完整回复成功后再显示；失败、切换和循环只写入插件记录。

[下载完整安装包](https://github.com/tiewangba2020/SillyTavern-SilentFailover/releases/latest) · [源码仓库](https://github.com/tiewangba2020/SillyTavern-SilentFailover)

## 安装

需要 SillyTavern 1.18.0 或更新版本，以及 Node.js 20.3 或更新版本，推荐仍在维护的 LTS 版本。当前已验证的酒馆提交为 `8172dcd0ee672d3cd9a5e5f7af134f91a45cd2b8`。更高版本需要重新确认宿主请求接口兼容性。

解压交付包后，在交付包目录运行：

```powershell
node install.mjs --target "D:\SillyTavern"
```

安装器会复制两部分、备份已有插件及 config.yaml，并仅将 `enableServerPlugins` 设为 true。它不会写入聊天、供应商 Key 或连接预设。安装或升级后重启酒馆并刷新网页。交付包已包含所有运行依赖，无需在酒馆或插件目录执行 npm install。

也可手动安装：

1. 将 `SillyTavern-SilentFailover` 目录放入酒馆的 `public/scripts/extensions/third-party/`。
2. 将 `SillyTavern-SilentFailover-Server` 目录放入酒馆的 `plugins/`。
3. 将酒馆 `config.yaml` 中 `enableServerPlugins` 设为 true，重启酒馆。

推荐从 GitHub Releases 下载完整安装包，解压后运行上面的安装命令，同时安装前端与服务端。仓库根目录也包含前端扩展入口，可将仓库 URL 粘贴到酒馆扩展管理器的“从 URL 安装”；使用此方式后，只需从安装包手动复制服务端目录并开启 `enableServerPlugins`，无需再次复制前端。两种安装方式选择一种，避免不同目录里重复加载同一扩展。前端和服务端应使用相同版本。

前端扩展安装 URL：

```text
https://github.com/tiewangba2020/SillyTavern-SilentFailover
```

## 配置与使用

1. 打开酒馆顶部的扩展设置，展开“静默 API 故障转移”。
2. 新增备用节点，选择 API 协议，填入名称、API 地址、模型 ID、API Key 和优先级。OpenAI 兼容地址通常以 `/v1` 结尾，也接受完整 `/chat/completions` 地址；Claude 使用 `/v1` 或完整 `/v1/messages`；Gemini 使用服务根地址或 `/v1beta`。
3. 需要时点击节点的测试图标。测试会发起一次小规模 API 请求，结果显示在请求记录中。
4. 推荐打开“原生连接优先”：保留酒馆当前 API 面板配置，每次先尝试它，失败再用备用节点。支持 Custom、OpenAI、Claude、Google AI Studio；插件首位显示当前原生模型与地址，不需要重复填写 Key。也可点击“仅使用备用节点”，切到仅使用插件节点的专用模式。
5. 可打开“自动循环重试”，默认关闭。轮次全部失败后默认等待 5 秒，再从最高优先级重试；间隔可调整。

保存后 Key 只显示掩码。编辑 Key 留空保留原值；删除节点同时删除该节点存储的 Key。模型可以手填，不依赖供应商的模型列表接口。

节点可设置“节点输出上限”，留空跟随酒馆；填写后仅降低该节点的输出 token 预算，不改动全局设置。Claude 节点会将超范围温度限制到 0 到 1，参数适配显示在请求记录中。模型可列出不等于账号具有生成额度。

原生首选动态跟随酒馆当前所选模型、地址和当前用户的有效密钥（或反向代理密码）；每次新生成读取一次，同一任务的重试固定该次原生配置。插件不会回写原生 Key。关闭“原生连接优先”或“启用故障转移”后，普通原生连接恢复直接请求。联动模式的连接状态只表示故障转移路由准备就绪，并不证明首选 API 可用；详情以生成记录为准。

官方 API 地址：OpenAI `https://api.openai.com/v1`，Claude `https://api.anthropic.com/v1`，Gemini `https://generativelanguage.googleapis.com`。网页会员订阅通常不包含 API 调用额度，需要对应官方 API 凭据。支持 Gemini API Key / Google AI Studio，不包含 Vertex AI 服务账号或网页会话登录。

“恢复原连接”恢复激活前保存的 API 类型和自定义连接字段。不要在供应商界面把 `http://sillytavern-failover.invalid/v1` 当成真实 API；它是扩展识别专用连接的标记，不会作为上游地址访问。

## 重试规则

- 优先级数字越小越先尝试；同优先级按列表顺序。
- 每个启用节点每轮调用一次；任一节点成功即结束。
- 原生联动开启时，每轮先尝试原生连接，再尝试备用节点。与原生地址、模型、Key、协议、输出上限及流式选项完全相同的备用节点跳过，避免重复请求。
- 循环关闭：一轮耗尽后静默结束，不添加空白回复或错误消息。
- 循环开启：无隐藏的最大轮数，直到成功或停止；遵守节点返回的 Retry-After。
- 关闭循环开关：当前轮允许完成，处于轮次等待时则立即结束。
- 停止生成、切换聊天、停用插件会取消任务。刷新/关闭页面后显式取消，最迟由 60 秒租约兜底停止；服务重启不自动恢复旧任务。
- 节点配置修改从下一轮生效；原始消息和提示词在整个任务内保持不变。
- 中途断流产生的半段内容丢弃，使用下一节点重新生成完整回复，不拼接不同模型的回答。

## 范围与数据

支持 OpenAI 文本 Chat Completions、Claude Messages 和 Gemini generateContent/streamGenerateContent，JSON 与 SSE 上游、单候选回复。Claude/Gemini 使用酒馆的消息转换和思考预算工具；支持常用采样、系统提示和思考参数，不等同于完整复刻宿主后端的所有扩展参数及缓存策略。图片/音频消息、工具调用、联网搜索、图像生成及并行候选未纳入此版本；结构化输出目前只由 OpenAI 兼容节点处理。范围外请求会记录原因并静默结束。正常拒答和 token 上限不视为 Key 故障。

故障转移通过专用连接或明确开启的原生联动请求适配器接入，不修改酒馆源代码、不屏蔽全局通知。完整结果转换为当前宿主所需的协议格式，由酒馆自身保存与显示。酒馆主服务器离线、原生反向代理首次确认等发生在插件接管之前的宿主流程，宿主仍可能显示自身提示；本插件不隐藏与自己无关的提示。联动配置不可读取时普通连接透传，避免插件服务缺失阻断原生使用。

备用节点配置与 Key 保存在各酒馆用户数据目录的 `silent-failover/config.json`，属于服务端明文文件；不写入 extensionSettings 或浏览器 localStorage。原生 Key 直接使用酒馆自身的密钥接口，仅在当前任务内存中使用，任务结束释放。记录文件为 `silent-failover/records.json`，不主动保存聊天请求/回复正文，供应商错误会脱敏并截断。默认只返回最近 100 个任务，每任务最多 1000 条详情；持久记录限制为 7 天、1000 个任务且总计 16 MiB。

循环等待期间只保留酒馆原有生成状态和停止按钮，详细轮次与错误在插件记录中查看。失败或超时的上游请求可能已计费。

请求记录以一个生成任务为单位：“第 X 轮”指完整队列的遍历轮次，“累计尝试 Y 次”指实际调用的节点总数。成功就结束，不必走完一轮。“已取消”表示任务整体停止，详情显示停止生成、切换聊天、关闭页面或连接变化等来源；旧版本未保存来源的记录无法补推原因。单节点测试也只尝试一次，不进入循环。

## 升级与回退

升级时重新运行安装器并重启酒馆。配置和记录位于用户数据目录，不会被插件文件升级覆盖。安装器备份位于 `backups/silent-failover-时间戳/`。

回退前停止酒馆，将所选备份中的两份插件目录恢复到原位置，并按需要恢复该备份的 config.yaml，再启动酒馆。卸载时先在界面恢复原连接，再移除两份插件目录；保留用户数据目录即可保留节点与记录。`enableServerPlugins` 可能也被其他插件使用，不应随意关闭。

## 开发与验证

源码仓库运行 `npm ci`、`npm test`、`npm run build`。浏览器测试使用 `npm run test:e2e`，预期独立酒馆测试副本运行在 8017、本地模拟供应商运行在 9107 和 9108（`node tests/mock-provider.mjs --serve`、`node tests/native-provider.mjs --serve`）。安装后的测试副本与用户真实聊天数据完全隔离。

公开验证摘要见 `docs/PUBLIC-VERIFICATION.md`，安装包内对应 `VERIFICATION.md`。发布内容不包含任何预置 API Key、个人节点配置、聊天、截图或真实 API 联调报告，首次安装的节点列表为空。
