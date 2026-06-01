# Lark Copilot MCP

这个项目把 GitHub Copilot Chat 和飞书开放平台打通：Copilot 通过 VS Code 的 MCP 配置启动本服务，本服务再使用飞书应用的 `app_id` / `app_secret` 调用开放平台 API。

## 已提供的工具

- `feishu_send_text_message`: 给用户或群聊发送文本消息。
- `feishu_list_chats`: 查看应用机器人可访问的群聊。
- `feishu_api_request`: 调用任意飞书开放平台 API，适合你已经申请好权限后继续扩展。

## 自动回复

## 自动回复控制台

项目内置一个极简网页控制台，可以在电脑或手机浏览器里登录后，一键启动、停止或重启服务器上的自动回复 PM2 进程。控制台应作为独立 PM2 应用运行，这样停止 `lark-autoreply` 时不会把控制台一起停掉。

在 `.env` 中配置：

```text
LARK_CONTROL_PANEL_HOST=0.0.0.0
LARK_CONTROL_PANEL_PORT=8788
LARK_CONTROL_PANEL_USERNAME=admin
LARK_CONTROL_PANEL_PASSWORD=replace-with-a-strong-password
LARK_CONTROL_PANEL_SESSION_SECRET=replace-with-a-long-random-secret
LARK_CONTROL_PANEL_PM2_APP=lark-autoreply
LARK_CONTROL_PANEL_SESSION_SECONDS=43200
LARK_CONTROL_PANEL_REMEMBER_SECONDS=2592000
LARK_AUTOREPLY_SWITCHES_FILE=.lark-auto-reply-switches.json
LARK_AUTOREPLY_SWITCHES_RELOAD_MS=1000
```

登录页默认勾选“记住登录”，会保存 30 天签名登录状态；取消勾选时默认 12 小时后需要重新登录。可以通过 `LARK_CONTROL_PANEL_REMEMBER_SECONDS` 和 `LARK_CONTROL_PANEL_SESSION_SECONDS` 调整时长。

控制台还提供运行时开关：群聊固定回复、单聊固定回复、单聊 AI 回复，以及 `LARK_SMART_REPLY_TARGET_NAMES` 中每个 AI 单聊联系人的独立开关。开关状态保存在 `LARK_AUTOREPLY_SWITCHES_FILE` 指定的文件里，自动回复进程默认每秒读取一次；关闭某类回复或某个人期间收到的对应消息会被跳过并记为已处理，重新打开后不会补发旧消息。

本地或服务器启动：

```powershell
npm.cmd run control:panel
```

PM2 部署时使用 `ecosystem.config.cjs` 会同时包含：

- `lark-autoreply`：自动回复主服务
- `lark-control-panel`：网页控制台

浏览器访问：

```text
http://服务器IP:8788
```

公网使用时请务必设置强密码；后续如绑定域名，建议放到 HTTPS 后面。

如果要在目标联系人给你发飞书消息时自动回复，先完成用户授权：

```powershell
npm.cmd run oauth:login
```

如果用户 token 经常过期，可以让授权链接只请求离线续期能力，重新授权后检查 `.lark-user-token.json` 是否出现 `refresh_token`：

```text
LARK_OAUTH_SCOPE_MODE=offline
```

`LARK_OAUTH_SCOPE_MODE` 支持 `default`、`offline`、`full`、`full_with_offline`。`offline` 只在授权链接里带 `offline_access`，用于避开完整 scope URL 过长或触发飞书 `20029` 的情况；`full_with_offline` 会把 `LARK_OAUTH_SCOPES` 和 `offline_access` 一起请求。

然后在 `.env` 中按需配置：

