# 自动回复评测闭环

目标不是直接“训练 DeepSeek 模型”，而是用真实聊天样本持续调优自动回复代理：提示词、工具判断、状态机和兜底规则。

## 推荐流程

1. 暂停服务器自动回复，避免测试时真实对外乱回：

```bash
pm2 stop lark-autoreply
```

2. 本地收集样本。把对方消息、上下文、你真人会怎么回，写到：

```text
.training/smart-reply-cases.json
```

`.training/` 已经被 `.gitignore` 忽略，不会上传 GitHub。

3. 本地批量评测：

```powershell
cd E:\AI_Agent\04_Lark_Operating
npm.cmd run smart:evaluate
```

第一次运行会自动生成一个样例文件。你改完样例，再跑一次。

4. 看输出文件：

```text
.training/smart-reply-eval-results.json
```

重点看 `generatedReply`、`idealReply`、`warnings`。

5. 根据评测结果修改代码或 `.env` 提示词，再本地构建：

```powershell
npm.cmd run build
npm.cmd run smart:evaluate
```

6. 满意后提交代码、部署服务器：

```powershell
git add .
git commit -m "improve smart reply behavior"
git push
```

服务器：

```bash
cd ~/lark-autoreply
git pull
npm run build
pm2 restart lark-autoreply --update-env
```

如果改了 `.env`，还要先从本地上传：

```powershell
scp E:\AI_Agent\04_Lark_Operating\.env root@149.28.84.11:~/lark-autoreply/.env
```

## 样本格式

```json
{
  "cases": [
    {
      "id": "lee-emoji-weather-confusion",
      "targetName": "Lee",
      "incomingMessage": "看不懂表情？",
      "conversation": [
        { "speaker": "target", "text": "🙂✅🔥" },
        { "speaker": "me", "text": "行，松江天气我这边没法直接看，你拿天气 App 扫一眼吧。" }
      ],
      "idealReply": "哈哈我刚没反应过来，你发的是表情，不是在说天气。",
      "notes": "不要把表情误判成天气任务。"
    }
  ]
}
```

## 为什么不直接自动改代码

完全自动改代码再部署风险很高，容易把小样本过拟合成奇怪规则。现在先采用半自动闭环：脚本批量发现问题，我根据结果改代码，然后再评测、提交、部署。等样本足够多，再考虑自动生成候选补丁。