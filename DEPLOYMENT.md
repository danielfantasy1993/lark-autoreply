# 部署到 Vultr

这份说明给代码小白用：GitHub 负责保存代码，Vultr 负责长期运行自动回复。

## 本地文件分工

可以上传 GitHub：

- `src/`
- `package.json`
- `package-lock.json`
- `tsconfig.json`
- `README.md`
- `DEPLOYMENT.md`
- `ecosystem.config.cjs`
- `.env.example`

不要上传 GitHub：

- `.env`
- `.lark-user-token.json`
- `.lark-auto-reply-state.json`
- `.knowledge/`
- `node_modules/`
- `dist/`

## 第一次部署服务器

服务器上安装 Node.js 20+、Git 和 PM2 后执行：

```bash
git clone <你的 GitHub 仓库地址>
cd 04_Lark_Operating
npm install
npm run build
```

然后把本地这两个文件复制到服务器项目目录：

```text
.env
.lark-user-token.json
```

如果你希望服务器也能直接读取本地知识库，再复制：

```text
.knowledge/
```

启动自动回复：

```bash
pm2 start ecosystem.config.cjs
pm2 save
```

设置服务器重启后自动恢复：

```bash
pm2 startup
```

执行后 PM2 会打印一条命令，复制那条命令再运行一次。

## 以后本地改代码后同步

本地提交并推送：

```powershell
git add .
git commit -m "update lark auto reply"
git push
```

服务器更新并重启：

```bash
cd 04_Lark_Operating
git pull
npm install
npm run build
pm2 restart lark-autoreply
```

## 能不能直接在服务器改代码

可以临时改，但不建议长期这样做。服务器改完要马上提交并推送到 GitHub，否则本地和服务器代码会不一致。

推荐习惯：本地改代码，GitHub 同步，服务器只拉取稳定版本并运行。