```text
LARK_AUTOREPLY_TARGETS=department:研发中心,department:产品中心,department:项目中心,department:Global Business,person:陈威,person:刘峥
# 如果还要额外加个人，可以写成：
# LARK_AUTOREPLY_TARGETS=department:系统部,person:张三
# 如果已经知道部门 open_department_id，也可以用：
# LARK_AUTOREPLY_TARGETS=department_id:od_xxx
# 群聊可以直接填 chat_id，只有群里有人 @ 你时才触发：
# LARK_AUTOREPLY_TARGETS=chat:oc_xxx
# 即使某个人属于已配置部门，也可以用排除名单跳过
LARK_AUTOREPLY_EXCLUDE_TARGET_NAMES=

# 旧配置仍兼容；当 LARK_AUTOREPLY_TARGETS 存在时会忽略这个 people-only 配置
LARK_AUTOREPLY_TARGET_NAMES=谷力刚,陈威
LARK_AUTOREPLY_TARGET_NAME=陈威
LARK_AUTOREPLY_MODE=mixed
LARK_SMART_REPLY_TARGET_NAMES=李文贤,何运伟,谷力刚,邓景夫,吴德宏,曾庆锦
LARK_AUTOREPLY_TEXTS=我现在不在，消息还没收到，先别急着把锅扣过来。|你又召唤了一次，但我这边还是离线状态。|第三次呼叫已记录，我本人依旧没有上线。
LARK_AUTOREPLY_REPLY_TO_SOURCE_MESSAGE_ENABLED=true
LARK_AUTOREPLY_REPLY_EXISTING=false
LARK_AUTOREPLY_POLL_SECONDS=0.3
LARK_AUTOREPLY_POLL_MS=300
LARK_AUTOREPLY_POLL_OVERLAP_SECONDS=120
LARK_AUTOREPLY_PRIORITY_POLL_CONCURRENCY=3
LARK_AUTOREPLY_FULL_POLL_MS=10000
LARK_AUTOREPLY_POLL_CONCURRENCY=8
LARK_AUTOREPLY_RATE_LIMIT_BACKOFF_MS=3000
LARK_AUTOREPLY_MAX_BACKOFF_MS=30000
LARK_AUTOREPLY_MAX_DEPARTMENT_USERS=1000
LARK_AUTOREPLY_MAX_DEPARTMENT_DEPTH=6
LARK_AUTOREPLY_SEARCH_MISSING_DEPARTMENT_CHAT_IDS=false
LARK_AUTOREPLY_VERBOSE_TARGETS=false
LARK_AUTOREPLY_VERBOSE_SKIPPED_TARGETS=false
# 如果自动发现失败，手动填这两个值
# LARK_AUTOREPLY_TARGET_OPEN_ID=ou_xxx
# LARK_AUTOREPLY_CHAT_ID=oc_xxx
```

`LARK_AUTOREPLY_TARGETS` 支持 `person:姓名`、`external:姓名`、`department:部门名`、`department_id:open_department_id`、`chat:chat_id`。脚本会把部门及其子部门递归展开成联系人，再按 `open_id` 去重，所以同一个人同时出现在个人名单和部门里也只会监听一次。`external:姓名` 会优先匹配外部联系人，适合同名内外部联系人并存的情况。群聊目标只在群里有人 @ 当前账号时触发，避免普通群聊内容刷屏自动回复。`LARK_AUTOREPLY_EXCLUDE_TARGET_NAMES` 会在个人目标和部门展开结果里统一生效。

大部门展开时，建议保持 `LARK_AUTOREPLY_SEARCH_MISSING_DEPARTMENT_CHAT_IDS=false`，只纳入飞书接口直接返回了私聊 `chat_id` 或已经缓存过 `chat_id` 的联系人，避免逐个搜索触发通讯录接口限流。

低延迟轮询可以用 `LARK_AUTOREPLY_POLL_MS`、`LARK_AUTOREPLY_PRIORITY_POLL_CONCURRENCY`、`LARK_AUTOREPLY_FULL_POLL_MS` 和 `LARK_AUTOREPLY_POLL_CONCURRENCY` 控制。开启混合模式时，智能回复目标会走优先通道，例如 `LARK_AUTOREPLY_POLL_MS=300` 表示李文贤、何运伟、`external:李翔` 每轮结束后只等 300ms；固定回复目标默认走全量扫描，例如 `LARK_AUTOREPLY_FULL_POLL_MS=10000` 表示每 10 秒扫一次。需要固定文案但又要低延迟的联系人，可以放进 `LARK_AUTOREPLY_PRIORITY_FIXED_TARGET_NAMES`，例如 `person:Lee` 会走优先轮询但仍发送固定文案。`LARK_AUTOREPLY_POLL_OVERLAP_SECONDS` 会让每次轮询向前重叠一小段时间，再用已回复消息 ID 去重，避免飞书消息列表接口短暂延迟时漏掉最后一条消息。程序遇到飞书限流后会按 `LARK_AUTOREPLY_RATE_LIMIT_BACKOFF_MS` 和 `LARK_AUTOREPLY_MAX_BACKOFF_MS` 自动退避。

