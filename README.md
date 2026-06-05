# 电子科技大学学术交流月讲座表

这是 `xueshujiangzuo.jasonmumiao.online` 的静态页面源码，用于整理电子科技大学研究生院 2026 年学术交流月讲座信息。

## 内容

- `index.html`：自包含静态页面，包含样式、数据和筛选逻辑。
- `scripts/update-lectures.mjs`：自动抓取研究生院讲座通知并重建页面。
- `.github/workflows/update-lectures.yml`：每 12 小时自动更新的 GitHub Actions 工作流。
- 数据源：电子科技大学研究生院“研究生学术交流月”栏目。
- 部署目标：Cloudflare Worker Custom Domain。

## 自动更新

GitHub Actions 会在 UTC `00:00` 和 `12:00` 自动运行，即北京时间约 `08:00` 和 `20:00`。

更新逻辑：

- 抓取研究生院“研究生学术交流月”栏目最近页面。
- 只保留第 11 届学术交流月中，讲座日期在 `2026-06-01` 至 `2026-07-12` 之间的通知。
- 自动识别讲座日期、开始/结束时间、上午/下午/晚上、地点/线上形式、主讲人、标题和源链接。
- 内容简介不做 AI 总结，只截取源网页“内容简介/报告摘要/讲座简介”等字段的前 180 个字。
- 到 `2026-07-12` 后脚本自动退出，不再修改页面。

本地手动更新：

```bash
npm run update
```

自动部署需要在 GitHub 仓库 Secrets 中配置：

- `CLOUDFLARE_ACCOUNT_ID`
- `CLOUDFLARE_API_TOKEN`

如果没有配置 `CLOUDFLARE_API_TOKEN`，Actions 仍会更新并提交 `index.html`，但不会自动部署到 Cloudflare。

## 部署

当前线上 Worker 名称：

```bash
uestc-lectures-worker
```

部署命令：

```bash
rm -rf dist
mkdir -p dist
COPYFILE_DISABLE=1 cp index.html dist/index.html
find dist -name '._*' -delete
npx wrangler deploy dist --name uestc-lectures-worker --domain xueshujiangzuo.jasonmumiao.online --compatibility-date 2026-06-05
```

或直接运行：

```bash
npm run deploy
```