飞书开放平台的消息已读接口目前只能查询应用/机器人自己发出的消息是否被别人读了，不能用当前用户 token 查询“别人发给我以后我是否已读”。如果想避免你已经在飞书里手动接话后机器人还继续回复，可以开启手动回复保护：

```text
LARK_AUTOREPLY_SKIP_IF_SELF_REPLIED_ENABLED=true
LARK_AUTOREPLY_SELF_REPLY_CHECK_DELAY_MS=2000
```

开启后，程序会在发送自动回复前等待一个短窗口，再重新读取这段聊天；如果发现你本人已经在目标消息之后发过非自动回复内容，就把该目标消息记为已处理并跳过自动回复。智能回复生成耗时会计入这个等待窗口，所以通常不会额外慢满整段时间。

启动日志默认只显示目标数量和回复分组，避免大部门刷屏。需要排查名单时，把 `LARK_AUTOREPLY_VERBOSE_TARGETS=true`；需要查看哪些部门成员因为没有私聊 `chat_id` 被跳过时，把 `LARK_AUTOREPLY_VERBOSE_SKIPPED_TARGETS=true`。

自动回复只会响应明确识别为目标联系人发给你的消息；你发给对方的消息、机器人自己发出的消息、以及接口没有返回发送人 `open_id` 的消息都会跳过。目标联系人发来的文字、表情、链接、图片等任意消息类型都会触发回复。固定文案模式会把 `LARK_AUTOREPLY_TEXTS` 里用 `|` 分隔的文本当作递进层级：同一会话第一次触发发第 1 条，第二次触发发第 2 条，达到最后一条后继续维持最后一条；如果检测到你在该会话里发过非自动回复内容，递进层级会清零。如果没有配置 `LARK_AUTOREPLY_TEXTS`，旧的 `LARK_AUTOREPLY_TEXT` 仍兼容。

默认 `LARK_AUTOREPLY_REPLY_EXISTING=false`，自动回复进程每次启动后只处理启动之后的新消息，不会补发停止期间累积的历史消息。如果确实要临时补处理历史消息，可以手动设置为 `true`。

默认情况下，自动回复会优先用飞书“回复某条消息”的形式挂到触发它的那条消息下面；如果该接口在某些外部联系人或权限场景失败，会自动回退为普通发消息。需要强制使用普通发消息时，可以设置 `LARK_AUTOREPLY_REPLY_TO_SOURCE_MESSAGE_ENABLED=false`。

所有自动发送的固定回复、AI 回复和工具跟进回复都会默认在结尾加上 `ᵃʳ` 标记，用来和用户真人回复区分。这个标记也会被智能上下文和风格学习脚本识别并跳过，避免把自动回复当成真人样本学习。如果确实要改标记，可以设置 `LARK_AUTOREPLY_MARKER`。历史 `ar` 后缀和 `AR:` 前缀仍会被识别为自动回复，避免污染训练样本。

风格学习和自评可以用 `npm run smart:learn`、`npm run smart:self-review`。自评脚本会读取学习样本或手工评测样本，生成候选回复，再用规则和 AI 评审打分，报告保存在 `.training/smart-reply-self-review.md` 和 `.training/smart-reply-self-review.json`。

05 工程里的智能回复功能已经合并到同一个 04 进程里。默认 `LARK_AUTOREPLY_MODE=mixed`：`LARK_SMART_REPLY_TARGET_NAMES` 里的联系人走 AI 智能回复，其他被监听目标继续走固定文案。配置 OpenAI 兼容的 Chat Completions 接口后即可启用智能联系人回复：

```text
LARK_AUTOREPLY_MODE=mixed
LARK_SMART_REPLY_TARGET_NAMES=李文贤,何运伟,谷力刚,邓景夫,吴德宏,曾庆锦,external:李翔
LARK_SMART_REPLY_API_KEY=sk_xxx
LARK_SMART_REPLY_API_URL=https://api.openai.com/v1/chat/completions
LARK_SMART_REPLY_MODEL=gpt-4o-mini
LARK_SMART_REPLY_CONTEXT_SECONDS=86400
LARK_SMART_REPLY_MAX_MESSAGES=3
LARK_REALTIME_WEATHER_ENABLED=true
LARK_REALTIME_WEATHER_DEFAULT_LOCATION=
LARK_REALTIME_REPLY_DELAY_MS=1800
LARK_SMART_REPLY_STYLE=用中文自然简短回复，像我本人在飞书里随手打字；不确定就说我确认下再回。
# LARK_SMART_REPLY_EXTRA_CONTEXT=我最近主要在处理 XXX 项目，语气直接但礼貌。
```

混合模式仍使用同一个 `npm.cmd run autoreply` 轮询进程，目标联系人继续由 `LARK_AUTOREPLY_TARGETS` 控制。比如要让李文贤、何运伟、谷力刚、邓景夫、吴德宏、曾庆锦走 AI，同时其他部门/个人走固定文案，可以这样配置：

```text
LARK_AUTOREPLY_TARGETS=department:研发中心,department:产品中心,department:项目中心,department:Global Business,person:陈威,person:刘峥,person:李文贤,person:何运伟,person:谷力刚,person:邓景夫,person:吴德宏,person:曾庆锦,external:李翔
LARK_AUTOREPLY_EXCLUDE_TARGET_NAMES=
LARK_AUTOREPLY_MODE=mixed
LARK_SMART_REPLY_TARGET_NAMES=李文贤,何运伟,谷力刚,邓景夫,吴德宏,曾庆锦,external:李翔
```

智能联系人每收到一条目标消息会读取最近一段聊天上下文，生成回复并发送；不会再按 `LARK_AUTOREPLY_TEXTS` 连续发送固定文案。智能回复可以用 `|` 分隔成最多 `LARK_SMART_REPLY_MAX_MESSAGES` 条短消息，默认最多 3 条，用来模拟真人连续发几句。`LARK_SMART_REPLY_CONTEXT_SECONDS` 控制用于生成回复的上下文时间范围，默认 24 小时。如果想所有目标都走固定文案，设置 `LARK_AUTOREPLY_MODE=fixed`；如果想所有目标都走 AI，设置 `LARK_AUTOREPLY_MODE=smart`。

天气类实时问题会走真实查询流程，不交给模型编造。对方问“深圳天气怎么样”时，程序会先发“我看下深圳天气”，再调用天气接口并补发结果；如果对方只问“帮我查一下天气”但没说城市，程序会问“你问哪个城市的天气？”，并在 10 分钟内接住下一条城市名继续查询。`LARK_REALTIME_REPLY_DELAY_MS` 控制第二条结果至少延迟多久发出。

智能回复还可以读取本地飞书知识索引。先配置项目关键词、飞书文档链接或手动背景，再运行同步脚本：

```text
LARK_KNOWLEDGE_ENABLED=true
LARK_KNOWLEDGE_KEYWORDS=DK057,DK075
LARK_KNOWLEDGE_SEARCH_CLOUD_DOCS=true
LARK_KNOWLEDGE_SEARCH_TYPES=doc,sheet
# 可选：限制文件所有者 Open ID；留空时搜索当前用户可见且命中关键词的云文档
LARK_KNOWLEDGE_OWNER_IDS=
LARK_KNOWLEDGE_CHUNK_CHARS=1800
LARK_KNOWLEDGE_CHUNK_OVERLAP_CHARS=180
LARK_KNOWLEDGE_SNIPPET_CHARS=900
LARK_KNOWLEDGE_DOC_URLS=https://example.feishu.cn/docx/xxxx
LARK_KNOWLEDGE_NOTES=DK057、DK075 是我最近重点推进和关注的项目。
```

```powershell
npm.cmd run knowledge:sync
```

同步会生成 `.knowledge/index.json`，自动回复进程会每分钟重新读取一次。当前同步使用 `POST /open-apis/suite/docs-api/search/object` 按 `LARK_KNOWLEDGE_KEYWORDS` 或 `LARK_KNOWLEDGE_SEARCH_KEYS` 搜索当前用户可见且命中关键词的云文档；接口要求 token 具备 `search:docs:read`、`drive:drive:readonly` 或 `drive:drive` 之一。搜索到新版飞书文档后，如果 token 具备 `docs:document.content:read`，会用 `GET /open-apis/docs/v1/content` 读取 Markdown 正文；否则先索引标题。表格搜索结果会先索引标题和摘要；如需读取表格单元格全文，需要继续补充表格范围读取配置。

长文档会在保存索引前按 Markdown 标题和固定长度切成 chunk。`LARK_KNOWLEDGE_CHUNK_CHARS` 控制每个 chunk 的目标长度，`LARK_KNOWLEDGE_CHUNK_OVERLAP_CHARS` 控制相邻超长切片的重叠字符数。自动回复时检索的是 chunk，不是整篇文档；最终传给模型的片段长度由 `LARK_KNOWLEDGE_SNIPPET_CHARS` 控制。

外部联系人的消息仍从你的用户私聊历史里监听；回复时会改用机器人身份发送给该外部联系人的 `open_id`。因此外部用户需要先和机器人建立/授权单聊，否则机器人发送会失败并提示 `Bot has NO availability to this user`。内部联系人仍按原策略用你的用户身份在原私聊中回复。

推荐使用轮询模式启动自动回复。脚本会用用户授权读取私聊历史，并从联系人信息里自动发现单聊 `chat_id`，所以一般不需要手动填写 `LARK_AUTOREPLY_CHAT_ID`：

```powershell
npm.cmd run autoreply
```

长连接模式也保留在项目里，但当前更适合机器人事件，不作为个人私聊自动回复的首选：

```powershell
npm.cmd run autoreply:ws
```

也可以使用事件回调模式启动自动回复，这种方式不需要手动填写单聊 `chat_id`，因为飞书消息事件里会带上 `chat_id`，但需要一个飞书可以访问的公网 HTTPS 地址：

```powershell
npm.cmd run autoreply:webhook
```

然后在飞书开放平台的事件订阅里配置请求地址：

```text
http://<你的公网地址>:8790/feishu/events
```

如果飞书配置了 Verification Token，在 `.env` 里同步填写：

```text
LARK_EVENT_VERIFICATION_TOKEN=xxx
```

本地开发时，飞书需要能访问到这个地址；如果你的电脑没有公网地址，可以用内网穿透工具把本地 `8790` 端口暴露出去。

如果自动发现失败，再手动配置 `LARK_AUTOREPLY_TARGET_OPEN_ID` 和 `LARK_AUTOREPLY_CHAT_ID`。

脚本会读取 `.lark-user-token.json`，并记录 `.lark-auto-reply-state.json` 避免重复回复。默认没有冷却时间；如果需要防止同一会话频繁回复，可以把 `LARK_AUTOREPLY_COOLDOWN_MINUTES` 设置为大于 `0` 的分钟数。

## 准备飞书权限

至少需要在飞书开放平台完成这些配置：

1. 创建企业自建应用，并拿到 `App ID` 和 `App Secret`。
2. 启用机器人能力，并把机器人加入目标群聊。
3. 按需申请权限，例如发送消息通常需要 `im:message`，读取群列表通常需要对应的 `im:chat` 权限。自动回复还需要用户态授权相关权限，例如 `auth:user.id:read`、`contact:user:search`、`im:message`、`im:message:readonly`、`im:message.p2p_msg:get_as_user`、`im:message.send_as_user`。如果要回复外部联系人，还需要外部会话能力权限，例如 `ability:im.access_external_chat`。
4. 发布或重新发布应用，让新权限生效。

## 本地启动

```powershell
npm install
npm run build
```

创建 `.env`，参考 `.env.example` 填入你的飞书应用信息。`.env` 已经被 `.gitignore` 忽略，不会进入代码仓库：

```powershell
Copy-Item .env.example .env
```

然后打开 `.env` 填入：

```text
LARK_APP_ID=cli_xxx
LARK_APP_SECRET=xxx
LARK_API_BASE_URL=https://open.feishu.cn
```

终端直接运行：

```powershell
npm.cmd start
```

## 在 VS Code/Copilot 中使用

本项目已经包含 `.vscode/mcp.json`。先执行：

```powershell
npm install
npm run build
```

然后在 VS Code 中打开 MCP/Copilot Chat 的工具列表，启动 `lark-copilot-mcp`。服务会自动读取项目根目录的 `.env`，不需要每次输入 `LARK_APP_ID` 和 `LARK_APP_SECRET`。

之后可以在 Copilot Chat 里让它调用工具，例如：

- “列出飞书里机器人可访问的群聊”
- “给 chat_id 为 xxx 的群发一条测试消息”
- “调用飞书 `/open-apis/contact/v3/users/batch_get_id` 查询邮箱对应的 open_id”

## 常见问题

- `Failed to get tenant_access_token`: 检查 `App ID`、`App Secret` 和 `LARK_API_BASE_URL` 是否正确。
- `99991663 permission denied`: 权限未申请、未发布，或机器人没有加入目标群聊。
- 海外 Lark 租户请把 `LARK_API_BASE_URL` 改成 `https://open.larksuite.com`。